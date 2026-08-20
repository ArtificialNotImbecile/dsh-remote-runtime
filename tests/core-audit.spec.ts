import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ProxyAuditLog, safeAuditEvent, type ProxyAuditEvent } from '../src/audit.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function rootFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-remote-audit-'))
  roots.push(root)
  return root
}

function event(overrides: Partial<ProxyAuditEvent> = {}): ProxyAuditEvent {
  return {
    timestamp: '2026-08-20T00:00:00.000Z',
    host: 'api.deepseek.com',
    resolvedAddress: '8.8.8.8',
    port: 443,
    decision: 'allow',
    method: 'CONNECT',
    bytesUp: 12,
    bytesDown: 34,
    durationMs: 56,
    ...overrides,
  }
}

describe('proxy audit log', () => {
  test('projects only bounded metadata fields', () => {
    const safe = safeAuditEvent({
      ...event(),
      host: 'api.deepseek.com\nAuthorization: secret',
      requestUrl: 'https://user:pass@example/' as never,
      headers: { authorization: 'secret' } as never,
    } as ProxyAuditEvent)
    expect(safe.host).not.toContain('\n')
    expect(safe).not.toHaveProperty('requestUrl')
    expect(safe).not.toHaveProperty('headers')
  })

  test('writes JSONL and rotates before exceeding its configured generation', async () => {
    const root = await rootFixture()
    const log = new ProxyAuditLog('11111111-1111-4111-8111-111111111111', root, { maxBytes: 80 })
    log.write(event({ host: 'first.example' }))
    await log.flush()
    log.write(event({ host: 'second.example' }))
    await log.flush()

    const current = await readFile(log.filePath, 'utf8')
    const rotated = await readFile(`${log.filePath}.1`, 'utf8')
    expect(current).toContain('second.example')
    expect(rotated).toContain('first.example')
    expect(current).not.toMatch(/authorization|password|requestUrl/iu)
  })
})
