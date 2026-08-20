import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RemoteRuntimeError, errnoCode } from './errors.ts'
import { withOwnedFileLock } from './file-lock.ts'
import type {
  AddRemoteWorkspaceRequest,
  CreateRemoteProfileRequest,
  RemoteEgressMode,
  RemoteNetworkConfig,
  RemoteProfile,
  RemoteProfileId,
  RemoteWorkspace,
  RemoteWorkspaceId,
  UpdateRemoteProfileRequest,
  UpdateRemoteWorkspaceRequest,
} from './types.ts'

export interface ProfilesDocument {
  readonly version: 1
  readonly profiles: readonly RemoteProfile[]
}

const PROFILE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u
const SSH_HOST = /^[^\s\0\r\n]+$/u
const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const NO_PROXY_ENTRY = /^[A-Za-z0-9._:-]+$/u
const OPTIONAL_IMMUTABLE_FIELDS = ['network', 'remoteRoot'] as const

export function defaultProfilesPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.DSH_REMOTE_RUNTIME_CONFIG_PATH || env.DSH_REMOTE_CONFIG_PATH
  if (override) return path.resolve(override)
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'dsh-remote-runtime', 'profiles.json')
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'dsh-remote-runtime', 'profiles.json')
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dsh-remote-runtime', 'profiles.json')
}

/** Atomic, cross-process profile and workspace storage. */
export class ProfileStore {
  readonly filePath: string

  constructor(filePath = defaultProfilesPath()) {
    this.filePath = path.resolve(filePath)
  }

  async list(): Promise<RemoteProfile[]> {
    const document = await this.read()
    return document.profiles
      .map(cloneProfile)
      .sort((left, right) => left.sshHost.localeCompare(right.sshHost) || left.name.localeCompare(right.name))
  }

  async get(idOrName: string): Promise<RemoteProfile> {
    const profile = findProfile(await this.read(), idOrName)
    if (!profile) throw profileNotFound(idOrName)
    return cloneProfile(profile)
  }

  /** Alias retained for CLI-style consumers. */
  add(input: CreateRemoteProfileRequest): Promise<RemoteProfile> {
    return this.create(input)
  }

  async create(input: CreateRemoteProfileRequest): Promise<RemoteProfile> {
    const name = validateProfileName(input.name)
    const sshHost = validateSshHost(input.sshHost)
    const sshPort = input.sshPort === undefined ? undefined : validatePort(input.sshPort, 'SSH port')
    const defaultCwd = input.defaultCwd === undefined ? undefined : validateRemotePath(input.defaultCwd, 'default cwd')
    const remoteRoot = input.remoteRoot === undefined ? undefined : validateRemotePath(input.remoteRoot, 'remote root')
    const network = validateNetworkConfig(input.network)

    return this.withLock(async () => {
      const document = await this.read()
      if (document.profiles.some((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new RemoteRuntimeError('profile-exists', `Remote profile ${JSON.stringify(name)} already exists.`, {
          phase: 'config',
        })
      }
      const now = new Date().toISOString()
      const id = randomUUID() as RemoteProfileId
      const workspaces: RemoteWorkspace[] = defaultCwd
        ? [{
            id: randomUUID() as RemoteWorkspaceId,
            name: defaultWorkspaceName(defaultCwd),
            cwd: defaultCwd,
            pinned: true,
            createdAt: now,
          }]
        : []
      const profile: RemoteProfile = {
        version: 1,
        id,
        name,
        sshHost,
        ...(sshPort === undefined ? {} : { sshPort }),
        ...(defaultCwd === undefined ? {} : { defaultCwd }),
        ...(remoteRoot === undefined ? {} : { remoteRoot }),
        network,
        workspaces,
        createdAt: now,
        updatedAt: now,
      }
      const next: ProfilesDocument = { version: 1, profiles: [...document.profiles, profile] }
      await this.write(next)
      return cloneProfile(profile)
    })
  }

  async update(request: UpdateRemoteProfileRequest): Promise<RemoteProfile> {
    for (const field of OPTIONAL_IMMUTABLE_FIELDS) {
      if (Object.hasOwn(request as object, field)) {
        throw new RemoteRuntimeError(
          'profile-field-immutable',
          `${field} cannot change after a remote profile is created.`,
          {
            phase: 'config',
            remediation: 'Create another profile for a different remote root or egress mode.',
          },
        )
      }
    }
    const name = request.name === undefined ? undefined : validateProfileName(request.name)
    const sshHost = request.sshHost === undefined ? undefined : validateSshHost(request.sshHost)
    const sshPort = request.sshPort === undefined || request.sshPort === null
      ? request.sshPort
      : validatePort(request.sshPort, 'SSH port')
    const defaultCwd = request.defaultCwd === undefined || request.defaultCwd === null
      ? request.defaultCwd
      : validateRemotePath(request.defaultCwd, 'default cwd')

    return this.withLock(async () => {
      const document = await this.read()
      const index = document.profiles.findIndex((profile) => profile.id === request.id)
      if (index < 0) throw profileNotFound(request.id)
      const current = document.profiles[index]!
      if (name && document.profiles.some((profile) => profile.id !== current.id
        && profile.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        throw new RemoteRuntimeError('profile-exists', `Remote profile ${JSON.stringify(name)} already exists.`, {
          phase: 'config',
        })
      }

      let workspaces = current.workspaces.map(cloneWorkspace)
      if (defaultCwd) {
        const existing = workspaces.find((workspace) => workspace.cwd === defaultCwd)
        if (!existing) {
          workspaces.push({
            id: randomUUID() as RemoteWorkspaceId,
            name: defaultWorkspaceName(defaultCwd),
            cwd: defaultCwd,
            pinned: true,
            createdAt: new Date().toISOString(),
          })
        }
      }
      workspaces = sortWorkspaces(workspaces)
      const nextProfile: RemoteProfile = {
        version: 1,
        id: current.id,
        name: name ?? current.name,
        sshHost: sshHost ?? current.sshHost,
        ...resolveOptional('sshPort', sshPort, current.sshPort),
        ...resolveOptional('defaultCwd', defaultCwd, current.defaultCwd),
        ...(current.remoteRoot === undefined ? {} : { remoteRoot: current.remoteRoot }),
        network: cloneNetwork(current.network),
        workspaces,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      }
      const profiles = [...document.profiles]
      profiles[index] = nextProfile
      await this.write({ version: 1, profiles })
      return cloneProfile(nextProfile)
    })
  }

  async remove(idOrName: string): Promise<RemoteProfile> {
    return this.withLock(async () => {
      const document = await this.read()
      const profile = findProfile(document, idOrName)
      if (!profile) throw profileNotFound(idOrName)
      await this.write({ version: 1, profiles: document.profiles.filter((candidate) => candidate.id !== profile.id) })
      return cloneProfile(profile)
    })
  }

  async addWorkspace(request: AddRemoteWorkspaceRequest): Promise<RemoteWorkspace> {
    const name = validateWorkspaceName(request.name)
    const cwd = validateRemotePath(request.cwd, 'workspace cwd')
    return this.withLock(async () => {
      const document = await this.read()
      const index = document.profiles.findIndex((profile) => profile.id === request.profileId)
      if (index < 0) throw profileNotFound(request.profileId)
      const current = document.profiles[index]!
      const existing = current.workspaces.find((workspace) => workspace.cwd === cwd)
      const workspace: RemoteWorkspace = existing
        ? { ...cloneWorkspace(existing), name, pinned: request.pinned ?? existing.pinned }
        : {
            id: randomUUID() as RemoteWorkspaceId,
            name,
            cwd,
            pinned: request.pinned ?? false,
            createdAt: new Date().toISOString(),
          }
      const workspaces = existing
        ? current.workspaces.map((candidate) => candidate.id === existing.id ? workspace : cloneWorkspace(candidate))
        : [...current.workspaces.map(cloneWorkspace), workspace]
      const profiles = [...document.profiles]
      profiles[index] = { ...cloneProfile(current), workspaces: sortWorkspaces(workspaces), updatedAt: new Date().toISOString() }
      await this.write({ version: 1, profiles })
      return cloneWorkspace(workspace)
    })
  }

  async updateWorkspace(request: UpdateRemoteWorkspaceRequest): Promise<RemoteWorkspace> {
    const name = request.name === undefined ? undefined : validateWorkspaceName(request.name)
    return this.withLock(async () => {
      const document = await this.read()
      const profileIndex = document.profiles.findIndex((profile) => profile.id === request.profileId)
      if (profileIndex < 0) throw profileNotFound(request.profileId)
      const current = document.profiles[profileIndex]!
      const workspaceIndex = current.workspaces.findIndex((workspace) => workspace.id === request.workspaceId)
      if (workspaceIndex < 0) throw workspaceNotFound(request.workspaceId)
      const workspace: RemoteWorkspace = {
        ...cloneWorkspace(current.workspaces[workspaceIndex]!),
        ...(name === undefined ? {} : { name }),
        ...(request.pinned === undefined ? {} : { pinned: request.pinned }),
      }
      const workspaces = current.workspaces.map((candidate, index) => index === workspaceIndex
        ? workspace
        : cloneWorkspace(candidate))
      const profiles = [...document.profiles]
      profiles[profileIndex] = { ...cloneProfile(current), workspaces: sortWorkspaces(workspaces), updatedAt: new Date().toISOString() }
      await this.write({ version: 1, profiles })
      return cloneWorkspace(workspace)
    })
  }

  async removeWorkspace(profileId: RemoteProfileId, workspaceId: RemoteWorkspaceId): Promise<RemoteWorkspace> {
    return this.withLock(async () => {
      const document = await this.read()
      const profileIndex = document.profiles.findIndex((profile) => profile.id === profileId)
      if (profileIndex < 0) throw profileNotFound(profileId)
      const current = document.profiles[profileIndex]!
      const workspace = current.workspaces.find((candidate) => candidate.id === workspaceId)
      if (!workspace) throw workspaceNotFound(workspaceId)
      const profiles = [...document.profiles]
      profiles[profileIndex] = {
        ...cloneProfile(current),
        workspaces: current.workspaces.filter((candidate) => candidate.id !== workspaceId).map(cloneWorkspace),
        updatedAt: new Date().toISOString(),
      }
      await this.write({ version: 1, profiles })
      return cloneWorkspace(workspace)
    })
  }

  private async read(): Promise<ProfilesDocument> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return { version: 1, profiles: [] }
      throw new RemoteRuntimeError('profile-read-failed', 'Failed to read remote profiles.', {
        phase: 'config',
        safeDetails: { path: this.filePath },
        cause: error,
      })
    }
    try {
      return parseProfilesDocument(JSON.parse(raw) as unknown)
    } catch (error) {
      throw new RemoteRuntimeError('profile-config-invalid', 'Remote profile configuration is invalid.', {
        phase: 'config',
        safeDetails: { path: this.filePath },
        remediation: 'Repair or move the profile file; it is never overwritten after a parse failure.',
        cause: error,
      })
    }
  }

  private async write(document: ProfilesDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.filePath)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private withLock<T>(run: () => Promise<T>): Promise<T> {
    return withOwnedFileLock(`${this.filePath}.lock`, run, {
      timeoutCode: 'profile-lock-timeout',
      timeoutMessage: 'Timed out waiting for the profile configuration lock.',
      phase: 'config',
    })
  }
}

export function validateProfileName(value: string): string {
  const normalized = value.trim()
  if (!PROFILE_NAME.test(normalized)) {
    throw new RemoteRuntimeError('profile-name-invalid', 'Profile names may use letters, numbers, dots, underscores, and hyphens.', {
      phase: 'config',
    })
  }
  return normalized
}

export function validateSshHost(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 255 || normalized.startsWith('-') || !SSH_HOST.test(normalized)) {
    throw new RemoteRuntimeError('ssh-host-invalid', 'SSH host must be a host or OpenSSH alias, not an option or command.', {
      phase: 'config',
    })
  }
  return normalized
}

export function validateRemotePath(value: string, label = 'remote path'): string {
  const normalized = value.trim()
  if (!normalized.startsWith('/') || normalized.length > 4096 || /[\0\r\n]/u.test(normalized)) {
    throw new RemoteRuntimeError('remote-path-invalid', `${label} must be an absolute POSIX path.`, { phase: 'config' })
  }
  const canonical = path.posix.normalize(normalized)
  return canonical.length > 1 ? canonical.replace(/\/+$/u, '') : canonical
}

export function validateWorkspaceName(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 80 || /[\0\r\n]/u.test(normalized)) {
    throw new RemoteRuntimeError('workspace-name-invalid', 'Workspace names must be 1 through 80 printable characters.', {
      phase: 'config',
    })
  }
  return normalized
}

export function validatePort(value: number, label = 'port'): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new RemoteRuntimeError('port-invalid', `${label} must be an integer from 1 through 65535.`, { phase: 'config' })
  }
  return value
}

export function validateNetworkConfig(input: CreateRemoteProfileRequest['network']): RemoteNetworkConfig {
  const mode: RemoteEgressMode = input?.mode ?? 'remote-direct'
  if (mode !== 'remote-direct' && mode !== 'client-proxy') {
    throw new RemoteRuntimeError('egress-mode-invalid', 'Unsupported remote egress mode.', { phase: 'config' })
  }
  const allowedPorts = validateAllowedPorts(input?.clientProxy?.allowedPorts ?? [80, 443])
  const noProxy = validateNoProxy(input?.clientProxy?.noProxy ?? [])
  const upstreamProxyEnv = input?.clientProxy?.upstreamProxyEnv
  if (upstreamProxyEnv !== undefined && !ENVIRONMENT_NAME.test(upstreamProxyEnv)) {
    throw new RemoteRuntimeError('proxy-environment-invalid', 'Upstream proxy must be selected by an environment variable name.', {
      phase: 'config',
    })
  }
  return {
    mode,
    clientProxy: {
      allowedPorts,
      noProxy,
      ...(upstreamProxyEnv === undefined ? {} : { upstreamProxyEnv }),
    },
  }
}

export function validateAllowedPorts(values: readonly number[]): number[] {
  if (values.length === 0 || values.length > 64) {
    throw new RemoteRuntimeError('proxy-ports-invalid', 'Client proxy requires between 1 and 64 allowed ports.', {
      phase: 'config',
    })
  }
  return [...new Set(values.map((value) => validatePort(value, 'Allowed proxy port')))].sort((a, b) => a - b)
}

export function validateNoProxy(values: readonly string[]): string[] {
  if (values.length > 64) {
    throw new RemoteRuntimeError('no-proxy-invalid', 'NO_PROXY accepts at most 64 exact hosts or addresses.', { phase: 'config' })
  }
  const normalized = values.map((value) => value.trim()).filter(Boolean)
  if (normalized.some((value) => value.length > 255 || !NO_PROXY_ENTRY.test(value))) {
    throw new RemoteRuntimeError('no-proxy-invalid', 'NO_PROXY entries must be exact host names or addresses.', { phase: 'config' })
  }
  return [...new Set(normalized)]
}

export function defaultWorkspaceName(cwd: string): string {
  const base = path.posix.basename(cwd.replace(/\/+$/u, ''))
  return base || cwd
}

function parseProfilesDocument(value: unknown): ProfilesDocument {
  const object = asObject(value, 'profile document')
  if (object.version !== 1 || !Array.isArray(object.profiles)) throw new TypeError('Unsupported profile document version')
  const profiles = object.profiles.map(parseProfile)
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const profile of profiles) {
    const name = profile.name.toLocaleLowerCase()
    if (ids.has(profile.id) || names.has(name)) throw new TypeError('Duplicate profile identity')
    ids.add(profile.id)
    names.add(name)
  }
  return { version: 1, profiles }
}

function parseProfile(value: unknown): RemoteProfile {
  const object = asObject(value, 'profile')
  if (object.version !== 1 || typeof object.id !== 'string' || !IDENTIFIER.test(object.id)) throw new TypeError('Invalid profile identity')
  if (typeof object.name !== 'string' || typeof object.sshHost !== 'string') throw new TypeError('Invalid profile fields')
  const name = validateProfileName(object.name)
  const sshHost = validateSshHost(object.sshHost)
  const sshPort = object.sshPort === undefined ? undefined : validatePort(asNumber(object.sshPort), 'SSH port')
  const defaultCwd = object.defaultCwd === undefined ? undefined : validateRemotePath(asString(object.defaultCwd), 'default cwd')
  const remoteRoot = object.remoteRoot === undefined ? undefined : validateRemotePath(asString(object.remoteRoot), 'remote root')
  const networkObject = asObject(object.network, 'network')
  const proxyObject = asObject(networkObject.clientProxy, 'client proxy')
  const network = validateNetworkConfig({
    mode: networkObject.mode as RemoteEgressMode,
    clientProxy: {
      allowedPorts: asNumberArray(proxyObject.allowedPorts),
      noProxy: asStringArray(proxyObject.noProxy),
      ...(proxyObject.upstreamProxyEnv === undefined ? {} : { upstreamProxyEnv: asString(proxyObject.upstreamProxyEnv) }),
    },
  })
  if (!Array.isArray(object.workspaces)) throw new TypeError('Invalid workspaces')
  const workspaces = object.workspaces.map(parseWorkspace)
  const workspaceIds = new Set<string>()
  const workspacePaths = new Set<string>()
  for (const workspace of workspaces) {
    if (workspaceIds.has(workspace.id) || workspacePaths.has(workspace.cwd)) throw new TypeError('Duplicate workspace identity')
    workspaceIds.add(workspace.id)
    workspacePaths.add(workspace.cwd)
  }
  const createdAt = validateTimestamp(object.createdAt)
  const updatedAt = validateTimestamp(object.updatedAt)
  return {
    version: 1,
    id: object.id as RemoteProfileId,
    name,
    sshHost,
    ...(sshPort === undefined ? {} : { sshPort }),
    ...(defaultCwd === undefined ? {} : { defaultCwd }),
    ...(remoteRoot === undefined ? {} : { remoteRoot }),
    network,
    workspaces: sortWorkspaces(workspaces),
    createdAt,
    updatedAt,
  }
}

function parseWorkspace(value: unknown): RemoteWorkspace {
  const object = asObject(value, 'workspace')
  if (typeof object.id !== 'string' || !IDENTIFIER.test(object.id)) throw new TypeError('Invalid workspace identity')
  if (typeof object.name !== 'string' || typeof object.cwd !== 'string' || typeof object.pinned !== 'boolean') {
    throw new TypeError('Invalid workspace fields')
  }
  return {
    id: object.id as RemoteWorkspaceId,
    name: validateWorkspaceName(object.name),
    cwd: validateRemotePath(object.cwd, 'workspace cwd'),
    pinned: object.pinned,
    createdAt: validateTimestamp(object.createdAt),
  }
}

function findProfile(document: ProfilesDocument, idOrName: string): RemoteProfile | undefined {
  const normalized = idOrName.trim().toLocaleLowerCase()
  return document.profiles.find((profile) => profile.id.toLocaleLowerCase() === normalized
    || profile.name.toLocaleLowerCase() === normalized)
}

function profileNotFound(idOrName: string): RemoteRuntimeError {
  return new RemoteRuntimeError('profile-not-found', `Remote profile ${JSON.stringify(idOrName)} was not found.`, {
    phase: 'config',
    remediation: 'List profiles or create the profile first.',
  })
}

function workspaceNotFound(id: string): RemoteRuntimeError {
  return new RemoteRuntimeError('workspace-not-found', `Remote workspace ${JSON.stringify(id)} was not found.`, {
    phase: 'config',
  })
}

function cloneProfile(profile: RemoteProfile): RemoteProfile {
  return structuredClone(profile)
}

function cloneWorkspace(workspace: RemoteWorkspace): RemoteWorkspace {
  return structuredClone(workspace)
}

function cloneNetwork(network: RemoteNetworkConfig): RemoteNetworkConfig {
  return {
    mode: network.mode,
    clientProxy: {
      allowedPorts: [...network.clientProxy.allowedPorts],
      noProxy: [...network.clientProxy.noProxy],
      ...(network.clientProxy.upstreamProxyEnv === undefined ? {} : { upstreamProxyEnv: network.clientProxy.upstreamProxyEnv }),
    },
  }
}

function sortWorkspaces(workspaces: readonly RemoteWorkspace[]): RemoteWorkspace[] {
  return workspaces.map(cloneWorkspace).sort((left, right) => Number(right.pinned) - Number(left.pinned)
    || left.name.localeCompare(right.name))
}

function resolveOptional<K extends string, V>(
  key: K,
  incoming: V | null | undefined,
  current: V | undefined,
): Partial<Record<K, V>> {
  if (incoming === undefined) return current === undefined ? {} : { [key]: current } as Partial<Record<K, V>>
  if (incoming === null) return {}
  return { [key]: incoming } as Partial<Record<K, V>>
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value as Record<string, unknown>
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Expected a string')
  return value
}

function asNumber(value: unknown): number {
  if (typeof value !== 'number') throw new TypeError('Expected a number')
  return value
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new TypeError('Expected strings')
  return value as string[]
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'number')) throw new TypeError('Expected numbers')
  return value as number[]
}

function validateTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError('Invalid timestamp')
  return value
}
