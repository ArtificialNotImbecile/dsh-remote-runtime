import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'
import { SshRunner, type SpawnSshOptions } from '../src/ssh.ts'
import { SshTunnelManager } from '../src/tunnel.ts'
import type { RemoteProfile, RemoteProfileId } from '../src/types.ts'

const PROFILE: RemoteProfile = {
  version: 1,
  id: '11111111-1111-4111-8111-111111111111' as RemoteProfileId,
  name: 'ops-box',
  sshHost: 'ops-box',
  network: { mode: 'remote-direct', clientProxy: { allowedPorts: [80, 443], noProxy: [] } },
  workspaces: [],
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
}

type FakeChild = ChildProcessWithoutNullStreams

class FakeSsh extends SshRunner {
  readonly calls: Array<{ command?: string; options: SpawnSshOptions; child: FakeChild }> = []
  failNext = false
  exitAfterMarker = false

  override spawn(_profile: RemoteProfile, command?: string, options: SpawnSshOptions = {}): ChildProcessWithoutNullStreams {
    const child = fakeChild()
    this.calls.push({ ...(command === undefined ? {} : { command }), options, child })
    queueMicrotask(() => {
      if (this.failNext) {
        this.failNext = false
        ;(child.stderr as PassThrough).write('Proxy-Authorization: Basic secret-token')
        child.emit('exit', 255)
      } else {
        ;(child.stdout as PassThrough).write('DSH_REMOTE_TUNNEL/1\n')
        if (this.exitAfterMarker) {
          this.exitAfterMarker = false
          child.emit('exit', 255)
        }
      }
    })
    return child
  }
}

const managers: SshTunnelManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()))
})

describe('long-lived SSH tunnel manager', () => {
  test('starts one loopback local forward plus the requested reverse proxy forward', async () => {
    const ssh = new FakeSsh()
    const states: string[] = []
    const manager = new SshTunnelManager({ ssh, reconnectBaseMs: 1, reconnectMaxMs: 2, maxReconnectAttempts: 2 })
    managers.push(manager)
    const tunnel = await manager.start(PROFILE, {
      localPort: 32100,
      remotePort: 1455,
      reverseForwards: [{ remoteHost: '127.0.0.1', remotePort: 49152, localHost: '127.0.0.1', localPort: 33333 }],
      onStateChange: (state) => states.push(state),
    })

    expect(tunnel.state).toBe('open')
    expect(tunnel.localUrl).toBe('http://127.0.0.1:32100')
    expect(tunnel.snapshot()).toMatchObject({ localPort: 32100, remotePort: 1455, state: 'open' })
    expect(ssh.calls[0]!.options.localForwards).toEqual([
      { localHost: '127.0.0.1', localPort: 32100, remoteHost: '127.0.0.1', remotePort: 1455 },
    ])
    expect(ssh.calls[0]!.options.remoteForwards).toEqual([
      { remoteHost: '127.0.0.1', remotePort: 49152, localHost: '127.0.0.1', localPort: 33333 },
    ])
    expect(states).toContain('open')
  })

  test('rejects duplicate profile tunnels and non-loopback control binds', async () => {
    const ssh = new FakeSsh()
    const manager = new SshTunnelManager({ ssh })
    managers.push(manager)
    await manager.start(PROFILE, { localPort: 32100, remotePort: 1455 })
    await expect(manager.start(PROFILE, { localPort: 32101, remotePort: 1455 }))
      .rejects.toMatchObject({ code: 'tunnel-already-open' })
    await expect(new SshTunnelManager({ ssh }).start(PROFILE, {
      localHost: '0.0.0.0',
      localPort: 32102,
      remotePort: 1455,
    })).rejects.toMatchObject({ code: 'tunnel-bind-invalid' })
  })

  test('reconnects after unexpected SSH exit and stops reconnecting after close', async () => {
    const ssh = new FakeSsh()
    const manager = new SshTunnelManager({ ssh, reconnectBaseMs: 1, reconnectMaxMs: 2, maxReconnectAttempts: 3 })
    managers.push(manager)
    const tunnel = await manager.start(PROFILE, { localPort: 32100, remotePort: 1455 })
    ssh.calls[0]!.child.emit('exit', 255)

    await waitFor(() => ssh.calls.length === 2 && tunnel.state === 'open')
    expect(tunnel.revision).toBeGreaterThanOrEqual(3)
    await manager.stop(PROFILE.id)
    const count = ssh.calls.length
    ssh.calls.at(-1)!.child.emit('exit', 255)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ssh.calls).toHaveLength(count)
    expect(tunnel.state).toBe('closed')
  })

  test('returns a redacted structured failure when forwarding is disabled', async () => {
    const ssh = new FakeSsh()
    ssh.failNext = true
    const manager = new SshTunnelManager({ ssh })
    managers.push(manager)

    await expect(manager.start(PROFILE, { localPort: 32100, remotePort: 1455 }))
      .rejects.toSatisfy((error: unknown) => {
        const candidate = error as { code?: string; safeDetails?: { diagnostic?: string } }
        return candidate.code === 'ssh-forwarding-failed'
          && !candidate.safeDetails?.diagnostic?.includes('secret-token')
      })
  })

  test('does not report open when SSH exits immediately after its ready marker', async () => {
    const ssh = new FakeSsh()
    ssh.exitAfterMarker = true
    const manager = new SshTunnelManager({ ssh })
    managers.push(manager)

    await expect(manager.start(PROFILE, { localPort: 32100, remotePort: 1455 }))
      .rejects.toMatchObject({ code: 'ssh-forwarding-failed' })
    expect(manager.get(PROFILE.id)).toBeUndefined()
  })
})

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 1234,
    connected: false,
    exitCode: null,
    signalCode: null,
    killed: false,
    spawnargs: [],
    spawnfile: 'ssh',
  })
  child.kill = (() => {
    queueMicrotask(() => child.emit('exit', 0))
    return true
  }) as FakeChild['kill']
  return child
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
