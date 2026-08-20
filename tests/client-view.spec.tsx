// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteProfileId, RemoteProfileSummary, RemoteRuntimeSnapshot, RemoteWorkspaceId } from '../src/types.ts'
import type { Loadable, RemoteRuntimeViewState } from '../src/client/controller.ts'
import { en, type RemoteRuntimeLocaleKey } from '../src/client/locales.ts'
import { RemoteRuntimeSettings } from '../src/client/RemoteRuntimeSettings.tsx'
import type { RemoteRuntimeSettingsProps } from '../src/client/slots.ts'

const PROFILE_ID = 'profile-a' as RemoteProfileId
const WORKSPACE_ID = 'workspace-a' as RemoteWorkspaceId

const profile: RemoteProfileSummary = {
  version: 1,
  id: PROFILE_ID,
  name: 'Research box',
  sshHost: 'research-box',
  defaultCwd: '/srv/research',
  remoteRoot: '/home/dev/.local/share/dsh-remote-runtime',
  network: { mode: 'client-proxy', clientProxy: { allowedPorts: [80, 443], noProxy: ['registry.internal'], upstreamProxyEnv: 'HTTPS_PROXY' } },
  workspaces: [{ id: WORKSPACE_ID, name: 'Research', cwd: '/srv/research', pinned: true, createdAt: '2026-08-20T00:00:00.000Z' }],
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('RemoteRuntimeSettings', () => {
  it('clears write-only credential fields when the selected profile changes', () => {
    const first = createProps(readyState())
    const rendered = render(<RemoteRuntimeSettings {...first.props} />)
    fireEvent.change(screen.getByLabelText('DeepSeek API key'), { target: { value: 'sk-private-a' } })
    fireEvent.change(screen.getByLabelText('Base URL (optional)'), { target: { value: 'https://gateway.example' } })

    const secondProfile = { ...profile, id: 'profile-b', name: 'Second box', sshHost: 'second-box' }
    const secondState = readyState()
    const second = createProps({
      ...secondState,
      selectedProfileId: secondProfile.id,
      snapshot: { ...secondState.snapshot, profiles: [secondProfile], statuses: [] },
      credential: idle(),
    })
    rendered.rerender(<RemoteRuntimeSettings {...second.props} />)

    expect((screen.getByLabelText('DeepSeek API key') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Base URL (optional)') as HTMLInputElement).value).toBe('')
  })

  it('enables Start after Doctor confirms an installed runtime following a Host restart', () => {
    const state = readyState()
    const actions = createProps({
      ...state,
      snapshot: { ...state.snapshot, statuses: [] },
      doctor: {
        status: 'ready',
        value: { profileId: PROFILE_ID, checkedAt: 'now', ready: true, runtimeInstalled: true, checks: [] },
        error: null,
      },
    })
    render(<RemoteRuntimeSettings {...actions.props} />)

    expect((screen.getByRole('button', { name: 'Start runtime' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('renders profiles, workspace management, sessions, and a transcript without replacing shell UI', () => {
    const actions = createProps(readyState())
    render(<RemoteRuntimeSettings {...actions.props} />)

    expect(screen.getByRole('heading', { name: 'DSH Remote Runtime' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Research box' })).toBeTruthy()
    expect(actions.activate).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Workspaces' }))
    expect(screen.getByRole('heading', { name: 'Saved paths' })).toBeTruthy()
    expect(screen.getByText('/srv/research')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Sessions & transcript' }))
    expect(screen.getAllByText('Remote session')).toHaveLength(2)
    expect(screen.getByText('Remote answer')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps profile creation and runtime installation as distinct wizard stages', async () => {
    const actions = createProps(emptyState())
    actions.createProfile.mockResolvedValue(profile)
    render(<RemoteRuntimeSettings {...actions.props} />)

    fireEvent.click(screen.getAllByRole('button', { name: 'Add profile' })[0]!)
    expect(screen.getByRole('dialog', { name: 'Add a remote runtime' })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Research box' } })
    fireEvent.change(screen.getByLabelText('OpenSSH host'), { target: { value: 'research-box' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByLabelText(/Client proxy/))
    fireEvent.click(screen.getByRole('button', { name: 'Create profile' }))

    await waitFor(() => expect(actions.createProfile).toHaveBeenCalledOnce())
    expect(actions.createProfile.mock.calls[0]?.[0]).toMatchObject({
      name: 'Research box',
      sshHost: 'research-box',
      network: { mode: 'client-proxy' },
    })
    expect(screen.getByText('Profile saved. Nothing has been installed yet.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Install verified runtime' }) as HTMLButtonElement).disabled).toBe(true)
    expect(actions.install).not.toHaveBeenCalled()
  })

  it('shows transcript failure with an actionable retry', () => {
    const state = readyState()
    const failure = { code: 'session-read-failed', message: 'Remote transcript read failed.', phase: 'session' as const, retryable: true }
    const actions = createProps({ ...state, transcript: { status: 'error', value: null, error: failure } })
    render(<RemoteRuntimeSettings {...actions.props} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sessions & transcript' }))
    expect(screen.getByRole('alert').textContent).toContain('Remote transcript read failed.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(actions.retryTranscript).toHaveBeenCalledOnce()
  })
})

function createProps(state: RemoteRuntimeViewState) {
  const activate = vi.fn(() => vi.fn())
  const createProfile = vi.fn<RemoteRuntimeSettingsProps['createProfile']>(async () => null)
  const install = vi.fn<RemoteRuntimeSettingsProps['install']>(async () => false)
  const retryTranscript = vi.fn<RemoteRuntimeSettingsProps['retryTranscript']>(async () => undefined)
  const props = {
    useRemoteRuntime: (selector: (value: RemoteRuntimeViewState) => unknown) => selector(state),
    activate,
    refresh: vi.fn(async () => undefined),
    selectProfile: vi.fn(),
    createProfile,
    updateProfile: vi.fn(async () => true),
    removeProfile: vi.fn(async () => true),
    runDoctor: vi.fn(async () => null),
    install,
    start: vi.fn(async () => true),
    stop: vi.fn(async () => true),
    disconnect: vi.fn(async () => true),
    importCredential: vi.fn(async () => true),
    browseDirectory: vi.fn(async () => undefined),
    addWorkspace: vi.fn(async () => true),
    updateWorkspace: vi.fn(async () => true),
    removeWorkspace: vi.fn(async () => true),
    refreshProfileData: vi.fn(async () => undefined),
    selectSession: vi.fn(),
    retryTranscript,
    loadOlderTranscript: vi.fn(async () => undefined),
    prompt: vi.fn(async () => true),
    cancelTurn: vi.fn(async () => true),
    clearOperationError: vi.fn(),
    t: translate,
    close: vi.fn(),
  } as unknown as RemoteRuntimeSettingsProps
  return { props, activate, createProfile, install, retryTranscript }
}

function readyState(): RemoteRuntimeViewState {
  const snapshot: RemoteRuntimeSnapshot = {
    revision: 3,
    profiles: [profile],
    statuses: [{
      profileId: PROFILE_ID,
      state: 'disconnected',
      revision: 3,
      runtime: {
        runtimeVersion: '0.1.0',
        dshVersion: '0.1.0-rc.8',
        nodeVersion: '22.19.0',
        artifactSha256: 'a'.repeat(64),
        remoteRoot: '/runtime',
        profileRoot: '/profile',
        dshHome: '/dsh',
        installed: true,
      },
      changedAt: '2026-08-20T00:00:00.000Z',
    }],
  }
  return {
    status: 'ready',
    snapshot,
    selectedProfileId: PROFILE_ID,
    doctor: idle(),
    credential: { status: 'ready', value: { configured: false }, error: null },
    directory: idle(),
    harnessWorkspaces: { status: 'ready', value: [], error: null },
    sessions: { status: 'ready', value: [{ sessionId: 'session-a', title: 'Remote session', updatedAt: 1, running: false, blank: false, cwd: '/srv/research' }], error: null },
    selectedSessionId: 'session-a',
    transcript: { status: 'ready', value: { sessionId: 'session-a', title: 'Remote session', entries: [{ id: 'entry-a', seq: 1, time: 1, kind: 'assistant', text: 'Remote answer' }], hasMore: false }, error: null },
    operation: null,
    operationError: null,
    lastUpdatedAt: 1,
    error: null,
  }
}

function emptyState(): RemoteRuntimeViewState {
  return {
    ...readyState(),
    snapshot: { revision: 0, profiles: [], statuses: [] },
    selectedProfileId: null,
    sessions: idle(),
    selectedSessionId: null,
    transcript: idle(),
  }
}

function idle<T>(): Loadable<T> {
  return { status: 'idle', value: null, error: null }
}

function translate(key: RemoteRuntimeLocaleKey, values?: Record<string, unknown>): string {
  let value: string = en[key]
  for (const [name, replacement] of Object.entries(values ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}
