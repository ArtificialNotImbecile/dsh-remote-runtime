/** Browser object layer over the generated DSH Remote Runtime namespace. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AddRemoteWorkspaceRequest,
  CreateRemoteProfileRequest,
  DoctorReport,
  ImportCredentialRequest,
  PromptRemoteSessionRequest,
  RemoteConnectionStatus,
  RemoteDirectoryEntry,
  RemoteHarnessWorkspace,
  RemoteProfileId,
  RemoteProfileSummary,
  RemoteRuntimeFailure,
  RemoteRuntimeInfo,
  RemoteRuntimeResult,
  RemoteRuntimeSnapshot,
  RemoteSessionSummary,
  RemoteSessionTranscript,
  RemoteWorkspace,
  RemoteWorkspaceId,
  StartRemoteRuntimeRequest,
  UpdateRemoteProfileRequest,
  UpdateRemoteWorkspaceRequest,
} from '../types.ts'

type RemoteCall<T> = Promise<RemoteResult<RemoteRuntimeResult<T>>>

/** Non-secret credential metadata safe to show in the browser. */
export interface RemoteCredentialStatus {
  readonly configured: boolean
  readonly baseUrl?: string
  readonly updatedAt?: string
}

/** Browser-owned directory cursor around Host-returned directory entries. */
export interface RemoteDirectoryListing {
  readonly path: string
  readonly parentPath: string | null
  readonly entries: readonly RemoteDirectoryEntry[]
}

/** Generated Remote methods consumed by this UI. Positional arguments match rc.8 Typert output. */
export interface DshRemoteRuntimeRemote {
  snapshot(): RemoteCall<RemoteRuntimeSnapshot>
  watch(afterRevision: number, timeoutMs: number | undefined, signal?: AbortSignal): RemoteCall<RemoteRuntimeSnapshot>
  createProfile(request: CreateRemoteProfileRequest): RemoteCall<RemoteProfileSummary>
  updateProfile(request: UpdateRemoteProfileRequest): RemoteCall<RemoteProfileSummary>
  removeProfile(profileId: RemoteProfileId): RemoteCall<{ readonly changed: boolean }>
  doctor(profileId: RemoteProfileId, signal?: AbortSignal): RemoteCall<DoctorReport>
  installRuntime(profileId: RemoteProfileId, signal?: AbortSignal): RemoteCall<RemoteRuntimeInfo>
  start(request: StartRemoteRuntimeRequest, signal?: AbortSignal): RemoteCall<RemoteConnectionStatus>
  stop(profileId: RemoteProfileId, signal?: AbortSignal): RemoteCall<{ readonly changed: boolean }>
  disconnect(profileId: RemoteProfileId): RemoteCall<{ readonly changed: boolean }>
  importCredential(request: ImportCredentialRequest, signal?: AbortSignal): RemoteCall<{
    readonly configured: true
    readonly updatedAt: string
  }>
  credentialStatus(profileId: RemoteProfileId, signal?: AbortSignal): RemoteCall<RemoteCredentialStatus>
  listDirectory(profileId: RemoteProfileId, path: string | undefined, signal?: AbortSignal): RemoteCall<readonly RemoteDirectoryEntry[]>
  addWorkspace(request: AddRemoteWorkspaceRequest): RemoteCall<RemoteWorkspace>
  updateWorkspace(request: UpdateRemoteWorkspaceRequest): RemoteCall<RemoteWorkspace>
  removeWorkspace(profileId: RemoteProfileId, workspaceId: RemoteWorkspaceId): RemoteCall<{ readonly changed: boolean }>
  listHarnessWorkspaces(profileId: RemoteProfileId, signal?: AbortSignal): RemoteCall<readonly RemoteHarnessWorkspace[]>
  listSessions(profileId: RemoteProfileId, signal?: AbortSignal): RemoteCall<readonly RemoteSessionSummary[]>
  readTranscript(
    profileId: RemoteProfileId,
    sessionId: string,
    beforeSeq: number | undefined,
    maxMessages: number | undefined,
    signal?: AbortSignal,
  ): RemoteCall<RemoteSessionTranscript>
  prompt(request: PromptRemoteSessionRequest, signal?: AbortSignal): RemoteCall<{ readonly accepted: true }>
  cancel(profileId: RemoteProfileId, sessionId: string, signal?: AbortSignal): RemoteCall<{ readonly accepted: true }>
}

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** One independently retryable section of the control surface. */
export interface Loadable<T> {
  readonly status: LoadStatus
  readonly value: T | null
  readonly error: RemoteRuntimeFailure | null
}

export type RemoteOperation =
  | 'create-profile'
  | 'update-profile'
  | 'remove-profile'
  | 'doctor'
  | 'install'
  | 'start'
  | 'stop'
  | 'disconnect'
  | 'credential'
  | 'add-workspace'
  | 'update-workspace'
  | 'remove-workspace'
  | 'prompt'
  | 'cancel'

/** Immutable state projected into React. */
export interface RemoteRuntimeViewState {
  readonly status: LoadStatus
  readonly snapshot: RemoteRuntimeSnapshot
  readonly selectedProfileId: RemoteProfileId | null
  readonly doctor: Loadable<DoctorReport>
  readonly credential: Loadable<RemoteCredentialStatus>
  readonly directory: Loadable<RemoteDirectoryListing>
  readonly harnessWorkspaces: Loadable<readonly RemoteHarnessWorkspace[]>
  readonly sessions: Loadable<readonly RemoteSessionSummary[]>
  readonly selectedSessionId: string | null
  readonly transcript: Loadable<RemoteSessionTranscript>
  readonly operation: RemoteOperation | null
  readonly operationError: RemoteRuntimeFailure | null
  readonly lastUpdatedAt: number | null
  readonly error: RemoteRuntimeFailure | null
}

const EMPTY_SNAPSHOT: RemoteRuntimeSnapshot = Object.freeze({
  revision: 0,
  profiles: Object.freeze([]),
  statuses: Object.freeze([]),
})

const INITIAL: RemoteRuntimeViewState = Object.freeze({
  status: 'idle',
  snapshot: EMPTY_SNAPSHOT,
  selectedProfileId: null,
  doctor: idle<DoctorReport>(),
  credential: idle<RemoteCredentialStatus>(),
  directory: idle<RemoteDirectoryListing>(),
  harnessWorkspaces: idle<readonly RemoteHarnessWorkspace[]>(),
  sessions: idle<readonly RemoteSessionSummary[]>(),
  selectedSessionId: null,
  transcript: idle<RemoteSessionTranscript>(),
  operation: null,
  operationError: null,
  lastUpdatedAt: null,
  error: null,
})

const WATCH_TIMEOUT_MS = 15_000
const WATCH_RETRY_MS = 2_000
const WATCH_SETTLE_MS = 250
const TRANSCRIPT_PAGE_SIZE = 80

/** Root-scoped controller. Long polling runs only while its settings section is mounted. */
export class RemoteRuntimeController implements HostObservable<RemoteRuntimeViewState> {
  private view = INITIAL
  private readonly listeners = new Set<() => void>()
  private activeViews = 0
  private disposed = false
  private refreshGeneration = 0
  private profileGeneration = 0
  private directoryGeneration = 0
  private transcriptGeneration = 0
  private watchAbort?: AbortController
  private profileAbort?: AbortController
  private directoryAbort?: AbortController
  private transcriptAbort?: AbortController
  private operationAbort?: AbortController
  private watchTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly remote: DshRemoteRuntimeRemote) {}

  getSnapshot = (): RemoteRuntimeViewState => this.view

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Begin data activity for one mounted settings section. */
  activate(): () => void {
    if (this.disposed) return () => undefined
    this.activeViews++
    if (this.activeViews === 1) void this.refresh(true)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.deactivate()
    }
  }

  /** Explicit full refresh; expensive profile facts remain separate from the snapshot watch. */
  async refresh(includeProfile = true): Promise<void> {
    if (this.disposed) return
    const generation = ++this.refreshGeneration
    this.publish({
      ...this.view,
      status: this.view.status === 'ready' ? 'ready' : 'loading',
      error: null,
    })
    try {
      const snapshot = await unwrap(this.remote.snapshot())
      if (this.disposed || generation !== this.refreshGeneration) return
      const selectedProfileId = retainedProfileId(snapshot.profiles, this.view.selectedProfileId)
      const selectionChanged = selectedProfileId !== this.view.selectedProfileId
      this.publish({
        ...this.view,
        status: 'ready',
        snapshot,
        selectedProfileId,
        ...(selectionChanged ? resetProfileResources() : {}),
        lastUpdatedAt: Date.now(),
        error: null,
      })
      this.restartWatch()
      if (includeProfile && selectedProfileId !== null) await this.loadProfileOverview(selectedProfileId)
    } catch (error: unknown) {
      if (generation !== this.refreshGeneration || isAbort(error)) return
      this.publish({ ...this.view, status: 'error', error: asFailure(error, 'api') })
      this.restartWatch(WATCH_RETRY_MS)
    }
  }

  /** Select a profile and fetch only the facts owned by its detail surface. */
  selectProfile(profileId: RemoteProfileId): void {
    if (this.disposed || this.view.operation !== null || profileId === this.view.selectedProfileId) return
    this.abortProfileReads()
    this.publish({
      ...this.view,
      selectedProfileId: profileId,
      ...resetProfileResources(),
    })
    void this.loadProfileOverview(profileId)
  }

  async createProfile(request: CreateRemoteProfileRequest): Promise<RemoteProfileSummary | null> {
    const profile = await this.runOperation('create-profile', () => unwrap(this.remote.createProfile(request)))
    if (profile === null) return null
    await this.refresh(false)
    await this.selectAndLoadProfile(profile.id)
    return profile
  }

  async updateProfile(request: UpdateRemoteProfileRequest): Promise<boolean> {
    const profile = await this.runOperation('update-profile', () => unwrap(this.remote.updateProfile(request)))
    if (profile === null) return false
    await this.refresh(false)
    await this.selectAndLoadProfile(profile.id)
    return true
  }

  async removeProfile(profileId: RemoteProfileId): Promise<boolean> {
    const result = await this.runOperation('remove-profile', () => unwrap(this.remote.removeProfile(profileId)))
    if (result === null) return false
    await this.refresh(true)
    return result.changed
  }

  async runDoctor(profileId = this.view.selectedProfileId): Promise<DoctorReport | null> {
    if (profileId === null) return null
    const profileGeneration = this.profileGeneration
    this.publish({ ...this.view, doctor: loading(this.view.doctor.value) })
    const report = await this.runOperation('doctor', signal => unwrap(this.remote.doctor(profileId, signal)))
    if (report === null) {
      if (!this.profileReadIsStale(profileGeneration, profileId)) {
        this.publish({ ...this.view, doctor: failed(this.view.operationError) })
      }
      return null
    }
    if (!this.profileReadIsStale(profileGeneration, profileId)) {
      this.publish({ ...this.view, doctor: ready(report) })
    }
    return report
  }

  async install(profileId = this.view.selectedProfileId): Promise<boolean> {
    if (profileId === null) return false
    const runtime = await this.runOperation('install', signal => unwrap(this.remote.installRuntime(profileId, signal)))
    if (runtime === null) return false
    await this.refresh(false)
    return true
  }

  async start(cwd?: string): Promise<boolean> {
    const profileId = this.view.selectedProfileId
    if (profileId === null) return false
    const request: StartRemoteRuntimeRequest = cwd === undefined || cwd.trim() === ''
      ? { profileId }
      : { profileId, cwd: cwd.trim() }
    const status = await this.runOperation('start', signal => unwrap(this.remote.start(request, signal)))
    if (status === null) return false
    await this.refresh(false)
    return true
  }

  async stop(): Promise<boolean> {
    const profileId = this.view.selectedProfileId
    if (profileId === null) return false
    const result = await this.runOperation('stop', signal => unwrap(this.remote.stop(profileId, signal)))
    if (result === null) return false
    await this.refresh(false)
    return result.changed
  }

  async disconnect(): Promise<boolean> {
    const profileId = this.view.selectedProfileId
    if (profileId === null) return false
    const result = await this.runOperation('disconnect', () => unwrap(this.remote.disconnect(profileId)))
    if (result === null) return false
    await this.refresh(false)
    return result.changed
  }

  async importCredential(apiKey: string, baseUrl?: string): Promise<boolean> {
    const profileId = this.view.selectedProfileId
    if (profileId === null || apiKey.trim() === '') return false
    const profileGeneration = this.profileGeneration
    const request: ImportCredentialRequest = {
      profileId,
      apiKey,
      ...(baseUrl === undefined || baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
    }
    const result = await this.runOperation('credential', signal => unwrap(this.remote.importCredential(request, signal)))
    if (result === null) return false
    if (!this.profileReadIsStale(profileGeneration, profileId)) {
      this.publish({ ...this.view, credential: ready({ configured: true, updatedAt: result.updatedAt }) })
    }
    return true
  }

  async browseDirectory(path?: string): Promise<void> {
    const profileId = this.view.selectedProfileId
    if (profileId === null) return
    const normalized = normalizeRemotePath(path)
    const profileGeneration = this.profileGeneration
    const generation = ++this.directoryGeneration
    this.directoryAbort?.abort()
    const abort = new AbortController()
    this.directoryAbort = abort
    this.publish({ ...this.view, directory: loading(this.view.directory.value) })
    try {
      const entries = await unwrap(this.remote.listDirectory(profileId, normalized, abort.signal))
      if (this.directoryReadIsStale(generation, profileGeneration, profileId, abort)) return
      const currentPath = normalized ?? '/'
      this.publish({
        ...this.view,
        directory: ready({ path: currentPath, parentPath: parentRemotePath(currentPath), entries }),
      })
    } catch (error: unknown) {
      if (this.directoryReadIsStale(generation, profileGeneration, profileId, abort) || isAbort(error)) return
      this.publish({ ...this.view, directory: failed(asFailure(error, 'ssh')) })
    }
  }

  async addWorkspace(name: string, cwd: string, pinned: boolean): Promise<boolean> {
    const profileId = this.view.selectedProfileId
    if (profileId === null) return false
    const request: AddRemoteWorkspaceRequest = { profileId, name: name.trim(), cwd: cwd.trim(), pinned }
    const workspace = await this.runOperation('add-workspace', () => unwrap(this.remote.addWorkspace(request)))
    if (workspace === null) return false
    await this.refresh(false)
    return true
  }

  async updateWorkspace(request: UpdateRemoteWorkspaceRequest): Promise<boolean> {
    const workspace = await this.runOperation('update-workspace', () => unwrap(this.remote.updateWorkspace(request)))
    if (workspace === null) return false
    await this.refresh(false)
    return true
  }

  async removeWorkspace(workspaceId: RemoteWorkspaceId): Promise<boolean> {
    const profileId = this.view.selectedProfileId
    if (profileId === null) return false
    const result = await this.runOperation(
      'remove-workspace',
      () => unwrap(this.remote.removeWorkspace(profileId, workspaceId)),
    )
    if (result === null) return false
    await this.refresh(false)
    return result.changed
  }

  async refreshProfileData(): Promise<void> {
    const profileId = this.view.selectedProfileId
    if (profileId !== null) await this.loadProfileOverview(profileId)
  }

  selectSession(sessionId: string): void {
    if (this.disposed || sessionId === this.view.selectedSessionId) return
    this.transcriptAbort?.abort()
    this.transcriptGeneration++
    this.publish({
      ...this.view,
      selectedSessionId: sessionId,
      transcript: loading<RemoteSessionTranscript>(),
    })
    void this.readTranscript(false)
  }

  async retryTranscript(): Promise<void> {
    await this.readTranscript(false)
  }

  async loadOlderTranscript(): Promise<void> {
    const transcript = this.view.transcript.value
    if (transcript === null || !transcript.hasMore) return
    await this.readTranscript(true)
  }

  async prompt(text: string, mode: 'queue' | 'steer'): Promise<boolean> {
    const profileId = this.view.selectedProfileId
    const sessionId = this.view.selectedSessionId
    if (profileId === null || sessionId === null || text.trim() === '') return false
    const request: PromptRemoteSessionRequest = { profileId, sessionId, text: text.trim(), mode }
    const accepted = await this.runOperation('prompt', signal => unwrap(this.remote.prompt(request, signal)))
    if (accepted === null) return false
    await this.loadSessions(profileId, this.profileGeneration, this.profileAbort?.signal)
    await this.readTranscript(false)
    return true
  }

  async cancelTurn(): Promise<boolean> {
    const profileId = this.view.selectedProfileId
    const sessionId = this.view.selectedSessionId
    if (profileId === null || sessionId === null) return false
    const accepted = await this.runOperation('cancel', signal => unwrap(this.remote.cancel(profileId, sessionId, signal)))
    if (accepted === null) return false
    await this.readTranscript(false)
    return true
  }

  clearOperationError(): void {
    this.publish({ ...this.view, operationError: null })
  }

  reset(): void {
    if (this.disposed) return
    this.abortReads()
    this.publish({
      ...this.view,
      status: 'idle',
      ...resetProfileResources(),
      operation: null,
      operationError: null,
      error: null,
    })
    if (this.activeViews > 0) void this.refresh(true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.activeViews = 0
    this.abortReads()
    this.listeners.clear()
  }

  private deactivate(): void {
    this.activeViews = Math.max(0, this.activeViews - 1)
    if (this.activeViews !== 0) return
    this.abortReads()
  }

  private async loadProfileOverview(profileId: RemoteProfileId): Promise<void> {
    this.abortProfileReads()
    const generation = ++this.profileGeneration
    const abort = new AbortController()
    this.profileAbort = abort
    this.publish({
      ...this.view,
      credential: loading(this.view.credential.value),
      harnessWorkspaces: loading(this.view.harnessWorkspaces.value),
      sessions: loading(this.view.sessions.value),
    })
    await Promise.all([
      this.loadCredential(profileId, generation, abort.signal),
      this.loadHarnessWorkspaces(profileId, generation, abort.signal),
      this.loadSessions(profileId, generation, abort.signal),
    ])
  }

  private async selectAndLoadProfile(profileId: RemoteProfileId): Promise<void> {
    this.abortProfileReads()
    this.publish({
      ...this.view,
      selectedProfileId: profileId,
      ...resetProfileResources(),
    })
    await this.loadProfileOverview(profileId)
  }

  private async loadCredential(profileId: RemoteProfileId, generation: number, signal?: AbortSignal): Promise<void> {
    try {
      const value = await unwrap(this.remote.credentialStatus(profileId, signal))
      if (!this.profileReadIsStale(generation, profileId)) this.publish({ ...this.view, credential: ready(value) })
    } catch (error: unknown) {
      if (!this.profileReadIsStale(generation, profileId) && !isAbort(error)) {
        this.publish({ ...this.view, credential: failed(asFailure(error, 'credential')) })
      }
    }
  }

  private async loadHarnessWorkspaces(profileId: RemoteProfileId, generation: number, signal?: AbortSignal): Promise<void> {
    try {
      const value = await unwrap(this.remote.listHarnessWorkspaces(profileId, signal))
      if (!this.profileReadIsStale(generation, profileId)) this.publish({ ...this.view, harnessWorkspaces: ready(value) })
    } catch (error: unknown) {
      if (!this.profileReadIsStale(generation, profileId) && !isAbort(error)) {
        this.publish({ ...this.view, harnessWorkspaces: failed(asFailure(error, 'api')) })
      }
    }
  }

  private async loadSessions(profileId: RemoteProfileId, generation: number, signal?: AbortSignal): Promise<void> {
    try {
      const value = await unwrap(this.remote.listSessions(profileId, signal))
      if (this.profileReadIsStale(generation, profileId)) return
      const selectedSessionId = value.some(session => session.sessionId === this.view.selectedSessionId)
        ? this.view.selectedSessionId
        : null
      this.publish({
        ...this.view,
        sessions: ready(value),
        selectedSessionId,
        ...(selectedSessionId === null ? { transcript: idle<RemoteSessionTranscript>() } : {}),
      })
    } catch (error: unknown) {
      if (!this.profileReadIsStale(generation, profileId) && !isAbort(error)) {
        this.publish({ ...this.view, sessions: failed(asFailure(error, 'session')) })
      }
    }
  }

  private async readTranscript(older: boolean): Promise<void> {
    const profileId = this.view.selectedProfileId
    const sessionId = this.view.selectedSessionId
    if (profileId === null || sessionId === null) return
    const previous = older ? this.view.transcript.value : null
    const beforeSeq = older ? previous?.beforeSeq : undefined
    const generation = ++this.transcriptGeneration
    this.transcriptAbort?.abort()
    const abort = new AbortController()
    this.transcriptAbort = abort
    this.publish({ ...this.view, transcript: loading(previous) })
    try {
      const page = await unwrap(this.remote.readTranscript(
        profileId,
        sessionId,
        beforeSeq,
        TRANSCRIPT_PAGE_SIZE,
        abort.signal,
      ))
      if (this.transcriptReadIsStale(generation, profileId, sessionId, abort)) return
      this.publish({ ...this.view, transcript: ready(previous === null ? page : mergeTranscript(page, previous)) })
    } catch (error: unknown) {
      if (!this.transcriptReadIsStale(generation, profileId, sessionId, abort) && !isAbort(error)) {
        this.publish({ ...this.view, transcript: failed(asFailure(error, 'session'), previous) })
      }
    }
  }

  private async runOperation<T>(
    operation: RemoteOperation,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | null> {
    if (this.disposed || this.view.operation !== null) return null
    this.operationAbort?.abort()
    const abort = new AbortController()
    this.operationAbort = abort
    this.publish({ ...this.view, operation, operationError: null })
    try {
      const value = await call(abort.signal)
      if (this.disposed || abort.signal.aborted) return null
      this.publish({ ...this.view, operation: null, operationError: null })
      return value
    } catch (error: unknown) {
      if (this.disposed) return null
      if (abort.signal.aborted || isAbort(error)) {
        this.publish({ ...this.view, operation: null })
        return null
      }
      this.publish({ ...this.view, operation: null, operationError: asFailure(error, operationPhase(operation)) })
      return null
    }
  }

  private restartWatch(delay = 0): void {
    if (this.watchTimer !== undefined) clearTimeout(this.watchTimer)
    this.watchAbort?.abort()
    if (this.disposed || this.activeViews === 0) return
    this.watchTimer = setTimeout(() => void this.watchOnce(), delay)
  }

  private async watchOnce(): Promise<void> {
    if (this.disposed || this.activeViews === 0) return
    const abort = new AbortController()
    this.watchAbort = abort
    try {
      const snapshot = await unwrap(this.remote.watch(this.view.snapshot.revision, WATCH_TIMEOUT_MS, abort.signal))
      if (this.disposed || this.activeViews === 0 || abort.signal.aborted) return
      if (snapshot.revision >= this.view.snapshot.revision) {
        const selectedProfileId = retainedProfileId(snapshot.profiles, this.view.selectedProfileId)
        const selectionChanged = selectedProfileId !== this.view.selectedProfileId
        this.publish({
          ...this.view,
          status: 'ready',
          snapshot,
          selectedProfileId,
          ...(selectionChanged ? resetProfileResources() : {}),
          lastUpdatedAt: Date.now(),
          error: null,
        })
        if (selectionChanged && selectedProfileId !== null) void this.loadProfileOverview(selectedProfileId)
      }
      this.restartWatch(WATCH_SETTLE_MS)
    } catch (error: unknown) {
      if (!this.disposed && this.activeViews > 0 && !abort.signal.aborted && !isAbort(error)) {
        this.restartWatch(WATCH_RETRY_MS)
      }
    }
  }

  private profileReadIsStale(generation: number, profileId: RemoteProfileId): boolean {
    return this.disposed || generation !== this.profileGeneration || profileId !== this.view.selectedProfileId
  }

  private transcriptReadIsStale(
    generation: number,
    profileId: RemoteProfileId,
    sessionId: string,
    abort: AbortController,
  ): boolean {
    return this.disposed || abort.signal.aborted || generation !== this.transcriptGeneration
      || profileId !== this.view.selectedProfileId || sessionId !== this.view.selectedSessionId
  }

  private directoryReadIsStale(
    generation: number,
    profileGeneration: number,
    profileId: RemoteProfileId,
    abort: AbortController,
  ): boolean {
    return this.disposed || abort.signal.aborted || generation !== this.directoryGeneration
      || profileGeneration !== this.profileGeneration || profileId !== this.view.selectedProfileId
  }

  private abortProfileReads(): void {
    this.profileAbort?.abort()
    this.directoryAbort?.abort()
    this.transcriptAbort?.abort()
    this.profileGeneration++
    this.directoryGeneration++
    this.transcriptGeneration++
  }

  private abortReads(): void {
    this.watchAbort?.abort()
    this.operationAbort?.abort()
    this.abortProfileReads()
    this.refreshGeneration++
    if (this.watchTimer !== undefined) clearTimeout(this.watchTimer)
  }

  private publish(view: RemoteRuntimeViewState): void {
    if (this.disposed) return
    this.view = Object.freeze(view)
    for (const listener of this.listeners) listener()
  }
}

class RemoteRuntimeUiError extends Error {
  constructor(readonly failure: RemoteRuntimeFailure) {
    super(failure.message)
    this.name = 'RemoteRuntimeUiError'
  }
}

async function unwrap<T>(call: RemoteCall<T>): Promise<T> {
  const transport = await call
  if (!transport.ok) {
    throw new RemoteRuntimeUiError({
      code: 'remote-transport-failed',
      message: transport.error.message,
      phase: 'api',
      retryable: true,
    })
  }
  if (!transport.value.ok) throw new RemoteRuntimeUiError(transport.value.error)
  return transport.value.value
}

function idle<T>(): Loadable<T> {
  return Object.freeze({ status: 'idle', value: null, error: null })
}

function loading<T>(value: T | null = null): Loadable<T> {
  return Object.freeze({ status: 'loading', value, error: null })
}

function ready<T>(value: T): Loadable<T> {
  return Object.freeze({ status: 'ready', value, error: null })
}

function failed<T>(error: RemoteRuntimeFailure | null, value: T | null = null): Loadable<T> {
  return Object.freeze({
    status: 'error',
    value,
    error: error ?? {
      code: 'remote-operation-failed',
      message: 'Remote operation failed.',
      phase: 'api',
      retryable: true,
    },
  })
}

function resetProfileResources(): Pick<
  RemoteRuntimeViewState,
  'doctor' | 'credential' | 'directory' | 'harnessWorkspaces' | 'sessions' | 'selectedSessionId' | 'transcript'
> {
  return {
    doctor: idle<DoctorReport>(),
    credential: idle<RemoteCredentialStatus>(),
    directory: idle<RemoteDirectoryListing>(),
    harnessWorkspaces: idle<readonly RemoteHarnessWorkspace[]>(),
    sessions: idle<readonly RemoteSessionSummary[]>(),
    selectedSessionId: null,
    transcript: idle<RemoteSessionTranscript>(),
  }
}

function retainedProfileId(
  profiles: readonly RemoteProfileSummary[],
  selected: RemoteProfileId | null,
): RemoteProfileId | null {
  if (selected !== null && profiles.some(profile => profile.id === selected)) return selected
  return profiles[0]?.id ?? null
}

function normalizeRemotePath(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

function parentRemotePath(path: string): string | null {
  const normalized = path.replace(/\/+$/u, '') || '/'
  if (normalized === '/') return null
  const boundary = normalized.lastIndexOf('/')
  return boundary <= 0 ? '/' : normalized.slice(0, boundary)
}

function mergeTranscript(older: RemoteSessionTranscript, newer: RemoteSessionTranscript): RemoteSessionTranscript {
  const byId = new Map([...older.entries, ...newer.entries].map(entry => [entry.id, entry]))
  return {
    sessionId: newer.sessionId,
    ...(newer.title === undefined ? {} : { title: newer.title }),
    entries: [...byId.values()].sort((left, right) => left.seq - right.seq),
    hasMore: older.hasMore,
    ...(older.beforeSeq === undefined ? {} : { beforeSeq: older.beforeSeq }),
  }
}

function asFailure(error: unknown, phase: RemoteRuntimeFailure['phase']): RemoteRuntimeFailure {
  if (error instanceof RemoteRuntimeUiError) return error.failure
  if (isAbort(error)) {
    return { code: 'operation-aborted', message: 'Operation aborted.', phase, retryable: true }
  }
  return {
    code: 'client-operation-failed',
    message: error instanceof Error ? error.message : String(error),
    phase,
    retryable: true,
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function operationPhase(operation: RemoteOperation): RemoteRuntimeFailure['phase'] {
  switch (operation) {
    case 'create-profile':
    case 'update-profile':
    case 'remove-profile':
    case 'add-workspace':
    case 'update-workspace':
    case 'remove-workspace':
      return 'config'
    case 'doctor': return 'doctor'
    case 'install': return 'install'
    case 'start':
    case 'stop':
    case 'disconnect': return 'runtime'
    case 'credential': return 'credential'
    case 'prompt':
    case 'cancel': return 'session'
  }
}
