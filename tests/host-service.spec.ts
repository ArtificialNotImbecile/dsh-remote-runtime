import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProxyAuditLog } from '../src/audit.ts'
import { RemoteRuntimeError, redactDiagnostic } from '../src/errors.ts'
import { ProfileStore } from '../src/profiles.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Host-owned local state', () => {
  it('keeps credentials out of serialized and redacted diagnostics', () => {
    const secret = 'sk-very-secret-value'
    const failure = new RemoteRuntimeError('credential-rejected', 'Credential import failed.', {
      phase: 'credential', cause: new Error(`api key=${secret}`),
    })
    expect(JSON.stringify(failure.serialize())).not.toContain(secret)
    expect(redactDiagnostic(`api key=${secret}`)).not.toContain(secret)
  })

  it('profile removal can delete only local metadata and audit state', async () => {
    const root = await temporaryRoot()
    const profiles = new ProfileStore(join(root, 'profiles.json'))
    const profile = await profiles.create({ name: 'remote', sshHost: 'host' })
    const audit = new ProxyAuditLog(profile, join(root, 'audit'))
    audit.write({ timestamp: new Date().toISOString(), host: 'example.com', port: 443, decision: 'allow', method: 'CONNECT' })
    await audit.flush()
    await expect(stat(audit.filePath)).resolves.toBeDefined()

    await profiles.remove(profile.id)
    await Promise.all([rm(audit.filePath, { force: true }), rm(`${audit.filePath}.1`, { force: true })])
    await expect(profiles.list()).resolves.toEqual([])
    await expect(stat(audit.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stores profile and workspace DTOs without secret fields', async () => {
    const root = await temporaryRoot()
    const profiles = new ProfileStore(join(root, 'profiles.json'))
    const profile = await profiles.create({ name: 'alpha', sshHost: 'host', defaultCwd: '/work' })
    expect(JSON.stringify(profile)).not.toMatch(/api.?key|password|secret/iu)
    expect(profile.workspaces).toHaveLength(1)
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-host-'))
  roots.push(root)
  return root
}
