/** Build the content-addressed Linux x64 managed DSH runtime. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const RUNTIME_VERSION = '0.1.0'
const DSH_VERSION = '0.1.0-rc.8'
const NODE_VERSION = '22.19.0'
const NODE_FLAVOR = 'linux-x64'
const NODE_FILE = `node-v${NODE_VERSION}-${NODE_FLAVOR}.tar.xz`
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_FILE}`
const NODE_SHA256 = 'c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2'
const BUILDER_NODE_FILE = `node-v${NODE_VERSION}-linux-x64-glibc-217.tar.xz`
const BUILDER_NODE_URL = `https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/${BUILDER_NODE_FILE}`
const BUILDER_NODE_SHA256 = '1964c6cbeb345474f3b7ada6688d4b2674520bc0d2fe12933bc835f980aaf5b4'
const ARTIFACT_FILE = `dsh-remote-runtime-${RUNTIME_VERSION}-linux-x64-glibc.tar.gz`
const ARTIFACT_URL = `https://github.com/ArtificialNotImbecile/dsh-remote-runtime/releases/download/runtime-v${RUNTIME_VERSION}/${ARTIFACT_FILE}`

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outputRoot = resolve(process.env.DSH_REMOTE_RUNTIME_OUTPUT_DIR ?? join(root, 'runtime', 'artifacts'))
const cacheRoot = join(outputRoot, 'cache')
const nodeArchive = resolve(process.env.DSH_REMOTE_NODE_ARCHIVE ?? join(cacheRoot, NODE_FILE))
const builderNodeArchive = process.platform === 'win32'
  ? resolve(process.env.DSH_REMOTE_BUILDER_NODE_ARCHIVE ?? join(cacheRoot, BUILDER_NODE_FILE))
  : nodeArchive
const artifact = join(outputRoot, ARTIFACT_FILE)
const lockPath = join(root, 'runtime', 'pnpm-lock.yaml')
const workspacePath = join(root, 'runtime', 'pnpm-workspace.yaml')

await mkdir(cacheRoot, { recursive: true })
await ensureArchive(nodeArchive, NODE_URL, NODE_SHA256, 'Node runtime')
if (builderNodeArchive !== nodeArchive) {
  await ensureArchive(builderNodeArchive, BUILDER_NODE_URL, BUILDER_NODE_SHA256, 'Node builder')
}
await access(lockPath)

const dependencyLockSha256 = await sha256(lockPath)
const metadata = JSON.stringify({
  runtimeVersion: RUNTIME_VERSION,
  dshVersion: DSH_VERSION,
  nodeVersion: NODE_VERSION,
  nodeFlavor: NODE_FLAVOR,
  dependencyLockSha256,
  platform: 'linux',
  arch: 'x64',
  minimumGlibc: '2.28',
})

const shellScript = join(outputRoot, `build-runtime-${process.pid}.sh`)
const script = `#!/bin/sh
set -eu
node_archive="$1"
builder_node_archive="$2"
package_json="$3"
dependency_lock="$4"
workspace_config="$5"
finalizer="$6"
archiver="$7"
artifact="$8"
metadata="$9"
artifact_temporary="${'${artifact}'}.build-$$"
work="$(mktemp -d "${'${TMPDIR:-/tmp}'}/dsh-remote-runtime.XXXXXX")"
cleanup() { rm -rf -- "$work"; rm -f -- "$artifact_temporary"; }
trap cleanup EXIT INT TERM
mkdir -p "$work/unpack" "$work/stage/app" "$work/stage/bin"
tar -xJf "$node_archive" -C "$work/unpack"
mv "$work/unpack/node-v${NODE_VERSION}-${NODE_FLAVOR}" "$work/stage/node"
mkdir -p "$work/builder-unpack"
tar -xJf "$builder_node_archive" -C "$work/builder-unpack"
builder_dir=$(find "$work/builder-unpack" -mindepth 1 -maxdepth 1 -type d -print -quit)
test -n "$builder_dir"
mv "$builder_dir" "$work/builder"
cp "$package_json" "$work/stage/app/package.json"
cp "$dependency_lock" "$work/stage/app/pnpm-lock.yaml"
cp "$workspace_config" "$work/stage/app/pnpm-workspace.yaml"
chmod 644 "$work/stage/app/package.json" "$work/stage/app/pnpm-lock.yaml" "$work/stage/app/pnpm-workspace.yaml"
PATH="$work/builder/bin:$PATH"
export PATH
LC_ALL=C
export LC_ALL
COREPACK_HOME="$work/corepack"
export COREPACK_HOME
"$work/builder/bin/corepack" pnpm@11.7.0 --dir "$work/stage/app" install \\
  --prod --frozen-lockfile --store-dir "$work/pnpm-store"
# Type declarations and source maps are not runtime inputs. Removing them also
# keeps every remaining path representable by deterministic USTAR.
for pattern in '*.d.ts' '*.d.ts.map' '*.d.mts' '*.d.cts' '*.js.map' '*.cjs.map' '*.mjs.map'; do
  find "$work/stage/app/node_modules" -type f -name "$pattern" -delete
done
rm -f -- \\
  "$work/stage/app/node_modules/.modules.yaml" \\
  "$work/stage/app/node_modules/.pnpm-workspace-state-v1.json"
if grep -R -I -F -l -- "$work" "$work/stage" >/dev/null 2>&1; then
  echo 'runtime stage contains a nondeterministic build path' >&2
  exit 1
fi
cat > "$work/stage/app/proxy-preload.mjs" <<'EOF'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
setGlobalDispatcher(new EnvHttpProxyAgent())
EOF
cat > "$work/stage/bin/dsh" <<'EOF'
#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$root/node/bin/node" "$root/app/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"
EOF
chmod 755 "$work/stage/bin/dsh" "$work/stage/node/bin/node"
find "$work/stage" -depth -type d -empty -delete
"$work/builder/bin/node" "$work/stage/app/node_modules/@deepseek-ai/dsh/lib/bin.js" --version >/dev/null
"$work/builder/bin/node" "$finalizer" "$work/stage" "$metadata"
"$work/builder/bin/node" "$archiver" "$work/stage" "$artifact_temporary"
mv -f -- "$artifact_temporary" "$artifact"
`
await writeFile(shellScript, script, { mode: 0o700 })
try {
  if (process.platform === 'linux') {
    run('sh', [shellScript, nodeArchive, builderNodeArchive, join(root, 'runtime', 'package.json'), lockPath, workspacePath,
      join(root, 'scripts', 'finalize-runtime.mjs'), join(root, 'scripts', 'archive-runtime.mjs'), artifact, metadata])
  } else if (process.platform === 'win32') {
    const paths = [shellScript, nodeArchive, builderNodeArchive, join(root, 'runtime', 'package.json'), lockPath, workspacePath,
      join(root, 'scripts', 'finalize-runtime.mjs'), join(root, 'scripts', 'archive-runtime.mjs'), artifact]
    const converted = paths.map(toWslPath)
    run('wsl.exe', ['--exec', 'env',
      'HOME=/tmp',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      '/bin/sh', converted[0], ...converted.slice(1), metadata], wslEnvironment())
  } else {
    throw new Error('runtime:build requires Linux, or WSL when invoked on Windows')
  }
} finally {
  await rm(shellScript, { force: true })
}

const artifactInfo = await stat(artifact)
const artifactSha256 = await sha256(artifact)
const descriptorPath = join(root, 'runtime', 'manifest.json')
const descriptorTemporary = `${descriptorPath}.${process.pid}.tmp`
await writeFile(descriptorTemporary, `${JSON.stringify({
  formatVersion: 1,
  runtimeVersion: RUNTIME_VERSION,
  dshVersion: DSH_VERSION,
  nodeVersion: NODE_VERSION,
  platform: 'linux',
  arch: 'x64',
  minimumGlibc: '2.28',
  node: 'node/bin/node',
  launcher: 'bin/dsh',
  archive: {
    url: ARTIFACT_URL,
    sha256: artifactSha256,
    bytes: artifactInfo.size,
  },
}, null, 2)}\n`)
await rename(descriptorTemporary, descriptorPath)
await writeFile(
  join(outputRoot, 'SHA256SUMS.txt'),
  `${artifactSha256}  ${ARTIFACT_FILE}\n`,
)
process.stdout.write(`${JSON.stringify({ artifact, artifactSha256, size: artifactInfo.size })}\n`)

async function ensureArchive(target, url, expectedSha256, label) {
  if (await matchesHash(target, expectedSha256)) return
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.download-${process.pid}.tmp`
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl'
  try {
    let status = runStatus(curl, ['--fail', '--location', '--continue-at', '-', '--output', temporary, url])
    if (status !== 0 || !await matchesHash(temporary, expectedSha256)) {
      await rm(temporary, { force: true })
      status = runStatus(curl, ['--fail', '--location', '--output', temporary, url])
    }
    if (status !== 0 || !await matchesHash(temporary, expectedSha256)) {
      throw new Error(`${label} archive failed SHA-256 verification: ${target}`)
    }
    await rm(target, { force: true })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function toWslPath(path) {
  const result = spawnSync('wsl.exe', ['--exec', 'wslpath', '-a', path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`wslpath failed for ${path}: ${result.stderr}`)
  return result.stdout.trim()
}

function wslEnvironment() {
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']
    .filter(name => process.env[name] !== undefined && process.env[name] !== '')
  const inherited = (process.env.WSLENV ?? '').split(':').filter(Boolean)
  return { ...process.env, WSLENV: [...new Set([...inherited, ...names])].join(':') }
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`)
}

function runStatus(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env })
  if (result.error !== undefined) throw result.error
  return result.status ?? 1
}

async function matchesHash(path, expected) {
  try { return await sha256(path) === expected } catch { return false }
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
