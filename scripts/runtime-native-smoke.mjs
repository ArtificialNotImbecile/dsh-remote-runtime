/** Exercise native dependencies from the extracted Linux runtime. */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const stage = process.argv[2]
if (stage === undefined) throw new Error('usage: runtime-native-smoke.mjs <stage>')
const require = createRequire(pathToFileURL(join(stage, 'app', 'package.json')))

const pty = require('node-pty')
const output = await new Promise((resolve, reject) => {
  const child = pty.spawn('/bin/sh', ['-c', 'printf DSH_REMOTE_PTY_OK'], {
    cols: 80,
    rows: 24,
    cwd: stage,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  })
  let text = ''
  const timer = setTimeout(() => {
    child.kill()
    reject(new Error('node-pty smoke timed out'))
  }, 10_000)
  child.onData(chunk => { text += chunk })
  child.onExit(({ exitCode }) => {
    clearTimeout(timer)
    if (exitCode === 0) resolve(text)
    else reject(new Error(`node-pty exited ${String(exitCode)}`))
  })
})
if (!String(output).includes('DSH_REMOTE_PTY_OK')) throw new Error('node-pty returned the wrong output')

const sharp = require('sharp')
const image = await sharp({
  create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
}).png().toBuffer()
if (image.length < 8 || image.subarray(1, 4).toString('ascii') !== 'PNG') throw new Error('sharp smoke failed')

const koffi = require('koffi')
if (typeof koffi.load !== 'function') throw new Error('koffi smoke failed')

process.stdout.write(`${JSON.stringify({ pty: true, sharp: true, koffi: true })}\n`)
