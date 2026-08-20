import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ManagedRuntimeArtifact, RuntimeArtifactManifest, RuntimeArtifactProvider } from '../src/artifact.ts'
import { RemoteRuntimeError } from '../src/errors.ts'
import {
  RemoteRuntimeController,
  type RuntimeClientProxyPort,
  type RuntimeSshPort,
  type RuntimeTunnelPort,
} from '../src/runtime.ts'
import type { RemoteProbe, SshCommandResult } from '../src/ssh.ts'
import type { ManagedSshTunnel } from '../src/tunnel.ts'
import type { RemoteProfile } from '../src/types.ts'

describe('remote runtime controller', () => {
  it('Doctor reads only the small descriptor and enforces Bash plus glibc 2.28', async () => {
    const ssh = new FakeSsh()
    const artifacts = new FakeArtifacts()
    const controller = makeController(ssh, artifacts)
    const report = await controller.doctor(profile(), new AbortController().signal)
    expect(report.ready).toBe(true)
    expect(report.runtimeInstalled).toBe(false)
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bash', status: 'pass' }),
      expect.objectContaining({ id: 'glibc', status: 'pass' }),
      expect.objectContaining({ id: 'gnu-find', status: 'pass' }),
      expect.objectContaining({ id: 'sha256sum-check', status: 'pass' }),
      expect.objectContaining({ id: 'runtime-installed', status: 'warning' }),
    ]))
    expect(artifacts.describe).toHaveBeenCalledTimes(1)
    expect(artifacts.resolve).not.toHaveBeenCalled()
    expect(ssh.uploads).toHaveLength(0)
  })

  it.each([
    ['musl 1.2.4', true, 'glibc'],
    ['glibc 2.17', true, 'glibc'],
    ['glibc 2.36', false, 'bash'],
  ])('fails Doctor for unsupported libc or missing Bash: %s', async (libc, bash, failedId) => {
    const ssh = new FakeSsh({ libc, bash })
    const controller = makeController(ssh, new FakeArtifacts())
    const report = await controller.doctor(profile(), new AbortController().signal)
    expect(report.ready).toBe(false)
    expect(report.checks).toContainEqual(expect.objectContaining({ id: failedId, status: 'fail' }))
  })

  it('streams the large archive and verifies both fresh and pre-existing runtime directories', async () => {
    const ssh = new FakeSsh()
    const artifacts = new FakeArtifacts()
    const controller = makeController(ssh, artifacts)
    const result = await controller.install(profile(), new AbortController().signal)
    expect(result).toMatchObject({ installed: true, dshVersion: '0.1.0-rc.8' })
    expect(ssh.uploadFiles).toEqual([expect.objectContaining({ localPath: 'C:/cache/runtime.tar.gz' })])
    const verification = ssh.commands.find(call => call.command === 'bash -s')?.input
    expect(verification).toContain('mkdir -- "$lock"')
    expect(verification).toContain('candidate=$runtime')
    expect(verification).toContain('sha256sum --check --strict')
    expect(verification).not.toContain('if test -d "$runtime"; then exit 0')
    expect(verification).not.toContain('rm -f -- "$expected"')
    expect(ssh.uploads.some(upload => upload.path.endsWith('runtime.json'))).toBe(true)
  })

  it('uses one remote hash lock across concurrent profile installs', async () => {
    const ssh = new FakeSsh()
    const controller = makeController(ssh, new FakeArtifacts())
    await Promise.all([
      controller.install(profile('profile-1'), new AbortController().signal),
      controller.install(profile('profile-2'), new AbortController().signal),
    ])
    const scripts = ssh.commands.filter(call => call.command === 'bash -s').map(call => call.input ?? '')
    expect(scripts).toHaveLength(2)
    for (const script of scripts) {
      expect(script).toContain('lock="$runtime.lock"')
      expect(script).toContain('until mkdir -- "$lock"')
      expect(script.indexOf('until mkdir -- "$lock"')).toBeLessThan(script.indexOf('candidate=$runtime'))
    }
  })

  it('quarantines and rebuilds a corrupt existing runtime only when no process owns it', async () => {
    const ssh = new FakeSsh()
    let verificationAttempts = 0
    ssh.runHook = (command, input) => {
      if (command !== 'bash -s') return undefined
      if (input?.includes('quarantine="$runtime.corrupt-')) return result(0)
      if (input?.includes('sha256sum --check --strict')) {
        verificationAttempts += 1
        return result(verificationAttempts === 1 ? 1 : 0)
      }
      return undefined
    }
    const controller = makeController(ssh, new FakeArtifacts())
    await expect(controller.install(profile(), new AbortController().signal)).resolves.toMatchObject({ installed: true })
    const quarantine = ssh.commands.find(call => call.input?.includes('quarantine="$runtime.corrupt-'))?.input ?? ''
    expect(quarantine).toContain('/proc/[0-9]*/exe')
    expect(quarantine).toContain('mv -- "$runtime" "$quarantine"')
    expect(verificationAttempts).toBe(2)
  })

  it('does not quarantine a corrupt runtime that a process still owns', async () => {
    const ssh = new FakeSsh()
    ssh.runHook = (command, input) => command === 'bash -s'
      ? result(input?.includes('quarantine="$runtime.corrupt-') ? 70 : 1)
      : undefined
    const controller = makeController(ssh, new FakeArtifacts())
    await expect(controller.install(profile(), new AbortController().signal))
      .rejects.toMatchObject({ code: 'runtime-corrupt-in-use' })
  })

  it('fails closed on a stale/reused PID and never reaches its kill branch', async () => {
    const ssh = new FakeSsh()
    ssh.runtimeReference = runtimeReference()
    ssh.runHook = command => command.includes('/proc/$pid/environ')
      ? result(47)
      : undefined
    const controller = makeController(ssh, new FakeArtifacts())
    await expect(controller.stop(profile(), new AbortController().signal)).resolves.toEqual({ changed: false })
    const ownershipCommand = ssh.commands.find(call => call.command.includes('/proc/$pid/environ'))?.command ?? ''
    expect(ownershipCommand.indexOf('grep -Fqx')).toBeGreaterThanOrEqual(0)
    expect(ownershipCommand.indexOf('grep -Fqx')).toBeLessThan(ownershipCommand.indexOf('then kill "$pid"'))
    expect(ownershipCommand.match(/DSH_REMOTE_RUN_TOKEN=\$token/gu)).toHaveLength(2)
    expect(ownershipCommand).not.toContain('kill -9')
    expect(ownershipCommand.lastIndexOf('DSH_REMOTE_RUN_TOKEN=$token')).toBeLessThan(ownershipCommand.lastIndexOf('exit 50'))
  })

  it('uses a remote profile lifecycle lock around process publication', async () => {
    const ssh = new FakeSsh()
    ssh.runtimeReference = runtimeReference()
    ssh.runHook = command => command.includes('test -f "$state"') ? result(44) : undefined
    const controller = makeController(ssh, new FakeArtifacts(), new ImmediateTunnels(), undefined, apiDescriptionFetch())

    await controller.start(profile(), { profileId: 'profile-1' }, new AbortController().signal)

    const acquire = ssh.commands.find(call => call.command.includes('lifecycle.lock') && call.command.includes('until mkdir'))?.command ?? ''
    const release = ssh.commands.find(call => call.command.includes('lifecycle.lock') && call.command.includes('s/^token='))?.command ?? ''
    const launchIndex = ssh.commands.findIndex(call => call.command.includes('nohup env'))
    expect(acquire).toContain('until mkdir -- "$lock"')
    expect(release).toContain('rm -rf -- "$lock"')
    expect(ssh.commands.findIndex(call => call.command === acquire)).toBeLessThan(launchIndex)
    expect(ssh.commands.findIndex(call => call.command === release)).toBeGreaterThan(launchIndex)
    await controller.close()
  })

  it('reclaims ownerless lifecycle locks and token-releases an acquisition cancelled after SSH returns', async () => {
    const ssh = new FakeSsh()
    ssh.runtimeReference = runtimeReference()
    const abort = new AbortController()
    ssh.runHook = command => {
      if (command.includes('lifecycle.lock') && command.includes('until mkdir')) {
        abort.abort(new Error('cancel after lock acquisition'))
        return result(0)
      }
      return command.includes('test -f "$state"') ? result(44) : undefined
    }
    const controller = makeController(ssh, new FakeArtifacts(), new ImmediateTunnels(), undefined, apiDescriptionFetch())

    await expect(controller.start(profile(), { profileId: 'profile-1' }, abort.signal)).rejects.toBeDefined()

    const acquire = ssh.commands.find(call => call.command.includes('lifecycle.lock') && call.command.includes('until mkdir'))?.command ?? ''
    const release = ssh.commands.find(call => call.command.includes('lifecycle.lock') && call.command.includes('s/^token='))?.command ?? ''
    expect(acquire).toContain('date -r "$lock"')
    expect(acquire).toContain('test $((now-lock_time)) -gt 30')
    expect(release).toContain('rm -rf -- "$lock"')
    await controller.close()
  })

  it('refuses to start a tampered pre-existing runtime before opening a tunnel', async () => {
    const ssh = new FakeSsh()
    ssh.runtimeReference = runtimeReference()
    ssh.runHook = (command, input) => command === 'bash -s' && input?.includes('sha256sum --check --strict')
      ? result(1, '', 'checksum mismatch')
      : undefined
    const tunnels = new ImmediateTunnels()
    const controller = makeController(ssh, new FakeArtifacts(), tunnels)
    await expect(controller.start(profile(), { profileId: 'profile-1' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'remote-command-failed' })
    expect(tunnels.lastOptions).toBeUndefined()
    expect(ssh.commands.some(call => call.command.includes('nohup env'))).toBe(false)
  })

  it('aborts and drains an in-flight start before closing tunnels', async () => {
    const ssh = new FakeSsh()
    ssh.runtimeReference = runtimeReference()
    ssh.runHook = command => command.includes('printf "%s %s') ? result(0, '321 41000\n') : undefined
    const tunnels = new DeferredTunnels()
    const controller = makeController(ssh, new FakeArtifacts(), tunnels)
    const starting = controller.start(profile(), { profileId: 'profile-1' }, new AbortController().signal)
    await tunnels.entered
    let closed = false
    const closing = controller.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    tunnels.release()
    await expect(starting).rejects.toBeDefined()
    await closing
    expect(tunnels.close).toHaveBeenCalledTimes(1)
    expect(controller.listStatuses().some(status => status.state === 'connected')).toBe(false)
  })

  it('keeps proxy credentials out of argv/status and hardens all proxy environment names', async () => {
    const ssh = new FakeSsh()
    ssh.layoutRoot = '/remote root'
    ssh.runtimeReference = runtimeReference('/remote root')
    ssh.runHook = command => command.includes('test -f "$state"') ? result(44) : undefined
    const proxyUrl = 'http://dsh:super-secret-token@127.0.0.1:45000/'
    const proxy: RuntimeClientProxyPort = {
      open: vi.fn(async () => ({
        localHost: '127.0.0.1' as const,
        localPort: 46000,
        remotePort: 45000,
        proxyUrl,
        close: vi.fn(async () => undefined),
      })),
    }
    const tunnels = new ImmediateTunnels()
    const controller = makeController(ssh, new FakeArtifacts(), tunnels, proxy, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { rpcId: string }
      return Response.json({
        type: 'server-response', rpcId: body.rpcId,
        result: { ok: true, value: {
          version: '0.1.0-rc.8', cwd: '/work', attachedSessions: 0, home: '/home/test', canOpenPath: false,
        } },
      })
    })
    const connected = await controller.start(clientProxyProfile(), { profileId: 'profile-1' }, new AbortController().signal)
    const launch = ssh.commands.find(call => call.command.includes('nohup env'))?.command ?? ''
    expect(launch).toContain('NODE_OPTIONS=')
    expect(launch).toContain('proxy-preload.mjs')
    expect(launch).toContain('file:///remote%20root/runtimes/')
    expect(launch).toContain('http_proxy="$DSH_REMOTE_PROXY_URL"')
    expect(launch).toContain('https_proxy="$DSH_REMOTE_PROXY_URL"')
    expect(launch).toContain("NO_PROXY='direct.example.test'")
    expect(launch).toContain("no_proxy='direct.example.test'")
    expect(launch).toContain('unset ALL_PROXY all_proxy')
    expect(launch).not.toContain('super-secret-token')
    expect(JSON.stringify(connected)).not.toContain('super-secret-token')
    expect(ssh.uploads.find(upload => upload.path.endsWith('/proxy-url'))?.data).toContain('super-secret-token')
    expect(tunnels.lastOptions?.reverseForwards).toEqual([{
      remoteHost: '127.0.0.1', remotePort: 45000, localHost: '127.0.0.1', localPort: 46000,
    }])
    await controller.close()
  })

  it('restores connected status after an automatic tunnel reconnect', async () => {
    const ssh = new FakeSsh()
    ssh.runtimeReference = runtimeReference()
    ssh.runHook = command => command.includes('printf "%s %s') ? result(0, '321 41000\n') : undefined
    const tunnels = new ImmediateTunnels()
    const controller = makeController(ssh, new FakeArtifacts(), tunnels, undefined, apiDescriptionFetch())
    await controller.start(profile(), { profileId: 'profile-1' }, new AbortController().signal)
    tunnels.lastOptions?.onStateChange?.('reconnecting')
    expect(controller.listStatuses()[0]).toMatchObject({ state: 'starting', runtime: { installed: true } })
    tunnels.lastOptions?.onStateChange?.('open')
    expect(controller.listStatuses()[0]).toMatchObject({
      state: 'connected', localUrl: 'http://127.0.0.1:42000', remotePort: 41000,
      runtime: { installed: true },
    })
    await controller.close()
  })

  it('removes the write-only credential payload when cancellation lands after upload', async () => {
    const ssh = new FakeSsh()
    ssh.runtimeReference = runtimeReference()
    const abort = new AbortController()
    ssh.uploadHook = path => {
      if (path.includes('/credential-')) abort.abort(new Error('cancel after upload'))
    }
    const controller = makeController(ssh, new FakeArtifacts())
    await expect(controller.importCredential(profile(), {
      profileId: 'profile-1', apiKey: 'sk-do-not-return-this-value',
    }, abort.signal)).rejects.toBeDefined()
    const cleanup = ssh.commands.find(call => call.command.startsWith('rm -f --') && call.command.includes('/credential-'))
    expect(cleanup).toBeDefined()
    expect(JSON.stringify(cleanup)).not.toContain('sk-do-not-return-this-value')
  })

  it('rejects base URLs carrying query credentials before remote mutation', async () => {
    const ssh = new FakeSsh()
    const controller = makeController(ssh, new FakeArtifacts())
    await expect(controller.importCredential(profile(), {
      profileId: 'profile-1', apiKey: 'sk-safe-input-value', baseUrl: 'https://api.example.test/v1?api_key=leak',
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'base-url-invalid' })
    expect(ssh.uploads).toHaveLength(0)
  })
})

class FakeArtifacts implements RuntimeArtifactProvider {
  readonly describe = vi.fn(async (): Promise<RuntimeArtifactManifest> => descriptor())
  readonly resolve = vi.fn(async (): Promise<ManagedRuntimeArtifact> => artifact())
}

class FakeSsh implements RuntimeSshPort {
  readonly commands: { command: string; input?: string }[] = []
  readonly uploads: { path: string; data: string }[] = []
  readonly uploadFiles: { localPath: string; remotePath: string }[] = []
  runtimeReference: object | undefined
  layoutRoot = '/remote'
  runHook?: (command: string, input?: string) => SshCommandResult | undefined
  uploadHook?: (path: string) => void
  private readonly probeValue: RemoteProbe

  constructor(probe: Partial<RemoteProbe> = {}) {
    this.probeValue = {
      platform: 'Linux', arch: 'x86_64', libc: 'glibc 2.36', homeWritable: true,
      tar: true, sha256sum: true, bash: true, ...probe,
    }
  }

  async probe(): Promise<RemoteProbe> { return this.probeValue }

  async run(profile: RemoteProfile, command: string, input?: string | Uint8Array): Promise<SshCommandResult> {
    this.commands.push({ command, ...(typeof input === 'string' ? { input } : {}) })
    const hooked = this.runHook?.(command, typeof input === 'string' ? input : undefined)
    if (hooked !== undefined) return hooked
    if (command === 'sh -s' && typeof input === 'string' && input.includes('DSH_REMOTE_TOOLS/1')) {
      return result(0, 'DSH_REMOTE_TOOLS/1|yes|yes|yes|yes|yes|yes\n')
    }
    if (command.includes('printf "%s\n%s\n%s\n"')) {
      return result(0, `${this.layoutRoot}\n${this.layoutRoot}/profiles/${profile.id}\n/home/test\n`)
    }
    if (command.includes('while ! test -e')) return result(0)
    if (command.startsWith('test -f ') && command.includes('/runtime.json')) {
      return result(this.runtimeReference === undefined ? 1 : 0)
    }
    if (command.includes('test -f "$object"')) return result(44)
    if (command.includes('test -f "$state"')) return result(44)
    return result(0)
  }

  async upload(_profile: RemoteProfile, path: string, data: string | Uint8Array) {
    this.uploads.push({ path, data: typeof data === 'string' ? data : Buffer.from(data).toString('utf8') })
    this.uploadHook?.(path)
    return { path, bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength }
  }

  async uploadFile(_profile: RemoteProfile, localPath: string, remotePath: string) {
    this.uploadFiles.push({ localPath, remotePath })
    return { path: remotePath, bytes: 100 }
  }

  async download(): Promise<Buffer> {
    if (this.runtimeReference === undefined) {
      throw new RemoteRuntimeError('missing', 'missing', { phase: 'runtime' })
    }
    return Buffer.from(JSON.stringify(this.runtimeReference))
  }
}

class ImmediateTunnels implements RuntimeTunnelPort {
  readonly stop = vi.fn(async () => undefined)
  readonly close = vi.fn(async () => undefined)
  lastOptions: Parameters<RuntimeTunnelPort['start']>[1] | undefined
  private handle: ManagedSshTunnel | undefined

  async start(_profile: RemoteProfile, options: Parameters<RuntimeTunnelPort['start']>[1]): Promise<ManagedSshTunnel> {
    this.lastOptions = options
    this.handle = tunnelHandle(options.localPort, options.remotePort)
    return this.handle
  }

  get(): ManagedSshTunnel | undefined { return this.handle }
}

class DeferredTunnels extends ImmediateTunnels {
  private resolveEntered!: () => void
  private resolveStart!: () => void
  readonly entered = new Promise<void>(resolve => { this.resolveEntered = resolve })
  private readonly gate = new Promise<void>(resolve => { this.resolveStart = resolve })

  override async start(_profile: RemoteProfile, options: Parameters<RuntimeTunnelPort['start']>[1]): Promise<ManagedSshTunnel> {
    this.lastOptions = options
    this.resolveEntered()
    await this.gate
    return tunnelHandle(options.localPort, options.remotePort)
  }

  release(): void { this.resolveStart() }
}

function makeController(
  ssh: FakeSsh,
  artifacts: RuntimeArtifactProvider,
  tunnels: RuntimeTunnelPort = new ImmediateTunnels(),
  clientProxy?: RuntimeClientProxyPort,
  apiFetch?: typeof fetch,
): RemoteRuntimeController {
  return new RemoteRuntimeController({
    ssh,
    tunnels,
    artifacts,
    ...(clientProxy === undefined ? {} : { clientProxy }),
    ...(apiFetch === undefined ? {} : { apiFetch }),
    commandTimeoutMs: 1_000,
    maxTranscriptBytes: 1024 * 1024,
    allocateLocalPort: async () => 42000,
    allocateRemotePort: () => 41000,
  })
}

function profile(id = 'profile-1'): RemoteProfile {
  return {
    version: 1,
    id,
    name: 'remote',
    sshHost: 'host',
    network: { mode: 'remote-direct', clientProxy: { allowedPorts: [80, 443], noProxy: [] } },
    workspaces: [],
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  }
}

function clientProxyProfile(): RemoteProfile {
  return {
    ...profile(),
    network: {
      mode: 'client-proxy',
      clientProxy: { allowedPorts: [80, 443], noProxy: ['direct.example.test'] },
    },
  }
}

function descriptor(): RuntimeArtifactManifest {
  return {
    formatVersion: 1,
    runtimeVersion: 'test-1',
    dshVersion: '0.1.0-rc.8',
    nodeVersion: '22.19.0',
    platform: 'linux',
    arch: 'x64',
    minimumGlibc: '2.28',
    node: 'bin/node',
    launcher: 'bin/dsh',
    archive: { url: 'https://example.test/runtime.tar.gz', sha256: 'a'.repeat(64), bytes: 100 },
  }
}

function artifact(): ManagedRuntimeArtifact {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const files = [
    ['manifest.json', '{}'], ['bin/node', 'node'], ['bin/dsh', 'dsh'],
    ['app/proxy-preload.mjs', 'preload'], ['app/package.json', '{}'],
  ] as const
  return {
    ...descriptor(),
    localPath: 'C:/cache/runtime.tar.gz',
    entries: files.map(([path, text]) => ({ type: 'file' as const, path, size: text.length, sha256: hash(text) })),
  }
}

function runtimeReference(remoteRoot = '/remote') {
  return {
    version: 1,
    runtimeVersion: 'test-1',
    dshVersion: '0.1.0-rc.8',
    nodeVersion: '22.19.0',
    artifactSha256: 'a'.repeat(64),
    runtimeRoot: `${remoteRoot}/runtimes/${'a'.repeat(64)}`,
    node: 'bin/node',
    launcher: 'bin/dsh',
  }
}

function result(code: number, stdout = '', stderr = ''): SshCommandResult {
  return { code, stdout, stderr, stdoutTruncated: false, stderrTruncated: false }
}

function tunnelHandle(localPort: number, remotePort: number): ManagedSshTunnel {
  return {
    profileId: 'profile-1', localPort, remotePort,
    localUrl: `http://127.0.0.1:${String(localPort)}`,
    state: 'open', closed: false, revision: 1,
    snapshot: () => ({ profileId: 'profile-1', state: 'open', localUrl: `http://127.0.0.1:${String(localPort)}`, localPort, remotePort, revision: 1 }),
    start: async function () { return this },
    close: vi.fn(async () => undefined),
  } as unknown as ManagedSshTunnel
}

function apiDescriptionFetch(): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { rpcId: string }
    return Response.json({
      type: 'server-response', rpcId: body.rpcId,
      result: { ok: true, value: {
        version: '0.1.0-rc.8', cwd: '/work', attachedSessions: 0, home: '/home/test', canOpenPath: false,
      } },
    })
  }) as typeof fetch
}
