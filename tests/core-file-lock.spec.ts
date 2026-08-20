import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { RemoteRuntimeError } from '../src/errors.ts'
import { withOwnedFileLock } from '../src/file-lock.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-remote-lock-'))
  roots.push(root)
  return root
}

describe('owned file lock', () => {
  test('serializes concurrent writers without losing one', async () => {
    const root = await temporaryRoot()
    const lockPath = path.join(root, 'profiles.json.lock')
    const events: string[] = []
    await Promise.all(Array.from({ length: 12 }, (_, index) => withOwnedFileLock(lockPath, async () => {
      events.push(`start-${index}`)
      await Promise.resolve()
      events.push(`end-${index}`)
    }, { pollMs: 1, staleMs: 5_000 })))

    expect(events).toHaveLength(24)
    for (let index = 0; index < events.length; index += 2) {
      expect(events[index]).toMatch(/^start-/u)
      expect(events[index + 1]).toBe(events[index]!.replace('start-', 'end-'))
    }
  })

  test('reclaims a genuinely stale owner before entering the critical section', async () => {
    const root = await temporaryRoot()
    const lockPath = path.join(root, 'state.lock')
    await mkdir(lockPath)
    const ownerPath = path.join(lockPath, `owner-${randomUUID()}.lock`)
    await writeFile(ownerPath, '{}')
    const old = new Date(Date.now() - 60_000)
    await utimes(ownerPath, old, old)

    let entered = false
    await withOwnedFileLock(lockPath, async () => { entered = true }, { attempts: 1, pollMs: 1, staleMs: 10 })
    expect(entered).toBe(true)
  })

  test('does not steal a live owner', async () => {
    const root = await temporaryRoot()
    const lockPath = path.join(root, 'state.lock')
    await mkdir(lockPath)
    await writeFile(path.join(lockPath, `owner-${randomUUID()}.lock`), '{}')

    await expect(withOwnedFileLock(lockPath, async () => undefined, {
      attempts: 0,
      pollMs: 0,
      staleMs: 60_000,
      timeoutCode: 'test-timeout',
    })).rejects.toMatchObject({ code: 'test-timeout', retryable: true } satisfies Partial<RemoteRuntimeError>)
  })
})
