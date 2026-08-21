/** Static publication gate that does not recurse into npm pack lifecycle hooks. */
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const expectedRuntimeVersion = '0.1.0'

if (manifest.name !== '@artificialnotimbecile/dsh-remote-runtime') {
  throw new Error('unexpected package name')
}
if (manifest.version !== '0.1.1') throw new Error('unexpected package version')
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('missing DSH bundle patch')
if (manifest.dsh?.client?.platform !== 'web') throw new Error('missing DSH Web client declaration')
if (manifest.bin?.['dsh-remote'] !== 'lib/cli.js') throw new Error('published CLI bin path is not npm-normalized')
if (!manifest.files.includes('scripts/*.mjs')) throw new Error('published package scripts are missing from files')
if (!manifest.files.includes('docs/assets/readme/*')) throw new Error('README product assets are missing from files')

const readmeAssets = [
  'connected-profile.png',
  'credential-configured.png',
  'doctor-install.png',
  'profile-wizard-egress.png',
  'profile-wizard-host.png',
  'remote-runtime-demo.gif',
  'remote-ui-real-deepseek.png',
  'sessions-real-deepseek.png',
  'workspaces.png',
]

const pinned = Object.entries({ ...manifest.peerDependencies, ...manifest.devDependencies })
  .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
for (const [name, version] of pinned) {
  if (version !== '0.1.0-rc.8') throw new Error(`${name} must be pinned to DSH rc.8`)
}

for (const file of [
  'lib/index.js',
  'lib/cli.js',
  'lib/client.js',
  'lib/typert.host.js',
  'lib/typert.remote-client.js',
  'cordis.patch.yml',
  'runtime/manifest.json',
  'runtime/pnpm-lock.yaml',
  'runtime/pnpm-workspace.yaml',
  'scripts/test-dsh-install.mjs',
  'scripts/test-live.mjs',
  ...readmeAssets.map(file => `docs/assets/readme/${file}`),
  'LICENSE',
]) {
  await access(join(root, file))
}

for (const file of readmeAssets) {
  const info = await stat(join(root, 'docs', 'assets', 'readme', file))
  const maximum = file.endsWith('.gif') ? 8 * 1024 * 1024 : 500 * 1024
  if (!info.isFile() || info.size < 1 || info.size > maximum) {
    throw new Error(`README asset is missing or too large: ${file}`)
  }
}

const hostChunks = (await readdir(join(root, 'lib'))).filter(file => /^service-[A-Za-z0-9_-]+\.js$/u.test(file))
if (hostChunks.length !== 1 || !manifest.files.includes('lib/service-*.js')) {
  throw new Error('host bundle chunk is missing from the publication manifest')
}

const remoteClient = await readFile(join(root, 'lib', 'typert.remote-client.js'), 'utf8')
if (!remoteClient.includes('dshRemoteRuntime_installRuntime_') || remoteClient.includes('dshRemoteRuntime_install_')) {
  throw new Error('generated Remote must avoid the client service reserved install method')
}

const runtime = JSON.parse(await readFile(join(root, 'runtime/manifest.json'), 'utf8'))
if (
  runtime.formatVersion !== 1
  || runtime.runtimeVersion !== expectedRuntimeVersion
  || runtime.dshVersion !== '0.1.0-rc.8'
  || runtime.nodeVersion !== '22.19.0'
  || runtime.platform !== 'linux'
  || runtime.arch !== 'x64'
  || runtime.minimumGlibc !== '2.28'
  || runtime.node !== 'node/bin/node'
  || runtime.launcher !== 'bin/dsh'
  || typeof runtime.archive?.url !== 'string'
  || runtime.archive.url !== `https://github.com/ArtificialNotImbecile/dsh-remote-runtime/releases/download/runtime-v${expectedRuntimeVersion}/dsh-remote-runtime-${expectedRuntimeVersion}-linux-x64-glibc.tar.gz`
  || !/^[a-f0-9]{64}$/u.test(runtime.archive.sha256)
  || !Number.isSafeInteger(runtime.archive.bytes)
  || runtime.archive.bytes < 1
) {
  throw new Error('runtime manifest does not match the published package and pinned runtime contract')
}

const source = await Promise.all([
  readFile(join(root, 'cordis.patch.yml'), 'utf8'),
  readFile(join(root, 'README.md'), 'utf8').catch(() => ''),
])
if (source.some(text => /(?:sk-[A-Za-z0-9]{16,}|DEEPSEEK_API_KEY\s*[:=]\s*[^$\s])/u.test(text))) {
  throw new Error('publication files appear to contain a secret')
}

process.stdout.write('package gate passed\n')
