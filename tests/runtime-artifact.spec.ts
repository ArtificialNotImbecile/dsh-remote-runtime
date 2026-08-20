import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalRuntimeArtifactProvider, RuntimeArtifactError } from '../src/artifact.ts'

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('managed runtime artifacts', () => {
  const packagedDescriptor = existsSync(join(process.cwd(), 'runtime', 'manifest.json'))
    ? JSON.parse(readFileSync(join(process.cwd(), 'runtime', 'manifest.json'), 'utf8')) as { runtimeVersion: string }
    : undefined
  const realArchive = packagedDescriptor === undefined
    ? ''
    : join(process.cwd(), 'runtime', 'artifacts', `dsh-remote-runtime-${packagedDescriptor.runtimeVersion}-linux-x64-glibc.tar.gz`)
  it.runIf(realArchive !== '' && existsSync(realArchive))(
    'accepts the real built 90 MiB runtime and its compact manifest',
    async () => {
      const root = await temporaryRoot()
      const realManifest = JSON.parse(await readFile(join(process.cwd(), 'runtime', 'manifest.json'), 'utf8')) as {
        archive: { sha256: string; bytes: number }
      }
      const objectDir = join(root, 'objects')
      await mkdir(objectDir)
      const name = `${realManifest.archive.sha256}.tar.gz`
      await copyFile(realArchive, join(objectDir, name))
      const source = JSON.parse(await readFile(join(process.cwd(), 'runtime', 'manifest.json'), 'utf8')) as Record<string, unknown>
      source.archive = {
        path: `objects/${name}`,
        sha256: realManifest.archive.sha256,
        bytes: realManifest.archive.bytes,
      }
      const manifestPath = join(root, 'manifest.json')
      await writeFile(manifestPath, JSON.stringify(source))
      const artifact = await new LocalRuntimeArtifactProvider({ manifestPath }).resolve()
      expect(artifact.entries.length).toBeGreaterThan(1_000)
      expect(artifact.entries).toContainEqual(expect.objectContaining({ type: 'file', path: 'app/proxy-preload.mjs' }))
    },
    60_000,
  )

  it('verifies outer SHA plus the complete in-archive file roster', async () => {
    const root = await temporaryRoot()
    const archive = runtimeArchive()
    const sha256 = digest(archive)
    const objectDir = join(root, 'objects')
    await mkdir(objectDir)
    const archivePath = join(objectDir, `${sha256}.tar.gz`)
    await writeFile(archivePath, archive)
    const manifestPath = join(root, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify(descriptor({ path: `objects/${sha256}.tar.gz` }, sha256, archive.length)))

    const artifact = await new LocalRuntimeArtifactProvider({ manifestPath }).resolve()
    expect(artifact.localPath).toBe(archivePath)
    expect(artifact.entries.map(entry => entry.path)).toEqual([
      'manifest.json', 'bin/node', 'bin/dsh', 'app/proxy-preload.mjs', 'app/package.json',
    ])
    expect(artifact.entries.every(entry => entry.type === 'file')).toBe(true)
  })

  it('rejects symlink targets that escape before an archive can be uploaded', async () => {
    const root = await temporaryRoot()
    const archive = runtimeArchive([{ type: 'symlink', path: 'app/escape', target: '../../outside' }])
    const sha256 = digest(archive)
    const objectDir = join(root, 'objects')
    await mkdir(objectDir)
    await writeFile(join(objectDir, `${sha256}.tar.gz`), archive)
    const manifestPath = join(root, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify(descriptor({ path: `objects/${sha256}.tar.gz` }, sha256, archive.length)))
    await expect(new LocalRuntimeArtifactProvider({ manifestPath }).resolve())
      .rejects.toMatchObject({ code: 'ARCHIVE_SYMLINK_ESCAPE' })
  })

  it('downloads a pinned HTTPS artifact once into its SHA-addressed cache', async () => {
    const root = await temporaryRoot()
    const archive = runtimeArchive()
    const sha256 = digest(archive)
    const manifestPath = join(root, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify(descriptor(
      { url: 'https://releases.example.test/runtime.tar.gz' }, sha256, archive.length,
    )))
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('follow')
      const response = new Response(archive, {
        status: 200,
        headers: { 'content-length': String(archive.length) },
      })
      Object.defineProperty(response, 'url', { value: 'https://objects.example.test/pinned-runtime.tar.gz' })
      return response
    })
    const provider = new LocalRuntimeArtifactProvider({ manifestPath, cacheRoot: join(root, 'cache'), fetch })
    const secondProvider = new LocalRuntimeArtifactProvider({ manifestPath, cacheRoot: join(root, 'cache'), fetch })
    const [first, second] = await Promise.all([provider.resolve(), secondProvider.resolve()])
    expect(first.localPath).toMatch(new RegExp(`${sha256}\\.tar\\.gz$`, 'u'))
    expect(second.localPath).toBe(first.localPath)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(digest(await readFile(first.localPath))).toBe(sha256)
  })

  it('rejects an HTTPS release redirect that downgrades the final URL', async () => {
    const root = await temporaryRoot()
    const archive = runtimeArchive()
    const sha256 = digest(archive)
    const manifestPath = join(root, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify(descriptor(
      { url: 'https://releases.example.test/runtime.tar.gz' }, sha256, archive.length,
    )))
    const response = new Response(archive, { status: 200 })
    Object.defineProperty(response, 'url', { value: 'http://objects.example.test/runtime.tar.gz' })
    const provider = new LocalRuntimeArtifactProvider({ manifestPath, fetch: vi.fn(async () => response) })
    await expect(provider.resolve()).rejects.toMatchObject({ code: 'ARCHIVE_REDIRECT_INVALID' })
  })

  it('descriptor reads stay download-free for Doctor', async () => {
    const root = await temporaryRoot()
    const manifestPath = join(root, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify(descriptor(
      { url: 'https://releases.example.test/runtime.tar.gz' }, 'a'.repeat(64), 123,
    )))
    const fetch = vi.fn()
    const provider = new LocalRuntimeArtifactProvider({ manifestPath, fetch })
    await expect(provider.describe()).resolves.toMatchObject({ minimumGlibc: '2.28', dshVersion: '0.1.0-rc.8' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses hash and content-address naming mismatches', async () => {
    const root = await temporaryRoot()
    const archive = runtimeArchive()
    const manifestPath = join(root, 'manifest.json')
    await writeFile(join(root, 'wrong.tar.gz'), archive)
    await writeFile(manifestPath, JSON.stringify(descriptor({ path: 'wrong.tar.gz' }, 'b'.repeat(64), archive.length)))
    await expect(new LocalRuntimeArtifactProvider({ manifestPath }).resolve())
      .rejects.toBeInstanceOf(RuntimeArtifactError)
  })

  it('rejects a compressed archive declaring more than 2 GiB expanded bytes', async () => {
    const root = await temporaryRoot()
    const archive = gzipSync(Buffer.concat([
      tarHeader('huge.bin', 2 * 1024 * 1024 * 1024 + 1, '0', '', 0o600),
      Buffer.alloc(1024),
    ]))
    const sha256 = digest(archive)
    const objectDir = join(root, 'objects')
    await mkdir(objectDir)
    await writeFile(join(objectDir, `${sha256}.tar.gz`), archive)
    const manifestPath = join(root, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify(descriptor({ path: `objects/${sha256}.tar.gz` }, sha256, archive.length)))
    await expect(new LocalRuntimeArtifactProvider({ manifestPath }).resolve())
      .rejects.toMatchObject({ code: 'ARCHIVE_EXPANDED_TOO_LARGE' })
  })
})

type InnerEntry =
  | { readonly type: 'file'; readonly path: string; readonly data: Buffer; readonly mode?: number }
  | { readonly type: 'symlink'; readonly path: string; readonly target: string }

function runtimeArchive(extra: readonly InnerEntry[] = []): Buffer {
  const payload: InnerEntry[] = [
    { type: 'file', path: 'bin/node', data: Buffer.from('node'), mode: 0o755 },
    { type: 'file', path: 'bin/dsh', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
    { type: 'file', path: 'app/proxy-preload.mjs', data: Buffer.from('export {}\n') },
    { type: 'file', path: 'app/package.json', data: Buffer.from('{"type":"module"}\n') },
    ...extra,
  ]
  const inner = {
    formatVersion: 1,
    entries: payload.map(entry => entry.type === 'file'
      ? { type: 'file', path: entry.path, size: entry.data.length, sha256: digest(entry.data) }
      : { type: 'symlink', path: entry.path, target: entry.target }),
  }
  const manifest = Buffer.from(`${JSON.stringify(inner)}\n`)
  const members: InnerEntry[] = [{ type: 'file', path: 'manifest.json', data: manifest }, ...payload]
  const blocks: Buffer[] = []
  for (const member of members) {
    const body = member.type === 'file' ? member.data : Buffer.alloc(0)
    blocks.push(tarHeader(member.path, body.length, member.type === 'symlink' ? '2' : '0',
      member.type === 'symlink' ? member.target : '', member.type === 'file' ? member.mode ?? 0o644 : 0o777))
    blocks.push(body)
    if (body.length % 512 !== 0) blocks.push(Buffer.alloc(512 - body.length % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function tarHeader(path: string, size: number, type: '0' | '2', target: string, mode: number): Buffer {
  const header = Buffer.alloc(512)
  writeText(header, 0, 100, path)
  writeOctal(header, 100, 8, mode)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, 0)
  header.fill(32, 148, 156)
  header[156] = type.charCodeAt(0)
  writeText(header, 157, 100, target)
  writeText(header, 257, 6, 'ustar')
  writeText(header, 263, 2, '00')
  let checksum = 0
  for (const byte of header) checksum += byte
  const checksumText = checksum.toString(8).padStart(6, '0')
  header.write(checksumText, 148, 6, 'ascii')
  header[154] = 0
  header[155] = 32
  return header
}

function writeText(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value)
  if (bytes.length > length) throw new Error('tar test field too long')
  bytes.copy(buffer, offset)
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0')
  buffer.write(text, offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

function descriptor(source: { path?: string; url?: string }, sha256: string, bytes: number) {
  return {
    formatVersion: 1,
    runtimeVersion: 'test-1',
    dshVersion: '0.1.0-rc.8',
    nodeVersion: '22.19.0',
    platform: 'linux',
    arch: 'x64',
    minimumGlibc: '2.28',
    node: 'bin/node',
    launcher: 'bin/dsh',
    archive: { ...source, sha256, bytes },
  }
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-artifact-'))
  roots.push(root)
  return root
}
