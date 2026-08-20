import type { RemoteRuntimeFailure } from './types.ts'

export type RemoteRuntimeErrorPhase = RemoteRuntimeFailure['phase']

export type SafeDiagnosticValue = string | number | boolean | null

export interface RemoteRuntimeErrorOptions {
  readonly phase: RemoteRuntimeErrorPhase
  readonly retryable?: boolean
  readonly remediation?: string
  readonly safeDetails?: Readonly<Record<string, SafeDiagnosticValue>>
  readonly cause?: unknown
}

/**
 * An operation failure whose public representation is safe to render.
 *
 * The original cause is retained for local debugging but deliberately excluded
 * from `serialize()` and JSON output. Callers must opt individual diagnostic
 * fields into `safeDetails`; arbitrary stderr and provider bodies never cross
 * the host/browser boundary.
 */
export class RemoteRuntimeError extends Error {
  readonly code: string
  readonly phase: RemoteRuntimeErrorPhase
  readonly retryable: boolean
  readonly remediation?: string
  readonly safeDetails?: Readonly<Record<string, SafeDiagnosticValue>>

  constructor(code: string, message: string, options: RemoteRuntimeErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RemoteRuntimeError'
    this.code = code
    this.phase = options.phase
    this.retryable = options.retryable ?? false
    if (options.remediation !== undefined) this.remediation = options.remediation
    if (options.safeDetails !== undefined) this.safeDetails = Object.freeze({ ...options.safeDetails })
  }

  serialize(): RemoteRuntimeFailure {
    return {
      code: this.code,
      message: this.message,
      phase: this.phase,
      retryable: this.retryable,
      ...(this.remediation === undefined ? {} : { remediation: this.remediation }),
    }
  }

  toJSON(): RemoteRuntimeFailure {
    return this.serialize()
  }
}

/** Normalize an unknown failure without exposing its raw contents. */
export function asRemoteRuntimeError(
  error: unknown,
  fallback: { readonly code: string; readonly message: string; readonly phase: RemoteRuntimeErrorPhase },
): RemoteRuntimeError {
  if (error instanceof RemoteRuntimeError) return error
  return new RemoteRuntimeError(fallback.code, fallback.message, {
    phase: fallback.phase,
    cause: error,
  })
}

/**
 * Redact common credential forms before a bounded diagnostic is logged.
 * This is intentionally conservative: losing a little diagnostic fidelity is
 * preferable to persisting an API key, bearer token, or proxy password.
 */
export function redactDiagnostic(value: string): string {
  return value
    .replace(/((?:proxy-)?authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;"'}]+/giu, '$1<redacted>')
    .replace(/(api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;"'}]+/giu, '$1=<redacted>')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&#\s]+/giu, '$1<redacted>')
    .replace(/https?:\/\/[^\s:@/]+:[^\s@/]+@/giu, 'http://<redacted>@')
}

export function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

// Friendly alias for consumers that prefer the package name in diagnostics.
export { RemoteRuntimeError as DshRemoteError }
