/** Pack, install, compose, and boot this plugin in an isolated official DSH rc.8 Web profile. */
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), 'dsh-remote-runtime-install-'))
const home = join(temporary, 'home')
const port = await freePort()
let server

try {
  const tarball = process.env.DSH_PLUGIN_TARBALL === undefined
    ? pack(temporary)
    : resolve(process.env.DSH_PLUGIN_TARBALL)
  const command = dshCommand()
  const environment = {
    ...process.env,
    DSH_HOME: home,
    DEEPSEEK_API_KEY: '',
    DSH_TELEMETRY_DISABLED: '1',
  }
  run(command, ['plugin', '--profile', 'web', 'add', tarball], environment)
  const dump = run(command, ['--profile', 'web', '--dump-config'], environment, true)
  if (!dump.includes('@artificialnotimbecile/dsh-remote-runtime')) {
    throw new Error('assembled DSH config does not contain the plugin')
  }

  server = spawn(command.executable, [...command.prefix, '--profile', 'web', '--no-open', '--port', String(port)], {
    cwd: root,
    env: environment,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const diagnostics = boundedOutput(server)
  await waitForHttp(`http://127.0.0.1:${String(port)}/`, 45_000)
  process.stdout.write(`${JSON.stringify({ installed: true, dshVersion: '0.1.0-rc.8', port, diagnostics: diagnostics.summary() })}\n`)
} finally {
  if (server !== undefined && server.exitCode === null) {
    terminateTree(server)
    await Promise.race([once(server, 'close'), delay(5_000)]).catch(() => undefined)
  }
  await rm(temporary, { recursive: true, force: true })
}

function dshCommand() {
  const source = process.env.DSH_SOURCE_ROOT
  if (source !== undefined && source !== '') {
    return { executable: process.execPath, prefix: [join(resolve(source), 'apps', 'cli', 'lib', 'bin.js')] }
  }
  const installedCli = process.env.DSH_CLI_PATH
  if (installedCli !== undefined && installedCli !== '') {
    const entry = resolve(installedCli)
    if (!existsSync(entry)) throw new Error(`DSH_CLI_PATH does not exist: ${entry}`)
    return { executable: process.execPath, prefix: [entry] }
  }
  return process.platform === 'win32'
    ? { executable: process.execPath, prefix: [resolveNpmCli(), 'exec', '--yes', '--package=@deepseek-ai/dsh@0.1.0-rc.8', '--', 'dsh'] }
    : { executable: process.execPath, prefix: [resolveNpmCli(), 'exec', '--yes', '--package=@deepseek-ai/dsh@0.1.0-rc.8', '--', 'dsh'] }
}

function pack(destination) {
  const result = spawnSync(process.execPath, [resolveNpmCli(), 'pack', '--ignore-scripts', '--pack-destination', destination], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error('npm pack failed')
  const name = readdirSync(destination).filter(value => value.endsWith('.tgz')).sort().at(-1)
  if (name === undefined) throw new Error('npm pack produced no tarball')
  return join(destination, name)
}

function resolveNpmCli() {
  const locator = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'npm.cmd' : 'npm'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (locator.error !== undefined) throw locator.error
  const executable = locator.stdout.split(/\r?\n/u).find(Boolean)
  if (executable === undefined) throw new Error('npm is not available on PATH')
  const candidate = process.platform === 'win32'
    ? join(dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : realpathSync(executable)
  if (!existsSync(candidate)) throw new Error('npm CLI entrypoint could not be resolved')
  return candidate
}

function terminateTree(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
}

function run(command, args, env, capture = false) {
  const result = spawnSync(command.executable, [...command.prefix, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
    stdio: capture ? 'pipe' : ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`DSH command failed with status ${String(result.status)}`)
  return result.stdout ?? ''
}

function boundedOutput(child) {
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout = `${stdout}${String(chunk)}`.slice(-4_096) })
  child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4_096) })
  return { summary: () => ({ stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) }) }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The server has not opened its loopback listener yet.
    }
    await delay(200)
  }
  throw new Error('timed out waiting for the isolated DSH Web profile')
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const listener = createServer()
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address()
      const value = typeof address === 'object' && address !== null ? address.port : undefined
      listener.close(error => error === undefined && value !== undefined ? resolvePort(value) : reject(error ?? new Error('port allocation failed')))
    })
  })
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}
