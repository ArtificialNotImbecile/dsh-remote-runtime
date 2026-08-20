/** Verify every regular file declared by an extracted managed runtime. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'

const stage = process.argv[2]
if (stage === undefined) throw new Error('usage: verify-runtime-stage.mjs <stage>')
const manifest = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'))
if (manifest.formatVersion !== 1 || !Array.isArray(manifest.entries)) throw new Error('invalid runtime manifest')
for (const file of manifest.entries) {
  if (typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split('/').includes('..')) {
    throw new Error('unsafe runtime manifest path')
  }
  const target = join(stage, ...file.path.split('/'))
  const info = await lstat(target)
  if (file.type === 'symlink') {
    if (!info.isSymbolicLink() || await readlink(target) !== file.target) {
      throw new Error(`runtime symlink mismatch: ${file.path}`)
    }
  } else {
    if (!info.isFile() || info.size !== file.size) throw new Error(`runtime size mismatch: ${file.path}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(target)) hash.update(chunk)
    if (hash.digest('hex') !== file.sha256) throw new Error(`runtime hash mismatch: ${file.path}`)
  }
}
process.stdout.write(`${JSON.stringify({ files: manifest.entries.length, dshVersion: manifest.dshVersion })}\n`)
