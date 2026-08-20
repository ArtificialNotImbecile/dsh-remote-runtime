/** Public Host entry for the standalone DSH Remote Runtime bundle. */
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { DshRemoteRuntimeService as ServiceType } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Managed remote Harness profiles and their Host-only SSH control plane. */
    dshRemoteRuntime: ServiceType
  }
}

export { DshRemoteRuntimeService, DshRemoteRuntimeCore, Config } from './service.ts'
export type {
  AdmissionReceipt,
  ChangedResult,
  Config as DshRemoteRuntimeConfig,
  CredentialImportReceipt,
  DshRemoteRuntimeCoreOptions,
} from './service.ts'
export {
  DSH_API_VERSION,
  DshOfficialApiClient,
  DshOfficialApiError,
} from './api-client.ts'
export type {
  DshHostDescription,
  DshOfficialApiClientOptions,
} from './api-client.ts'
export {
  LocalRuntimeArtifactProvider,
  RuntimeArtifactError,
  validateRuntimeArtifactManifest,
} from './artifact.ts'
export type {
  ManagedRuntimeArtifact,
  RuntimeArchiveEntry,
  RuntimeArtifactManifest,
  RuntimeArtifactProvider,
} from './artifact.ts'
export type { RemoteCredentialStatus } from './runtime.ts'
export type * from './types.ts'

export { DshRemoteRuntimeService as default } from './service.ts'
