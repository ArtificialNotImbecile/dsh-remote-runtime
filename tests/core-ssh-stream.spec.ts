import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test } from 'vitest'
import {
  DEFAULT_FILE_TRANSFER_BYTES,
  MAX_RUNTIME_UPLOAD_BYTES,
  SshRunner,
  type SpawnSshOptions,
} from '../src/ssh.ts'
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

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class StreamingRunner extends SshRunner {
  chunks = 0
  bytes = 0
  calls = 0
  command = ''

  override spawn(_profile: RemoteProfile, command?: string, _options: SpawnSshOptions = {}): ChildProcessWithoutNullStreams {
    this.calls += 1
    this.command = command ?? ''
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    stdin.on('data', (chunk: Buffer) => {
      this.chunks += 1
      this.bytes += chunk.length
    })
    stdin.once('finish', () => queueMicrotask(() => child.emit('close', 0)))
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      pid: 123,
      connected: false,
      exitCode: null,
      signalCode: null,
      killed: false,
      spawnargs: [],
      spawnfile: 'ssh',
      kill: () => true,
    })
    return child
  }
}

describe('streaming SSH upload', () => {
  test('streams a regular file in chunks and verifies byte count before atomic publish', async () => {
    const root = await temporaryRoot()
    const localPath = path.join(root, 'runtime.tar.gz')
    const size = 2 * 1024 * 1024 + 17
    await writeFile(localPath, Buffer.alloc(size, 0x5a))
    const runner = new StreamingRunner()

    const result = await runner.uploadFile(PROFILE, localPath, '/var/lib/dsh/runtime.tar.gz', {
      maxBytes: MAX_RUNTIME_UPLOAD_BYTES,
      force: true,
    })

    expect(result.bytes).toBe(size)
    expect(runner.bytes).toBe(size)
    expect(runner.chunks).toBeGreaterThan(1)
    expect(runner.command).toContain('cat > "$temporary"')
    expect(runner.command).toContain('actual=$(wc -c < "$temporary"')
    expect(runner.command).toContain(`test "$actual" = '${size}' || exit 74`)
    expect(runner.command).toContain('mv -f -- "$temporary" "$target"')
  })

  test('keeps ordinary transfers at 64 MiB but permits an explicit 512 MiB runtime ceiling', async () => {
    expect(DEFAULT_FILE_TRANSFER_BYTES).toBe(64 * 1024 * 1024)
    expect(MAX_RUNTIME_UPLOAD_BYTES).toBe(512 * 1024 * 1024)
    const root = await temporaryRoot()
    const oversized = path.join(root, 'oversized.bin')
    const handle = await open(oversized, 'w')
    await handle.truncate(DEFAULT_FILE_TRANSFER_BYTES + 1)
    await handle.close()
    const runner = new StreamingRunner()

    await expect(runner.uploadFile(PROFILE, oversized, '/tmp/oversized.bin'))
      .rejects.toMatchObject({ code: 'file-too-large' })
    expect(runner.calls).toBe(0)
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-remote-stream-'))
  roots.push(root)
  return root
}
