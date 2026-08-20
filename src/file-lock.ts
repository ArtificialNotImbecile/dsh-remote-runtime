import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { RemoteRuntimeError, errnoCode, type RemoteRuntimeErrorPhase } from './errors.ts'

export interface OwnedFileLockOptions {
  readonly attempts?: number
  readonly pollMs?: number
  readonly staleMs?: number
  readonly timeoutCode?: string
  readonly timeoutMessage?: string
  readonly phase?: RemoteRuntimeErrorPhase
}

const OWNER_NAME = /^owner-[0-9a-f-]{36}\.lock$/u
const RELEASING_NAME = /^releasing-[0-9a-f-]{36}-[0-9a-f-]{36}\.lock$/u
const LOCK_COLLISION_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'])

/** Remove exactly one cryptographically unique owner from a lock directory. */
export async function removeOwnedLock(lockPath: string, ownerName: string): Promise<boolean> {
  const tombstonePath = await claimOwnedLock(lockPath, ownerName)
  if (!tombstonePath) return false
  await finishOwnedLockRemoval(lockPath, tombstonePath)
  return true
}

/** Claim a stale owner, restoring it if a heartbeat landed after observation. */
export async function reclaimOwnedLock(
  lockPath: string,
  ownerName: string,
  observedMtimeMs: number,
  staleBefore: number,
): Promise<boolean> {
  const tombstonePath = await claimOwnedLock(lockPath, ownerName)
  if (!tombstonePath) return false
  const claimed = await stat(tombstonePath).catch(() => null)
  if (claimed && (claimed.mtimeMs !== observedMtimeMs || claimed.mtimeMs > staleBefore)) {
    await rename(tombstonePath, path.join(lockPath, ownerName))
    return false
  }
  await finishOwnedLockRemoval(lockPath, tombstonePath)
  return true
}

async function claimOwnedLock(lockPath: string, ownerName: string): Promise<string | undefined> {
  if (!OWNER_NAME.test(ownerName)) throw new TypeError('Invalid lock owner name')
  const tombstoneName = `releasing-${ownerName.slice(6, -5)}-${randomUUID()}.lock`
  const tombstonePath = path.join(lockPath, tombstoneName)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rename(path.join(lockPath, ownerName), tombstonePath)
      return tombstonePath
    } catch (error) {
      const code = errnoCode(error)
      if (code === 'ENOENT') return undefined
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt === 19) throw error
      await transientDelay(attempt)
    }
  }
  return undefined
}

async function finishOwnedLockRemoval(lockPath: string, tombstonePath: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(tombstonePath, { force: true })
      break
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(errnoCode(error) ?? '') || attempt === 19) throw error
      await transientDelay(attempt)
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rmdir(lockPath)
      return
    } catch (error) {
      const code = errnoCode(error)
      if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code ?? '')) return
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '') || attempt === 19) throw error
      await transientDelay(attempt)
    }
  }
}

/**
 * Cross-process directory lock with a heartbeat and owner-safe stale recovery.
 * A delayed releaser can never remove a newer owner's lock directory.
 */
export async function withOwnedFileLock<T>(
  lockPath: string,
  run: () => Promise<T>,
  options: OwnedFileLockOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 100
  const pollMs = options.pollMs ?? 50
  const staleMs = options.staleMs ?? 30_000
  if (!Number.isInteger(attempts) || attempts < 0) throw new TypeError('attempts must be a non-negative integer')
  if (!Number.isFinite(pollMs) || pollMs < 0) throw new TypeError('pollMs must be non-negative')
  if (!Number.isFinite(staleMs) || staleMs <= 0) throw new TypeError('staleMs must be positive')

  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  const ownerName = `owner-${randomUUID()}.lock`
  const candidatePath = `${lockPath}.candidate-${randomUUID()}`
  await mkdir(candidatePath, { mode: 0o700 })
  await writeFile(
    path.join(candidatePath, ownerName),
    `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  )

  let acquired = false
  try {
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try {
        await rename(candidatePath, lockPath)
        acquired = true
        break
      } catch (error) {
        if (!LOCK_COLLISION_CODES.has(errnoCode(error) ?? '')) throw error
      }

      await reclaimStaleLock(lockPath, Date.now() - staleMs)
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, pollMs))
    }

    // One final acquire after the final stale-lock observation avoids timing out
    // just as the previous owner releases.
    if (!acquired) {
      try {
        await rename(candidatePath, lockPath)
        acquired = true
      } catch (error) {
        if (!LOCK_COLLISION_CODES.has(errnoCode(error) ?? '')) throw error
      }
    }

    if (!acquired) {
      throw new RemoteRuntimeError(
        options.timeoutCode ?? 'state-lock-timeout',
        options.timeoutMessage ?? 'Timed out waiting for the remote profile state lock.',
        { phase: options.phase ?? 'config', retryable: true },
      )
    }

    const ownerPath = path.join(lockPath, ownerName)
    const heartbeatMs = Math.max(250, Math.floor(staleMs / 3))
    const heartbeat = setInterval(() => {
      const now = new Date()
      void utimes(ownerPath, now, now).catch(() => undefined)
    }, heartbeatMs)
    heartbeat.unref()
    try {
      return await run()
    } finally {
      clearInterval(heartbeat)
      await removeOwnedLock(lockPath, ownerName)
    }
  } finally {
    if (!acquired) await rm(candidatePath, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function reclaimStaleLock(lockPath: string, staleBefore: number): Promise<void> {
  let entries
  try {
    entries = await readdir(lockPath, { withFileTypes: true })
  } catch (error) {
    // Windows can report a short EPERM/EBUSY window while another process is
    // atomically renaming or removing this directory. That is an occupied lock,
    // not a fatal read failure; the normal retry path observes it again.
    if (['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES', 'EBUSY'].includes(errnoCode(error) ?? '')) return
    throw error
  }

  const owner = entries.find((entry) => entry.isFile() && OWNER_NAME.test(entry.name))
  if (owner) {
    const info = await stat(path.join(lockPath, owner.name)).catch(() => null)
    if (info && info.mtimeMs <= staleBefore) {
      await reclaimOwnedLock(lockPath, owner.name, info.mtimeMs, staleBefore)
    }
    return
  }

  for (const entry of entries) {
    if (!entry.isFile() || !RELEASING_NAME.test(entry.name)) continue
    const target = path.join(lockPath, entry.name)
    const info = await stat(target).catch(() => null)
    if (info && info.mtimeMs <= staleBefore) await rm(target, { force: true }).catch(() => undefined)
  }
  await rmdir(lockPath).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EBUSY', 'EPERM'].includes(errnoCode(error) ?? '')) throw error
  })
}

function transientDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(5 * (attempt + 1), 100)))
}
