/** Write the in-archive manifest after the Linux runtime stage is complete. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const [stage, metadataJson] = process.argv.slice(2)
if (stage === undefined || metadataJson === undefined) {
  throw new Error('usage: finalize-runtime.mjs <stage> <metadata-json>')
}

const metadata = JSON.parse(metadataJson)
const paths = await walk(stage)
const files = []
for (const file of paths) {
  const info = await lstat(file)
  const name = relative(stage, file).split(sep).join('/')
  if (name === 'manifest.json') continue
  if (info.isFile()) {
    files.push({ type: 'file', path: name, size: info.size, sha256: await sha256(file) })
  } else if (info.isSymbolicLink()) {
    const target = await readlink(file)
    const resolved = resolve(join(file, '..'), target)
    if (isAbsolute(target) || (resolved !== stage && !resolved.startsWith(stage + sep))) {
      throw new Error(`unsafe runtime symlink: ${name}`)
    }
    files.push({ type: 'symlink', path: name, target })
  }
}
files.sort((left, right) => left.path.localeCompare(right.path))
await writeFile(join(stage, 'manifest.json'), `${JSON.stringify({
  formatVersion: 1,
  ...metadata,
  entries: files,
})}\n`, { mode: 0o644 })

async function walk(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await walk(target))
    else if (entry.isFile() || entry.isSymbolicLink()) result.push(target)
  }
  return result
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
