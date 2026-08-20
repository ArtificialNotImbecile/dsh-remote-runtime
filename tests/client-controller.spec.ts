import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  RemoteProfileId,
  RemoteProfileSummary,
  RemoteRuntimeResult,
  RemoteRuntimeSnapshot,
  RemoteSessionTranscript,
} from '../src/types.ts'
import { RemoteRuntimeController, type DshRemoteRuntimeRemote } from '../src/client/controller.ts'

const PROFILE_ID = 'profile-a' as RemoteProfileId

const profile: RemoteProfileSummary = {
  version: 1,
  id: PROFILE_ID,
  name: 'Research box',
  sshHost: 'research-box',
  network: {
    mode: 'remote-direct',
    clientProxy: { allowedPorts: [80, 443], noProxy: [] },
  },
  workspaces: [],
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
}

const snapshot: RemoteRuntimeSnapshot = {
  revision: 7,
  profiles: [profile],
  statuses: [{
    profileId: PROFILE_ID,
    state: 'disconnected',
    revision: 7,
    changedAt: '2026-08-20T00:00:00.000Z',
  }],
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RemoteRuntimeController', () => {
  it('selects and loads the first created profile instead of no-oping after refresh', async () => {
    let current: RemoteRuntimeSnapshot = { revision: 0, profiles: [], statuses: [] }
    const remote = fakeRemote({
      snapshot: vi.fn(() => ok(current)),
      createProfile: vi.fn(request => {
        current = { ...snapshot, profiles: [{ ...profile, name: request.name, sshHost: request.sshHost }] }
        return ok(current.profiles[0]!)
      }),
    })
    const controller = new RemoteRuntimeController(remote)
    controller.activate()
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))

    await controller.createProfile({ name: 'Research box', sshHost: 'research-box' })

    expect(controller.getSnapshot().selectedProfileId).toBe(PROFILE_ID)
    expect(remote.credentialStatus).toHaveBeenCalledWith(PROFILE_ID, expect.any(AbortSignal))
    expect(remote.listSessions).toHaveBeenCalledWith(PROFILE_ID, expect.any(AbortSignal))
    controller.dispose()
  })

  it('drops old profile resources and refetches after an SSH host edit', async () => {
    let current = snapshot
    let listCall = 0
    const remote = fakeRemote({
      snapshot: vi.fn(() => ok(current)),
      listSessions: vi.fn(() => ok([{
        sessionId: listCall++ === 0 ? 'old-session' : 'new-session',
        updatedAt: listCall,
        running: false,
        blank: false,
      }])),
      updateProfile: vi.fn(request => {
        const updated = { ...profile, sshHost: request.sshHost ?? profile.sshHost }
        current = { ...snapshot, revision: 8, profiles: [updated] }
        return ok(updated)
      }),
    })
    const controller = new RemoteRuntimeController(remote)
    controller.activate()
    await vi.waitFor(() => expect(controller.getSnapshot().sessions.value?.[0]?.sessionId).toBe('old-session'))

    await controller.updateProfile({ id: PROFILE_ID, sshHost: 'replacement-box' })

    expect(controller.getSnapshot().snapshot.profiles[0]?.sshHost).toBe('replacement-box')
    expect(controller.getSnapshot().sessions.value?.[0]?.sessionId).toBe('new-session')
    expect(remote.listSessions).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('starts bounded long polling only while the settings section is mounted', async () => {
    vi.useFakeTimers()
    let watchSignal: AbortSignal | undefined
    const remote = fakeRemote({
      watch: vi.fn((_revision, _timeout, signal) => {
        watchSignal = signal
        return new Promise<never>(() => undefined)
      }),
    })
    const controller = new RemoteRuntimeController(remote)

    expect(remote.snapshot).not.toHaveBeenCalled()
    expect(remote.watch).not.toHaveBeenCalled()

    const deactivate = controller.activate()
    await vi.waitFor(() => expect(remote.snapshot).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(0)

    expect(remote.watch).toHaveBeenCalledWith(7, 15_000, expect.any(AbortSignal))
    expect(watchSignal?.aborted).toBe(false)

    deactivate()
    expect(watchSignal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    controller.dispose()
  })

  it('loads retryable transcript failure state, then replaces it on retry', async () => {
    let attempts = 0
    const transcript: RemoteSessionTranscript = {
      sessionId: 'session-a',
      title: 'Remote session',
      entries: [{ id: 'entry-1', seq: 1, time: 1, kind: 'assistant', text: 'ready' }],
      hasMore: false,
    }
    const remote = fakeRemote({
      listSessions: vi.fn(() => ok([{ sessionId: 'session-a', updatedAt: 1, running: false, blank: false }])),
      readTranscript: vi.fn(() => {
        attempts++
        return attempts === 1
          ? rejected({ code: 'session-read-failed', message: 'read failed', phase: 'session', retryable: true })
          : ok(transcript)
      }),
    })
    const controller = new RemoteRuntimeController(remote)

    controller.activate()
    await vi.waitFor(() => expect(controller.getSnapshot().sessions.status).toBe('ready'))
    controller.selectSession('session-a')
    await vi.waitFor(() => expect(controller.getSnapshot().transcript.status).toBe('error'))

    expect(controller.getSnapshot().transcript.error?.code).toBe('session-read-failed')
    await controller.retryTranscript()
    expect(controller.getSnapshot().transcript).toMatchObject({ status: 'ready', value: transcript, error: null })
    controller.dispose()
  })

  it('prepends older transcript pages without duplicating entries', async () => {
    let page = 0
    const remote = fakeRemote({
      listSessions: vi.fn(() => ok([{ sessionId: 'session-a', updatedAt: 1, running: false, blank: false }])),
      readTranscript: vi.fn(() => {
        page++
        return page === 1
          ? ok<RemoteSessionTranscript>({
              sessionId: 'session-a',
              entries: [{ id: 'entry-3', seq: 3, time: 3, kind: 'assistant', text: 'newer' }],
              hasMore: true,
              beforeSeq: 3,
            })
          : ok<RemoteSessionTranscript>({
              sessionId: 'session-a',
              entries: [
                { id: 'entry-1', seq: 1, time: 1, kind: 'user', text: 'older' },
                { id: 'entry-3', seq: 3, time: 3, kind: 'assistant', text: 'newer' },
              ],
              hasMore: false,
            })
      }),
    })
    const controller = new RemoteRuntimeController(remote)

    controller.activate()
    await vi.waitFor(() => expect(controller.getSnapshot().sessions.status).toBe('ready'))
    controller.selectSession('session-a')
    await vi.waitFor(() => expect(controller.getSnapshot().transcript.status).toBe('ready'))
    await controller.loadOlderTranscript()

    expect(controller.getSnapshot().transcript.value?.entries.map(entry => entry.seq)).toEqual([1, 3])
    expect(controller.getSnapshot().transcript.value?.hasMore).toBe(false)
    controller.dispose()
  })

  it('surfaces structured operation failures without discarding the loaded snapshot', async () => {
    const remote = fakeRemote({
      doctor: vi.fn(() => rejected({
        code: 'ssh-unreachable',
        message: 'SSH host is unreachable.',
        phase: 'ssh',
        retryable: true,
        remediation: 'Check the OpenSSH alias.',
      })),
    })
    const controller = new RemoteRuntimeController(remote)

    controller.activate()
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
    await controller.runDoctor(PROFILE_ID)

    expect(controller.getSnapshot().snapshot.profiles).toEqual([profile])
    expect(controller.getSnapshot().doctor.status).toBe('error')
    expect(controller.getSnapshot().operationError).toMatchObject({ code: 'ssh-unreachable', retryable: true })
    controller.dispose()
  })
})

function fakeRemote(overrides: Partial<DshRemoteRuntimeRemote> = {}): DshRemoteRuntimeRemote {
  const base: DshRemoteRuntimeRemote = {
    snapshot: vi.fn(() => ok(snapshot)),
    watch: vi.fn(() => ok(snapshot)),
    createProfile: vi.fn(request => ok({ ...profile, name: request.name, sshHost: request.sshHost })),
    updateProfile: vi.fn(() => ok(profile)),
    removeProfile: vi.fn(() => ok({ changed: true })),
    doctor: vi.fn(() => ok({ profileId: PROFILE_ID, checkedAt: 'now', ready: true, runtimeInstalled: false, checks: [] })),
    installRuntime: vi.fn(() => ok({ runtimeVersion: '0.1.0', dshVersion: '0.1.0-rc.8', nodeVersion: '22.19.0', artifactSha256: 'a'.repeat(64), remoteRoot: '/runtime', profileRoot: '/profile', dshHome: '/dsh', installed: true })),
    start: vi.fn(() => ok({ profileId: PROFILE_ID, state: 'connected', revision: 8, changedAt: 'now' })),
    stop: vi.fn(() => ok({ changed: true })),
    disconnect: vi.fn(() => ok({ changed: true })),
    importCredential: vi.fn(() => ok({ configured: true, updatedAt: 'now' })),
    credentialStatus: vi.fn(() => ok({ configured: false })),
    listDirectory: vi.fn(() => ok([])),
    addWorkspace: vi.fn(request => ok({ id: 'workspace-a' as never, name: request.name, cwd: request.cwd, pinned: request.pinned ?? false, createdAt: 'now' })),
    updateWorkspace: vi.fn(() => ok({ id: 'workspace-a' as never, name: 'Workspace', cwd: '/srv/project', pinned: false, createdAt: 'now' })),
    removeWorkspace: vi.fn(() => ok({ changed: true })),
    listHarnessWorkspaces: vi.fn(() => ok([])),
    listSessions: vi.fn(() => ok([])),
    readTranscript: vi.fn((_profileId, sessionId) => ok({ sessionId, entries: [], hasMore: false })),
    prompt: vi.fn(() => ok({ accepted: true })),
    cancel: vi.fn(() => ok({ accepted: true })),
  }
  return { ...base, ...overrides }
}

function ok<T>(value: T): Promise<RemoteResult<RemoteRuntimeResult<T>>> {
  return Promise.resolve({ ok: true, value: { ok: true, value } })
}

function rejected<T = never>(error: Extract<RemoteRuntimeResult<T>, { ok: false }>['error']): Promise<RemoteResult<RemoteRuntimeResult<T>>> {
  return Promise.resolve({ ok: true, value: { ok: false, error } })
}
