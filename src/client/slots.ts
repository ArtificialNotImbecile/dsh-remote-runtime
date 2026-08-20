/** Settings slot props and injected actions for DSH Remote Runtime. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  CreateRemoteProfileRequest,
  RemoteProfileId,
  RemoteProfileSummary,
  RemoteWorkspaceId,
  UpdateRemoteProfileRequest,
  UpdateRemoteWorkspaceRequest,
} from '../types.ts'
import type { RemoteRuntimeController, RemoteRuntimeViewState } from './controller.ts'

/** Business face supplied to the settings contribution. */
export interface RemoteRuntimeInjected {
  hooks: { remoteRuntime: RemoteRuntimeController }
  activate(): () => void
  refresh(): Promise<void>
  selectProfile(profileId: RemoteProfileId): void
  createProfile(request: CreateRemoteProfileRequest): Promise<RemoteProfileSummary | null>
  updateProfile(request: UpdateRemoteProfileRequest): Promise<boolean>
  removeProfile(profileId: RemoteProfileId): Promise<boolean>
  runDoctor(profileId?: RemoteProfileId | null): ReturnType<RemoteRuntimeController['runDoctor']>
  install(profileId?: RemoteProfileId | null): Promise<boolean>
  start(cwd?: string): Promise<boolean>
  stop(): Promise<boolean>
  disconnect(): Promise<boolean>
  importCredential(apiKey: string, baseUrl?: string): Promise<boolean>
  browseDirectory(path?: string): Promise<void>
  addWorkspace(name: string, cwd: string, pinned: boolean): Promise<boolean>
  updateWorkspace(request: UpdateRemoteWorkspaceRequest): Promise<boolean>
  removeWorkspace(workspaceId: RemoteWorkspaceId): Promise<boolean>
  refreshProfileData(): Promise<void>
  selectSession(sessionId: string): void
  retryTranscript(): Promise<void>
  loadOlderTranscript(): Promise<void>
  prompt(text: string, mode: 'queue' | 'steer'): Promise<boolean>
  cancelTurn(): Promise<boolean>
  clearOperationError(): void
}

/** Complete props received by the settings section. */
export type RemoteRuntimeSettingsProps = PropsRuntime<'settings.section'>
  & InjectFace<RemoteRuntimeInjected>
  & PropsLocale<'dsh-remote-runtime'>

/** Narrow shape useful to test locale-agnostic render helpers. */
export type RemoteRuntimeSnapshotSelector = (state: RemoteRuntimeViewState) => RemoteRuntimeViewState
