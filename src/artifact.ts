/** Hash-verified, content-addressed managed runtime artifacts. */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'
import { DSH_API_VERSION } from './api-client.ts'
import { withOwnedFileLock } from './file-lock.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const GLIBC_VERSION = /^\d+\.\d+$/u
const MAX_MANIFEST_BYTES = 64 * 1024
const DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
const MAX_INNER_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 100_000
const MAX_EXPANDED_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
let environmentProxyDispatcher: EnvHttpProxyAgent | undefined

/** Archive source pinned by the small npm-shipped descriptor. */
export interface RuntimeArtifactArchiveManifest {
  /** Optional package-relative development artifact. */
  readonly path?: string
  /** Optional immutable HTTPS release asset used by normal npm installs. */
  readonly url?: string
  /** Exact lowercase archive SHA-256. */
  readonly sha256: string
  /** Exact archive byte count. */
  readonly bytes: number
}

/** Version-one local/download descriptor. Reading it never downloads. */
export interface RuntimeArtifactManifest {
  readonly formatVersion: 1
  readonly runtimeVersion: string
  readonly dshVersion: typeof DSH_API_VERSION
  readonly nodeVersion: string
  readonly platform: 'linux'
  readonly arch: 'x64'
  /** Oldest supported glibc ABI, currently `2.28`. */
  readonly minimumGlibc: string
  /** Node executable path inside the extracted runtime directory. */
  readonly node: string
  /** Executable DSH launcher path inside the extracted runtime directory. */
  readonly launcher: string
  readonly archive: RuntimeArtifactArchiveManifest
}

/** A locally cached and re-verified artifact safe for streaming upload. */
export interface ManagedRuntimeArtifact extends RuntimeArtifactManifest {
  readonly localPath: string
  /** Verified archive roster used again after remote extraction. */
  readonly entries: readonly RuntimeArchiveEntry[]
}

/** One integrity-protected member from the in-archive `manifest.json`. */
export type RuntimeArchiveEntry =
  | { readonly type: 'file'; readonly path: string; readonly size: number; readonly sha256: string }
  | { readonly type: 'symlink'; readonly path: string; readonly target: string }

/** Artifact source consumed only by Doctor descriptor reads and explicit install. */
export interface RuntimeArtifactProvider {
  /** Read and validate the small descriptor. Must not download the archive. */
  describe(signal?: AbortSignal): Promise<RuntimeArtifactManifest>
  /** Resolve, download/cache when necessary, and hash-verify the archive. */
  resolve(signal?: AbortSignal): Promise<ManagedRuntimeArtifact>
}

/** Options for the packaged descriptor plus local content-addressed cache. */
export interface LocalRuntimeArtifactProviderOptions {
  readonly manifestPath?: string
  readonly cacheRoot?: string
  readonly maxArtifactBytes?: number
  readonly fetch?: typeof globalThis.fetch
}

/** Safe local artifact error. */
export class RuntimeArtifactError extends Error {
  override readonly name = 'RuntimeArtifactError'

  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message)
  }
}

/** Packaged descriptor provider with an atomic, SHA-addressed download cache. */
export class LocalRuntimeArtifactProvider implements RuntimeArtifactProvider {
  private readonly manifestPath: string
  private readonly cacheRoot: string
  private readonly maxArtifactBytes: number
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly downloads = new Map<string, Promise<void>>()

  constructor(options: LocalRuntimeArtifactProviderOptions = {}) {
    this.manifestPath = resolve(options.manifestPath ?? defaultManifestPath())
    this.cacheRoot = resolve(options.cacheRoot ?? defaultCacheRoot())
    this.maxArtifactBytes = positiveInteger(options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES, 'maxArtifactBytes')
    this.fetchImpl = options.fetch ?? fetchWithEnvironmentProxy
  }

  async describe(signal?: AbortSignal): Promise<RuntimeArtifactManifest> {
    signal?.throwIfAborted()
    let source: string
    try {
      const info = await stat(this.manifestPath)
      if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) {
        throw new RuntimeArtifactError('MANIFEST_INVALID', 'runtime artifact manifest is missing or too large')
      }
      source = await readFile(this.manifestPath, 'utf8')
    } catch (error: unknown) {
      if (error instanceof RuntimeArtifactError) throw error
      throw new RuntimeArtifactError('MANIFEST_MISSING', `runtime artifact manifest is unavailable: ${diagnostic(error)}`)
    }
    signal?.throwIfAborted()
    try {
      return validateManifest(JSON.parse(source) as unknown)
    } catch (error: unknown) {
      if (error instanceof RuntimeArtifactError) throw error
      throw new RuntimeArtifactError('MANIFEST_INVALID', 'runtime artifact manifest is not valid JSON')
    }
  }

  async resolve(signal?: AbortSignal): Promise<ManagedRuntimeArtifact> {
    const manifest = await this.describe(signal)
    signal?.throwIfAborted()
    if (manifest.archive.bytes > this.maxArtifactBytes) {
      throw new RuntimeArtifactError('ARCHIVE_TOO_LARGE', 'runtime archive exceeds the configured cache limit')
    }
    const expectedName = `${manifest.archive.sha256}.tar.gz`
    const packaged = manifest.archive.path === undefined
      ? undefined
      : resolveContained(dirname(this.manifestPath), manifest.archive.path)
    if (packaged !== undefined) {
      if (basename(packaged) !== expectedName) {
        throw new RuntimeArtifactError('MANIFEST_NOT_CONTENT_ADDRESSED', `runtime archive must be named ${expectedName}`)
      }
      await verifyArchive(packaged, manifest, signal)
      const entries = await inspectRuntimeArchive(packaged, signal)
      return Object.freeze({ ...manifest, localPath: packaged, entries })
    }
    const url = manifest.archive.url
    if (url === undefined) throw new RuntimeArtifactError('ARCHIVE_SOURCE_MISSING', 'runtime descriptor has no archive source')
    const objectRoot = join(this.cacheRoot, 'objects')
    const localPath = join(objectRoot, expectedName)
    let download = this.downloads.get(manifest.archive.sha256)
    if (download === undefined) {
      download = this.ensureCached(url, objectRoot, localPath, manifest, signal)
      this.downloads.set(manifest.archive.sha256, download)
      void download.finally(() => {
        if (this.downloads.get(manifest.archive.sha256) === download) this.downloads.delete(manifest.archive.sha256)
      }).catch(() => undefined)
    }
    await download
    signal?.throwIfAborted()
    await verifyArchive(localPath, manifest, signal)
    const entries = await inspectRuntimeArchive(localPath, signal)
    return Object.freeze({ ...manifest, localPath, entries })
  }

  private async ensureCached(
    url: string,
    objectRoot: string,
    localPath: string,
    manifest: RuntimeArtifactManifest,
    signal?: AbortSignal,
  ): Promise<void> {
    await mkdir(objectRoot, { recursive: true, mode: 0o700 })
    await withOwnedFileLock(`${localPath}.lock`, async () => {
      signal?.throwIfAborted()
      if (await archiveMatches(localPath, manifest, signal)) return
      await rm(localPath, { force: true })
      await this.download(url, localPath, manifest, signal)
    }, {
      attempts: 600,
      pollMs: 100,
      staleMs: 10 * 60_000,
      timeoutCode: 'artifact-cache-lock-timeout',
      timeoutMessage: 'Timed out waiting for the runtime artifact cache lock.',
      phase: 'artifact',
    })
  }

  private async download(
    source: string,
    destination: string,
    manifest: RuntimeArtifactManifest,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = new URL(source)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      throw new RuntimeArtifactError('ARCHIVE_URL_INVALID', 'runtime archive URL must be credential-free HTTPS')
    }
    const temporary = `${destination}.download-${process.pid}-${randomUUID()}`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const response = await this.fetchImpl(url, {
        // WHATWG fetch follows at most its bounded redirect limit. GitHub
        // release assets require a 302 to immutable object storage.
        redirect: 'follow',
        ...(signal === undefined ? {} : { signal }),
      })
      const finalUrl = new URL(response.url || url)
      if (finalUrl.protocol !== 'https:' || finalUrl.username !== '' || finalUrl.password !== '') {
        throw new RuntimeArtifactError('ARCHIVE_REDIRECT_INVALID', 'runtime archive redirect left credential-free HTTPS')
      }
      if (!response.ok || response.body === null) {
        throw new RuntimeArtifactError(
          'ARCHIVE_DOWNLOAD_FAILED',
          `runtime archive download returned HTTP ${String(response.status)}`,
          response.status === 408 || response.status === 429 || response.status >= 500,
        )
      }
      const declared = response.headers.get('content-length')
      if (declared !== null && /^\d+$/u.test(declared) && Number(declared) !== manifest.archive.bytes) {
        throw new RuntimeArtifactError('ARCHIVE_SIZE_MISMATCH', 'download Content-Length does not match the descriptor')
      }
      handle = await open(temporary, 'wx', 0o600)
      const reader = response.body.getReader()
      const hash = createHash('sha256')
      let bytes = 0
      try {
        while (true) {
          signal?.throwIfAborted()
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > manifest.archive.bytes || bytes > this.maxArtifactBytes) {
            throw new RuntimeArtifactError('ARCHIVE_SIZE_MISMATCH', 'runtime archive download exceeded the descriptor size')
          }
          hash.update(value)
          await handle.write(value)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      if (bytes !== manifest.archive.bytes || !hashEquals(hash.digest('hex'), manifest.archive.sha256)) {
        throw new RuntimeArtifactError('ARCHIVE_HASH_MISMATCH', 'downloaded runtime archive failed size or SHA-256 verification')
      }
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, destination)
    } catch (error: unknown) {
      if (error instanceof RuntimeArtifactError) throw error
      if (signal?.aborted === true) throw signal.reason
      throw new RuntimeArtifactError('ARCHIVE_DOWNLOAD_FAILED', `runtime archive download failed: ${diagnostic(error)}`, true)
    } finally {
      await handle?.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}

async function fetchWithEnvironmentProxy(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
  environmentProxyDispatcher ??= new EnvHttpProxyAgent()
  return await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: environmentProxyDispatcher,
  }) as unknown as Response
}

/** Validate an untrusted JSON descriptor into the frozen public contract. */
export function validateRuntimeArtifactManifest(value: unknown): RuntimeArtifactManifest {
  return validateManifest(value)
}

function validateManifest(value: unknown): RuntimeArtifactManifest {
  if (!isRecord(value) || value.formatVersion !== 1) {
    throw new RuntimeArtifactError('MANIFEST_INVALID', 'runtime artifact manifest formatVersion must be 1')
  }
  const runtimeVersion = nonEmpty(value.runtimeVersion, 'runtimeVersion')
  if (value.dshVersion !== DSH_API_VERSION) {
    throw new RuntimeArtifactError('DSH_VERSION_MISMATCH', `runtime artifact must contain official DSH ${DSH_API_VERSION}`)
  }
  const nodeVersion = nonEmpty(value.nodeVersion, 'nodeVersion')
  if (value.platform !== 'linux' || value.arch !== 'x64') {
    throw new RuntimeArtifactError('ARTIFACT_PLATFORM_UNSUPPORTED', 'runtime artifact must target linux x64')
  }
  const minimumGlibc = nonEmpty(value.minimumGlibc, 'minimumGlibc')
  if (!GLIBC_VERSION.test(minimumGlibc)) throw new RuntimeArtifactError('MANIFEST_INVALID', 'minimumGlibc must be major.minor')
  const launcher = safeRelativePath(value.launcher, 'launcher')
  const node = safeRelativePath(value.node, 'node')
  const archive = isRecord(value.archive) ? value.archive : undefined
  if (archive === undefined) throw new RuntimeArtifactError('MANIFEST_INVALID', 'runtime artifact archive entry is missing')
  const archivePath = archive.path === undefined ? undefined : safeRelativePath(archive.path, 'archive.path')
  const archiveUrl = archive.url === undefined ? undefined : validateArchiveUrl(archive.url)
  if ((archivePath === undefined) === (archiveUrl === undefined)) {
    throw new RuntimeArtifactError('MANIFEST_INVALID', 'archive must declare exactly one of path or url')
  }
  const sha256 = nonEmpty(archive.sha256, 'archive.sha256')
  if (!SHA256.test(sha256)) throw new RuntimeArtifactError('MANIFEST_INVALID', 'archive.sha256 must be lowercase SHA-256')
  const bytes = archive.bytes
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw new RuntimeArtifactError('MANIFEST_INVALID', 'archive.bytes must be a positive safe integer')
  }
  return Object.freeze({
    formatVersion: 1,
    runtimeVersion,
    dshVersion: DSH_API_VERSION,
    nodeVersion,
    platform: 'linux',
    arch: 'x64',
    minimumGlibc,
    node,
    launcher,
    archive: Object.freeze({
      ...(archivePath === undefined ? {} : { path: archivePath }),
      ...(archiveUrl === undefined ? {} : { url: archiveUrl }),
      sha256,
      bytes,
    }),
  })
}

async function archiveMatches(path: string, manifest: RuntimeArtifactManifest, signal?: AbortSignal): Promise<boolean> {
  try {
    await verifyArchive(path, manifest, signal)
    return true
  } catch {
    if (signal?.aborted === true) throw signal.reason
    return false
  }
}

async function verifyArchive(path: string, manifest: RuntimeArtifactManifest, signal?: AbortSignal): Promise<void> {
  let info
  try {
    info = await stat(path)
  } catch (error: unknown) {
    throw new RuntimeArtifactError('ARCHIVE_MISSING', `runtime archive is unavailable: ${diagnostic(error)}`)
  }
  if (!info.isFile() || info.size !== manifest.archive.bytes) {
    throw new RuntimeArtifactError('ARCHIVE_SIZE_MISMATCH', 'runtime archive size does not match its descriptor')
  }
  const actual = await hashFile(path, signal)
  if (!hashEquals(actual, manifest.archive.sha256)) {
    throw new RuntimeArtifactError('ARCHIVE_HASH_MISMATCH', 'runtime archive SHA-256 does not match its descriptor')
  }
}

async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  const abort = (): void => { stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error('artifact hashing cancelled')) }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted === true) abort()
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted()
      hash.update(chunk as Buffer)
    }
    return hash.digest('hex')
  } catch (error: unknown) {
    if (signal?.aborted === true) throw signal.reason
    throw new RuntimeArtifactError('ARCHIVE_READ_FAILED', `runtime archive could not be hashed: ${diagnostic(error)}`, true)
  } finally {
    signal?.removeEventListener('abort', abort)
    stream.destroy()
  }
}

interface ParsedTarMember {
  readonly type: 'file' | 'symlink' | 'directory'
  readonly path: string
  readonly size: number
  readonly sha256?: string
  readonly target?: string
}

/** Stream-parse the pinned gzip/USTAR archive before it ever reaches SSH. */
async function inspectRuntimeArchive(path: string, signal?: AbortSignal): Promise<readonly RuntimeArchiveEntry[]> {
  const compressed = createReadStream(path)
  const stream = compressed.pipe(createGunzip())
  const abort = (): void => {
    stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error('archive inspection cancelled'))
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted === true) abort()
  let buffer = Buffer.alloc(0)
  let current: {
    member: ParsedTarMember
    remaining: number
    padding: number
    hash: ReturnType<typeof createHash>
    manifest: Buffer[]
  } | undefined
  const members: ParsedTarMember[] = []
  let expandedBytes = 0
  let zeroBlocks = 0
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted()
      buffer = buffer.length === 0 ? Buffer.from(chunk as Buffer) : Buffer.concat([buffer, Buffer.from(chunk as Buffer)])
      while (buffer.length > 0) {
        if (current !== undefined) {
          if (current.remaining > 0) {
            const take = Math.min(current.remaining, buffer.length)
            const body = buffer.subarray(0, take)
            current.hash.update(body)
            if (current.member.path === 'manifest.json') {
              const collected = current.member.size - current.remaining + take
              if (collected > MAX_INNER_MANIFEST_BYTES) {
                throw new RuntimeArtifactError('INNER_MANIFEST_TOO_LARGE', 'archive manifest.json exceeds its size limit')
              }
              current.manifest.push(Buffer.from(body))
            }
            current.remaining -= take
            buffer = buffer.subarray(take)
            if (current.remaining > 0) break
          }
          if (current.padding > 0) {
            const take = Math.min(current.padding, buffer.length)
            current.padding -= take
            buffer = buffer.subarray(take)
            if (current.padding > 0) break
          }
          members.push(Object.freeze({
            ...current.member,
            ...(current.member.type === 'file' ? { sha256: current.hash.digest('hex') } : {}),
            ...(current.member.path === 'manifest.json'
              ? { target: Buffer.concat(current.manifest).toString('utf8') }
              : {}),
          }))
          current = undefined
          continue
        }
        if (buffer.length < 512) break
        const header = buffer.subarray(0, 512)
        buffer = buffer.subarray(512)
        if (header.every(byte => byte === 0)) {
          zeroBlocks += 1
          if (zeroBlocks >= 2) {
            buffer = Buffer.alloc(0)
            break
          }
          continue
        }
        if (zeroBlocks !== 0) throw new RuntimeArtifactError('ARCHIVE_INVALID', 'archive contains data after a zero terminator')
        const member = parseTarHeader(header)
        expandedBytes += member.size
        if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED_ARCHIVE_BYTES) {
          throw new RuntimeArtifactError('ARCHIVE_EXPANDED_TOO_LARGE', 'runtime archive exceeds the expanded-byte limit')
        }
        if (members.length >= MAX_ARCHIVE_ENTRIES) {
          throw new RuntimeArtifactError('ARCHIVE_TOO_MANY_ENTRIES', 'runtime archive contains too many entries')
        }
        current = {
          member,
          remaining: member.size,
          padding: (512 - member.size % 512) % 512,
          hash: createHash('sha256'),
          manifest: [],
        }
        if (member.size === 0 && current.padding === 0) {
          members.push(Object.freeze({ ...member, ...(member.type === 'file' ? { sha256: current.hash.digest('hex') } : {}) }))
          current = undefined
        }
      }
    }
  } catch (error: unknown) {
    if (error instanceof RuntimeArtifactError) throw error
    if (signal?.aborted === true) throw signal.reason
    throw new RuntimeArtifactError('ARCHIVE_INVALID', `runtime archive could not be inspected: ${diagnostic(error)}`)
  } finally {
    signal?.removeEventListener('abort', abort)
    compressed.destroy()
    stream.destroy()
  }
  if (current !== undefined || buffer.length !== 0 || zeroBlocks < 2) {
    throw new RuntimeArtifactError('ARCHIVE_TRUNCATED', 'runtime archive has an incomplete tar stream')
  }
  return validateInnerManifest(members)
}

function parseTarHeader(header: Buffer): ParsedTarMember {
  const storedChecksum = parseTarNumber(header.subarray(148, 156), 'checksum')
  let checksum = 0
  for (let index = 0; index < header.length; index += 1) {
    checksum += index >= 148 && index < 156 ? 32 : header[index]!
  }
  if (storedChecksum !== checksum) throw new RuntimeArtifactError('ARCHIVE_CHECKSUM_INVALID', 'tar header checksum is invalid')
  const name = tarString(header.subarray(0, 100))
  const prefix = tarString(header.subarray(345, 500))
  const rawPath = prefix === '' ? name : `${prefix}/${name}`
  const memberPath = archivePath(rawPath)
  const size = parseTarNumber(header.subarray(124, 136), 'size')
  const typeFlag = header[156]
  if (typeFlag === 0 || typeFlag === 48) return { type: 'file', path: memberPath, size }
  if (typeFlag === 53) {
    if (size !== 0) throw new RuntimeArtifactError('ARCHIVE_INVALID', 'directory entry has a non-zero body')
    return { type: 'directory', path: memberPath, size: 0 }
  }
  if (typeFlag === 50) {
    if (size !== 0) throw new RuntimeArtifactError('ARCHIVE_INVALID', 'symlink entry has a non-zero body')
    const target = tarString(header.subarray(157, 257))
    validateSymlinkTarget(memberPath, target)
    return { type: 'symlink', path: memberPath, size: 0, target }
  }
  throw new RuntimeArtifactError('ARCHIVE_ENTRY_UNSUPPORTED', 'runtime archive contains a non-file, non-directory, or non-symlink entry')
}

function validateInnerManifest(members: readonly ParsedTarMember[]): readonly RuntimeArchiveEntry[] {
  const manifests = members.filter(member => member.path === 'manifest.json' && member.type === 'file')
  const manifestMember = manifests[0]
  if (manifests.length !== 1 || manifestMember === undefined || typeof manifestMember.target !== 'string'
    || manifestMember.sha256 === undefined) {
    throw new RuntimeArtifactError('INNER_MANIFEST_MISSING', 'runtime archive must contain one root manifest.json')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestMember.target) as unknown
  } catch {
    throw new RuntimeArtifactError('INNER_MANIFEST_INVALID', 'runtime archive manifest.json is not valid JSON')
  }
  if (!isRecord(parsed) || (parsed.formatVersion !== 1 && parsed.version !== 1) || !Array.isArray(parsed.entries)) {
    throw new RuntimeArtifactError('INNER_MANIFEST_INVALID', 'runtime archive manifest.json has an invalid version or entries list')
  }
  const entries: RuntimeArchiveEntry[] = []
  const expected = new Map<string, RuntimeArchiveEntry>()
  for (const raw of parsed.entries) {
    if (!isRecord(raw)) throw new RuntimeArtifactError('INNER_MANIFEST_INVALID', 'runtime archive entry is not an object')
    const memberPath = archivePath(raw.path)
    if (memberPath === 'manifest.json' || expected.has(memberPath)) {
      throw new RuntimeArtifactError('INNER_MANIFEST_INVALID', 'runtime archive manifest contains a duplicate or reserved path')
    }
    let entry: RuntimeArchiveEntry
    if (raw.type === 'file') {
      const size = raw.size
      const sha256 = nonEmpty(raw.sha256, 'entry.sha256')
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || !SHA256.test(sha256)) {
        throw new RuntimeArtifactError('INNER_MANIFEST_INVALID', 'runtime archive file metadata is invalid')
      }
      entry = Object.freeze({ type: 'file', path: memberPath, size, sha256 })
    } else if (raw.type === 'symlink') {
      const target = nonEmpty(raw.target, 'entry.target')
      validateSymlinkTarget(memberPath, target)
      entry = Object.freeze({ type: 'symlink', path: memberPath, target })
    } else {
      throw new RuntimeArtifactError('INNER_MANIFEST_INVALID', 'runtime archive entry type is invalid')
    }
    expected.set(memberPath, entry)
    entries.push(entry)
  }
  const actualPayload = members.filter(member => member.type !== 'directory' && member.path !== 'manifest.json')
  if (actualPayload.length !== expected.size) {
    throw new RuntimeArtifactError('INNER_MANIFEST_INCOMPLETE', 'runtime archive payload does not match manifest completeness')
  }
  for (const member of actualPayload) {
    const entry = expected.get(member.path)
    if (entry === undefined || entry.type !== member.type) {
      throw new RuntimeArtifactError('INNER_MANIFEST_INCOMPLETE', 'runtime archive contains an undeclared or mismatched member')
    }
    if (entry.type === 'file' && (entry.size !== member.size || entry.sha256 !== member.sha256)) {
      throw new RuntimeArtifactError('INNER_MANIFEST_HASH_MISMATCH', 'runtime archive file does not match manifest size or SHA-256')
    }
    if (entry.type === 'symlink' && entry.target !== member.target) {
      throw new RuntimeArtifactError('INNER_MANIFEST_SYMLINK_MISMATCH', 'runtime archive symlink target does not match its manifest')
    }
  }
  // Directories carry no bytes or target and are fully pinned by the outer
  // archive SHA. Completeness is defined over regular files and symlinks;
  // package managers legitimately emit empty runtime directories.
  return Object.freeze([
    Object.freeze({
      type: 'file' as const,
      path: 'manifest.json',
      size: manifestMember.size,
      sha256: manifestMember.sha256,
    }),
    ...entries,
  ])
}

function parseTarNumber(field: Buffer, label: string): number {
  if ((field[0]! & 0x80) !== 0) throw new RuntimeArtifactError('ARCHIVE_INVALID', `tar ${label} uses unsupported base-256 encoding`)
  const raw = tarString(field).trim()
  if (raw === '') return 0
  if (!/^[0-7]+$/u.test(raw)) throw new RuntimeArtifactError('ARCHIVE_INVALID', `tar ${label} is not octal`)
  const value = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(value) || value < 0) throw new RuntimeArtifactError('ARCHIVE_INVALID', `tar ${label} is out of range`)
  return value
}

function tarString(field: Buffer): string {
  const end = field.indexOf(0)
  const bytes = end < 0 ? field : field.subarray(0, end)
  const value = bytes.toString('utf8')
  if (value.includes('\uFFFD') || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RuntimeArtifactError('ARCHIVE_INVALID', 'tar text field is not safe UTF-8 text')
  }
  return value
}

function archivePath(value: unknown): string {
  let pathValue = nonEmpty(value, 'archive entry path').replace(/^\.\//u, '').replace(/\/$/u, '')
  if (pathValue === '' || pathValue.includes('\\') || posix.isAbsolute(pathValue)) {
    throw new RuntimeArtifactError('ARCHIVE_PATH_ESCAPE', 'runtime archive contains an unsafe path')
  }
  const normalized = posix.normalize(pathValue)
  if (normalized === '..' || normalized.startsWith('../') || normalized !== pathValue) {
    throw new RuntimeArtifactError('ARCHIVE_PATH_ESCAPE', 'runtime archive path is non-canonical or escapes its root')
  }
  return pathValue
}

function validateSymlinkTarget(memberPath: string, target: string): void {
  if (target === '' || /[\u0000-\u001f\u007f\\]/u.test(target) || posix.isAbsolute(target)) {
    throw new RuntimeArtifactError('ARCHIVE_SYMLINK_ESCAPE', 'runtime archive symlink target is unsafe')
  }
  const resolved = posix.normalize(posix.join(posix.dirname(memberPath), target))
  if (resolved === '..' || resolved.startsWith('../')) {
    throw new RuntimeArtifactError('ARCHIVE_SYMLINK_ESCAPE', 'runtime archive symlink escapes its extraction root')
  }
}

function resolveContained(root: string, child: string): string {
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, child)
  const relation = relative(resolvedRoot, target)
  if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) {
    throw new RuntimeArtifactError('MANIFEST_PATH_ESCAPE', 'runtime artifact path escapes its manifest directory')
  }
  return target
}

function safeRelativePath(value: unknown, label: string): string {
  const path = nonEmpty(value, label)
  if (isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/u).some(part => part === '..' || part === '')) {
    throw new RuntimeArtifactError('MANIFEST_INVALID', `${label} must be a contained relative path`)
  }
  return path
}

function validateArchiveUrl(value: unknown): string {
  const raw = nonEmpty(value, 'archive.url')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new RuntimeArtifactError('MANIFEST_INVALID', 'archive.url must be an absolute HTTPS URL')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new RuntimeArtifactError('MANIFEST_INVALID', 'archive.url must be credential-free HTTPS')
  }
  return url.toString()
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RuntimeArtifactError('MANIFEST_INVALID', `${label} must be a non-empty string`)
  }
  return value
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RuntimeArtifactError('INVALID_CONFIG', `${label} must be a positive safe integer`)
  }
  return value
}

function hashEquals(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function defaultManifestPath(): string {
  return fileURLToPath(new URL('../runtime/manifest.json', import.meta.url))
}

function defaultCacheRoot(): string {
  if (process.env.DSH_REMOTE_RUNTIME_CACHE) return process.env.DSH_REMOTE_RUNTIME_CACHE
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'dsh-remote-runtime', 'cache')
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dsh-remote-runtime')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function diagnostic(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return value.replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, 'sk-[redacted]').slice(0, 500)
}
