/** Verify the outer archive and every in-archive file, then smoke the DSH launcher. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const descriptor = JSON.parse(await readFile(join(root, 'runtime', 'manifest.json'), 'utf8'))
const artifactName = `dsh-remote-runtime-${descriptor.runtimeVersion}-linux-x64-glibc.tar.gz`
const artifact = join(
  process.env.DSH_REMOTE_RUNTIME_OUTPUT_DIR ?? join(root, 'runtime', 'artifacts'),
  artifactName,
)
const info = await stat(artifact)
if (info.size !== descriptor.archive.bytes) throw new Error('runtime archive size does not match descriptor')
if (await sha256(artifact) !== descriptor.archive.sha256) throw new Error('runtime archive hash does not match descriptor')

const shell = join(dirname(artifact), `verify-runtime-${process.pid}.sh`)
await writeFile(shell, `#!/bin/sh
set -eu
artifact="$1"
verifier="$2"
native_smoke="$3"
work="$(mktemp -d "${'${TMPDIR:-/tmp}'}/dsh-remote-verify.XXXXXX")"
server_pid=""
cleanup() { test -z "$server_pid" || kill "$server_pid" 2>/dev/null || true; rm -rf -- "$work"; }
trap cleanup EXIT INT TERM
tar -xzf "$artifact" -C "$work"
"$work/node/bin/node" "$verifier" "$work"
version=$("$work/bin/dsh" --version)
test "$version" = "${descriptor.dshVersion}"
"$work/node/bin/node" "$native_smoke" "$work"
port=$("$work/node/bin/node" -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
mkdir -p "$work/web-home" "$work/workspace"
previous_dir=$PWD
cd "$work/workspace"
env -u DEEPSEEK_API_KEY DSH_HOME="$work/web-home" DSH_TELEMETRY_DISABLED=1 "$work/bin/dsh" --profile web --no-open --port "$port" >"$work/web.log" 2>&1 &
server_pid=$!
cd "$previous_dir"
ready=no
for _ in $(seq 1 150); do
  if curl -fsS "http://127.0.0.1:$port/" >/dev/null 2>&1; then ready=yes; break; fi
  kill -0 "$server_pid" 2>/dev/null || break
  sleep 0.2
done
test "$ready" = yes
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=""
`, { mode: 0o700 })
try {
  if (process.platform === 'linux') {
    run('sh', [shell, artifact, join(root, 'scripts', 'verify-runtime-stage.mjs'), join(root, 'scripts', 'runtime-native-smoke.mjs')])
  } else if (process.platform === 'win32') {
    run('wsl.exe', ['--exec', 'env', '-i', 'HOME=/tmp',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      '/bin/sh', toWslPath(shell), toWslPath(artifact), toWslPath(join(root, 'scripts', 'verify-runtime-stage.mjs')), toWslPath(join(root, 'scripts', 'runtime-native-smoke.mjs'))])
  } else {
    throw new Error('runtime:verify requires Linux, or WSL when invoked on Windows')
  }
} finally {
  await rm(shell, { force: true })
}
process.stdout.write(`${JSON.stringify({ artifact, sha256: descriptor.archive.sha256, size: info.size })}\n`)

function toWslPath(path) {
  const result = spawnSync('wsl.exe', ['--exec', 'wslpath', '-a', path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`wslpath failed: ${result.stderr}`)
  return result.stdout.trim()
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`)
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
