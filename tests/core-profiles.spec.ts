import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { RemoteRuntimeError } from '../src/errors.ts'
import { ProfileStore, defaultProfilesPath } from '../src/profiles.ts'
import type { RemoteProfileId } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storeFixture(): Promise<{ root: string; filePath: string; store: ProfileStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-remote-profile-'))
  roots.push(root)
  const filePath = path.join(root, 'profiles.json')
  return { root, filePath, store: new ProfileStore(filePath) }
}

describe('profile store', () => {
  test('creates an isolated profile and default workspace without storing secrets', async () => {
    const { filePath, store } = await storeFixture()
    const profile = await store.create({
      name: 'ops-box',
      sshHost: 'ops-box.example',
      sshPort: 2222,
      defaultCwd: '/srv/application',
      network: {
        mode: 'client-proxy',
        clientProxy: {
          allowedPorts: [443, 80, 443],
          noProxy: ['registry.internal'],
          upstreamProxyEnv: 'HTTPS_PROXY',
        },
      },
    })

    expect(profile.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(profile.network.clientProxy.allowedPorts).toEqual([80, 443])
    expect(profile.workspaces).toHaveLength(1)
    expect(profile.workspaces[0]).toMatchObject({ name: 'application', cwd: '/srv/application', pinned: true })
    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toMatch(/api.?key|password|secret/iu)
    expect((await store.get('OPS-BOX')).id).toBe(profile.id)
  })

  test('updates only mutable fields and preserves profile/workspace identities', async () => {
    const { store } = await storeFixture()
    const created = await store.create({
      name: 'ops-box',
      sshHost: 'ops-box',
      sshPort: 22,
      defaultCwd: '/srv/application',
      remoteRoot: '/var/lib/dsh-remote',
      network: { mode: 'client-proxy' },
    })
    const workspaceId = created.workspaces[0]!.id
    const updated = await store.update({
      id: created.id,
      name: 'ops-renamed',
      sshHost: 'ops-new',
      sshPort: null,
      defaultCwd: '/srv/etl',
    })

    expect(updated.id).toBe(created.id)
    expect(updated.remoteRoot).toBe('/var/lib/dsh-remote')
    expect(updated.network.mode).toBe('client-proxy')
    expect(updated.sshPort).toBeUndefined()
    expect(updated.workspaces.some((workspace) => workspace.id === workspaceId)).toBe(true)
    expect(updated.workspaces.some((workspace) => workspace.cwd === '/srv/etl')).toBe(true)

    await expect(store.update({
      id: created.id,
      network: { mode: 'remote-direct' },
    } as never)).rejects.toMatchObject({ code: 'profile-field-immutable' })
    await expect(store.update({
      id: created.id,
      remoteRoot: '/other',
    } as never)).rejects.toMatchObject({ code: 'profile-field-immutable' })
  })

  test('upserts, edits, and removes profile-owned workspaces atomically', async () => {
    const { store } = await storeFixture()
    const profile = await store.create({ name: 'ops-box', sshHost: 'ops-box' })
    const added = await store.addWorkspace({
      profileId: profile.id,
      name: 'Application',
      cwd: '/srv/application/',
    })
    const promoted = await store.addWorkspace({
      profileId: profile.id,
      name: 'App',
      cwd: '/srv/application',
      pinned: true,
    })
    expect(promoted.id).toBe(added.id)
    expect(promoted).toMatchObject({ name: 'App', pinned: true, cwd: '/srv/application' })

    const renamed = await store.updateWorkspace({
      profileId: profile.id,
      workspaceId: added.id,
      name: 'Production App',
      pinned: false,
    })
    expect(renamed).toMatchObject({ name: 'Production App', pinned: false })
    expect((await store.removeWorkspace(profile.id, added.id)).id).toBe(added.id)
    expect((await store.get(profile.id)).workspaces).toEqual([])
  })

  test('serializes concurrent profile creation and retains every distinct entry', async () => {
    const { store } = await storeFixture()
    await Promise.all(Array.from({ length: 16 }, (_, index) => store.create({
      name: `host-${index}`,
      sshHost: `host-${index}.example`,
    })))
    expect(await store.list()).toHaveLength(16)
  })

  test('fails closed on malformed storage and does not overwrite it', async () => {
    const { filePath, store } = await storeFixture()
    const malformed = '{"version":1,"profiles":[{"id":"not-a-uuid"}]}'
    await writeFile(filePath, malformed, 'utf8')

    await expect(store.list()).rejects.toMatchObject({ code: 'profile-config-invalid' } satisfies Partial<RemoteRuntimeError>)
    await expect(store.create({ name: 'new-profile', sshHost: 'host' })).rejects.toMatchObject({ code: 'profile-config-invalid' })
    expect(await readFile(filePath, 'utf8')).toBe(malformed)
  })

  test('rejects option injection, relative paths, duplicate names, and invalid proxy policy', async () => {
    const { store } = await storeFixture()
    await expect(store.create({ name: 'ops box', sshHost: 'host' })).rejects.toMatchObject({ code: 'profile-name-invalid' })
    await expect(store.create({ name: 'ops-box', sshHost: '-oProxyCommand=evil' })).rejects.toMatchObject({ code: 'ssh-host-invalid' })
    await expect(store.create({ name: 'ops-box', sshHost: 'host', defaultCwd: 'relative' })).rejects.toMatchObject({ code: 'remote-path-invalid' })
    await expect(store.create({
      name: 'ops-box',
      sshHost: 'host',
      network: {
        mode: 'client-proxy',
        clientProxy: { allowedPorts: [80, 443], noProxy: [], upstreamProxyEnv: 'https://proxy' },
      },
    })).rejects.toMatchObject({ code: 'proxy-environment-invalid' })

    const profile = await store.create({ name: 'ops-box', sshHost: 'host' })
    await expect(store.create({ name: 'OPS-BOX', sshHost: 'other' })).rejects.toMatchObject({ code: 'profile-exists' })
    await expect(store.get('00000000-0000-4000-8000-000000000000' as RemoteProfileId)).rejects.toMatchObject({ code: 'profile-not-found' })
    expect((await store.remove(profile.id)).id).toBe(profile.id)
  })

  test('uses a Windows roaming path by default without mutating environment', () => {
    expect(defaultProfilesPath({ APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, 'win32'))
      .toBe(path.resolve('C:\\Users\\test\\AppData\\Roaming', 'dsh-remote-runtime', 'profiles.json'))
  })
})
