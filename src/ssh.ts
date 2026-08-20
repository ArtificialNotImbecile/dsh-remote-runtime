import { spawn as spawnProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { RemoteRuntimeError, errnoCode, redactDiagnostic } from './errors.ts'
import { validateRemotePath } from './profiles.ts'
import type { RemoteProfile } from './types.ts'

const DEFAULT_MAX_CAPTURE_BYTES = 1024 * 1024
export const DEFAULT_FILE_TRANSFER_BYTES = 64 * 1024 * 1024
export const MAX_RUNTIME_UPLOAD_BYTES = 512 * 1024 * 1024

export interface SshCommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export interface SshBinaryResult {
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export interface RemoteProbe {
  readonly platform: string
  readonly arch: string
  readonly libc: string
  readonly homeWritable: boolean
  readonly tar: boolean
  readonly sha256sum: boolean
  readonly bash: boolean
}

export interface LocalForward {
  readonly localHost: string
  readonly localPort: number
  readonly remoteHost: string
  readonly remotePort: number
}

export interface RemoteForward {
  readonly remoteHost: string
  readonly remotePort: number
  readonly localHost: string
  readonly localPort: number
}

export interface SpawnSshOptions {
  readonly tty?: boolean
  readonly noCommand?: boolean
  readonly localForwards?: readonly LocalForward[]
  readonly remoteForwards?: readonly RemoteForward[]
  readonly stdio?: SpawnOptions['stdio']
  readonly extraArgs?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}

export interface SshRunOptions {
  readonly timeoutMs?: number
  readonly maxCaptureBytes?: number
}

export interface UploadOptions {
  readonly force?: boolean
  readonly mode?: number
  readonly maxBytes?: number
  readonly timeoutMs?: number
}

export interface DownloadOptions {
  readonly maxBytes?: number
  readonly timeoutMs?: number
}

type SpawnFunction = typeof spawnProcess

/** System OpenSSH wrapper. No shell is used to assemble local argv. */
export class SshRunner {
  readonly executable: string
  readonly port?: number
  private readonly spawnProcess: SpawnFunction

  constructor(options: { readonly executable?: string; readonly port?: number; readonly spawn?: SpawnFunction } = {}) {
    this.executable = options.executable || process.env.DSH_REMOTE_RUNTIME_SSH_COMMAND
      || process.env.DSH_REMOTE_SSH_COMMAND || 'ssh'
    if (options.port !== undefined) this.port = validateTcpPort(options.port, 'SSH port')
    this.spawnProcess = options.spawn ?? spawnProcess
  }

  baseArgs(profile: RemoteProfile): string[] {
    assertSafeSshHost(profile.sshHost)
    const port = profile.sshPort ?? this.port
    return [
      ...(port === undefined ? [] : ['-p', String(validateTcpPort(port, 'SSH port'))]),
      '-o', 'BatchMode=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ClearAllForwardings=yes',
      profile.sshHost,
    ]
  }

  buildArgs(profile: RemoteProfile, remoteCommand?: string, options: SpawnSshOptions = {}): string[] {
    if (remoteCommand !== undefined && /[\0\r\n]/u.test(remoteCommand)) {
      // Commands built by package code may contain newlines; callers that need a
      // script should deliberately use `sh -s` and send it over stdin instead.
      throw new RemoteRuntimeError('ssh-command-invalid', 'Remote command contains a record separator.', { phase: 'ssh' })
    }
    const localForwards = options.localForwards ?? []
    const remoteForwards = options.remoteForwards ?? []
    const hasForwards = localForwards.length > 0 || remoteForwards.length > 0
    const args = this.baseArgs(profile)
    if (hasForwards) {
      const clearIndex = args.indexOf('ClearAllForwardings=yes')
      if (clearIndex >= 1 && args[clearIndex - 1] === '-o') args.splice(clearIndex - 1, 2)
      args.splice(args.length - 1, 0, '-o', 'ExitOnForwardFailure=yes')
    }
    for (const forward of localForwards) {
      args.splice(args.length - 1, 0, '-L', formatLocalForward(forward))
    }
    for (const forward of remoteForwards) {
      args.splice(args.length - 1, 0, '-R', formatRemoteForward(forward))
    }
    if (options.extraArgs?.length) {
      for (const arg of options.extraArgs) {
        if (/\0|\r|\n/u.test(arg)) throw new RemoteRuntimeError('ssh-argument-invalid', 'SSH argument contains a record separator.', { phase: 'ssh' })
      }
      args.splice(args.length - 1, 0, ...options.extraArgs)
    }
    if (options.noCommand) {
      args.splice(args.length - 1, 0, '-N', '-T')
    } else {
      args.splice(args.length - 1, 0, options.tty ? '-tt' : '-T')
      if (remoteCommand !== undefined) args.push(remoteCommand)
    }
    // Defensive invariant: every option must precede the validated host.
    const expectedHostIndex = remoteCommand === undefined ? args.length - 1 : args.length - 2
    if (args[expectedHostIndex] !== profile.sshHost) {
      // No user-facing data is included if this package invariant ever breaks.
      throw new RemoteRuntimeError('ssh-argv-invalid', 'Failed to assemble a safe OpenSSH argument vector.', { phase: 'ssh' })
    }
    return args
  }

  spawn(profile: RemoteProfile, remoteCommand?: string, options: SpawnSshOptions = {}): ChildProcessWithoutNullStreams {
    return this.spawnProcess(this.executable, this.buildArgs(profile, remoteCommand, options), {
      windowsHide: true,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'pipe',
    }) as ChildProcessWithoutNullStreams
  }

  async run(
    profile: RemoteProfile,
    remoteCommand: string,
    input?: string | Uint8Array,
    options: number | SshRunOptions = {},
  ): Promise<SshCommandResult> {
    const result = await this.runBinary(profile, remoteCommand, input, options)
    return {
      ...result,
      stdout: result.stdout.toString('utf8'),
    }
  }

  async runBinary(
    profile: RemoteProfile,
    remoteCommand: string,
    input?: string | Uint8Array,
    options: number | SshRunOptions = {},
  ): Promise<SshBinaryResult> {
    const normalizedOptions = typeof options === 'number' ? { timeoutMs: options } : options
    const timeoutMs = normalizedOptions.timeoutMs ?? 30_000
    const maxCaptureBytes = normalizedOptions.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive')
    if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes < 1) throw new TypeError('maxCaptureBytes must be a positive integer')

    const child = this.spawn(profile, remoteCommand)
    const stdout = boundedCollector(maxCaptureBytes)
    const stderr = boundedCollector(maxCaptureBytes)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const inputComplete = finishSshInput(child, input)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    timeout.unref()
    let code: number
    try {
      const [[exitCode]] = await Promise.all([
        once(child, 'close') as Promise<[number | null]>,
        inputComplete,
      ])
      code = exitCode ?? 255
    } catch (error) {
      child.kill()
      throw mapSshFailure(error, stderr.text(), profile)
    } finally {
      clearTimeout(timeout)
    }
    if (timedOut) {
      throw new RemoteRuntimeError('ssh-timeout', `SSH operation for ${profile.name} timed out.`, {
        phase: 'ssh',
        retryable: true,
        safeDetails: { timeoutMs },
      })
    }
    return {
      code,
      stdout: stdout.buffer(),
      stderr: stderr.text(),
      stdoutTruncated: stdout.truncated(),
      stderrTruncated: stderr.truncated(),
    }
  }

  async probe(profile: RemoteProfile): Promise<RemoteProbe> {
    const script = [
      'set -eu',
      'platform=$(uname -s 2>/dev/null || printf unknown)',
      'arch=$(uname -m 2>/dev/null || printf unknown)',
      'libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || printf unknown)',
      'home_write=no; test -d "$HOME" && test -w "$HOME" && home_write=yes',
      'tar_ok=no; command -v tar >/dev/null 2>&1 && tar_ok=yes',
      'sha_ok=no; command -v sha256sum >/dev/null 2>&1 && sha_ok=yes',
      'bash_ok=no; command -v bash >/dev/null 2>&1 && bash_ok=yes',
      'printf "DSH_REMOTE_PROBE/1|%s|%s|%s|%s|%s|%s|%s\\n" "$platform" "$arch" "$libc" "$home_write" "$tar_ok" "$sha_ok" "$bash_ok"',
      '',
    ].join('\n')
    const result = await this.run(profile, 'sh -s', script, { timeoutMs: 20_000 })
    if (result.code !== 0) throw mapSshFailure(undefined, result.stderr, profile, result.code)
    const normalized = result.stdout.replace(/\r\n/gu, '\n').trimEnd()
    const lines = normalized.split('\n')
    if (lines.length !== 1 || !lines[0]!.startsWith('DSH_REMOTE_PROBE/1|')) {
      throw new RemoteRuntimeError('remote-shell-output-contaminated', 'Remote shell printed unexpected bootstrap output.', {
        phase: 'doctor',
        remediation: 'Remove output from non-interactive shell startup files such as .bashrc or ~/.ssh/rc.',
        safeDetails: { sample: redactDiagnostic(normalized).slice(0, 240) },
      })
    }
    const [, platform, arch, libc, homeWritable, tar, sha256sum, bash] = lines[0]!.split('|')
    return {
      platform: platform || 'unknown',
      arch: arch || 'unknown',
      libc: libc || 'unknown',
      homeWritable: homeWritable === 'yes',
      tar: tar === 'yes',
      sha256sum: sha256sum === 'yes',
      bash: bash === 'yes',
    }
  }

  /** Upload an in-memory payload through SSH stdin and publish it atomically. */
  async upload(
    profile: RemoteProfile,
    remotePath: string,
    data: string | Uint8Array,
    options: UploadOptions = {},
  ): Promise<{ readonly path: string; readonly bytes: number }> {
    const target = validateRemotePath(remotePath, 'upload target')
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    const maxBytes = options.maxBytes ?? DEFAULT_FILE_TRANSFER_BYTES
    if (bytes.length > maxBytes) throw transferTooLarge(bytes.length, maxBytes)
    const command = buildUploadCommand(target, bytes.length, options)
    const result = await this.run(profile, command, bytes, {
      timeoutMs: options.timeoutMs ?? 5 * 60_000,
      maxCaptureBytes: 64 * 1024,
    })
    assertUploadResult(result.code, result.stderr, profile, target)
    return { path: target, bytes: bytes.length }
  }

  async uploadFile(
    profile: RemoteProfile,
    localPath: string,
    remotePath: string,
    options: UploadOptions = {},
  ): Promise<{ readonly path: string; readonly bytes: number }> {
    const info = await stat(localPath).catch((error) => {
      throw new RemoteRuntimeError('local-file-read-failed', 'Failed to read the local upload source.', {
        phase: 'ssh',
        cause: error,
      })
    })
    if (!info.isFile()) throw new RemoteRuntimeError('local-file-invalid', 'Upload source must be one regular file.', { phase: 'ssh' })
    const maxBytes = options.maxBytes ?? DEFAULT_FILE_TRANSFER_BYTES
    if (info.size > maxBytes) throw transferTooLarge(info.size, maxBytes)
    return this.uploadFileStream(profile, localPath, remotePath, info.size, options)
  }

  private async uploadFileStream(
    profile: RemoteProfile,
    localPath: string,
    remotePath: string,
    expectedBytes: number,
    options: UploadOptions,
  ): Promise<{ readonly path: string; readonly bytes: number }> {
    const target = validateRemotePath(remotePath, 'upload target')
    const child = this.spawn(profile, buildUploadCommand(target, expectedBytes, options))
    const stdout = boundedCollector(64 * 1024)
    const stderr = boundedCollector(64 * 1024)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const source = createReadStream(localPath)
    let transferError: unknown
    const transfer = pipeline(source, child.stdin).catch((error: unknown) => {
      transferError = error
    })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      source.destroy()
      child.kill()
    }, options.timeoutMs ?? 10 * 60_000)
    timeout.unref()
    let code = 255
    try {
      const [[exitCode]] = await Promise.all([
        once(child, 'close') as Promise<[number | null]>,
        transfer,
      ])
      code = exitCode ?? 255
    } catch (error) {
      source.destroy()
      child.kill()
      throw mapSshFailure(error, stderr.text(), profile)
    } finally {
      clearTimeout(timeout)
    }
    if (timedOut) {
      throw new RemoteRuntimeError('ssh-timeout', `SSH upload for ${profile.name} timed out.`, {
        phase: 'ssh',
        retryable: true,
      })
    }
    // A no-clobber refusal is authoritative even though its early exit can also
    // surface as EPIPE in the local stream.
    if (code === 73) assertUploadResult(code, stderr.text(), profile, target)
    if (transferError && !['EPIPE', 'ECONNRESET'].includes(errnoCode(transferError) ?? '')) {
      throw new RemoteRuntimeError('local-file-read-failed', 'Failed while streaming the local upload source.', {
        phase: 'ssh',
        cause: transferError,
      })
    }
    assertUploadResult(code, stderr.text(), profile, target)
    if (transferError) {
      throw new RemoteRuntimeError('ssh-upload-incomplete', 'SSH closed before the complete file was uploaded.', {
        phase: 'ssh',
        retryable: true,
      })
    }
    return { path: target, bytes: expectedBytes }
  }

  async download(profile: RemoteProfile, remotePath: string, options: DownloadOptions = {}): Promise<Buffer> {
    const target = validateRemotePath(remotePath, 'download target')
    const maxBytes = options.maxBytes ?? DEFAULT_FILE_TRANSFER_BYTES
    const result = await this.runBinary(profile, `set -eu; test -f ${shellQuote(target)}; cat -- ${shellQuote(target)}`, undefined, {
      timeoutMs: options.timeoutMs ?? 5 * 60_000,
      maxCaptureBytes: maxBytes + 1,
    })
    if (result.stdoutTruncated || result.stdout.length > maxBytes) throw transferTooLarge(result.stdout.length, maxBytes)
    if (result.code !== 0) throw mapSshFailure(undefined, result.stderr, profile, result.code)
    return result.stdout
  }
}

export function shellQuote(value: string): string {
  if (/[\0\r\n]/u.test(value)) {
    throw new RemoteRuntimeError('shell-argument-invalid', 'Remote shell argument contains a control character.', { phase: 'ssh' })
  }
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

export function remoteRootShellExpression(profile: RemoteProfile): string {
  return profile.remoteRoot === undefined
    ? '"${XDG_DATA_HOME:-$HOME/.local/share}/dsh-remote-runtime"'
    : shellQuote(profile.remoteRoot)
}

/** Shell-safe absolute profile root; separate profiles never share Harness state. */
export function profileRootShellExpression(profile: RemoteProfile): string {
  return profile.remoteRoot === undefined
    ? `"\${XDG_DATA_HOME:-$HOME/.local/share}/dsh-remote-runtime/profiles/${profile.id}"`
    : shellQuote(`${profile.remoteRoot.replace(/\/+$/u, '')}/profiles/${profile.id}`)
}

export { redactDiagnostic }

function formatLocalForward(forward: LocalForward): string {
  return `${validateListenerHost(forward.localHost)}:${validateTcpPort(forward.localPort, 'Local forward port')}:${validateForwardHost(forward.remoteHost)}:${validateTcpPort(forward.remotePort, 'Remote service port')}`
}

function formatRemoteForward(forward: RemoteForward): string {
  return `${validateListenerHost(forward.remoteHost)}:${validateTcpPort(forward.remotePort, 'Remote forward port')}:${validateForwardHost(forward.localHost)}:${validateTcpPort(forward.localPort, 'Local service port')}`
}

function validateListenerHost(value: string): string {
  const normalized = value.trim().replace(/^\[|\]$/gu, '').toLocaleLowerCase()
  if (!['127.0.0.1', '::1', 'localhost'].includes(normalized)) {
    throw new RemoteRuntimeError('forward-listener-invalid', 'SSH forwarding listeners must bind loopback only.', {
      phase: 'tunnel',
    })
  }
  return validateForwardHost(value)
}

function validateForwardHost(value: string): string {
  const normalized = value.trim()
  if (!normalized || /[\s\0\r\n,]/u.test(normalized) || normalized.startsWith('-')) {
    throw new RemoteRuntimeError('forward-host-invalid', 'SSH forwarding host is invalid.', { phase: 'tunnel' })
  }
  return normalized.includes(':') && !normalized.startsWith('[') ? `[${normalized}]` : normalized
}

function validateTcpPort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new RemoteRuntimeError('port-invalid', `${label} must be an integer from 1 through 65535.`, { phase: 'config' })
  }
  return value
}

function validateFileMode(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0o777) throw new TypeError('mode must be between 000 and 777')
  return value.toString(8).padStart(3, '0')
}

function buildUploadCommand(target: string, expectedBytes: number, options: UploadOptions): string {
  const mode = validateFileMode(options.mode ?? 0o600)
  const temporarySuffix = randomUUID().replaceAll('-', '')
  return [
    'set -eu',
    `target=${shellQuote(target)}`,
    'parent=$(dirname -- "$target")',
    'mkdir -p -- "$parent"',
    options.force ? ':' : 'if test -e "$target"; then exit 73; fi',
    `temporary="$target.dsh-remote-runtime-${temporarySuffix}.tmp"`,
    'trap \"rm -f -- \\\"$temporary\\\"\" EXIT HUP INT TERM',
    'umask 077',
    'cat > "$temporary"',
    'actual=$(wc -c < "$temporary" | tr -d "[:space:]")',
    `test "$actual" = ${shellQuote(String(expectedBytes))} || exit 74`,
    `chmod ${mode} "$temporary"`,
    options.force
      ? 'mv -f -- "$temporary" "$target"'
      : 'if ln -- "$temporary" "$target"; then rm -f -- "$temporary"; elif test -e "$target"; then exit 73; else exit 75; fi',
    'trap - EXIT HUP INT TERM',
    '',
  ].join('; ')
}

function assertUploadResult(code: number, stderr: string, profile: RemoteProfile, target: string): void {
  if (code === 73) {
    throw new RemoteRuntimeError('remote-file-exists', 'Remote upload target already exists.', {
      phase: 'ssh',
      remediation: 'Choose another path or explicitly allow replacement.',
      safeDetails: { path: target },
    })
  }
  if (code === 74) {
    throw new RemoteRuntimeError('ssh-upload-incomplete', 'Remote host refused an incomplete upload.', {
      phase: 'ssh',
      retryable: true,
    })
  }
  if (code !== 0) throw mapSshFailure(undefined, stderr, profile, code)
}

function assertSafeSshHost(value: string): void {
  if (!value || value.startsWith('-') || /[\s\0\r\n]/u.test(value)) {
    throw new RemoteRuntimeError('ssh-host-invalid', 'SSH host must be a host or OpenSSH alias, not an option or command.', {
      phase: 'config',
    })
  }
}

function boundedCollector(maxBytes: number): {
  push(chunk: Uint8Array): void
  buffer(): Buffer
  text(): string
  truncated(): boolean
} {
  const chunks: Buffer[] = []
  let bytes = 0
  let wasTruncated = false
  return {
    push(chunk) {
      const buffer = Buffer.from(chunk)
      const remaining = maxBytes - bytes
      if (remaining > 0) {
        const kept = buffer.subarray(0, remaining)
        chunks.push(Buffer.from(kept))
        bytes += kept.length
      }
      if (buffer.length > remaining) wasTruncated = true
    },
    buffer: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: () => wasTruncated,
  }
}

function finishSshInput(child: ChildProcessWithoutNullStreams, input?: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error | null) => {
      if (settled) return
      settled = true
      child.stdin.off('error', onError)
      if (error && !['EPIPE', 'ECONNRESET'].includes(errnoCode(error) ?? '')) reject(error)
      else resolve()
    }
    const onError = (error: Error) => finish(error)
    child.stdin.once('error', onError)
    if (input === undefined) child.stdin.end(() => finish())
    else child.stdin.end(input, () => finish())
  })
}

function mapSshFailure(error: unknown, stderr: string, profile: RemoteProfile, code?: number): RemoteRuntimeError {
  const lower = stderr.toLocaleLowerCase()
  let failureCode = 'ssh-failed'
  let remediation = 'Verify the SSH profile and run ssh manually for detailed diagnostics.'
  if (lower.includes('permission denied') || lower.includes('authentication failed')) {
    failureCode = 'ssh-auth-failed'
    remediation = 'Configure key or ssh-agent authentication for this OpenSSH host.'
  } else if (lower.includes('connection timed out') || lower.includes('no route to host')
    || lower.includes('could not resolve hostname') || lower.includes('connection refused')) {
    failureCode = 'ssh-unreachable'
    remediation = 'Verify hostname, port, ProxyJump, routing, and that sshd is running.'
  }
  return new RemoteRuntimeError(failureCode, `SSH connection to ${profile.name} failed.`, {
    phase: 'ssh',
    retryable: failureCode === 'ssh-unreachable',
    remediation,
    safeDetails: { exitCode: code ?? null, diagnostic: redactDiagnostic(stderr).slice(0, 400) },
    cause: error,
  })
}

function transferTooLarge(bytes: number, limit: number): RemoteRuntimeError {
  return new RemoteRuntimeError('file-too-large', 'File exceeds the bounded SSH transfer limit.', {
    phase: 'ssh',
    safeDetails: { bytes, limit },
  })
}
