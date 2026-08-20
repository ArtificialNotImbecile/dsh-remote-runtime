/** Create a byte-stable USTAR+gzip runtime archive with the pinned builder Node. */
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { constants, createGzip } from 'node:zlib'

const [stageArgument, output] = process.argv.slice(2)
if (stageArgument === undefined || output === undefined) {
  throw new Error('usage: archive-runtime.mjs <stage> <output.tar.gz>')
}

const stage = resolve(stageArgument)
const entries = await walk(stage)
entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))

await pipeline(
  Readable.from(tarChunks(), { objectMode: false }),
  createGzip({
    level: 9,
    strategy: constants.Z_DEFAULT_STRATEGY,
    chunkSize: 64 * 1024,
  }),
  createWriteStream(output, { flags: 'wx', mode: 0o600 }),
)

async function* tarChunks() {
  for (const entry of entries) {
    const info = await lstat(entry.absolute)
    const kind = info.isDirectory() ? 'directory'
      : info.isSymbolicLink() ? 'symlink'
        : info.isFile() ? 'file'
          : undefined
    if (kind === undefined) throw new Error(`unsupported runtime entry: ${entry.path}`)
    const link = kind === 'symlink' ? await readlink(entry.absolute) : ''
    const size = kind === 'file' ? info.size : 0
    const mode = kind === 'directory' ? 0o755 : kind === 'symlink' ? 0o777 : (info.mode & 0o111) === 0 ? 0o644 : 0o755
    yield ustarHeader({ path: entry.path, kind, link, size, mode })

    if (kind !== 'file') continue
    let bytes = 0
    for await (const chunk of createReadStream(entry.absolute, { highWaterMark: 64 * 1024 })) {
      bytes += chunk.length
      yield chunk
    }
    if (bytes !== size) throw new Error(`runtime file changed while archiving: ${entry.path}`)
    const padding = (512 - (size % 512)) % 512
    if (padding !== 0) yield Buffer.alloc(padding)
  }
  yield Buffer.alloc(1_024)
}

async function walk(root) {
  const result = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name)
      const path = relative(root, absolute).split(sep).join('/')
      if (path === '' || path.startsWith('../') || /[\0-\x1f\x7f]/u.test(path)) {
        throw new Error(`unsafe runtime archive path: ${path}`)
      }
      result.push({ absolute, path })
      if (entry.isDirectory()) await visit(absolute)
    }
  }
  await visit(root)
  return result
}

function ustarHeader(entry) {
  const header = Buffer.alloc(512)
  const { name, prefix } = splitUstarPath(entry.path)
  putString(header, 0, 100, name)
  putOctal(header, 100, 8, entry.mode)
  putOctal(header, 108, 8, 0)
  putOctal(header, 116, 8, 0)
  putOctal(header, 124, 12, entry.size)
  putOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  putString(header, 156, 1, entry.kind === 'directory' ? '5' : entry.kind === 'symlink' ? '2' : '0')
  putString(header, 157, 100, entry.link)
  putString(header, 257, 6, 'ustar\0')
  putString(header, 263, 2, '00')
  putOctal(header, 329, 8, 0)
  putOctal(header, 337, 8, 0)
  putString(header, 345, 155, prefix)
  const checksum = header.reduce((total, byte) => total + byte, 0)
  putString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  return header
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`runtime path does not fit USTAR: ${path}`)
}

function putString(header, offset, length, value) {
  const bytes = Buffer.from(value)
  if (bytes.length > length) throw new Error(`USTAR field overflow: ${value}`)
  bytes.copy(header, offset)
}

function putOctal(header, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid USTAR numeric value')
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`
  if (encoded.length !== length) throw new Error(`USTAR numeric field overflow: ${String(value)}`)
  putString(header, offset, length, encoded)
}
