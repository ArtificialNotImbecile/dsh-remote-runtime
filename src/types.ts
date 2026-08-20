/** JSON-safe contracts shared by the Host service, browser client, and CLI. */

/** Stable UUID identity for one local connection profile. */
export type RemoteProfileId = string

/** Stable UUID identity for one profile-owned workspace. */
export type RemoteWorkspaceId = string

/** How the remote Harness reaches public Internet destinations. */
export type RemoteEgressMode = 'remote-direct' | 'client-proxy'

/** Client-proxy policy; private and local addresses always bypass or fail closed. */
export interface ClientProxyPolicy {
  readonly allowedPorts: readonly number[]
  readonly noProxy: readonly string[]
  readonly upstreamProxyEnv?: string
}

/** Immutable network selection stored with a profile. */
export interface RemoteNetworkConfig {
  readonly mode: RemoteEgressMode
  readonly clientProxy: ClientProxyPolicy
}

/** One saved path on a remote host. */
export interface RemoteWorkspace {
  readonly id: RemoteWorkspaceId
  readonly name: string
  readonly cwd: string
  readonly pinned: boolean
  readonly createdAt: string
}

/** Durable local profile. Secrets are never part of this value. */
export interface RemoteProfile {
  readonly version: 1
  readonly id: RemoteProfileId
  readonly name: string
  readonly sshHost: string
  readonly sshPort?: number
  readonly defaultCwd?: string
  readonly remoteRoot?: string
  readonly network: RemoteNetworkConfig
  readonly workspaces: readonly RemoteWorkspace[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Public profile view returned to the browser. */
export type RemoteProfileSummary = RemoteProfile

/** Create one profile; egress mode and remote root become immutable. */
export interface CreateRemoteProfileRequest {
  readonly name: string
  readonly sshHost: string
  readonly sshPort?: number
  readonly defaultCwd?: string
  readonly remoteRoot?: string
  readonly network?: Partial<RemoteNetworkConfig> & {
    readonly clientProxy?: Partial<ClientProxyPolicy>
  }
}

/** Mutable profile fields. Undefined preserves a field and null clears it. */
export interface UpdateRemoteProfileRequest {
  readonly id: RemoteProfileId
  readonly name?: string
  readonly sshHost?: string
  readonly sshPort?: number | null
  readonly defaultCwd?: string | null
}

/** Add a path to one profile without contacting or modifying the project. */
export interface AddRemoteWorkspaceRequest {
  readonly profileId: RemoteProfileId
  readonly name: string
  readonly cwd: string
  readonly pinned?: boolean
}

/** Update local display state for one saved path. */
export interface UpdateRemoteWorkspaceRequest {
  readonly profileId: RemoteProfileId
  readonly workspaceId: RemoteWorkspaceId
  readonly name?: string
  readonly pinned?: boolean
}

/** One read-only connectivity or runtime prerequisite result. */
export interface DoctorCheck {
  readonly id: string
  readonly status: 'pass' | 'fail' | 'warning' | 'not-run'
  readonly message: string
  readonly remediation?: string
}

/** Complete read-only profile diagnostic. Doctor never installs a runtime. */
export interface DoctorReport {
  readonly profileId: RemoteProfileId
  readonly checkedAt: string
  readonly ready: boolean
  readonly runtimeInstalled: boolean
  readonly checks: readonly DoctorCheck[]
}

/** Content-addressed managed runtime selected for one profile. */
export interface RemoteRuntimeInfo {
  readonly runtimeVersion: string
  readonly dshVersion: string
  readonly nodeVersion: string
  readonly artifactSha256: string
  readonly remoteRoot: string
  readonly profileRoot: string
  readonly dshHome: string
  readonly installed: boolean
}

/** Local tunnel and remote Harness lifecycle state. */
export interface RemoteConnectionStatus {
  readonly profileId: RemoteProfileId
  readonly state: 'disconnected' | 'checking' | 'installing' | 'starting' | 'connected' | 'failed'
  readonly revision: number
  readonly localUrl?: string
  readonly remotePort?: number
  readonly runtime?: RemoteRuntimeInfo
  readonly message?: string
  readonly remediation?: string
  readonly changedAt: string
}

/** Directory row returned by a plain-SSH browser, available before runtime install. */
export interface RemoteDirectoryEntry {
  readonly name: string
  readonly path: string
  readonly kind: 'directory' | 'symlink'
  readonly writable: boolean
  readonly gitRepository: boolean
}

/** One remote DSH workspace returned by the official Host API. */
export interface RemoteHarnessWorkspace {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** One remote DSH session returned by the official Host API. */
export interface RemoteSessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly cwd?: string
  readonly title?: string | null
  readonly parentSessionId?: string
  readonly origin?: 'subagent'
}

/** Compact transcript entry projected from an official session.history event. */
export interface RemoteTranscriptEntry {
  readonly id: string
  readonly seq: number
  readonly time: number
  readonly kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'notice' | 'other'
  readonly text: string
  readonly toolName?: string
}

/** One paged remote transcript. */
export interface RemoteSessionTranscript {
  readonly sessionId: string
  readonly title?: string | null
  readonly entries: readonly RemoteTranscriptEntry[]
  readonly hasMore: boolean
  readonly beforeSeq?: number
}

/** Latest browser-facing state. Expensive remote facts are refreshed explicitly. */
export interface RemoteRuntimeSnapshot {
  readonly revision: number
  readonly profiles: readonly RemoteProfileSummary[]
  readonly statuses: readonly RemoteConnectionStatus[]
}

/** Structured operation failure safe to render and log. */
export interface RemoteRuntimeFailure {
  readonly code: string
  readonly message: string
  readonly phase: 'config' | 'ssh' | 'doctor' | 'artifact' | 'install' | 'runtime' | 'tunnel' | 'api' | 'credential' | 'session'
  readonly retryable: boolean
  readonly remediation?: string
}

/** JSON-safe success/failure return used for every browser mutation. */
export type RemoteRuntimeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteRuntimeFailure }

/** Runtime start request. Credential import is a separate explicit operation. */
export interface StartRemoteRuntimeRequest {
  readonly profileId: RemoteProfileId
  readonly cwd?: string
}

/** Explicit credential copy. The secret is write-only and never echoed. */
export interface ImportCredentialRequest {
  readonly profileId: RemoteProfileId
  readonly apiKey: string
  readonly baseUrl?: string
}

/** Prompt one already-running remote Session through the official DSH API. */
export interface PromptRemoteSessionRequest {
  readonly profileId: RemoteProfileId
  readonly sessionId: string
  readonly text: string
  readonly mode?: 'queue' | 'steer'
}
