#!/usr/bin/env node
/** Small JSON CLI over the same core used by the Cordis Remote. */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RemoteRuntimeError, asRemoteRuntimeError } from './errors.ts'
import { DshRemoteRuntimeCore, type Config } from './service.ts'
import type { RemoteProfileId } from './types.ts'

/** Injectable CLI streams for tests. */
export interface CliIo {
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>
  readonly stderr: Pick<NodeJS.WriteStream, 'write'>
}

/** Run one CLI command and return its process exit code. */
export async function runCli(
  argv: readonly string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  core?: DshRemoteRuntimeCore,
): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    io.stdout.write(helpText())
    return 0
  }
  const owned = core ?? new DshRemoteRuntimeCore(defaultConfig())
  const controller = new AbortController()
  const onSignal = (): void => controller.abort(new Error('CLI interrupted'))
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    await owned.initialize()
    const [command, ...args] = argv
    let value: unknown
    switch (command) {
      case 'list':
      case 'status':
        requireArity(args, 0, command)
        value = await owned.snapshot()
        break
      case 'doctor':
        requireArity(args, 1, command)
        value = await owned.doctor(profileId(args[0]), controller.signal)
        break
      case 'install':
        requireArity(args, 1, command)
        value = await owned.install(profileId(args[0]), controller.signal)
        break
      case 'start': {
        if (args.length < 1 || args.length > 2) throw usageError('start requires PROFILE [CWD]')
        const id = profileId(args[0])
        value = await owned.start({ profileId: id, ...(args[1] === undefined ? {} : { cwd: args[1] }) }, controller.signal)
        break
      }
      case 'stop':
        requireArity(args, 1, command)
        value = await owned.stop(profileId(args[0]), controller.signal)
        break
      case 'disconnect':
        requireArity(args, 1, command)
        value = await owned.disconnect(profileId(args[0]))
        break
      case 'credential-status':
        requireArity(args, 1, command)
        value = await owned.credentialStatus(profileId(args[0]), controller.signal)
        break
      case 'workspaces': {
        requireArity(args, 1, command)
        const id = profileId(args[0])
        await owned.start({ profileId: id }, controller.signal)
        value = await owned.listHarnessWorkspaces(id, controller.signal)
        break
      }
      case 'sessions': {
        requireArity(args, 1, command)
        const id = profileId(args[0])
        await owned.start({ profileId: id }, controller.signal)
        value = await owned.listSessions(id, controller.signal)
        break
      }
      case 'history': {
        if (args.length < 2 || args.length > 3) throw usageError('history requires PROFILE SESSION [BEFORE_SEQ]')
        const id = profileId(args[0])
        const beforeSeq = args[2] === undefined ? undefined : nonNegativeInteger(args[2], 'BEFORE_SEQ')
        await owned.start({ profileId: id }, controller.signal)
        value = await owned.readTranscript(id, args[1]!, beforeSeq, 50, controller.signal)
        break
      }
      default:
        throw usageError(`unknown command ${JSON.stringify(command)}`)
    }
    io.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return 0
  } catch (error: unknown) {
    const failure = asRemoteRuntimeError(error, {
      code: 'cli-failed', message: 'DSH Remote Runtime command failed.', phase: 'runtime',
    })
    io.stderr.write(`${JSON.stringify(failure.serialize())}\n`)
    return failure.code === 'cli-usage' ? 2 : 1
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (core === undefined) await owned.close().catch(() => undefined)
  }
}

function defaultConfig(): Config {
  const root = process.env.DSH_REMOTE_RUNTIME_ROOT
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-remote-runtime')
  return {
    root: resolve(root),
    sshExecutable: process.env.DSH_REMOTE_SSH_COMMAND ?? 'ssh',
    commandTimeoutMs: 30_000,
    maxTranscriptBytes: 64 * 1024 * 1024,
  }
}

function profileId(value: string | undefined): RemoteProfileId {
  if (value === undefined || value.trim() === '') throw usageError('PROFILE must not be empty')
  return value as RemoteProfileId
}

function requireArity(args: readonly string[], expected: number, command: string): void {
  if (args.length !== expected) throw usageError(`${command} requires ${String(expected)} argument(s)`)
}

function nonNegativeInteger(value: string, label: string): number {
  if (!/^\d+$/u.test(value)) throw usageError(`${label} must be a non-negative integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw usageError(`${label} is too large`)
  return parsed
}

function usageError(message: string): RemoteRuntimeError {
  return new RemoteRuntimeError('cli-usage', message, { phase: 'config', remediation: 'Run dsh-remote --help.' })
}

function helpText(): string {
  return `Usage: dsh-remote <command>\n\nCommands:\n  list | status\n  doctor PROFILE\n  install PROFILE\n  start PROFILE [CWD]\n  stop PROFILE\n  disconnect PROFILE\n  credential-status PROFILE\n  workspaces PROFILE\n  sessions PROFILE\n  history PROFILE SESSION [BEFORE_SEQ]\n\nCredential values are intentionally not accepted on argv. Use the Web write-only credential form.\n`
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invoked === import.meta.url) process.exitCode = await runCli(process.argv.slice(2))
