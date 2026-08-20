/** Cordis Remote service plus CLI-shareable core orchestration. */
import { randomInt } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { LocalRuntimeArtifactProvider, RuntimeArtifactError } from './artifact.ts'
import { ProxyAuditLog } from './audit.ts'
import { DshOfficialApiError } from './api-client.ts'
import { RemoteRuntimeError, asRemoteRuntimeError, redactDiagnostic } from './errors.ts'
import { ClientGateway } from './gateway.ts'
import { ProfileStore } from './profiles.ts'
import {
  RemoteRuntimeController,
  type RemoteCredentialStatus,
  type RuntimeClientProxyPort,
} from './runtime.ts'
import { SshRunner } from './ssh.ts'
import { SshTunnelManager } from './tunnel.ts'
import type {
  AddRemoteWorkspaceRequest,
  CreateRemoteProfileRequest,
  DoctorReport,
  ImportCredentialRequest,
  PromptRemoteSessionRequest,
  RemoteConnectionStatus,
  RemoteDirectoryEntry,
  RemoteHarnessWorkspace,
  RemoteProfile,
  RemoteProfileId,
  RemoteProfileSummary,
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
} from './types.ts'

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024

/** Deployment configuration supplied by `cordis.patch.yml`. */
export interface Config {
  readonly root: string
  readonly sshExecutable: string
  readonly commandTimeoutMs: number
  readonly maxTranscriptBytes: number
}

/** Validated deployment schema. */
export const Config: Schema<Config> = Schema.object({
  root: Schema.string().required(),
  sshExecutable: Schema.string().default('ssh'),
  commandTimeoutMs: Schema.number().step(1).min(1).default(DEFAULT_COMMAND_TIMEOUT_MS),
  maxTranscriptBytes: Schema.number().step(1).min(1).default(DEFAULT_MAX_TRANSCRIPT_BYTES),
}) as Schema<Config>

/** Public result of removal/stop/disconnect operations. */
export interface ChangedResult {
  readonly changed: boolean
}

/** Public write-only credential import receipt. */
export interface CredentialImportReceipt {
  readonly configured: true
  readonly updatedAt: string
}

/** Public prompt/cancel admission receipt. */
export interface AdmissionReceipt {
  readonly accepted: true
}

/** Dependency overrides used by unit tests and the CLI. */
export interface DshRemoteRuntimeCoreOptions {
  readonly profiles?: ProfileStore
  readonly runtime?: RemoteRuntimeController
}

/**
 * Application core shared by the Cordis Remote and the `dsh-remote` CLI.
 * It contains no renderer state and never serializes a credential value.
 */
export class DshRemoteRuntimeCore {
  readonly profiles: ProfileStore
  readonly runtime: RemoteRuntimeController
  private readonly auditRoot: string

  constructor(readonly config: Config, options: DshRemoteRuntimeCoreOptions = {}) {
    const root = resolve(config.root)
    this.auditRoot = join(root, 'audit')
    this.profiles = options.profiles ?? new ProfileStore(join(root, 'profiles.json'))
    if (options.runtime !== undefined) {
      this.runtime = options.runtime
      return
    }
    const ssh = new SshRunner({ executable: config.sshExecutable })
    const tunnels = new SshTunnelManager({ ssh })
    this.runtime = new RemoteRuntimeController({
      ssh,
      tunnels,
      artifacts: new LocalRuntimeArtifactProvider({ cacheRoot: join(root, 'cache') }),
      clientProxy: new ClientGatewayRuntimePort(this.auditRoot),
      commandTimeoutMs: config.commandTimeoutMs,
      maxTranscriptBytes: config.maxTranscriptBytes,
    })
  }

  async initialize(): Promise<void> {
    await mkdir(resolve(this.config.root), { recursive: true, mode: 0o700 })
  }

  async snapshot(): Promise<RemoteRuntimeSnapshot> {
    const profiles = await this.profiles.list()
    return Object.freeze({
      revision: this.runtime.currentRevision,
      profiles: Object.freeze(profiles),
      statuses: this.runtime.listStatuses(),
    })
  }

  async watch(afterRevision: number, timeoutMs: number | undefined, signal: AbortSignal): Promise<RemoteRuntimeSnapshot> {
    await this.runtime.waitForRevision(afterRevision, timeoutMs, signal)
    return this.snapshot()
  }

  async createProfile(request: CreateRemoteProfileRequest): Promise<RemoteProfile> {
    const profile = await this.profiles.create(request)
    this.runtime.noteProfileMutation()
    return profile
  }

  async updateProfile(request: UpdateRemoteProfileRequest): Promise<RemoteProfile> {
    const previous = await this.profiles.get(request.id)
    const profile = await this.profiles.update(request)
    if (previous.sshHost !== profile.sshHost || previous.sshPort !== profile.sshPort) {
      await this.runtime.disconnect(previous)
    }
    this.runtime.noteProfileMutation()
    return profile
  }

  async removeProfile(profileId: RemoteProfileId): Promise<ChangedResult> {
    const profile = await this.profiles.get(profileId)
    // Removing local configuration never stops or deletes the remote runtime.
    await this.runtime.disconnect(profile)
    await this.profiles.remove(profileId)
    const audit = new ProxyAuditLog(profile, this.auditRoot)
    await Promise.all([
      rm(audit.filePath, { force: true }),
      rm(`${audit.filePath}.1`, { force: true }),
    ])
    this.runtime.noteProfileMutation()
    return Object.freeze({ changed: true })
  }

  async doctor(profileId: RemoteProfileId, signal: AbortSignal): Promise<DoctorReport> {
    return this.runtime.doctor(await this.profiles.get(profileId), signal)
  }

  async install(profileId: RemoteProfileId, signal: AbortSignal): Promise<RemoteRuntimeInfo> {
    return this.runtime.install(await this.profiles.get(profileId), signal)
  }

  async start(request: StartRemoteRuntimeRequest, signal: AbortSignal): Promise<RemoteConnectionStatus> {
    return this.runtime.start(await this.profiles.get(request.profileId), request, signal)
  }

  async stop(profileId: RemoteProfileId, signal: AbortSignal): Promise<ChangedResult> {
    return this.runtime.stop(await this.profiles.get(profileId), signal)
  }

  async disconnect(profileId: RemoteProfileId): Promise<ChangedResult> {
    return this.runtime.disconnect(await this.profiles.get(profileId))
  }

  async importCredential(request: ImportCredentialRequest, signal: AbortSignal): Promise<CredentialImportReceipt> {
    return this.runtime.importCredential(await this.profiles.get(request.profileId), request, signal)
  }

  async credentialStatus(profileId: RemoteProfileId, signal: AbortSignal): Promise<RemoteCredentialStatus> {
    return this.runtime.credentialStatus(await this.profiles.get(profileId), signal)
  }

  async listDirectory(
    profileId: RemoteProfileId,
    path: string | undefined,
    signal: AbortSignal,
  ): Promise<readonly RemoteDirectoryEntry[]> {
    return this.runtime.listDirectory(await this.profiles.get(profileId), path, signal)
  }

  async addWorkspace(request: AddRemoteWorkspaceRequest): Promise<RemoteWorkspace> {
    const workspace = await this.profiles.addWorkspace(request)
    this.runtime.noteProfileMutation()
    return workspace
  }

  async updateWorkspace(request: UpdateRemoteWorkspaceRequest): Promise<RemoteWorkspace> {
    const workspace = await this.profiles.updateWorkspace(request)
    this.runtime.noteProfileMutation()
    return workspace
  }

  async removeWorkspace(profileId: RemoteProfileId, workspaceId: RemoteWorkspaceId): Promise<ChangedResult> {
    await this.profiles.removeWorkspace(profileId, workspaceId)
    this.runtime.noteProfileMutation()
    return Object.freeze({ changed: true })
  }

  async listHarnessWorkspaces(profileId: RemoteProfileId, signal: AbortSignal): Promise<readonly RemoteHarnessWorkspace[]> {
    return this.runtime.listHarnessWorkspaces(await this.profiles.get(profileId), signal)
  }

  async listSessions(profileId: RemoteProfileId, signal: AbortSignal): Promise<readonly RemoteSessionSummary[]> {
    return this.runtime.listSessions(await this.profiles.get(profileId), signal)
  }

  async readTranscript(
    profileId: RemoteProfileId,
    sessionId: string,
    beforeSeq: number | undefined,
    maxMessages: number | undefined,
    signal: AbortSignal,
  ): Promise<RemoteSessionTranscript> {
    return this.runtime.readTranscript(await this.profiles.get(profileId), sessionId, beforeSeq, maxMessages, signal)
  }

  async prompt(request: PromptRemoteSessionRequest, signal: AbortSignal): Promise<AdmissionReceipt> {
    return this.runtime.prompt(await this.profiles.get(request.profileId), request, signal)
  }

  async cancel(profileId: RemoteProfileId, sessionId: string, signal: AbortSignal): Promise<AdmissionReceipt> {
    return this.runtime.cancel(await this.profiles.get(profileId), sessionId, signal)
  }

  close(): Promise<void> {
    return this.runtime.close()
  }
}

/** Typert Remote namespace exposed to the browser plugin. */
export class DshRemoteRuntimeService extends TypertRemoteService {
  static inject: string[] = []
  static Config = Config
  readonly core: DshRemoteRuntimeCore

  constructor(ctx: Context, config: Config) {
    super(ctx, 'dshRemoteRuntime')
    this.core = new DshRemoteRuntimeCore(config)
  }

  protected async [Service.init](): Promise<void> {
    await this.core.initialize()
    this.ctx.effect(() => () => this.core.close(), 'dsh-remote-runtime: close local control plane')
  }

  @Remote('snapshot')
  snapshot(): Promise<RemoteRuntimeResult<RemoteRuntimeSnapshot>> {
    return safeResult(() => this.core.snapshot(), 'snapshot-failed', 'Failed to read remote runtime state.', 'config')
  }

  @Remote('watch')
  watch(afterRevision: number, timeoutMs: number | undefined, signal: AbortSignal): Promise<RemoteRuntimeResult<RemoteRuntimeSnapshot>> {
    return safeResult(() => this.core.watch(afterRevision, timeoutMs, signal), 'watch-failed', 'Remote runtime watch failed.', 'runtime')
  }

  @Remote('createProfile')
  createProfile(request: CreateRemoteProfileRequest): Promise<RemoteRuntimeResult<RemoteProfileSummary>> {
    return safeResult(() => this.core.createProfile(request), 'profile-create-failed', 'Failed to create remote profile.', 'config')
  }

  @Remote('updateProfile')
  updateProfile(request: UpdateRemoteProfileRequest): Promise<RemoteRuntimeResult<RemoteProfileSummary>> {
    return safeResult(() => this.core.updateProfile(request), 'profile-update-failed', 'Failed to update remote profile.', 'config')
  }

  @Remote('removeProfile')
  removeProfile(profileId: RemoteProfileId): Promise<RemoteRuntimeResult<{ readonly changed: boolean }>> {
    return safeResult(() => this.core.removeProfile(profileId), 'profile-remove-failed', 'Failed to remove remote profile.', 'config')
  }

  @Remote('doctor')
  doctor(profileId: RemoteProfileId, signal: AbortSignal): Promise<RemoteRuntimeResult<DoctorReport>> {
    return safeResult(() => this.core.doctor(profileId, signal), 'doctor-failed', 'Remote diagnostics failed.', 'doctor')
  }

  @Remote('installRuntime')
  installRuntime(profileId: RemoteProfileId, signal: AbortSignal): Promise<RemoteRuntimeResult<RemoteRuntimeInfo>> {
    return safeResult(() => this.core.install(profileId, signal), 'install-failed', 'Managed runtime installation failed.', 'install')
  }

  @Remote('start')
  start(request: StartRemoteRuntimeRequest, signal: AbortSignal): Promise<RemoteRuntimeResult<RemoteConnectionStatus>> {
    return safeResult(() => this.core.start(request, signal), 'runtime-start-failed', 'Remote Harness failed to start.', 'runtime')
  }

  @Remote('stop')
  stop(profileId: RemoteProfileId, signal: AbortSignal): Promise<RemoteRuntimeResult<{ readonly changed: boolean }>> {
    return safeResult(() => this.core.stop(profileId, signal), 'runtime-stop-failed', 'Remote Harness failed to stop.', 'runtime')
  }

  @Remote('disconnect')
  disconnect(profileId: RemoteProfileId): Promise<RemoteRuntimeResult<{ readonly changed: boolean }>> {
    return safeResult(() => this.core.disconnect(profileId), 'disconnect-failed', 'SSH tunnel failed to disconnect.', 'tunnel')
  }

  @Remote('importCredential')
  importCredential(request: ImportCredentialRequest, signal: AbortSignal): Promise<RemoteRuntimeResult<{ readonly configured: true; readonly updatedAt: string }>> {
    return safeResult(() => this.core.importCredential(request, signal), 'credential-import-failed', 'Credential import failed.', 'credential')
  }

  @Remote('credentialStatus')
  credentialStatus(profileId: RemoteProfileId, signal: AbortSignal): Promise<RemoteRuntimeResult<{
    readonly configured: boolean
    readonly baseUrl?: string
    readonly updatedAt?: string
  }>> {
    return safeResult(() => this.core.credentialStatus(profileId, signal), 'credential-status-failed', 'Credential status check failed.', 'credential')
  }

  @Remote('listDirectory')
  listDirectory(profileId: RemoteProfileId, path: string | undefined, signal: AbortSignal): Promise<RemoteRuntimeResult<readonly RemoteDirectoryEntry[]>> {
    return safeResult(() => this.core.listDirectory(profileId, path, signal), 'directory-list-failed', 'Remote directory listing failed.', 'ssh')
  }

  @Remote('addWorkspace')
  addWorkspace(request: AddRemoteWorkspaceRequest): Promise<RemoteRuntimeResult<RemoteWorkspace>> {
    return safeResult(() => this.core.addWorkspace(request), 'workspace-add-failed', 'Failed to add remote workspace.', 'config')
  }

  @Remote('updateWorkspace')
  updateWorkspace(request: UpdateRemoteWorkspaceRequest): Promise<RemoteRuntimeResult<RemoteWorkspace>> {
    return safeResult(() => this.core.updateWorkspace(request), 'workspace-update-failed', 'Failed to update remote workspace.', 'config')
  }

  @Remote('removeWorkspace')
  removeWorkspace(profileId: RemoteProfileId, workspaceId: RemoteWorkspaceId): Promise<RemoteRuntimeResult<{ readonly changed: boolean }>> {
    return safeResult(() => this.core.removeWorkspace(profileId, workspaceId), 'workspace-remove-failed', 'Failed to remove remote workspace.', 'config')
  }

  @Remote('listHarnessWorkspaces')
  listHarnessWorkspaces(profileId: RemoteProfileId, signal: AbortSignal): Promise<RemoteRuntimeResult<readonly RemoteHarnessWorkspace[]>> {
    return safeResult(() => this.core.listHarnessWorkspaces(profileId, signal), 'workspace-list-failed', 'Remote Harness workspaces could not be listed.', 'api')
  }

  @Remote('listSessions')
  listSessions(profileId: RemoteProfileId, signal: AbortSignal): Promise<RemoteRuntimeResult<readonly RemoteSessionSummary[]>> {
    return safeResult(() => this.core.listSessions(profileId, signal), 'session-list-failed', 'Remote Sessions could not be listed.', 'session')
  }

  @Remote('readTranscript')
  readTranscript(
    profileId: RemoteProfileId,
    sessionId: string,
    beforeSeq: number | undefined,
    maxMessages: number | undefined,
    signal: AbortSignal,
  ): Promise<RemoteRuntimeResult<RemoteSessionTranscript>> {
    return safeResult(
      () => this.core.readTranscript(profileId, sessionId, beforeSeq, maxMessages, signal),
      'session-history-failed', 'Remote Session history could not be read.', 'session',
    )
  }

  @Remote('prompt')
  prompt(request: PromptRemoteSessionRequest, signal: AbortSignal): Promise<RemoteRuntimeResult<{ readonly accepted: true }>> {
    return safeResult(() => this.core.prompt(request, signal), 'session-prompt-failed', 'Remote Session prompt failed.', 'session')
  }

  @Remote('cancel')
  cancel(profileId: RemoteProfileId, sessionId: string, signal: AbortSignal): Promise<RemoteRuntimeResult<{ readonly accepted: true }>> {
    return safeResult(() => this.core.cancel(profileId, sessionId, signal), 'session-cancel-failed', 'Remote Session cancellation failed.', 'session')
  }
}

class ClientGatewayRuntimePort implements RuntimeClientProxyPort {
  constructor(private readonly auditRoot: string) {}

  async open(profile: RemoteProfile): Promise<{
    readonly localHost: '127.0.0.1'
    readonly localPort: number
    readonly remotePort: number
    readonly proxyUrl: string
    close(): Promise<void>
  }> {
    const environmentName = profile.network.clientProxy.upstreamProxyEnv
    const upstreamProxy = environmentName === undefined ? undefined : process.env[environmentName]
    const audit = new ProxyAuditLog(profile, this.auditRoot)
    const gateway = new ClientGateway({
      allowedPorts: profile.network.clientProxy.allowedPorts,
      ...(upstreamProxy === undefined || upstreamProxy === '' ? {} : { upstreamProxy }),
      onAudit: event => audit.write(event),
    })
    let address: Awaited<ReturnType<ClientGateway['start']>>
    try {
      address = await gateway.start()
    } catch (error: unknown) {
      await audit.flush()
      throw error
    }
    const remotePort = randomInt(20_000, 60_001)
    const remoteUrl = new URL(address.proxyUrl)
    remoteUrl.hostname = '127.0.0.1'
    remoteUrl.port = String(remotePort)
    return Object.freeze({
      localHost: '127.0.0.1',
      localPort: address.port,
      remotePort,
      proxyUrl: remoteUrl.toString(),
      close: async () => {
        await gateway.close()
        await audit.flush()
      },
    })
  }
}

async function safeResult<T>(
  operation: () => Promise<T>,
  code: string,
  message: string,
  phase: RemoteRuntimeError['phase'],
): Promise<RemoteRuntimeResult<T>> {
  try {
    return Object.freeze({ ok: true, value: await operation() })
  } catch (error: unknown) {
    const normalized = normalizeFailure(error, { code, message, phase })
    const failure = normalized.serialize()
    return Object.freeze({
      ok: false,
      error: Object.freeze({
        ...failure,
        message: redactDiagnostic(failure.message)
          .replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, 'sk-<redacted>')
          .slice(0, 1_000),
      }),
    })
  }
}

function normalizeFailure(
  error: unknown,
  fallback: { readonly code: string; readonly message: string; readonly phase: RemoteRuntimeError['phase'] },
): RemoteRuntimeError {
  if (error instanceof RuntimeArtifactError) {
    return new RemoteRuntimeError(error.code.toLocaleLowerCase().replaceAll('_', '-'), error.message, {
      phase: 'artifact', retryable: error.retryable, cause: error,
    })
  }
  if (error instanceof DshOfficialApiError) {
    return new RemoteRuntimeError(error.code.toLocaleLowerCase().replaceAll('_', '-'), error.message, {
      phase: 'api', retryable: error.retryable, cause: error,
    })
  }
  return asRemoteRuntimeError(error, fallback)
}
