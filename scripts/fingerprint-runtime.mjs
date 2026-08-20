/** Print content fingerprints that distinguish archive, compressor, and stage drift. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const descriptor = JSON.parse(await readFile(join(root, 'runtime', 'manifest.json'), 'utf8'))
const defaultName = basename(new URL(descriptor.archive.url).pathname)
const archive = resolve(process.argv[2] ?? join(root, 'runtime', 'artifacts', defaultName))
const archiveInfo = await stat(archive)

const manifestResult = spawnSync('tar', ['-xOf', archive, 'manifest.json'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
  windowsHide: true,
})
if (manifestResult.error !== undefined) throw manifestResult.error
if (manifestResult.status !== 0) {
  throw new Error(`tar could not read the runtime manifest: ${manifestResult.stderr}`)
}

const manifestText = manifestResult.stdout
const manifest = JSON.parse(manifestText)
if (!Array.isArray(manifest.entries)) throw new Error('runtime manifest has no entries array')
const { entries, ...metadata } = manifest
const canonicalEntries = [...entries].sort((left, right) => Buffer.compare(
  Buffer.from(String(left.path), 'utf8'),
  Buffer.from(String(right.path), 'utf8'),
))
const files = entries.filter(entry => entry.type === 'file')
const symlinks = entries.filter(entry => entry.type === 'symlink')
const tarFingerprint = await gunzipFingerprint(archive)

process.stdout.write(`${JSON.stringify({
  archive: {
    bytes: archiveInfo.size,
    sha256: await sha256File(archive),
  },
  tar: tarFingerprint,
  manifest: {
    bytes: Buffer.byteLength(manifestText),
    sha256: sha256Value(manifestText),
    metadataSha256: sha256Json(metadata),
    orderedEntriesSha256: sha256Json(entries),
    canonicalEntriesSha256: sha256Json(canonicalEntries),
    entries: entries.length,
    files: files.length,
    symlinks: symlinks.length,
    fileBytes: files.reduce((total, entry) => total + Number(entry.size), 0),
  },
  environment: {
    node: process.version,
    icu: process.versions.icu,
    platform: process.platform,
    arch: process.arch,
  },
})}\n`)

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function gunzipFingerprint(path) {
  const hash = createHash('sha256')
  const gunzip = createGunzip()
  const headers = tarHeaderCollector()
  createReadStream(path).pipe(gunzip)
  let bytes = 0
  for await (const chunk of gunzip) {
    hash.update(chunk)
    bytes += chunk.length
    headers.feed(chunk)
  }
  return { bytes, sha256: hash.digest('hex'), ...headers.finish() }
}

function tarHeaderCollector() {
  let pending = Buffer.alloc(0)
  let skipBytes = 0
  let finished = false
  const members = []

  return {
    feed(chunk) {
      let offset = 0
      while (offset < chunk.length && !finished) {
        if (skipBytes > 0) {
          const skipped = Math.min(skipBytes, chunk.length - offset)
          skipBytes -= skipped
          offset += skipped
          continue
        }
        const needed = 512 - pending.length
        const taken = Math.min(needed, chunk.length - offset)
        pending = pending.length === 0
          ? Buffer.from(chunk.subarray(offset, offset + taken))
          : Buffer.concat([pending, chunk.subarray(offset, offset + taken)])
        offset += taken
        if (pending.length !== 512) continue
        if (pending.every(byte => byte === 0)) {
          finished = true
          pending = Buffer.alloc(0)
          continue
        }
        const member = parseTarHeader(pending)
        members.push(member)
        skipBytes = Math.ceil(member.size / 512) * 512
        pending = Buffer.alloc(0)
      }
    },
    finish() {
      if (!finished || pending.length !== 0 || skipBytes !== 0) {
        throw new Error('runtime archive ended with an incomplete USTAR member')
      }
      const canonical = [...members].sort((left, right) => Buffer.compare(
        Buffer.from(left.path, 'utf8'),
        Buffer.from(right.path, 'utf8'),
      ))
      const executableFiles = members
        .filter(member => member.type === '0' && (Number.parseInt(member.mode, 8) & 0o111) !== 0)
        .map(member => member.path)
      return {
        members: members.length,
        orderedPathsSha256: sha256Json(members.map(member => member.path)),
        canonicalPathsSha256: sha256Json(canonical.map(member => member.path)),
        orderedMembersSha256: sha256Json(members),
        canonicalMembersSha256: sha256Json(canonical),
        modes: histogram(members.map(member => member.mode)),
        types: histogram(members.map(member => member.type)),
        executableFiles,
      }
    },
  }
}

function parseTarHeader(header) {
  const name = tarString(header, 0, 100)
  const prefix = tarString(header, 345, 155)
  return {
    path: prefix === '' ? name : `${prefix}/${name}`,
    mode: tarString(header, 100, 8),
    uid: tarString(header, 108, 8),
    gid: tarString(header, 116, 8),
    size: tarOctal(header, 124, 12),
    mtime: tarString(header, 136, 12),
    type: tarString(header, 156, 1) || '0',
    link: tarString(header, 157, 100),
    magic: tarString(header, 257, 6),
    version: tarString(header, 263, 2),
    uname: tarString(header, 265, 32),
    gname: tarString(header, 297, 32),
    devmajor: tarString(header, 329, 8),
    devminor: tarString(header, 337, 8),
  }
}

function tarString(header, offset, length) {
  const field = header.subarray(offset, offset + length)
  const nul = field.indexOf(0)
  return field.subarray(0, nul === -1 ? field.length : nul).toString('utf8').trim()
}

function tarOctal(header, offset, length) {
  const value = tarString(header, offset, length)
  const parsed = Number.parseInt(value || '0', 8)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid USTAR size field')
  return parsed
}

function histogram(values) {
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)))
}

function sha256Json(value) {
  return sha256Value(JSON.stringify(value))
}

function sha256Value(value) {
  return createHash('sha256').update(value).digest('hex')
}
