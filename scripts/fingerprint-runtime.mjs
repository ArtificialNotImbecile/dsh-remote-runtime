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
  createReadStream(path).pipe(gunzip)
  let bytes = 0
  for await (const chunk of gunzip) {
    hash.update(chunk)
    bytes += chunk.length
  }
  return { bytes, sha256: hash.digest('hex') }
}

function sha256Json(value) {
  return sha256Value(JSON.stringify(value))
}

function sha256Value(value) {
  return createHash('sha256').update(value).digest('hex')
}
