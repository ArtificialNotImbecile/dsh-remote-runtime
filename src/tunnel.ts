import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { RemoteRuntimeError, redactDiagnostic } from './errors.ts'
import { SshRunner, type LocalForward, type RemoteForward } from './ssh.ts'
import type { RemoteProfile, RemoteProfileId } from './types.ts'

const READY_MARKER = 'DSH_REMOTE_TUNNEL/1'

export type SshTunnelState = 'starting' | 'open' | 'reconnecting' | 'failed' | 'closed'

export interface SshTunnelStartOptions {
  readonly localHost?: string
  readonly localPort: number
  readonly remoteHost?: string
  readonly remotePort: number
  /** Additional client-to-remote forwards, rarely needed by the control plane. */
  readonly localForwards?: readonly LocalForward[]
  /** Remote-to-client forwards, including the authenticated client-proxy gateway. */
  readonly reverseForwards?: readonly RemoteForward[]
  readonly readyTimeoutMs?: number
  readonly reconnect?: boolean
  readonly onStateChange?: (state: SshTunnelState) => void
}

export interface SshTunnelSnapshot {
  readonly profileId: RemoteProfileId
  readonly state: SshTunnelState
  readonly localUrl: string
  readonly localPort: number
  readonly remotePort: number
  readonly revision: number
}

export interface SshTunnelManagerOptions {
  readonly ssh?: SshRunner
  readonly reconnectBaseMs?: number
  readonly reconnectMaxMs?: number
  readonly maxReconnectAttempts?: number
}

/** One local/reverse OpenSSH forwarding connection with automatic reconnection. */
export class ManagedSshTunnel {
  readonly profileId: RemoteProfileId
  readonly localPort: number
  readonly remotePort: number
  readonly localUrl: string

  private child: ChildProcessWithoutNullStreams | undefined
  private closing = false
  private reconnecting?: Promise<void>
  private stateValue: SshTunnelState = 'starting'
  private revisionValue = 0
  private generation = 0

  constructor(
    private readonly profile: RemoteProfile,
    private readonly options: SshTunnelStartOptions,
    private readonly managerOptions: Required<Omit<SshTunnelManagerOptions, 'ssh'>>,
    private readonly ssh: SshRunner,
  ) {
    this.profileId = profile.id
    this.localPort = validatePort(options.localPort, 'Local tunnel port')
    this.remotePort = validatePort(options.remotePort, 'Remote Harness port')
    const localHost = options.localHost ?? '127.0.0.1'
    if (localHost !== '127.0.0.1' && localHost !== '::1') {
      throw new RemoteRuntimeError('tunnel-bind-invalid', 'The local control tunnel must bind loopback only.', {
        phase: 'tunnel',
      })
    }
    this.localUrl = `http://${localHost === '::1' ? '[::1]' : localHost}:${this.localPort}`
  }

  get state(): SshTunnelState {
    return this.stateValue
  }

  get closed(): boolean {
    return this.stateValue === 'closed'
  }

  get revision(): number {
    return this.revisionValue
  }

  snapshot(): SshTunnelSnapshot {
    return {
      profileId: this.profileId,
      state: this.stateValue,
      localUrl: this.localUrl,
      localPort: this.localPort,
      remotePort: this.remotePort,
      revision: this.revisionValue,
    }
  }

  async start(): Promise<this> {
    if (this.closing || this.closed) throw new RemoteRuntimeError('tunnel-closed', 'SSH tunnel is already closed.', { phase: 'tunnel' })
    await this.openTunnel('starting')
    return this
  }

  async close(): Promise<void> {
    if (this.closing || this.closed) return
    this.closing = true
    this.generation += 1
    const child = this.child
    this.child = undefined
    if (child) {
      child.stdin.end()
      child.kill()
    }
    await this.reconnecting?.catch(() => undefined)
    this.setState('closed')
  }

  private async openTunnel(state: 'starting' | 'reconnecting'): Promise<void> {
    if (this.closing) return
    this.setState(state)
    const generation = ++this.generation
    const localHost = this.options.localHost ?? '127.0.0.1'
    const remoteHost = this.options.remoteHost ?? '127.0.0.1'
    const localForwards: LocalForward[] = [
      {
        localHost,
        localPort: this.localPort,
        remoteHost,
        remotePort: this.remotePort,
      },
      ...(this.options.localForwards ?? []),
    ]
    const child = this.ssh.spawn(
      this.profile,
      `printf '${READY_MARKER}\\n'; cat >/dev/null`,
      {
        localForwards,
        remoteForwards: this.options.reverseForwards ?? [],
      },
    )
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    let accepted = false
    let earlyExit: RemoteRuntimeError | undefined
    child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-4_096) })
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384) })

    const timeoutMs = this.options.readyTimeoutMs ?? 10_000
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: RemoteRuntimeError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout.off('data', inspect)
        if (error) reject(error)
        else resolve()
      }
      const inspect = () => {
        if (stdout.includes(READY_MARKER)) finish()
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(new RemoteRuntimeError('tunnel-timeout', 'Timed out waiting for the SSH forwarding connection.', {
          phase: 'tunnel',
          retryable: true,
        }))
      }, timeoutMs)
      timer.unref()
      child.stdout.on('data', inspect)
      child.once('error', (error) => {
        finish(tunnelFailure(this.profile, stderr, undefined, error))
      })
      child.once('exit', (code) => {
        if (!settled) {
          finish(tunnelFailure(this.profile, stderr, code ?? 255))
          return
        }
        if (!accepted) {
          earlyExit = tunnelFailure(this.profile, stderr, code ?? 255)
          return
        }
        if (this.closing || this.child !== child || generation !== this.generation) return
        this.child = undefined
        if (this.options.reconnect === false) {
          this.setState('failed')
          return
        }
        this.reconnecting = this.reconnectLoop()
      })
    })
    if (earlyExit) throw earlyExit
    if (this.closing || generation !== this.generation) {
      child.stdin.end()
      child.kill()
      return
    }
    accepted = true
    this.setState('open')
  }

  private async reconnectLoop(): Promise<void> {
    let delay = this.managerOptions.reconnectBaseMs
    for (let attempt = 1; !this.closing && attempt <= this.managerOptions.maxReconnectAttempts; attempt += 1) {
      await wait(delay)
      if (this.closing) return
      try {
        await this.openTunnel('reconnecting')
        return
      } catch {
        this.closeChild()
        delay = Math.min(delay * 2, this.managerOptions.reconnectMaxMs)
      }
    }
    if (!this.closing) this.setState('failed')
  }

  private closeChild(): void {
    const child = this.child
    this.child = undefined
    if (!child) return
    child.stdin.end()
    child.kill()
  }

  private setState(state: SshTunnelState): void {
    if (this.stateValue === state) return
    this.stateValue = state
    this.revisionValue += 1
    try {
      this.options.onStateChange?.(state)
    } catch {
      // UI observers cannot affect tunnel lifecycle.
    }
  }
}

/** Owns at most one long-lived tunnel per profile. */
export class SshTunnelManager {
  private readonly tunnels = new Map<string, ManagedSshTunnel>()
  private readonly ssh: SshRunner
  private readonly options: Required<Omit<SshTunnelManagerOptions, 'ssh'>>

  constructor(options: SshTunnelManagerOptions = {}) {
    this.ssh = options.ssh ?? new SshRunner()
    this.options = {
      reconnectBaseMs: options.reconnectBaseMs ?? 250,
      reconnectMaxMs: options.reconnectMaxMs ?? 5_000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Number.MAX_SAFE_INTEGER,
    }
    if (this.options.reconnectBaseMs < 0 || this.options.reconnectMaxMs < this.options.reconnectBaseMs) {
      throw new TypeError('Invalid reconnect delay')
    }
    if (!Number.isSafeInteger(this.options.maxReconnectAttempts) || this.options.maxReconnectAttempts < 0) {
      throw new TypeError('maxReconnectAttempts must be a non-negative integer')
    }
  }

  async start(profile: RemoteProfile, options: SshTunnelStartOptions): Promise<ManagedSshTunnel> {
    const existing = this.tunnels.get(profile.id)
    if (existing && !existing.closed) {
      throw new RemoteRuntimeError('tunnel-already-open', `Remote profile ${profile.name} already has a tunnel.`, {
        phase: 'tunnel',
        remediation: 'Stop the existing tunnel before starting another one.',
      })
    }
    const tunnel = new ManagedSshTunnel(profile, options, this.options, this.ssh)
    this.tunnels.set(profile.id, tunnel)
    try {
      await tunnel.start()
      return tunnel
    } catch (error) {
      if (this.tunnels.get(profile.id) === tunnel) this.tunnels.delete(profile.id)
      await tunnel.close()
      throw error
    }
  }

  get(profileId: RemoteProfileId | string): ManagedSshTunnel | undefined {
    return this.tunnels.get(profileId)
  }

  async stop(profileId: RemoteProfileId | string): Promise<void> {
    const tunnel = this.tunnels.get(profileId)
    if (!tunnel) return
    this.tunnels.delete(profileId)
    await tunnel.close()
  }

  async close(): Promise<void> {
    const tunnels = [...this.tunnels.values()]
    this.tunnels.clear()
    await Promise.all(tunnels.map((tunnel) => tunnel.close()))
  }
}

function tunnelFailure(profile: RemoteProfile, stderr: string, exitCode?: number, cause?: unknown): RemoteRuntimeError {
  return new RemoteRuntimeError('ssh-forwarding-failed', `SSH forwarding for ${profile.name} failed.`, {
    phase: 'tunnel',
    retryable: true,
    remediation: 'Check sshd AllowTcpForwarding, DisableForwarding, PermitOpen, and PermitListen policy.',
    safeDetails: {
      exitCode: exitCode ?? null,
      diagnostic: redactDiagnostic(stderr).slice(0, 400),
    },
    cause,
  })
}

function validatePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new RemoteRuntimeError('port-invalid', `${label} must be an integer from 1 through 65535.`, {
      phase: 'config',
    })
  }
  return value
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
  })
}
