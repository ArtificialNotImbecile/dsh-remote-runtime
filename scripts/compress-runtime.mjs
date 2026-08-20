/** Compress a deterministic USTAR stream with the pinned builder Node/zlib. */
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { constants, createGzip } from 'node:zlib'

const [input, output] = process.argv.slice(2)
if (input === undefined || output === undefined) {
  throw new Error('usage: compress-runtime.mjs <input.tar> <output.tar.gz>')
}

await pipeline(
  createReadStream(input, { highWaterMark: 64 * 1024 }),
  createGzip({
    level: 9,
    strategy: constants.Z_DEFAULT_STRATEGY,
    chunkSize: 64 * 1024,
  }),
  createWriteStream(output, { flags: 'wx', mode: 0o600 }),
)
