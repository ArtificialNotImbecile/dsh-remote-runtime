/** Remote runtime lifecycle, SSH control plane, and official API projection. */
import { randomInt, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import type {
  ManagedRuntimeArtifact,
  RuntimeArchiveEntry,
  RuntimeArtifactManifest,
  RuntimeArtifactProvider,
} from './artifact.ts'
import { DSH_API_VERSION, DshOfficialApiClient, DshOfficialApiError } from './api-client.ts'
import { RemoteRuntimeError, asRemoteRuntimeError, redactDiagnostic } from './errors.ts'
import { validateRemotePath } from './profiles.ts'
import {
  profileRootShellExpression,
  remoteRootShellExpression,
  shellQuote,
  MAX_RUNTIME_UPLOAD_BYTES,
  type RemoteProbe,
  type SshCommandResult,
  type SshRunner,
} from './ssh.ts'
import type { ManagedSshTunnel, SshTunnelManager, SshTunnelState } from './tunnel.ts'
import type {
  DoctorCheck,
  DoctorReport,
  ImportCredentialRequest,
  PromptRemoteSessionRequest,
  RemoteConnectionStatus,
  RemoteDirectoryEntry,
  RemoteHarnessWorkspace,
  RemoteProfile,
  RemoteProfileId,
  RemoteRuntimeInfo,
  RemoteSessionSummary,
  RemoteSessionTranscript,
  StartRemoteRuntimeRequest,
} from './types.ts'

const CONTROL_PROTOCOL = 1
const START_TIMEOUT_MS = 45_000
const WATCH_MAX_TIMEOUT_MS = 30_000
const MIN_REMOTE_PORT = 20_000
const MAX_REMOTE_PORT = 60_000
const PROXY_PRELOAD_PATH = 'app/proxy-preload.mjs'

/** Structural SSH dependency used by lifecycle tests and the production runner. */
export interface RuntimeSshPort {
  probe(profile: RemoteProfile): Promise<RemoteProbe>
  run(
    profile: RemoteProfile,
    command: string,
    input?: string | Uint8Array,
    options?: number | { readonly timeoutMs?: number; readonly maxCaptureBytes?: number },
  ): Promise<SshCommandResult>
  upload(
    profile: RemoteProfile,
    remotePath: string,
    data: string | Uint8Array,
    options?: { readonly force?: boolean; readonly mode?: number; readonly maxBytes?: number; readonly timeoutMs?: number },
  ): Promise<{ readonly path: string; readonly bytes: number }>
  uploadFile(
    profile: RemoteProfile,
    localPath: string,
    remotePath: string,
    options?: { readonly force?: boolean; readonly mode?: number; readonly maxBytes?: number; readonly timeoutMs?: number },
  ): Promise<{ readonly path: string; readonly bytes: number }>
  download(
    profile: RemoteProfile,
    remotePath: string,
    options?: { readonly maxBytes?: number; readonly timeoutMs?: number },
  ): Promise<Buffer>
}

/** Structural tunnel dependency used by lifecycle tests and production. */
export interface RuntimeTunnelPort {
  start(profile: RemoteProfile, options: {
    readonly localHost?: string
    readonly localPort: number
    readonly remoteHost?: string
    readonly remotePort: number
    readonly reverseForwards?: readonly {
      readonly remoteHost: string
      readonly remotePort: number
      readonly localHost: string
      readonly localPort: number
    }[]
    readonly readyTimeoutMs?: number
    readonly reconnect?: boolean
    readonly onStateChange?: (state: SshTunnelState) => void
  }): Promise<ManagedSshTunnel>
  get(profileId: RemoteProfileId | string): ManagedSshTunnel | undefined
  stop(profileId: RemoteProfileId | string): Promise<void>
  close(): Promise<void>
}

/** Optional client-side proxy gateway used only by client-proxy profiles. */
export interface RuntimeClientProxyPort {
  /** Open a loopback-only authenticated gateway and reserve its remote reverse-forward port. */
  open(profile: RemoteProfile, signal?: AbortSignal): Promise<{
    readonly localHost: '127.0.0.1'
    readonly localPort: number
    readonly remotePort: number
    /** Authenticated URL rewritten for the remote loopback reverse-forward. */
    readonly proxyUrl: string
    close(): Promise<void>
  }>
}

/** Runtime controller construction. */
export interface RemoteRuntimeControllerOptions {
  readonly ssh: RuntimeSshPort
  readonly tunnels: RuntimeTunnelPort
  readonly artifacts: RuntimeArtifactProvider
  readonly clientProxy?: RuntimeClientProxyPort
  readonly commandTimeoutMs: number
  readonly maxTranscriptBytes: number
  readonly now?: () => Date
  readonly allocateLocalPort?: () => Promise<number>
  readonly allocateRemotePort?: () => number
  readonly apiFetch?: typeof globalThis.fetch
}

/** Public credential-state response; no credential value is ever read. */
export interface RemoteCredentialStatus {
  readonly configured: boolean
  readonly baseUrl?: string
  readonly updatedAt?: string
}

interface RemoteLayout {
  readonly remoteRoot: string
  readonly profileRoot: string
  readonly dshHome: string
  readonly controlRoot: string
}

interface RuntimeReference {
  readonly version: 1
  readonly runtimeVersion: string
  readonly dshVersion: string
  readonly nodeVersion: string
  readonly artifactSha256: string
  readonly runtimeRoot: string
  readonly node: string
  readonly launcher: string
}

interface RunState {
  readonly pid: number
  readonly port: number
}

interface InstallerTools {
  readonly find: boolean
  readonly sort: boolean
  readonly cmp: boolean
  readonly readlink: boolean
  readonly date: boolean
  readonly sha256check: boolean
}

interface ProxyBinding {
  readonly remotePort: number
  readonly proxyUrl: string
  close(): Promise<void>
}

/**
 * Owns mutable lifecycle state. Profile persistence remains in ProfileStore;
 * callers notify this controller after a profile-only mutation so long-poll
 * snapshots share one monotonic revision.
 */
export class RemoteRuntimeController {
  private readonly statuses = new Map<RemoteProfileId, RemoteConnectionStatus>()
  private readonly clients = new Map<RemoteProfileId, DshOfficialApiClient>()
  private readonly proxyBindings = new Map<RemoteProfileId, ProxyBinding>()
  private readonly waiters = new Set<() => void>()
  private readonly tails = new Map<RemoteProfileId, Promise<void>>()
  private readonly lifetime = new AbortController()
  private revision = 0
  private disposed = false
  private closing: Promise<void> | undefined

  constructor(private readonly options: RemoteRuntimeControllerOptions) {
    positiveInteger(options.commandTimeoutMs, 'commandTimeoutMs')
    positiveInteger(options.maxTranscriptBytes, 'maxTranscriptBytes')
  }

  /** Current monotonic snapshot revision. */
  get currentRevision(): number {
    return this.revision
  }

  /** Stable copy of every profile status. */
  listStatuses(): readonly RemoteConnectionStatus[] {
    return Object.freeze([...this.statuses.values()].map(status => structuredClone(status)))
  }

  /** Signal a local profile/workspace mutation. */
  noteProfileMutation(): number {
    if (this.disposed) return this.revision
    return this.publish()
  }

  /** Wait until a later revision or the bounded timeout. */
  async waitForRevision(afterRevision: number, timeoutMs: number | undefined, signal: AbortSignal): Promise<number> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new RemoteRuntimeError('watch-revision-invalid', 'Watch revision must be a non-negative safe integer.', {
        phase: 'config',
      })
    }
    const bounded = Math.min(positiveInteger(timeoutMs ?? WATCH_MAX_TIMEOUT_MS, 'watch timeout'), WATCH_MAX_TIMEOUT_MS)
    const activeSignal = AbortSignal.any([signal, this.lifetime.signal])
    activeSignal.throwIfAborted()
    if (this.revision > afterRevision) return this.revision
    return new Promise<number>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.waiters.delete(onChange)
        activeSignal.removeEventListener('abort', onAbort)
        if (error !== undefined) reject(error)
        else resolve(this.revision)
      }
      const onChange = (): void => {
        if (this.revision > afterRevision) finish()
      }
      const onAbort = (): void => { finish(activeSignal.reason ?? new Error('watch cancelled')) }
      const timer = setTimeout(() => finish(), bounded)
      timer.unref()
      this.waiters.add(onChange)
      activeSignal.addEventListener('abort', onAbort, { once: true })
      if (activeSignal.aborted) onAbort()
    })
  }

  /** Read-only diagnostics. This method never resolves or uploads an artifact. */
  async doctor(profile: RemoteProfile, signal: AbortSignal): Promise<DoctorReport> {
    const activeSignal = AbortSignal.any([signal, this.lifetime.signal])
    activeSignal.throwIfAborted()
    const checks: DoctorCheck[] = []
    let descriptor: RuntimeArtifactManifest
    try {
      descriptor = await this.options.artifacts.describe(activeSignal)
      checks.push(check('artifact-descriptor', 'pass', `Managed runtime descriptor ${descriptor.runtimeVersion} is available.`))
    } catch {
      activeSignal.throwIfAborted()
      checks.push(check('artifact-descriptor', 'fail', 'Managed runtime descriptor is unavailable.', 'Reinstall this plugin or repair its runtime descriptor.'))
      return Object.freeze({
        profileId: profile.id,
        checkedAt: this.now(),
        ready: false,
        runtimeInstalled: false,
        checks: Object.freeze(checks),
      })
    }
    let probe: RemoteProbe
    try {
      probe = await this.options.ssh.probe(profile)
      activeSignal.throwIfAborted()
      checks.push(check('ssh', 'pass', 'OpenSSH connection succeeded.'))
    } catch (error: unknown) {
      activeSignal.throwIfAborted()
      checks.push(check('ssh', 'fail', 'OpenSSH connection failed.', 'Verify the SSH host, port, and key or agent authentication.'))
      return Object.freeze({
        profileId: profile.id,
        checkedAt: this.now(),
        ready: false,
        runtimeInstalled: false,
        checks: Object.freeze(checks),
      })
    }
    checks.push(probe.platform === 'Linux'
      ? check('platform', 'pass', 'Remote platform is Linux.')
      : check('platform', 'fail', `Remote platform ${safeToken(probe.platform)} is unsupported.`, 'Use a Linux x64 host.'))
    checks.push(probe.arch === 'x86_64' || probe.arch === 'amd64'
      ? check('architecture', 'pass', 'Remote architecture is x64.')
      : check('architecture', 'fail', `Remote architecture ${safeToken(probe.arch)} is unsupported.`, 'Use an x86-64 host.'))
    checks.push(probe.homeWritable
      ? check('home-writable', 'pass', 'Remote account home is writable.')
      : check('home-writable', 'fail', 'Remote account home is not writable.'))
    checks.push(probe.tar
      ? check('tar', 'pass', 'tar is available.')
      : check('tar', 'fail', 'tar is unavailable.', 'Install a tar implementation on the remote host.'))
    checks.push(probe.sha256sum
      ? check('sha256sum', 'pass', 'sha256sum is available.')
      : check('sha256sum', 'fail', 'sha256sum is unavailable.', 'Install GNU coreutils on the remote host.'))
    checks.push(probe.bash
      ? check('bash', 'pass', 'Bash is available.')
      : check('bash', 'fail', 'Bash is unavailable.', 'Install Bash; directory browsing and managed runtime scripts require it.'))
    const glibc = parseGlibcVersion(probe.libc)
    checks.push(glibc !== undefined && compareVersion(glibc, descriptor.minimumGlibc) >= 0
      ? check('glibc', 'pass', `Remote glibc ${glibc} satisfies the ${descriptor.minimumGlibc} minimum.`)
      : check(
          'glibc',
          'fail',
          `Remote libc does not satisfy the managed Node glibc ${descriptor.minimumGlibc} minimum.`,
          'Use a glibc-based Linux x64 host with a sufficiently recent glibc; musl and unknown libc builds are unsupported.',
        ))
    const tools = await this.probeInstallerTools(profile, activeSignal)
    for (const [id, available, remediation] of [
      ['gnu-find', tools.find, 'Install GNU findutils; the runtime verifier requires find -printf.'],
      ['sort', tools.sort, 'Install GNU coreutils sort.'],
      ['cmp', tools.cmp, 'Install GNU diffutils cmp.'],
      ['readlink', tools.readlink, 'Install GNU coreutils readlink.'],
      ['date', tools.date, 'Install GNU coreutils date.'],
      ['sha256sum-check', tools.sha256check, 'Install GNU coreutils with sha256sum --check --strict.'],
    ] as const) {
      checks.push(available
        ? check(id, 'pass', `${id} capability is available.`)
        : check(id, 'fail', `${id} capability is unavailable.`, remediation))
    }

    let runtimeInstalled = false
    try {
      const layout = await this.resolveLayout(profile, activeSignal)
      const writable = await this.readOnlyRootWritable(profile, layout, activeSignal)
      checks.push(writable
        ? check('runtime-root', 'pass', 'The nearest existing runtime-root ancestor is writable.')
        : check('runtime-root', 'fail', 'The runtime root cannot be created by this SSH account.'))
      const reference = await this.readRuntimeReference(profile, layout, activeSignal, true)
      runtimeInstalled = reference !== undefined
      checks.push(reference === undefined
        ? check('runtime-installed', 'warning', 'Managed runtime is not installed.', 'Run the explicit Install action.')
        : referenceMatchesDescriptor(reference, descriptor)
          ? check('runtime-installed', 'pass', `Managed DSH ${DSH_API_VERSION} is installed.`)
          : check('runtime-installed', 'fail', 'Installed managed runtime does not match this plugin descriptor.', 'Run Install to activate the tested runtime.'))
    } catch {
      activeSignal.throwIfAborted()
      checks.push(check('runtime-root', 'fail', 'Runtime-root diagnostics failed.'))
    }
    const ready = checks.every(item => item.status === 'pass' || item.id === 'runtime-installed' && item.status === 'warning')
    return Object.freeze({
      profileId: profile.id,
      checkedAt: this.now(),
      ready,
      runtimeInstalled,
      checks: Object.freeze(checks),
    })
  }

  /** Explicitly upload, hash-verify, and atomically extract the Linux x64 runtime. */
  install(profile: RemoteProfile, signal: AbortSignal): Promise<RemoteRuntimeInfo> {
    return this.serial(profile.id, async () => {
      this.assertActive()
      const activeSignal = AbortSignal.any([signal, this.lifetime.signal])
      activeSignal.throwIfAborted()
      this.setStatus(profile, 'installing', { message: 'Verifying the managed runtime artifact.' })
      try {
        const report = await this.doctor(profile, activeSignal)
        const blocking = report.checks.find(item => item.status === 'fail')
        if (blocking !== undefined) {
          throw new RemoteRuntimeError('doctor-failed', 'Remote prerequisites are not satisfied.', {
            phase: 'doctor',
            ...(blocking.remediation === undefined ? {} : { remediation: blocking.remediation }),
          })
        }
        const artifact = await this.options.artifacts.resolve(activeSignal)
        const layout = await this.resolveLayout(profile, activeSignal)
        await this.installArtifact(profile, layout, artifact, activeSignal)
        activeSignal.throwIfAborted()
        this.assertActive()
        const info = runtimeInfo(layout, artifact, true)
        this.setStatus(profile, 'disconnected', { runtime: info, message: 'Managed runtime installed.' })
        return info
      } catch (error: unknown) {
        const failure = asRemoteRuntimeError(error, {
          code: 'install-failed', message: 'Managed runtime installation failed.', phase: 'install',
        })
        this.setStatus(profile, 'failed', {
          message: failure.message,
          ...(failure.remediation === undefined ? {} : { remediation: failure.remediation }),
        })
        throw failure
      }
    })
  }

  /** Start or reconnect the profile-private official DSH Web runtime. */
  start(profile: RemoteProfile, request: StartRemoteRuntimeRequest, signal: AbortSignal): Promise<RemoteConnectionStatus> {
    return this.serial(profile.id, async () => {
      this.assertActive()
      const activeSignal = AbortSignal.any([signal, this.lifetime.signal])
      activeSignal.throwIfAborted()
      this.setStatus(profile, 'starting', { message: 'Starting the remote Harness runtime.' })
      let tunnel: ManagedSshTunnel | undefined
      try {
        const layout = await this.resolveLayout(profile, activeSignal)
        const reference = await this.readRuntimeReference(profile, layout, activeSignal, false)
        if (reference === undefined) {
          throw new RemoteRuntimeError('runtime-not-installed', 'Managed runtime is not installed.', {
            phase: 'runtime',
            remediation: 'Run Doctor, then the explicit Install action.',
          })
        }
        const descriptor = await this.options.artifacts.describe(activeSignal)
        if (!referenceMatchesDescriptor(reference, descriptor)) {
          throw new RemoteRuntimeError('runtime-version-mismatch', 'Installed runtime is not the tested DSH release.', {
            phase: 'runtime', remediation: 'Install the current managed runtime.',
          })
        }
        await this.verifyInstalledRuntime(profile, layout, reference, activeSignal)
        let proxy: (ProxyBinding & { readonly localPort: number }) | undefined
        let runState: RunState | undefined
        const releaseLifecycle = await this.acquireProfileLifecycleLock(profile, layout, activeSignal)
        try {
          await this.options.tunnels.stop(profile.id)
          await this.closeProxy(profile.id)
          proxy = await this.openProxy(profile, activeSignal)
          if (proxy !== undefined) {
            this.proxyBindings.set(profile.id, proxy)
            await this.options.ssh.upload(profile, `${layout.controlRoot}/proxy-url`, `${proxy.proxyUrl}\n`, {
              force: true, mode: 0o600, maxBytes: 4 * 1024, timeoutMs: this.options.commandTimeoutMs,
            })
            activeSignal.throwIfAborted()
          }
          // A reverse-forward port belongs to the current SSH tunnel. Relaunch
          // client-proxy profiles so the process environment never retains a
          // stale port from an earlier local process or tunnel generation.
          if (profile.network.mode === 'client-proxy') {
            await this.stopRemoteProcess(profile, activeSignal).catch(() => undefined)
          }
          runState = profile.network.mode === 'client-proxy'
            ? undefined
            : await this.readLiveRunState(profile, layout, reference, activeSignal)
          if (runState === undefined) {
            runState = await this.launchRemote(profile, layout, reference, request.cwd, activeSignal)
          }
        } finally {
          await releaseLifecycle()
        }
        if (runState === undefined) throw new Error('remote runtime launch produced no run state')
        const localPort = await (this.options.allocateLocalPort ?? allocateLoopbackPort)()
        tunnel = await this.options.tunnels.start(profile, {
          localHost: '127.0.0.1',
          localPort,
          remoteHost: '127.0.0.1',
          remotePort: runState.port,
          reconnect: true,
          ...(proxy === undefined ? {} : {
            reverseForwards: [{
              remoteHost: '127.0.0.1', remotePort: proxy.remotePort,
              localHost: '127.0.0.1', localPort: proxy.localPort,
            }],
          }),
          onStateChange: state => this.onTunnelState(profile, state),
        })
        const client = new DshOfficialApiClient({
          baseUrl: tunnel.localUrl,
          timeoutMs: this.options.commandTimeoutMs,
          maxResponseBytes: this.options.maxTranscriptBytes,
          ...(this.options.apiFetch === undefined ? {} : { fetch: this.options.apiFetch }),
        })
        await pollCompatible(client, START_TIMEOUT_MS, activeSignal)
        activeSignal.throwIfAborted()
        this.assertActive()
        this.clients.set(profile.id, client)
        const info = runtimeInfoFromReference(layout, reference)
        return this.setStatus(profile, 'connected', {
          localUrl: tunnel.localUrl,
          remotePort: runState.port,
          runtime: info,
          message: 'Remote Harness is connected through SSH.',
        })
      } catch (error: unknown) {
        await tunnel?.close().catch(() => undefined)
        await this.options.tunnels.stop(profile.id).catch(() => undefined)
        await this.closeProxy(profile.id)
        this.clients.delete(profile.id)
        const failure = asRemoteRuntimeError(error, {
          code: 'runtime-start-failed', message: 'Remote Harness failed to start.', phase: 'runtime',
        })
        this.setStatus(profile, 'failed', {
          message: failure.message,
          ...(failure.remediation === undefined ? {} : { remediation: failure.remediation }),
        })
        throw failure
      }
    })
  }

  /** Stop the remote process and its local SSH control path. */
  stop(profile: RemoteProfile, signal: AbortSignal): Promise<{ readonly changed: boolean }> {
    return this.serial(profile.id, async () => {
      signal.throwIfAborted()
      const hadTunnel = this.options.tunnels.get(profile.id) !== undefined
      await this.options.tunnels.stop(profile.id)
      await this.closeProxy(profile.id)
      this.clients.delete(profile.id)
      const layout = await this.resolveLayout(profile, signal)
      const releaseLifecycle = await this.acquireProfileLifecycleLock(profile, layout, signal)
      let changed: boolean
      try {
        changed = await this.stopRemoteProcess(profile, signal)
      } finally {
        await releaseLifecycle()
      }
      this.setStatus(profile, 'disconnected', { message: 'Remote Harness is stopped.' })
      return Object.freeze({ changed: changed || hadTunnel })
    })
  }

  /** Close only the local tunnel; the remote process keeps running. */
  async disconnect(profile: RemoteProfile): Promise<{ readonly changed: boolean }> {
    this.assertActive()
    const changed = this.options.tunnels.get(profile.id) !== undefined || this.clients.has(profile.id)
    await this.options.tunnels.stop(profile.id)
    await this.closeProxy(profile.id)
    this.clients.delete(profile.id)
    this.setStatus(profile, 'disconnected', { message: 'SSH tunnel disconnected; remote Harness was left running.' })
    return Object.freeze({ changed })
  }

  /** Explicit write-only credential import into the profile-private DSH home. */
  async importCredential(
    profile: RemoteProfile,
    request: ImportCredentialRequest,
    signal: AbortSignal,
  ): Promise<{ readonly configured: true; readonly updatedAt: string }> {
    this.assertActive()
    const activeSignal = AbortSignal.any([signal, this.lifetime.signal])
    activeSignal.throwIfAborted()
    const apiKey = validateApiKey(request.apiKey)
    const baseUrl = request.baseUrl === undefined ? undefined : validateBaseUrl(request.baseUrl)
    const layout = await this.resolveLayout(profile, activeSignal)
    const reference = await this.readRuntimeReference(profile, layout, activeSignal, false)
    if (reference === undefined) throw new RemoteRuntimeError('runtime-not-installed', 'Install the managed runtime before importing a credential.', { phase: 'credential' })
    const node = `${reference.runtimeRoot}/${reference.node}`
    const payloadPath = `${layout.controlRoot}/credential-${randomUUID()}.json`
    const credentialPath = `${layout.dshHome}/.credentials.yaml`
    const settingsPath = `${layout.dshHome}/settings.yaml`
    await this.runChecked(profile, `set -eu; umask 077; mkdir -p -- ${shellQuote(layout.dshHome)} ${shellQuote(layout.controlRoot)}`, undefined, activeSignal)
    let uploaded = false
    try {
      // Cleanup is required even when SSH loses the acknowledgement after the
      // remote atomic upload already committed the write-only payload.
      uploaded = true
      await this.options.ssh.upload(profile, payloadPath, `${JSON.stringify({ apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) })}\n`, {
        force: false, mode: 0o600, maxBytes: 16 * 1024, timeoutMs: this.options.commandTimeoutMs,
      })
      activeSignal.throwIfAborted()
      const command = [
        'set -eu', `payload=${shellQuote(payloadPath)}`,
        'trap \'rm -f -- "$payload"\' EXIT HUP INT TERM',
        `cd -- ${shellQuote(reference.runtimeRoot)}`,
        `${shellQuote(node)} --input-type=module - ${shellQuote(payloadPath)} ${shellQuote(credentialPath)} ${shellQuote(settingsPath)} ${shellQuote(reference.runtimeRoot)}`,
        'rm -f -- "$payload"', 'trap - EXIT HUP INT TERM',
      ].join('; ')
      await this.runChecked(profile, command, credentialPatchScript(), activeSignal, 32 * 1024)
      await this.runChecked(profile, `rm -f -- ${shellQuote(`${layout.profileRoot}/deepseek-base-url`)}`, undefined, activeSignal)
      return Object.freeze({ configured: true, updatedAt: this.now() })
    } finally {
      if (uploaded) {
        await this.options.ssh.run(profile, `rm -f -- ${shellQuote(payloadPath)}`, undefined, {
          timeoutMs: this.options.commandTimeoutMs, maxCaptureBytes: 4 * 1024,
        }).catch(() => undefined)
      }
    }
  }

  /** Probe credential presence without reading or returning the secret. */
  async credentialStatus(profile: RemoteProfile, signal: AbortSignal): Promise<RemoteCredentialStatus> {
    this.assertActive()
    const activeSignal = AbortSignal.any([signal, this.lifetime.signal])
    activeSignal.throwIfAborted()
    const layout = await this.resolveLayout(profile, activeSignal)
    const reference = await this.readRuntimeReference(profile, layout, activeSignal, true)
    if (reference === undefined) return Object.freeze({ configured: false })
    const credentialPath = `${layout.dshHome}/.credentials.yaml`
    const settingsPath = `${layout.dshHome}/settings.yaml`
    const node = `${reference.runtimeRoot}/${reference.node}`
    const command = `set -eu; cd -- ${shellQuote(reference.runtimeRoot)}; ${shellQuote(node)} --input-type=module - ${shellQuote(credentialPath)} ${shellQuote(settingsPath)} ${shellQuote(reference.runtimeRoot)}`
    const result = await this.runChecked(profile, command, credentialStatusScript(), activeSignal, 4 * 1024)
    let status: unknown
    try { status = JSON.parse(result.stdout) as unknown } catch { status = undefined }
    if (!isRecord(status) || typeof status.configured !== 'boolean'
      || (status.baseUrl !== undefined && typeof status.baseUrl !== 'string')) {
      throw new RemoteRuntimeError('credential-status-invalid', 'Remote credential status response is invalid.', { phase: 'credential' })
    }
    const baseUrl = status.baseUrl === undefined ? undefined : validateBaseUrl(status.baseUrl)
    const configured = status.configured
    return Object.freeze({ configured, ...(baseUrl === undefined ? {} : { baseUrl }) })
  }

  /** Browse remote directories over plain SSH before a runtime is installed. */
  async listDirectory(profile: RemoteProfile, requestedPath: string | undefined, signal: AbortSignal): Promise<readonly RemoteDirectoryEntry[]> {
    this.assertActive()
    const activeSignal = AbortSignal.any([signal, this.lifetime.signal])
    activeSignal.throwIfAborted()
    const path = requestedPath === undefined ? undefined : validateRemotePath(requestedPath, 'directory path')
    const script = [
      'set -eu',
      path === undefined ? 'target=$HOME' : `target=${shellQuote(path)}`,
      'test -d "$target"',
      'find "$target" -mindepth 1 -maxdepth 1 \\( -type d -o -type l \\) -print0 | while IFS= read -r -d "" item; do',
      '  name=${item##*/}',
      '  kind=directory; test -L "$item" && kind=symlink',
      '  writable=no; test -w "$item" && writable=yes',
      '  git=no; test -d "$item/.git" && git=yes',
      '  printf "%s\t%s\t%s\t%s\t%s\n" "$(printf %s "$name" | base64 | tr -d "\\n")" "$(printf %s "$item" | base64 | tr -d "\\n")" "$kind" "$writable" "$git"',
      'done',
    ].join('\n')
    const result = await this.options.ssh.run(profile, 'bash -s', script, {
      timeoutMs: this.options.commandTimeoutMs,
      maxCaptureBytes: Math.min(this.options.maxTranscriptBytes, 8 * 1024 * 1024),
    })
    activeSignal.throwIfAborted()
    if (result.code !== 0) {
      throw new RemoteRuntimeError('directory-list-failed', 'Remote directory could not be listed.', {
        phase: 'ssh', retryable: true,
      })
    }
    if (result.stdoutTruncated) {
      throw new RemoteRuntimeError('directory-list-too-large', 'Remote directory listing exceeded the configured bound.', {
        phase: 'ssh', remediation: 'Browse a narrower directory.',
      })
    }
    const entries = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => {
      const [name64, path64, kind, writable, gitRepository] = line.split('\t')
      if (name64 === undefined || path64 === undefined || (kind !== 'directory' && kind !== 'symlink')
        || (writable !== 'yes' && writable !== 'no') || (gitRepository !== 'yes' && gitRepository !== 'no')) {
        throw new RemoteRuntimeError('directory-list-invalid', 'Remote directory listing response is invalid.', { phase: 'ssh' })
      }
      const name = decodeBase64(name64)
      const cwd = decodeBase64(path64)
      validateRemotePath(cwd, 'listed directory path')
      return Object.freeze({
        name,
        path: cwd,
        kind,
        writable: writable === 'yes',
        gitRepository: gitRepository === 'yes',
      })
    })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    return Object.freeze(entries)
  }

  async listHarnessWorkspaces(profile: RemoteProfile, signal: AbortSignal): Promise<readonly RemoteHarnessWorkspace[]> {
    return this.requireClient(profile.id).listWorkspaces(AbortSignal.any([signal, this.lifetime.signal]))
  }

  async listSessions(profile: RemoteProfile, signal: AbortSignal): Promise<readonly RemoteSessionSummary[]> {
    return this.requireClient(profile.id).listSessions(AbortSignal.any([signal, this.lifetime.signal]))
  }

  async readTranscript(
    profile: RemoteProfile,
    sessionId: string,
    beforeSeq: number | undefined,
    maxMessages: number | undefined,
    signal: AbortSignal,
  ): Promise<RemoteSessionTranscript> {
    return this.requireClient(profile.id).readTranscript(
      sessionId, beforeSeq, maxMessages, AbortSignal.any([signal, this.lifetime.signal]),
    )
  }

  async prompt(
    profile: RemoteProfile,
    request: PromptRemoteSessionRequest,
    signal: AbortSignal,
  ): Promise<{ readonly accepted: true }> {
    return this.requireClient(profile.id).prompt(
      request.sessionId, request.text, request.mode ?? 'queue', AbortSignal.any([signal, this.lifetime.signal]),
    )
  }

  async cancel(profile: RemoteProfile, sessionId: string, signal: AbortSignal): Promise<{ readonly accepted: true }> {
    return this.requireClient(profile.id).cancel(sessionId, AbortSignal.any([signal, this.lifetime.signal]))
  }

  /** Dispose local control resources without stopping remote runtimes. */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.disposed = true
    this.lifetime.abort(new Error('remote runtime controller closed'))
    this.closing = (async () => {
      while (this.tails.size > 0) await Promise.allSettled([...this.tails.values()])
      this.clients.clear()
      await Promise.all([...this.proxyBindings.keys()].map(id => this.closeProxy(id)))
      await this.options.tunnels.close()
    })()
    return this.closing
  }

  private async resolveLayout(profile: RemoteProfile, signal: AbortSignal): Promise<RemoteLayout> {
    const command = [
      'set -eu',
      `remote_root=${remoteRootShellExpression(profile)}`,
      `profile_root=${profileRootShellExpression(profile)}`,
      'printf "%s\\n%s\\n%s\\n" "$remote_root" "$profile_root" "$HOME"',
    ].join('; ')
    const result = await this.runChecked(profile, command, undefined, signal, 16 * 1024)
    const lines = result.stdout.replace(/\r\n/gu, '\n').trimEnd().split('\n')
    if (lines.length !== 3) {
      throw new RemoteRuntimeError('remote-layout-invalid', 'Remote shell returned an invalid runtime layout.', {
        phase: 'runtime',
      })
    }
    const [remoteRoot, profileRoot, home] = lines
    if (remoteRoot === undefined || profileRoot === undefined || home === undefined) {
      throw new RemoteRuntimeError('remote-layout-invalid', 'Remote shell returned an incomplete runtime layout.', { phase: 'runtime' })
    }
    return Object.freeze({
      remoteRoot: validateRemotePath(remoteRoot, 'resolved runtime root'),
      profileRoot: validateRemotePath(profileRoot, 'resolved profile root'),
      dshHome: `${validateRemotePath(profileRoot, 'resolved profile root')}/dsh-home`,
      controlRoot: `${validateRemotePath(profileRoot, 'resolved profile root')}/control`,
    })
  }

  private async probeInstallerTools(profile: RemoteProfile, signal: AbortSignal): Promise<InstallerTools> {
    const script = [
      'set -u',
      'find_ok=no; command -v find >/dev/null 2>&1 && find --version 2>/dev/null | grep -q GNU && find / -maxdepth 0 -printf "" >/dev/null 2>&1 && find_ok=yes',
      'sort_ok=no; command -v sort >/dev/null 2>&1 && sort </dev/null >/dev/null 2>&1 && sort_ok=yes',
      'cmp_ok=no; command -v cmp >/dev/null 2>&1 && cmp /dev/null /dev/null >/dev/null 2>&1 && cmp_ok=yes',
      'readlink_ok=no; command -v readlink >/dev/null 2>&1 && readlink -f / >/dev/null 2>&1 && readlink_ok=yes',
      'date_ok=no; command -v date >/dev/null 2>&1 && date +%s >/dev/null 2>&1 && date_ok=yes',
      'sha_ok=no; printf "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  /dev/null\\n" | sha256sum --check --strict - >/dev/null 2>&1 && sha_ok=yes',
      'printf "DSH_REMOTE_TOOLS/1|%s|%s|%s|%s|%s|%s\\n" "$find_ok" "$sort_ok" "$cmp_ok" "$readlink_ok" "$date_ok" "$sha_ok"',
    ].join('\n')
    const result = await this.options.ssh.run(profile, 'sh -s', script, {
      timeoutMs: this.options.commandTimeoutMs, maxCaptureBytes: 4 * 1024,
    })
    signal.throwIfAborted()
    const match = /^DSH_REMOTE_TOOLS\/1\|(yes|no)\|(yes|no)\|(yes|no)\|(yes|no)\|(yes|no)\|(yes|no)\s*$/u.exec(result.stdout)
    if (result.code !== 0 || match === null) {
      return { find: false, sort: false, cmp: false, readlink: false, date: false, sha256check: false }
    }
    return {
      find: match[1] === 'yes', sort: match[2] === 'yes', cmp: match[3] === 'yes',
      readlink: match[4] === 'yes', date: match[5] === 'yes', sha256check: match[6] === 'yes',
    }
  }

  private async readOnlyRootWritable(profile: RemoteProfile, layout: RemoteLayout, signal: AbortSignal): Promise<boolean> {
    const command = [
      'set -eu',
      `probe=${shellQuote(layout.remoteRoot)}`,
      'while ! test -e "$probe"; do next=${probe%/*}; test -n "$next" || next=/; test "$next" != "$probe" || break; probe=$next; done',
      'test -d "$probe" && test -w "$probe"',
    ].join('; ')
    const result = await this.options.ssh.run(profile, command, undefined, { timeoutMs: this.options.commandTimeoutMs })
    signal.throwIfAborted()
    return result.code === 0
  }

  private async installArtifact(
    profile: RemoteProfile,
    layout: RemoteLayout,
    artifact: ManagedRuntimeArtifact,
    signal: AbortSignal,
  ): Promise<void> {
    const objectRoot = `${layout.remoteRoot}/objects`
    const runtimeRoot = `${layout.remoteRoot}/runtimes/${artifact.archive.sha256}`
    const objectPath = `${objectRoot}/${artifact.archive.sha256}.tar.gz`
    await this.runChecked(profile, [
      'set -eu', 'umask 077',
      `mkdir -p -- ${shellQuote(objectRoot)} ${shellQuote(`${layout.remoteRoot}/runtimes`)} ${shellQuote(layout.profileRoot)} ${shellQuote(layout.dshHome)} ${shellQuote(layout.controlRoot)}`,
    ].join('; '), undefined, signal)
    const existing = await this.options.ssh.run(profile, [
      'set -eu', `object=${shellQuote(objectPath)}`,
      `expected=${shellQuote(artifact.archive.sha256)}`,
      'test -f "$object" || exit 44',
      'actual=$(sha256sum -- "$object" | cut -d " " -f 1)',
      'test "$actual" = "$expected"',
    ].join('; '), undefined, { timeoutMs: this.options.commandTimeoutMs })
    signal.throwIfAborted()
    if (existing.code !== 0) {
      if (existing.code !== 1 && existing.code !== 44) {
        throw new RemoteRuntimeError('remote-artifact-check-failed', 'Remote artifact cache could not be verified.', {
          phase: 'install', retryable: true,
        })
      }
      const uploadPath = `${objectPath}.upload-${randomUUID()}`
      await this.options.ssh.uploadFile(profile, artifact.localPath, uploadPath, {
        force: false, mode: 0o600, maxBytes: MAX_RUNTIME_UPLOAD_BYTES, timeoutMs: 10 * 60_000,
      })
      signal.throwIfAborted()
      await this.runChecked(profile, [
        'set -eu', `upload=${shellQuote(uploadPath)}`, `object=${shellQuote(objectPath)}`,
        `expected=${shellQuote(artifact.archive.sha256)}`,
        'trap "rm -f -- \"$upload\"" EXIT HUP INT TERM',
        'actual=$(sha256sum -- "$upload" | cut -d " " -f 1)',
        'test "$actual" = "$expected"',
        'mv -f -- "$upload" "$object"',
        'trap - EXIT HUP INT TERM',
      ].join('; '), undefined, signal)
    }
    const temporary = `${runtimeRoot}.extract-${randomUUID()}`
    const roster = runtimeVerificationRoster(artifact)
    const rosterPaths = remoteRosterPaths(layout.remoteRoot, artifact.archive.sha256)
    await Promise.all([
      this.options.ssh.upload(profile, rosterPaths.expected, roster.expected, { force: true, mode: 0o600, maxBytes: 32 * 1024 * 1024 }),
      this.options.ssh.upload(profile, rosterPaths.files, roster.files, { force: true, mode: 0o600, maxBytes: 32 * 1024 * 1024 }),
      this.options.ssh.upload(profile, rosterPaths.checksums, roster.checksums, { force: true, mode: 0o600, maxBytes: 32 * 1024 * 1024 }),
      this.options.ssh.upload(profile, rosterPaths.symlinks, roster.symlinks, { force: true, mode: 0o600, maxBytes: 32 * 1024 * 1024 }),
    ])
    signal.throwIfAborted()
    const verification = runtimeVerificationScript(artifact, objectPath, runtimeRoot, temporary, rosterPaths)
    try {
      await this.runChecked(profile, 'bash -s', verification, signal, 64 * 1024, 10 * 60_000)
    } catch (error: unknown) {
      signal.throwIfAborted()
      const quarantine = await this.options.ssh.run(
        profile,
        'bash -s',
        quarantineRuntimeScript(runtimeRoot),
        { timeoutMs: this.options.commandTimeoutMs, maxCaptureBytes: 16 * 1024 },
      )
      signal.throwIfAborted()
      if (quarantine.code === 70) {
        throw new RemoteRuntimeError('runtime-corrupt-in-use', 'The existing runtime failed verification while a process still owns it.', {
          phase: 'install', remediation: 'Stop every profile using this runtime, then install again.', cause: error,
        })
      }
      if (quarantine.code !== 0) throw error
      await this.runChecked(profile, 'bash -s', verification, signal, 64 * 1024, 10 * 60_000)
    }
    const reference: RuntimeReference = {
      version: 1,
      runtimeVersion: artifact.runtimeVersion,
      dshVersion: artifact.dshVersion,
      nodeVersion: artifact.nodeVersion,
      artifactSha256: artifact.archive.sha256,
      runtimeRoot,
      node: artifact.node,
      launcher: artifact.launcher,
    }
    await this.options.ssh.upload(profile, `${layout.profileRoot}/runtime.json`, `${JSON.stringify(reference)}\n`, {
      force: true, mode: 0o600, maxBytes: 64 * 1024, timeoutMs: this.options.commandTimeoutMs,
    })
  }

  private async readRuntimeReference(
    profile: RemoteProfile,
    layout: RemoteLayout,
    signal: AbortSignal,
    optional: boolean,
  ): Promise<RuntimeReference | undefined> {
    const referencePath = `${layout.profileRoot}/runtime.json`
    if (optional) {
      const presence = await this.options.ssh.run(profile, `test -f ${shellQuote(referencePath)}`, undefined, {
        timeoutMs: this.options.commandTimeoutMs, maxCaptureBytes: 4 * 1024,
      })
      signal.throwIfAborted()
      if (presence.code === 1) return undefined
      if (presence.code !== 0) {
        throw new RemoteRuntimeError('runtime-reference-check-failed', 'Installed runtime metadata could not be checked.', {
          phase: 'runtime', retryable: true,
        })
      }
    }
    try {
      const bytes = await this.options.ssh.download(profile, referencePath, {
        maxBytes: 64 * 1024, timeoutMs: this.options.commandTimeoutMs,
      })
      signal.throwIfAborted()
      const reference = parseRuntimeReference(JSON.parse(bytes.toString('utf8')) as unknown)
      const expectedRoot = `${layout.remoteRoot}/runtimes/${reference.artifactSha256}`
      if (reference.runtimeRoot !== expectedRoot) {
        throw new RemoteRuntimeError('runtime-reference-invalid', 'Installed runtime metadata points outside its content-addressed root.', {
          phase: 'runtime', remediation: 'Run Install again.',
        })
      }
      return reference
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SyntaxError) {
        throw new RemoteRuntimeError('runtime-reference-invalid', 'Installed runtime metadata is invalid.', {
          phase: 'runtime', remediation: 'Run Install again.',
        })
      }
      throw error
    }
  }

  private async launchRemote(
    profile: RemoteProfile,
    layout: RemoteLayout,
    reference: RuntimeReference,
    requestedCwd: string | undefined,
    signal: AbortSignal,
  ): Promise<RunState> {
    const cwd = requestedCwd === undefined
      ? profile.defaultCwd ?? layout.profileRoot
      : validateRemotePath(requestedCwd, 'runtime cwd')
    const remotePort = (this.options.allocateRemotePort ?? (() => randomInt(MIN_REMOTE_PORT, MAX_REMOTE_PORT + 1)))()
    const statePath = `${layout.controlRoot}/run.state`
    const tokenPath = `${layout.controlRoot}/run.token`
    const logPath = `${layout.controlRoot}/runtime.log`
    const launcher = `${reference.runtimeRoot}/${reference.launcher}`
    const node = `${reference.runtimeRoot}/${reference.node}`
    const proxyPreload = `${reference.runtimeRoot}/${PROXY_PRELOAD_PATH}`
    const proxyFile = `${layout.controlRoot}/proxy-url`
    const noProxy = profile.network.clientProxy.noProxy.join(',')
    const environment = [
      `DSH_HOME=${shellQuote(layout.dshHome)}`,
      'DSH_TELEMETRY_DISABLED=1',
      `NODE_OPTIONS=${shellQuote(`--import=${remoteFileUrl(proxyPreload)}`)}`,
      ...(profile.network.mode === 'client-proxy'
        ? [
            // Only deployment-authored exact entries bypass the gateway;
            // inherited NO_PROXY and broad implicit private ranges never do.
            `NO_PROXY=${shellQuote(noProxy)}`,
            `no_proxy=${shellQuote(noProxy)}`,
          ]
        : []),
    ]
    await this.options.ssh.upload(profile, tokenPath, `${randomUUID()}\n`, {
      force: true, mode: 0o600, maxBytes: 256, timeoutMs: this.options.commandTimeoutMs,
    })
    signal.throwIfAborted()
    const command = [
      'set -eu', 'umask 077',
      `mkdir -p -- ${shellQuote(layout.controlRoot)} ${shellQuote(layout.dshHome)}`,
      `test -d ${shellQuote(cwd)}`, `test -x ${shellQuote(node)}`, `test -x ${shellQuote(launcher)}`,
      `test -f ${shellQuote(proxyPreload)}`,
      `node_dir=$(dirname -- ${shellQuote(node)}); PATH="$node_dir:$PATH"; export PATH`,
      `token_file=${shellQuote(tokenPath)}`,
      'DSH_REMOTE_RUN_TOKEN=$(head -n 1 -- "$token_file"); export DSH_REMOTE_RUN_TOKEN',
      ...(profile.network.mode === 'client-proxy'
        ? [
            `proxy_file=${shellQuote(proxyFile)}`,
            'DSH_REMOTE_PROXY_URL=$(head -n 1 -- "$proxy_file"); export HTTP_PROXY="$DSH_REMOTE_PROXY_URL" HTTPS_PROXY="$DSH_REMOTE_PROXY_URL" http_proxy="$DSH_REMOTE_PROXY_URL" https_proxy="$DSH_REMOTE_PROXY_URL"; unset ALL_PROXY all_proxy',
          ]
        : []),
      `cd -- ${shellQuote(cwd)}`,
      `nohup env ${environment.join(' ')} ${shellQuote(launcher)} web --no-open --port ${String(remotePort)} </dev/null >${shellQuote(logPath)} 2>&1 & pid=$!`,
      `temporary=${shellQuote(`${statePath}.tmp-${randomUUID()}`)}`,
      `printf 'version=${String(CONTROL_PROTOCOL)}\\npid=%s\\nport=%s\\ntoken=%s\\n' "$pid" ${String(remotePort)} "$DSH_REMOTE_RUN_TOKEN" > "$temporary"`,
      'chmod 600 "$temporary"', `mv -f -- "$temporary" ${shellQuote(statePath)}`,
      'sleep 0.1', 'kill -0 "$pid"',
    ].join('; ')
    await this.runChecked(profile, command, undefined, signal, 64 * 1024)
    return Object.freeze({ pid: -1, port: remotePort })
  }

  private async verifyInstalledRuntime(
    profile: RemoteProfile,
    layout: RemoteLayout,
    reference: RuntimeReference,
    signal: AbortSignal,
  ): Promise<void> {
    const roster = remoteRosterPaths(layout.remoteRoot, reference.artifactSha256)
    const script = installedRuntimeVerificationScript(reference, roster)
    await this.runChecked(profile, 'bash -s', script, signal, 64 * 1024, 10 * 60_000)
  }

  private async readLiveRunState(
    profile: RemoteProfile,
    layout: RemoteLayout,
    reference: RuntimeReference,
    signal: AbortSignal,
  ): Promise<RunState | undefined> {
    const statePath = `${layout.controlRoot}/run.state`
    const node = `${reference.runtimeRoot}/${reference.node}`
    const result = await this.options.ssh.run(profile, [
      'set -eu', `state=${shellQuote(statePath)}`, 'test -f "$state" || exit 44',
      'version=$(sed -n "s/^version=//p" "$state")', 'pid=$(sed -n "s/^pid=//p" "$state")', 'port=$(sed -n "s/^port=//p" "$state")', 'token=$(sed -n "s/^token=//p" "$state")',
      `test "$version" = ${shellQuote(String(CONTROL_PROTOCOL))}`,
      'case "$pid" in ""|*[!0-9]*) exit 45;; esac', 'case "$port" in ""|*[!0-9]*) exit 45;; esac', 'case "$token" in ""|*[!A-Za-z0-9-]*) exit 45;; esac',
      'kill -0 "$pid" 2>/dev/null || exit 46',
      'tr "\\000" "\\n" < "/proc/$pid/environ" | grep -Fqx -- "DSH_REMOTE_RUN_TOKEN=$token" || exit 47',
      `test "$(readlink -f -- "/proc/$pid/exe")" = "$(readlink -f -- ${shellQuote(node)})" || exit 48`,
      'printf "%s %s\n" "$pid" "$port"',
    ].join('; '), undefined, { timeoutMs: this.options.commandTimeoutMs, maxCaptureBytes: 4 * 1024 })
    signal.throwIfAborted()
    if (result.code !== 0) return undefined
    const match = /^(\d+) (\d+)\s*$/u.exec(result.stdout)
    if (match === null) return undefined
    const pid = Number(match[1])
    const port = Number(match[2])
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined
    return Object.freeze({ pid, port })
  }

  private async stopRemoteProcess(profile: RemoteProfile, signal?: AbortSignal): Promise<boolean> {
    const activeSignal = signal ?? new AbortController().signal
    const layout = await this.resolveLayout(profile, activeSignal)
    const statePath = `${layout.controlRoot}/run.state`
    const tokenPath = `${layout.controlRoot}/run.token`
    const reference = await this.readRuntimeReference(profile, layout, activeSignal, true)
    if (reference === undefined) {
      await this.options.ssh.run(profile, `rm -f -- ${shellQuote(statePath)} ${shellQuote(tokenPath)}`, undefined, {
        timeoutMs: this.options.commandTimeoutMs, maxCaptureBytes: 4 * 1024,
      })
      return false
    }
    const node = `${reference.runtimeRoot}/${reference.node}`
    const command = [
      'set -eu', `state=${shellQuote(statePath)}`, 'test -f "$state" || exit 44',
      'pid=$(sed -n "s/^pid=//p" "$state")', 'token=$(sed -n "s/^token=//p" "$state")',
      'case "$pid" in ""|*[!0-9]*) rm -f -- "$state"; exit 45;; esac',
      'case "$token" in ""|*[!A-Za-z0-9-]*) rm -f -- "$state"; exit 45;; esac',
      'if ! kill -0 "$pid" 2>/dev/null; then rm -f -- "$state"; exit 46; fi',
      'if ! tr "\\000" "\\n" < "/proc/$pid/environ" | grep -Fqx -- "DSH_REMOTE_RUN_TOKEN=$token"; then rm -f -- "$state"; exit 47; fi',
      `if test "$(readlink -f -- "/proc/$pid/exe")" != "$(readlink -f -- ${shellQuote(node)})"; then rm -f -- "$state"; exit 48; fi`,
      `if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; i=0; while kill -0 "$pid" 2>/dev/null && test "$i" -lt 50; do sleep 0.1; i=$((i+1)); done; if kill -0 "$pid" 2>/dev/null; then if ! tr "\\000" "\\n" < "/proc/$pid/environ" | grep -Fqx -- "DSH_REMOTE_RUN_TOKEN=$token" || test "$(readlink -f -- "/proc/$pid/exe")" != "$(readlink -f -- ${shellQuote(node)})"; then rm -f -- "$state"; exit 49; fi; exit 50; fi; fi`,
      `rm -f -- "$state" ${shellQuote(tokenPath)}`,
    ].join('; ')
    const result = await this.options.ssh.run(profile, command, undefined, {
      timeoutMs: Math.max(this.options.commandTimeoutMs, 10_000), maxCaptureBytes: 4 * 1024,
    })
    signal?.throwIfAborted()
    if (![0, 44, 45, 46, 47, 48, 49].includes(result.code)) {
      throw new RemoteRuntimeError('runtime-stop-failed', 'Remote Harness process could not be stopped.', {
        phase: 'runtime', retryable: true,
      })
    }
    return result.code === 0
  }

  private async acquireProfileLifecycleLock(
    profile: RemoteProfile,
    layout: RemoteLayout,
    signal: AbortSignal,
  ): Promise<() => Promise<void>> {
    const token = randomUUID()
    const lock = `${layout.controlRoot}/lifecycle.lock`
    const owner = `${lock}/owner`
    const command = [
      'set -euo pipefail', 'umask 077', `mkdir -p -- ${shellQuote(layout.controlRoot)}`,
      `lock=${shellQuote(lock)}`, `owner=${shellQuote(owner)}`, `token=${shellQuote(token)}`,
      'attempt=0; until mkdir -- "$lock" 2>/dev/null; do attempt=$((attempt+1)); now=$(date +%s); if test -f "$owner"; then owner_time=$(sed -n "s/^time=//p" "$owner"); case "$owner_time" in ""|*[!0-9]*) owner_time=0;; esac; if test $((now-owner_time)) -gt 300; then rm -rf -- "$lock"; continue; fi; else lock_time=$(date -r "$lock" +%s 2>/dev/null || printf 0); case "$lock_time" in ""|*[!0-9]*) lock_time=0;; esac; if test "$lock_time" -gt 0 && test $((now-lock_time)) -gt 30; then rm -rf -- "$lock"; continue; fi; fi; test "$attempt" -lt 100 || exit 63; sleep 0.2; done',
      'printf "token=%s\\ntime=%s\\n" "$token" "$(date +%s)" > "$owner"',
    ].join('; ')
    let released = false
    const release = async () => {
      if (released) return
      released = true
      await this.options.ssh.run(profile, [
        'set -eu', `lock=${shellQuote(lock)}`, `owner=${shellQuote(owner)}`, `token=${shellQuote(token)}`,
        'if test -f "$owner" && test "$(sed -n "s/^token=//p" "$owner")" = "$token"; then rm -rf -- "$lock"; fi',
      ].join('; '), undefined, { timeoutMs: this.options.commandTimeoutMs, maxCaptureBytes: 4 * 1024 }).catch(() => undefined)
    }
    signal.throwIfAborted()
    let result: SshCommandResult
    try {
      result = await this.options.ssh.run(profile, command, undefined, {
        timeoutMs: Math.max(25_000, this.options.commandTimeoutMs),
        maxCaptureBytes: 4 * 1024,
      })
    } catch (error) {
      await release()
      throw error
    }
    if (result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
      await release()
      throw new RemoteRuntimeError('profile-lifecycle-lock-failed', 'Timed out waiting for the remote profile lifecycle lock.', {
        phase: 'runtime', retryable: true,
        safeDetails: { exitCode: result.code, diagnostic: redactDiagnostic(result.stderr).slice(0, 300) },
      })
    }
    if (signal.aborted) {
      await release()
      signal.throwIfAborted()
    }
    return release
  }

  private async runChecked(
    profile: RemoteProfile,
    command: string,
    input: string | Uint8Array | undefined,
    signal: AbortSignal,
    maxCaptureBytes = 1024 * 1024,
    timeoutMs = this.options.commandTimeoutMs,
  ): Promise<SshCommandResult> {
    signal.throwIfAborted()
    const result = await this.options.ssh.run(profile, command, input, { timeoutMs, maxCaptureBytes })
    signal.throwIfAborted()
    if (result.code !== 0) {
      throw new RemoteRuntimeError('remote-command-failed', 'A managed remote command failed.', {
        phase: 'runtime', retryable: true,
        safeDetails: { exitCode: result.code, diagnostic: redactDiagnostic(result.stderr).slice(0, 300) },
      })
    }
    if (result.stdoutTruncated || result.stderrTruncated) {
      throw new RemoteRuntimeError('remote-command-output-truncated', 'A managed remote command exceeded its output bound.', {
        phase: 'runtime',
      })
    }
    return result
  }

  private requireClient(profileId: RemoteProfileId): DshOfficialApiClient {
    const client = this.clients.get(profileId)
    if (client === undefined) {
      throw new RemoteRuntimeError('runtime-not-connected', 'Remote Harness is not connected.', {
        phase: 'tunnel', retryable: true, remediation: 'Start or reconnect this remote profile first.',
      })
    }
    return client
  }

  private async openProxy(profile: RemoteProfile, signal: AbortSignal): Promise<(ProxyBinding & { readonly localPort: number }) | undefined> {
    if (profile.network.mode !== 'client-proxy') return undefined
    if (this.options.clientProxy === undefined) {
      throw new RemoteRuntimeError('client-proxy-unavailable', 'Client-proxy egress is not available in this composition.', {
        phase: 'tunnel', remediation: 'Use remote-direct or compose the client proxy gateway.',
      })
    }
    const binding = await this.options.clientProxy.open(profile, signal)
    const proxyUrl = new URL(binding.proxyUrl)
    if (proxyUrl.protocol !== 'http:' || proxyUrl.hostname !== '127.0.0.1'
      || Number(proxyUrl.port) !== binding.remotePort || proxyUrl.username === '' || proxyUrl.password === '') {
      await binding.close().catch(() => undefined)
      throw new RemoteRuntimeError('client-proxy-invalid', 'Client proxy returned an invalid authenticated loopback URL.', {
        phase: 'tunnel',
      })
    }
    return binding
  }

  private async closeProxy(profileId: RemoteProfileId): Promise<void> {
    const proxy = this.proxyBindings.get(profileId)
    this.proxyBindings.delete(profileId)
    await proxy?.close().catch(() => undefined)
  }

  private onTunnelState(profile: RemoteProfile, state: SshTunnelState): void {
    if (state === 'starting') return
    const current = this.statuses.get(profile.id)
    if (state === 'open') {
      const tunnel = this.options.tunnels.get(profile.id)
      if (this.clients.has(profile.id) && tunnel !== undefined) {
        this.setStatus(profile, 'connected', {
          localUrl: tunnel.localUrl,
          remotePort: tunnel.remotePort,
          ...(current?.runtime === undefined ? {} : { runtime: current.runtime }),
          message: 'SSH tunnel reconnected.',
        })
      }
    } else if (state === 'reconnecting') {
      this.setStatus(profile, 'starting', {
        ...(current?.localUrl === undefined ? {} : { localUrl: current.localUrl }),
        ...(current?.remotePort === undefined ? {} : { remotePort: current.remotePort }),
        ...(current?.runtime === undefined ? {} : { runtime: current.runtime }),
        message: 'SSH tunnel is reconnecting.',
      })
    } else if (state === 'failed') {
      this.clients.delete(profile.id)
      this.setStatus(profile, 'failed', { message: 'SSH tunnel failed.', remediation: 'Reconnect the profile.' })
    } else if (state === 'closed' && this.statuses.get(profile.id)?.state === 'connected') {
      this.clients.delete(profile.id)
      this.setStatus(profile, 'disconnected', { message: 'SSH tunnel closed.' })
    }
  }

  private setStatus(
    profile: RemoteProfile,
    state: RemoteConnectionStatus['state'],
    fields: Omit<RemoteConnectionStatus, 'profileId' | 'state' | 'revision' | 'changedAt'>,
  ): RemoteConnectionStatus {
    if (this.disposed) {
      return structuredClone(this.statuses.get(profile.id) ?? Object.freeze({
        profileId: profile.id,
        state: 'disconnected' as const,
        revision: this.revision,
        message: 'Remote runtime service is closed.',
        changedAt: this.now(),
      }))
    }
    const revision = this.revision + 1
    const status: RemoteConnectionStatus = Object.freeze({
      profileId: profile.id,
      state,
      revision,
      ...fields,
      changedAt: this.now(),
    })
    this.statuses.set(profile.id, status)
    this.publish()
    return structuredClone(status)
  }

  private publish(): number {
    this.revision += 1
    for (const waiter of [...this.waiters]) waiter()
    return this.revision
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString()
  }

  private assertActive(): void {
    if (this.disposed) throw new RemoteRuntimeError('service-closed', 'Remote runtime service is closed.', { phase: 'runtime' })
  }

  private serial<T>(profileId: RemoteProfileId, operation: () => Promise<T>): Promise<T> {
    this.assertActive()
    const prior = this.tails.get(profileId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = prior.catch(() => undefined).then(() => gate)
    this.tails.set(profileId, tail)
    return prior.catch(() => undefined).then(operation).finally(() => {
      release()
      if (this.tails.get(profileId) === tail) this.tails.delete(profileId)
    })
  }
}

function runtimeInfo(layout: RemoteLayout, artifact: ManagedRuntimeArtifact, installed: boolean): RemoteRuntimeInfo {
  return Object.freeze({
    runtimeVersion: artifact.runtimeVersion,
    dshVersion: artifact.dshVersion,
    nodeVersion: artifact.nodeVersion,
    artifactSha256: artifact.archive.sha256,
    remoteRoot: layout.remoteRoot,
    profileRoot: layout.profileRoot,
    dshHome: layout.dshHome,
    installed,
  })
}

function runtimeVerificationScript(
  artifact: ManagedRuntimeArtifact,
  objectPath: string,
  runtimeRoot: string,
  temporary: string,
  roster: { readonly expected: string; readonly files: string; readonly checksums: string; readonly symlinks: string },
): string {
  validateRuntimeRoster(artifact.entries, artifact.node, artifact.launcher)
  const actual = `${temporary}.actual`
  const listing = `${temporary}.listing`
  const lines = [
    'set -euo pipefail',
    'umask 077',
    `object=${shellQuote(objectPath)}`,
    `runtime=${shellQuote(runtimeRoot)}`,
    'lock="$runtime.lock"',
    `temporary=${shellQuote(temporary)}`,
    `expected=${shellQuote(roster.expected)}`,
    `files=${shellQuote(roster.files)}`,
    `checksums=${shellQuote(roster.checksums)}`,
    `symlinks=${shellQuote(roster.symlinks)}`,
    `actual=${shellQuote(actual)}`,
    `listing=${shellQuote(listing)}`,
    'attempt=0; until mkdir -- "$lock" 2>/dev/null; do attempt=$((attempt+1)); if test -f "$lock/owner"; then owner_pid=$(sed -n "s/^pid=//p" "$lock/owner"); owner_time=$(sed -n "s/^time=//p" "$lock/owner"); now=$(date +%s); case "$owner_pid:$owner_time" in *[!0-9:]*|:*) owner_pid=0; owner_time=0;; esac; if test $((now-owner_time)) -gt 600 && ! kill -0 "$owner_pid" 2>/dev/null; then rm -rf -- "$lock"; continue; fi; fi; test "$attempt" -lt 300 || exit 62; sleep 0.2; done',
    'printf "pid=%s\\ntime=%s\\n" "$$" "$(date +%s)" > "$lock/owner"',
    'trap \'rm -rf -- "$temporary" "$actual" "$listing" "$lock"\' EXIT HUP INT TERM',
    'tar -tzf "$object" > "$listing"',
    // This is intentionally before extraction. The local provider has already
    // parsed each USTAR header and validated symlink targets; this second gate
    // ensures the remote object still names only contained canonical paths.
    'while IFS= read -r member; do member=${member#./}; member=${member%/}; test -n "$member" || continue; case "$member" in /*|..|../*|*/..|*/../*|*\\*) exit 61;; esac; done < "$listing"',
    'new_runtime=no; if test -d "$runtime"; then candidate=$runtime; else new_runtime=yes; mkdir -p -- "$temporary"; tar --extract --gzip --file "$object" --directory "$temporary" --no-same-owner --no-same-permissions --numeric-owner; candidate=$temporary; fi',
    'find "$candidate" \\( -type f -o -type l \\) -printf "%P\\n" | LC_ALL=C sort -u > "$actual"',
    'cmp -s "$expected" "$actual"',
    'while IFS= read -r path; do test -f "$candidate/$path" && test ! -L "$candidate/$path"; done < "$files"',
    'while IFS=$\'\\t\' read -r path target; do test -L "$candidate/$path"; test "$(readlink -- "$candidate/$path")" = "$target"; done < "$symlinks"',
    '(cd -- "$candidate" && sha256sum --check --strict "$checksums" >/dev/null)',
    `test -x "$candidate"/${shellQuote(artifact.node)}`,
    `test -x "$candidate"/${shellQuote(artifact.launcher)}`,
    'if test "$new_runtime" = yes; then mv -- "$temporary" "$runtime"; fi',
    'rm -f -- "$actual" "$listing"',
    'rm -rf -- "$lock"',
    'trap - EXIT HUP INT TERM',
    '',
  ]
  return lines.join('\n')
}

function remoteRosterPaths(remoteRoot: string, artifactSha256: string): {
  readonly expected: string
  readonly files: string
  readonly checksums: string
  readonly symlinks: string
} {
  const root = `${remoteRoot}/verification/${artifactSha256}`
  return Object.freeze({
    expected: `${root}.expected`,
    files: `${root}.files`,
    checksums: `${root}.sha256`,
    symlinks: `${root}.symlinks`,
  })
}

function installedRuntimeVerificationScript(
  reference: RuntimeReference,
  roster: { readonly expected: string; readonly files: string; readonly checksums: string; readonly symlinks: string },
): string {
  const actual = `${reference.runtimeRoot}.verify-${randomUUID()}.actual`
  return [
    'set -euo pipefail',
    `runtime=${shellQuote(reference.runtimeRoot)}`,
    'lock="$runtime.lock"',
    `expected=${shellQuote(roster.expected)}`,
    `files=${shellQuote(roster.files)}`,
    `checksums=${shellQuote(roster.checksums)}`,
    `symlinks=${shellQuote(roster.symlinks)}`,
    `actual=${shellQuote(actual)}`,
    'test -f "$expected"; test -f "$files"; test -f "$checksums"; test -f "$symlinks"',
    'attempt=0; until mkdir -- "$lock" 2>/dev/null; do attempt=$((attempt+1)); if test -f "$lock/owner"; then owner_pid=$(sed -n "s/^pid=//p" "$lock/owner"); owner_time=$(sed -n "s/^time=//p" "$lock/owner"); now=$(date +%s); case "$owner_pid:$owner_time" in *[!0-9:]*|:*) owner_pid=0; owner_time=0;; esac; if test $((now-owner_time)) -gt 600 && ! kill -0 "$owner_pid" 2>/dev/null; then rm -rf -- "$lock"; continue; fi; fi; test "$attempt" -lt 300 || exit 62; sleep 0.2; done',
    'printf "pid=%s\\ntime=%s\\n" "$$" "$(date +%s)" > "$lock/owner"',
    'trap \'rm -f -- "$actual"; rm -rf -- "$lock"\' EXIT HUP INT TERM',
    'test -d "$runtime"',
    'find "$runtime" \\( -type f -o -type l \\) -printf "%P\\n" | LC_ALL=C sort -u > "$actual"',
    'cmp -s "$expected" "$actual"',
    'while IFS= read -r path; do test -f "$runtime/$path" && test ! -L "$runtime/$path"; done < "$files"',
    'while IFS=$\'\\t\' read -r path target; do test -L "$runtime/$path"; test "$(readlink -- "$runtime/$path")" = "$target"; done < "$symlinks"',
    '(cd -- "$runtime" && sha256sum --check --strict "$checksums" >/dev/null)',
    `test -x "$runtime"/${shellQuote(reference.node)}`,
    `test -x "$runtime"/${shellQuote(reference.launcher)}`,
    `test -f "$runtime"/${shellQuote(PROXY_PRELOAD_PATH)}`,
    'rm -f -- "$actual"; rm -rf -- "$lock"',
    'trap - EXIT HUP INT TERM',
    '',
  ].join('\n')
}

function quarantineRuntimeScript(runtimeRoot: string): string {
  return [
    'set -euo pipefail',
    `runtime=${shellQuote(runtimeRoot)}`,
    'test -d "$runtime" || exit 0',
    'lock="$runtime.lock"',
    'attempt=0; until mkdir -- "$lock" 2>/dev/null; do attempt=$((attempt+1)); if test -f "$lock/owner"; then owner_pid=$(sed -n "s/^pid=//p" "$lock/owner"); owner_time=$(sed -n "s/^time=//p" "$lock/owner"); now=$(date +%s); case "$owner_pid:$owner_time" in *[!0-9:]*|:*) owner_pid=0; owner_time=0;; esac; if test $((now-owner_time)) -gt 600 && ! kill -0 "$owner_pid" 2>/dev/null; then rm -rf -- "$lock"; continue; fi; fi; test "$attempt" -lt 300 || exit 62; sleep 0.2; done',
    'printf "pid=%s\\ntime=%s\\n" "$$" "$(date +%s)" > "$lock/owner"',
    'trap \'rm -rf -- "$lock"\' EXIT HUP INT TERM',
    'for exe in /proc/[0-9]*/exe; do resolved=$(readlink -f -- "$exe" 2>/dev/null || true); case "$resolved" in "$runtime"/*) exit 70;; esac; done',
    'quarantine="$runtime.corrupt-$(date +%s)-$$"',
    'mv -- "$runtime" "$quarantine"',
    'rm -rf -- "$lock"',
    'trap - EXIT HUP INT TERM',
    '',
  ].join('\n')
}

function runtimeVerificationRoster(artifact: ManagedRuntimeArtifact): {
  readonly expected: string
  readonly files: string
  readonly checksums: string
  readonly symlinks: string
} {
  validateRuntimeRoster(artifact.entries, artifact.node, artifact.launcher)
  const paths = artifact.entries.map(entry => entry.path).sort()
  const files = artifact.entries.filter((entry): entry is Extract<RuntimeArchiveEntry, { type: 'file' }> => entry.type === 'file')
  const symlinks = artifact.entries.filter((entry): entry is Extract<RuntimeArchiveEntry, { type: 'symlink' }> => entry.type === 'symlink')
  return Object.freeze({
    expected: `${paths.join('\n')}\n`,
    files: `${files.map(entry => entry.path).join('\n')}\n`,
    checksums: `${files.map(entry => `${entry.sha256}  ${entry.path}`).join('\n')}\n`,
    symlinks: symlinks.length === 0 ? '' : `${symlinks.map(entry => `${entry.path}\t${entry.target}`).join('\n')}\n`,
  })
}

function validateRuntimeRoster(
  entries: readonly RuntimeArchiveEntry[],
  nodePath: string,
  launcherPath: string,
): void {
  if (entries.length === 0 || entries.length > 100_000) {
    throw new RemoteRuntimeError('runtime-manifest-invalid', 'Runtime archive roster is empty or too large.', { phase: 'artifact' })
  }
  const paths = new Set<string>()
  for (const entry of entries) {
    if (!safeRosterPath(entry.path) || paths.has(entry.path)) {
      throw new RemoteRuntimeError('runtime-manifest-invalid', 'Runtime archive roster contains an unsafe or duplicate path.', {
        phase: 'artifact',
      })
    }
    paths.add(entry.path)
    if (entry.type === 'file') {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
        throw new RemoteRuntimeError('runtime-manifest-invalid', 'Runtime file integrity metadata is invalid.', { phase: 'artifact' })
      }
    } else if (!safeSymlink(entry.path, entry.target)) {
      throw new RemoteRuntimeError('runtime-manifest-invalid', 'Runtime symlink escapes its extraction root.', { phase: 'artifact' })
    }
  }
  for (const required of ['manifest.json', nodePath, launcherPath, PROXY_PRELOAD_PATH]) {
    if (!entries.some(entry => entry.type === 'file' && entry.path === required)) {
      throw new RemoteRuntimeError('runtime-manifest-incomplete', 'Runtime archive omits a required regular file.', {
        phase: 'artifact',
      })
    }
  }
}

function safeRosterPath(value: string): boolean {
  return value !== '' && !value.startsWith('/') && !/[\\\u0000-\u001f\u007f]/u.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function safeSymlink(member: string, target: string): boolean {
  if (target === '' || target.startsWith('/') || /[\\\u0000-\u001f\u007f]/u.test(target)) return false
  const parts = `${member.slice(0, Math.max(0, member.lastIndexOf('/')))}/${target}`.split('/')
  let depth = 0
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      depth -= 1
      if (depth < 0) return false
    } else {
      depth += 1
    }
  }
  return true
}

function runtimeInfoFromReference(layout: RemoteLayout, reference: RuntimeReference): RemoteRuntimeInfo {
  return Object.freeze({
    runtimeVersion: reference.runtimeVersion,
    dshVersion: reference.dshVersion,
    nodeVersion: reference.nodeVersion,
    artifactSha256: reference.artifactSha256,
    remoteRoot: layout.remoteRoot,
    profileRoot: layout.profileRoot,
    dshHome: layout.dshHome,
    installed: true,
  })
}

function referenceMatchesDescriptor(reference: RuntimeReference, descriptor: RuntimeArtifactManifest): boolean {
  return reference.runtimeVersion === descriptor.runtimeVersion
    && reference.dshVersion === descriptor.dshVersion
    && reference.nodeVersion === descriptor.nodeVersion
    && reference.artifactSha256 === descriptor.archive.sha256
    && reference.node === descriptor.node
    && reference.launcher === descriptor.launcher
}

function parseRuntimeReference(value: unknown): RuntimeReference {
  if (!isRecord(value) || value.version !== 1) throw new TypeError('runtime reference version is invalid')
  const artifactSha256 = stringValue(value.artifactSha256, 'artifactSha256')
  if (!/^[a-f0-9]{64}$/u.test(artifactSha256)) throw new TypeError('artifact SHA-256 is invalid')
  return Object.freeze({
    version: 1,
    runtimeVersion: stringValue(value.runtimeVersion, 'runtimeVersion'),
    dshVersion: stringValue(value.dshVersion, 'dshVersion'),
    nodeVersion: stringValue(value.nodeVersion, 'nodeVersion'),
    artifactSha256,
    runtimeRoot: validateRemotePath(stringValue(value.runtimeRoot, 'runtimeRoot'), 'runtime root'),
    node: safeArtifactPath(value.node, 'node'),
    launcher: safeArtifactPath(value.launcher, 'launcher'),
  })
}

function safeArtifactPath(value: unknown, label: string): string {
  const path = stringValue(value, label)
  if (path.startsWith('/') || path.includes('\0') || path.split('/').some(part => part === '..')) throw new TypeError(`${label} is invalid`)
  return path
}

function check(id: string, status: DoctorCheck['status'], message: string, remediation?: string): DoctorCheck {
  return Object.freeze({ id, status, message, ...(remediation === undefined ? {} : { remediation }) })
}

async function pollCompatible(client: DshOfficialApiClient, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let delay = 100
  let last: unknown
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    try {
      await client.assertCompatible(signal)
      return
    } catch (error: unknown) {
      if (error instanceof DshOfficialApiError && !error.retryable && error.code === 'DSH_VERSION_MISMATCH') throw error
      last = error
    }
    await abortableDelay(delay, signal)
    delay = Math.min(delay * 2, 1_000)
  }
  throw new RemoteRuntimeError('runtime-readiness-timeout', 'Remote Harness did not become ready before the deadline.', {
    phase: 'runtime', retryable: true, cause: last,
  })
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    timer.unref()
    const onAbort = (): void => done(signal.reason ?? new Error('operation cancelled'))
    function done(error?: unknown): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error === undefined) resolve()
      else reject(error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : undefined
      server.close(error => {
        if (error !== undefined) reject(error)
        else if (port === undefined) reject(new Error('failed to allocate loopback port'))
        else resolve(port)
      })
    })
  })
}

function validateApiKey(value: string): string {
  if (value.trim() === '' || value.length > 8_192 || /[\0\r\n]/u.test(value)) {
    throw new RemoteRuntimeError('credential-invalid', 'DeepSeek API key is empty or contains an invalid control character.', {
      phase: 'credential',
    })
  }
  return value
}

function remoteFileUrl(path: string): string {
  const normalized = validateRemotePath(path, 'remote module path')
  return `file://${normalized.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
}

function credentialPatchScript(): string {
  return `
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [, , payloadPath, credentialPath, settingsPath, runtimeRoot] = process.argv
if (!payloadPath || !credentialPath || !settingsPath || !runtimeRoot) throw new Error('credential patch arguments missing')
const require = createRequire(pathToFileURL(join(runtimeRoot, 'app', 'package.json')).href)
const yaml = require('js-yaml')
const readMap = async (path) => {
  try {
    const value = yaml.load(await readFile(path, 'utf8'))
    if (value == null) return {}
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('YAML root is not a mapping')
    return value
  } catch (error) {
    if (error && error.code === 'ENOENT') return {}
    throw error
  }
}
const atomicYaml = async (path, value) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, yaml.dump(value, { noRefs: true, lineWidth: -1 }), { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}
const payload = JSON.parse(await readFile(payloadPath, 'utf8'))
if (typeof payload.apiKey !== 'string' || payload.apiKey.length === 0) throw new Error('credential payload invalid')
const credentials = await readMap(credentialPath)
credentials.DEEPSEEK_API_KEY = payload.apiKey
await atomicYaml(credentialPath, credentials)
const settings = await readMap(settingsPath)
const section = settings['llm-deepseek']
if (section != null && (typeof section !== 'object' || Array.isArray(section))) throw new Error('llm-deepseek settings is not a mapping')
const nextSection = section == null ? {} : { ...section }
if (typeof payload.baseUrl === 'string') nextSection.baseURL = payload.baseUrl
else delete nextSection.baseURL
settings['llm-deepseek'] = nextSection
await atomicYaml(settingsPath, settings)
`
}

function credentialStatusScript(): string {
  return `
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [, , credentialPath, settingsPath, runtimeRoot] = process.argv
if (!credentialPath || !settingsPath || !runtimeRoot) throw new Error('credential status arguments missing')
const require = createRequire(pathToFileURL(join(runtimeRoot, 'app', 'package.json')).href)
const yaml = require('js-yaml')
const readMap = async (path) => {
  try {
    const value = yaml.load(await readFile(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch (error) {
    if (error && error.code === 'ENOENT') return {}
    throw error
  }
}
const credentials = await readMap(credentialPath)
const settings = await readMap(settingsPath)
const section = settings['llm-deepseek']
const baseUrl = section && typeof section === 'object' && !Array.isArray(section) && typeof section.baseURL === 'string'
  ? section.baseURL
  : undefined
process.stdout.write(JSON.stringify({
  configured: Object.prototype.hasOwnProperty.call(credentials, 'DEEPSEEK_API_KEY')
    && typeof credentials.DEEPSEEK_API_KEY === 'string'
    && credentials.DEEPSEEK_API_KEY.length > 0,
  ...(baseUrl === undefined ? {} : { baseUrl }),
}))
`
}

function validateBaseUrl(value: string): string {
  if (value.length > 2_048 || /[\0\r\n]/u.test(value)) {
    throw new RemoteRuntimeError('base-url-invalid', 'DeepSeek base URL is invalid.', { phase: 'credential' })
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RemoteRuntimeError('base-url-invalid', 'DeepSeek base URL must be an absolute HTTP(S) URL.', { phase: 'credential' })
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '') {
    throw new RemoteRuntimeError('base-url-invalid', 'DeepSeek base URL must be HTTP(S) and contain no credentials, query, or fragment.', { phase: 'credential' })
  }
  return url.toString().replace(/\/$/u, '')
}

function decodeBase64(value: string): string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new RemoteRuntimeError('directory-list-invalid', 'Remote directory listing contains invalid base64.', { phase: 'ssh' })
  }
  return Buffer.from(value, 'base64').toString('utf8')
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`)
  return value
}

function safeToken(value: string): string {
  return redactDiagnostic(value).replace(/[^A-Za-z0-9._-]/gu, '?').slice(0, 80) || 'unknown'
}

function parseGlibcVersion(value: string): string | undefined {
  const match = /(?:glibc|GNU libc)\s+(\d+\.\d+)/iu.exec(value)
  return match?.[1]
}

function compareVersion(left: string, right: string): number {
  const [leftMajor = 0, leftMinor = 0] = left.split('.').map(Number)
  const [rightMajor = 0, rightMinor = 0] = right.split('.').map(Number)
  return leftMajor - rightMajor || leftMinor - rightMinor
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${label} must be a non-empty string`)
  return value
}

export function productionRuntimeDependencies(
  ssh: SshRunner,
  tunnels: SshTunnelManager,
): Pick<RemoteRuntimeControllerOptions, 'ssh' | 'tunnels'> {
  return { ssh, tunnels }
}
