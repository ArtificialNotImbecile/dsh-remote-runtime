import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { defaultProfilesPath } from './profiles.ts'
import type { RemoteProfile, RemoteProfileId } from './types.ts'

const DEFAULT_MAX_AUDIT_BYTES = 10 * 1024 * 1024

/** Metadata-only proxy record. URLs, headers, bodies, and credentials are absent by design. */
export interface ProxyAuditEvent {
  readonly timestamp: string
  readonly host: string
  readonly resolvedAddress?: string
  readonly port: number
  readonly decision: 'allow' | 'deny'
  readonly method: string
  readonly bytesUp?: number
  readonly bytesDown?: number
  readonly durationMs?: number
  readonly errorCode?: string
}

export class ProxyAuditLog {
  readonly filePath: string
  private chain = Promise.resolve()
  private readonly maxBytes: number

  constructor(
    profile: RemoteProfile | RemoteProfileId | string,
    directory = process.env.DSH_REMOTE_RUNTIME_AUDIT_DIR || process.env.DSH_REMOTE_AUDIT_DIR
      || path.join(path.dirname(defaultProfilesPath()), 'audit'),
    options: { readonly maxBytes?: number } = {},
  ) {
    const profileId = typeof profile === 'string' ? profile : profile.id
    if (!/^[A-Za-z0-9._-]+$/u.test(profileId)) throw new TypeError('Invalid profile id for audit file')
    this.filePath = path.join(directory, `${profileId}.jsonl`)
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_AUDIT_BYTES
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new TypeError('maxBytes must be a positive integer')
  }

  /** Queue a write without ever blocking or failing live proxy traffic. */
  write(event: ProxyAuditEvent): void {
    const safe = safeAuditEvent(event)
    this.chain = this.chain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
      const info = await stat(this.filePath).catch(() => null)
      if (info && info.size >= this.maxBytes) {
        const rotated = `${this.filePath}.1`
        await rm(rotated, { force: true }).catch(() => undefined)
        await rename(this.filePath, rotated)
      }
      await appendFile(this.filePath, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 })
    }).catch(() => {
      // Audit failure is deliberately isolated from the connection it describes.
    })
  }

  async flush(): Promise<void> {
    await this.chain
  }
}

export function safeAuditEvent(event: ProxyAuditEvent): ProxyAuditEvent {
  const timestamp = Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : new Date().toISOString()
  const host = boundedField(event.host, 255, 'invalid')
  const method = boundedField(event.method, 32, 'UNKNOWN')
  const resolvedAddress = event.resolvedAddress === undefined
    ? undefined
    : boundedField(event.resolvedAddress, 64, 'invalid')
  const errorCode = event.errorCode === undefined ? undefined : boundedField(event.errorCode, 96, 'proxy-error')
  return {
    timestamp,
    host,
    ...(resolvedAddress === undefined ? {} : { resolvedAddress }),
    port: boundedInteger(event.port),
    decision: event.decision === 'allow' ? 'allow' : 'deny',
    method,
    ...(event.bytesUp === undefined ? {} : { bytesUp: boundedInteger(event.bytesUp) }),
    ...(event.bytesDown === undefined ? {} : { bytesDown: boundedInteger(event.bytesDown) }),
    ...(event.durationMs === undefined ? {} : { durationMs: boundedInteger(event.durationMs) }),
    ...(errorCode === undefined ? {} : { errorCode }),
  }
}

function boundedField(value: string, maxLength: number, fallback: string): string {
  const normalized = String(value).replace(/[\0\r\n\t]/gu, ' ').trim()
  return (normalized || fallback).slice(0, maxLength)
}

function boundedInteger(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}
