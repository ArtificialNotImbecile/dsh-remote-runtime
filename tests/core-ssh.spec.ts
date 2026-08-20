import { describe, expect, test } from 'vitest'
import { RemoteRuntimeError } from '../src/errors.ts'
import {
  SshRunner,
  profileRootShellExpression,
  redactDiagnostic,
  remoteRootShellExpression,
  shellQuote,
  type SshCommandResult,
  type SshRunOptions,
  type UploadOptions,
} from '../src/ssh.ts'
import type { RemoteProfile, RemoteProfileId } from '../src/types.ts'

const PROFILE: RemoteProfile = {
  version: 1,
  id: '11111111-1111-4111-8111-111111111111' as RemoteProfileId,
  name: 'ops-box',
  sshHost: 'ops-box',
  sshPort: 2222,
  network: {
    mode: 'client-proxy',
    clientProxy: { allowedPorts: [80, 443], noProxy: [] },
  },
  workspaces: [],
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
}

class CapturingRunner extends SshRunner {
  readonly calls: Array<{ command: string; input?: string | Uint8Array; options: number | SshRunOptions }> = []
  nextResult: SshCommandResult = {
    code: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  }

  override async run(
    _profile: RemoteProfile,
    command: string,
    input?: string | Uint8Array,
    options: number | SshRunOptions = {},
  ): Promise<SshCommandResult> {
    this.calls.push({ command, ...(input === undefined ? {} : { input }), options })
    return this.nextResult
  }
}

describe('OpenSSH wrapper', () => {
  test('keeps all options and forwards before the validated host', () => {
    const args = new SshRunner().buildArgs(PROFILE, "printf 'ready'", {
      localForwards: [{ localHost: '127.0.0.1', localPort: 32100, remoteHost: '127.0.0.1', remotePort: 1455 }],
      remoteForwards: [{ remoteHost: '127.0.0.1', remotePort: 49152, localHost: '127.0.0.1', localPort: 33333 }],
    })
    const hostIndex = args.indexOf('ops-box')

    expect(hostIndex).toBe(args.length - 2)
    expect(args.at(-1)).toBe("printf 'ready'")
    expect(args.slice(0, hostIndex)).toContain('ExitOnForwardFailure=yes')
    expect(args.slice(0, hostIndex)).not.toContain('ClearAllForwardings=yes')
    expect(args.slice(0, hostIndex)).toContain('127.0.0.1:32100:127.0.0.1:1455')
    expect(args.slice(0, hostIndex)).toContain('127.0.0.1:49152:127.0.0.1:33333')
  })

  test('uses BatchMode and rejects host, command, and forwarding option injection', () => {
    const runner = new SshRunner()
    expect(runner.baseArgs(PROFILE)).toEqual(expect.arrayContaining(['BatchMode=yes', 'ServerAliveInterval=15']))
    expect(() => runner.buildArgs({ ...PROFILE, sshHost: '-oProxyCommand=evil' }, 'true'))
      .toThrowError(RemoteRuntimeError)
    expect(() => runner.buildArgs(PROFILE, 'first\nsecond')).toThrowError(RemoteRuntimeError)
    expect(() => runner.buildArgs(PROFILE, 'true', {
      localForwards: [{ localHost: '127.0.0.1,evil', localPort: 1, remoteHost: '127.0.0.1', remotePort: 2 }],
    })).toThrowError(RemoteRuntimeError)
    expect(() => runner.buildArgs(PROFILE, 'true', {
      localForwards: [{ localHost: '0.0.0.0', localPort: 1, remoteHost: '127.0.0.1', remotePort: 2 }],
    })).toThrowError(expect.objectContaining({ code: 'forward-listener-invalid' }))
    expect(() => runner.buildArgs(PROFILE, 'true', {
      remoteForwards: [{ remoteHost: '0.0.0.0', remotePort: 1, localHost: '127.0.0.1', localPort: 2 }],
    })).toThrowError(expect.objectContaining({ code: 'forward-listener-invalid' }))
  })

  test('quotes shell literals and derives isolated default roots', () => {
    expect(shellQuote("a'b c")).toBe("'a'\"'\"'b c'")
    expect(() => shellQuote('bad\nvalue')).toThrowError(RemoteRuntimeError)
    expect(remoteRootShellExpression(PROFILE)).toBe('"${XDG_DATA_HOME:-$HOME/.local/share}/dsh-remote-runtime"')
    expect(profileRootShellExpression(PROFILE)).toBe(
      '"${XDG_DATA_HOME:-$HOME/.local/share}/dsh-remote-runtime/profiles/11111111-1111-4111-8111-111111111111"',
    )
    const custom = { ...PROFILE, remoteRoot: '/var/lib/dsh remote' }
    expect(profileRootShellExpression(custom)).toBe("'/var/lib/dsh remote/profiles/11111111-1111-4111-8111-111111111111'")
  })

  test('uploads through stdin to a unique temporary and publishes atomically', async () => {
    const runner = new CapturingRunner()
    const result = await runner.upload(PROFILE, "/srv/app/config's.json", 'hello', {
      mode: 0o600,
      force: false,
    })

    expect(result).toEqual({ path: "/srv/app/config's.json", bytes: 5 })
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.input).toEqual(Buffer.from('hello'))
    expect(runner.calls[0]!.command).toContain('.dsh-remote-')
    expect(runner.calls[0]!.command).toContain('cat > "$temporary"')
    expect(runner.calls[0]!.command).toContain('chmod 600 "$temporary"')
    expect(runner.calls[0]!.command).toContain('if test -e "$target"; then exit 73; fi')
    expect(runner.calls[0]!.command).toContain('ln -- "$temporary" "$target"')
    expect(runner.calls[0]!.command).not.toContain('hello')
  })

  test('does not overwrite without explicit force and bounds upload size', async () => {
    const runner = new CapturingRunner()
    runner.nextResult = { ...runner.nextResult, code: 73 }
    await expect(runner.upload(PROFILE, '/srv/app/config.json', 'value'))
      .rejects.toMatchObject({ code: 'remote-file-exists' })
    await expect(runner.upload(PROFILE, '/srv/app/large.bin', new Uint8Array(5), { maxBytes: 4 } satisfies UploadOptions))
      .rejects.toMatchObject({ code: 'file-too-large' })
    await expect(runner.upload(PROFILE, '../relative', 'value')).rejects.toMatchObject({ code: 'remote-path-invalid' })
  })

  test('redacts credentials from bounded SSH diagnostics', () => {
    const value = redactDiagnostic('Proxy-Authorization: Basic abc api_key=sk-live https://u:p@proxy/')
    expect(value).not.toContain('abc')
    expect(value).not.toContain('sk-live')
    expect(value).not.toContain('u:p')
  })

  test('reports bash as an explicit remote prerequisite', async () => {
    const runner = new CapturingRunner()
    runner.nextResult = {
      ...runner.nextResult,
      stdout: 'DSH_REMOTE_PROBE/1|Linux|x86_64|glibc 2.31|yes|yes|yes|no\n',
    }
    await expect(runner.probe(PROFILE)).resolves.toMatchObject({
      platform: 'Linux',
      arch: 'x86_64',
      bash: false,
    })
    expect(runner.calls[0]!.input).toContain('command -v bash')
  })
})
