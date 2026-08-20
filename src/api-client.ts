/** Host-only client for the official DeepSeek Harness rc.8 Web API. */
import { randomUUID } from 'node:crypto'
import type {
  RemoteHarnessWorkspace,
  RemoteSessionSummary,
  RemoteSessionTranscript,
  RemoteTranscriptEntry,
} from './types.ts'

const DSH_API_VERSION = '0.1.0-rc.8'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const MAX_ERROR_MESSAGE_CHARS = 1_000
const MAX_ENTRY_TEXT_CHARS = 1_000_000

type JsonRecord = Record<string, unknown>

/** Minimal fetch signature injected by tests and tunnel-aware callers. */
export type DshApiFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Safe failure raised by the official API carrier. */
export class DshOfficialApiError extends Error {
  override readonly name = 'DshOfficialApiError'

  /**
   * @param code - Stable local or remote business code.
   * @param message - Bounded, redacted diagnostic.
   * @param retryable - Whether reconnecting or retrying may help.
   * @param status - HTTP carrier status when one exists.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(redactDiagnostic(message).slice(0, MAX_ERROR_MESSAGE_CHARS))
  }
}

/** Exact rc.8 `host.describe` value used as the readiness handshake. */
export interface DshHostDescription {
  readonly version: string
  readonly cwd: string
  readonly provider?: string
  readonly model?: string
  readonly attachedSessions: number
  readonly home: string
  readonly canOpenPath: boolean
}

/** Options for one Host-only loopback API client. */
export interface DshOfficialApiClientOptions {
  readonly baseUrl: string
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly fetch?: DshApiFetch
}

/**
 * Typed subset of the official Web API used by the remote-runtime plugin.
 * The URL is required to be loopback because SSH, not this unauthenticated
 * API, is the remote access-control boundary.
 */
export class DshOfficialApiClient {
  private readonly baseUrl: URL
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly fetchImpl: DshApiFetch

  constructor(options: DshOfficialApiClientOptions) {
    const baseUrl = new URL(options.baseUrl)
    if (baseUrl.protocol !== 'http:' || !isLoopbackHostname(baseUrl.hostname)) {
      throw new DshOfficialApiError(
        'NON_LOOPBACK_API',
        'official DSH API transport must use an HTTP loopback SSH tunnel',
        false,
      )
    }
    if (baseUrl.username !== '' || baseUrl.password !== '' || baseUrl.search !== '' || baseUrl.hash !== '') {
      throw new DshOfficialApiError('INVALID_API_URL', 'official DSH API URL must not contain credentials, query, or fragment', false)
    }
    this.baseUrl = new URL('/', baseUrl)
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs')
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    )
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  /** Read the remote Host identity-free readiness snapshot. */
  async describe(signal?: AbortSignal): Promise<DshHostDescription> {
    const value = record(await this.post('host.describe', {}, signal), 'host.describe value')
    return Object.freeze({
      version: stringField(value, 'version'),
      cwd: stringField(value, 'cwd'),
      ...optionalStringField(value, 'provider'),
      ...optionalStringField(value, 'model'),
      attachedSessions: nonNegativeIntegerField(value, 'attachedSessions'),
      home: stringField(value, 'home'),
      canOpenPath: booleanField(value, 'canOpenPath'),
    })
  }

  /** List the official durable Workspace registry. */
  async listWorkspaces(signal?: AbortSignal): Promise<readonly RemoteHarnessWorkspace[]> {
    const value = record(await this.post('workspace.list', {}, signal), 'workspace.list value')
    return Object.freeze(arrayField(value, 'items').map((item, index) => {
      const row = record(item, `workspace.list item ${String(index)}`)
      return Object.freeze({
        workspaceId: stringField(row, 'workspaceId'),
        path: stringField(row, 'path'),
        title: stringField(row, 'title'),
        sessionIds: Object.freeze(stringArrayField(row, 'sessionIds')),
        createdAt: stringField(row, 'createdAt'),
        updatedAt: stringField(row, 'updatedAt'),
      })
    }))
  }

  /** List all non-account-scoped remote Sessions. */
  async listSessions(signal?: AbortSignal): Promise<readonly RemoteSessionSummary[]> {
    const value = record(await this.post('session.list', {}, signal), 'session.list value')
    return Object.freeze(arrayField(value, 'items').map((item, index) => {
      const row = record(item, `session.list item ${String(index)}`)
      const title = projectionTitle(row.projections)
      const origin = row.origin
      if (origin !== undefined && origin !== 'subagent') {
        throw protocolError(`session.list item ${String(index)} has an invalid origin`)
      }
      return Object.freeze({
        sessionId: stringField(row, 'sessionId'),
        updatedAt: finiteNumberField(row, 'updatedAt'),
        running: booleanField(row, 'running'),
        blank: booleanField(row, 'blank'),
        ...optionalStringField(row, 'cwd'),
        ...(title === undefined ? {} : { title }),
        ...optionalStringField(row, 'parentSessionId'),
        ...(origin === undefined ? {} : { origin }),
      })
    }))
  }

  /** Read and project one backwards-paged official history window. */
  async readTranscript(
    sessionId: string,
    beforeSeq: number | undefined,
    maxMessages: number | undefined,
    signal?: AbortSignal,
  ): Promise<RemoteSessionTranscript> {
    nonEmptyString(sessionId, 'sessionId')
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) {
      throw new DshOfficialApiError('INVALID_REQUEST', 'beforeSeq must be a non-negative safe integer', false)
    }
    if (maxMessages !== undefined && (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 200)) {
      throw new DshOfficialApiError('INVALID_REQUEST', 'maxMessages must be an integer from 1 through 200', false)
    }
    const payload = {
      sessionId,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      ...(maxMessages === undefined ? {} : { maxMessages }),
    }
    const value = record(await this.post('session.history', payload, signal), 'session.history value')
    const rawEvents = arrayField(value, 'events')
    const entries: RemoteTranscriptEntry[] = []
    let oldestSeq: number | undefined
    for (let index = 0; index < rawEvents.length; index += 1) {
      const historyEntry = record(rawEvents[index], `session.history item ${String(index)}`)
      const event = record(historyEntry.event, `session.history event ${String(index)}`)
      const seq = nonNegativeIntegerField(event, 'seq')
      oldestSeq = oldestSeq === undefined ? seq : Math.min(oldestSeq, seq)
      entries.push(...projectEvent(event, seq, finiteNumberField(event, 'time')))
    }
    const title = projectionTitle(value.projections)
    return Object.freeze({
      sessionId,
      ...(title === undefined ? {} : { title }),
      entries: Object.freeze(entries),
      hasMore: booleanField(value, 'hasMore'),
      ...(oldestSeq === undefined ? {} : { beforeSeq: oldestSeq }),
    })
  }

  /** Queue or steer one text prompt. This receipt is not an assistant result. */
  async prompt(
    sessionId: string,
    text: string,
    mode: 'queue' | 'steer' = 'queue',
    signal?: AbortSignal,
  ): Promise<{ readonly accepted: true }> {
    nonEmptyString(sessionId, 'sessionId')
    nonEmptyString(text, 'prompt text')
    const value = record(await this.post('session.prompt', {
      sessionId,
      mode,
      content: [{ type: 'text', text }],
    }, signal), 'session.prompt value')
    if (value.accepted !== true) throw protocolError('session.prompt did not return accepted=true')
    return Object.freeze({ accepted: true })
  }

  /** Cancel the active remote turn without removing queued input. */
  async cancel(sessionId: string, signal?: AbortSignal): Promise<{ readonly accepted: true }> {
    nonEmptyString(sessionId, 'sessionId')
    const value = record(await this.post('session.cancel', { sessionId }, signal), 'session.cancel value')
    if (value.accepted !== true) throw protocolError('session.cancel did not return accepted=true')
    return Object.freeze({ accepted: true })
  }

  /** Verify the published Host API shape; the managed runtime descriptor pins the DSH release. */
  async assertCompatible(signal?: AbortSignal): Promise<DshHostDescription> {
    // rc.8 deliberately returns the placeholder `0.0.1` here and its source
    // says this is not yet the CLI package version. Release compatibility is
    // established before launch by runtime.json + the pinned artifact roster.
    return this.describe(signal)
  }

  private async post(method: string, payload: JsonRecord, signal?: AbortSignal): Promise<unknown> {
    if (!/^[a-z][a-zA-Z]*(?:\.[a-zA-Z][a-zA-Z]*)$/u.test(method)) {
      throw new DshOfficialApiError('INVALID_METHOD', 'official DSH API method is invalid', false)
    }
    signal?.throwIfAborted()
    const rpcId = randomUUID()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`DSH API ${method} timed out`)), this.timeoutMs)
    const requestSignal = signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, signal])
    try {
      let response: Response
      try {
        response = await this.fetchImpl(new URL(`/api/${method}`, this.baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
          redirect: 'error',
          signal: requestSignal,
        })
      } catch (error: unknown) {
        if (signal?.aborted === true) throw new DshOfficialApiError('CANCELLED', 'official DSH API request was cancelled', true)
        if (controller.signal.aborted) throw new DshOfficialApiError('TIMEOUT', `official DSH API ${method} timed out`, true)
        throw new DshOfficialApiError('TRANSPORT', `official DSH API transport failed: ${diagnostic(error)}`, true)
      }
      if (!response.ok) {
        throw new DshOfficialApiError(
          `HTTP_${String(response.status)}`,
          `official DSH API ${method} returned HTTP ${String(response.status)}`,
          response.status === 408 || response.status === 429 || response.status >= 500,
          response.status,
        )
      }
      const body = record(await readBoundedJson(response, this.maxResponseBytes, requestSignal), 'server response')
      if (body.type !== 'server-response' || body.rpcId !== rpcId) {
        throw protocolError('official DSH API response envelope or rpcId is invalid')
      }
      const result = record(body.result, 'server response result')
      if (result.ok === true) return result.value
      if (result.ok !== false) throw protocolError('official DSH API result has no boolean ok discriminant')
      const error = record(result.error, 'server response error')
      const code = typeof error.code === 'string' && error.code !== '' ? error.code : 'REMOTE_ERROR'
      const message = typeof error.message === 'string' ? error.message : `official DSH API ${method} failed`
      throw new DshOfficialApiError(code, message, retryableBusinessCode(code))
    } finally {
      clearTimeout(timer)
    }
  }
}

async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    throw new DshOfficialApiError('RESPONSE_TOO_LARGE', 'official DSH API response exceeds the configured byte limit', false)
  }
  if (response.body === null) throw protocolError('official DSH API response body is missing')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        throw new DshOfficialApiError('RESPONSE_TOO_LARGE', 'official DSH API response exceeds the configured byte limit', false)
      }
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const joined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as unknown
  } catch {
    throw protocolError('official DSH API response is not valid UTF-8 JSON')
  }
}

function projectEvent(event: JsonRecord, seq: number, time: number): RemoteTranscriptEntry[] {
  const type = stringField(event, 'type')
  const data = record(event.data, `event ${type} data`)
  if (type === 'user/message') {
    const text = contentText(data.content)
    return text === '' ? [] : [transcriptEntry(seq, time, 'user', text, 'user')]
  }
  if (type === 'assistant/message') {
    const message = record(data.message, 'assistant/message message')
    const content = Array.isArray(message.content) ? message.content : []
    const entries: RemoteTranscriptEntry[] = []
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index]
      if (!isRecord(block)) continue
      if (block.type !== 'text' && block.type !== 'reasoning') continue
      const text = typeof block.text === 'string' ? boundedText(block.text) : ''
      if (text === '') continue
      entries.push(transcriptEntry(
        seq,
        time,
        block.type === 'reasoning' ? 'thinking' : 'assistant',
        text,
        `assistant-${String(index)}`,
      ))
    }
    return entries
  }
  if (type === 'tool/call' || type === 'tool/result') {
    const toolName = typeof data.name === 'string' ? data.name : undefined
    const text = contentText(data.content) || contentText(data.result)
      || (typeof data.arguments === 'string' ? boundedText(data.arguments) : '')
      || toolName
      || type
    return [transcriptEntry(seq, time, 'tool', text, type, toolName)]
  }
  if (type === 'compaction/summary' || type.startsWith('command/')) {
    const text = contentText(data.content) || contentText(data.summary) || type
    return [transcriptEntry(seq, time, 'notice', text, 'notice')]
  }
  return []
}

function transcriptEntry(
  seq: number,
  time: number,
  kind: RemoteTranscriptEntry['kind'],
  text: string,
  suffix: string,
  toolName?: string,
): RemoteTranscriptEntry {
  return Object.freeze({
    id: `${String(seq)}:${suffix}`,
    seq,
    time,
    kind,
    text: boundedText(text),
    ...(toolName === undefined ? {} : { toolName }),
  })
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return boundedText(value)
  if (!Array.isArray(value)) return ''
  const text: string[] = []
  for (const block of value) {
    if (!isRecord(block)) continue
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') {
      text.push(block.text)
    } else if (typeof block.content === 'string') {
      text.push(block.content)
    } else if (Array.isArray(block.content)) {
      const nested = contentText(block.content)
      if (nested !== '') text.push(nested)
    }
  }
  return boundedText(text.join('\n'))
}

function projectionTitle(value: unknown): string | null | undefined {
  if (!isRecord(value) || !isRecord(value.values) || !Object.hasOwn(value.values, 'title')) return undefined
  const title = value.values.title
  if (title === null || typeof title === 'string') return title
  throw protocolError('session title projection is neither string nor null')
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw protocolError(`${label} is not an object`)
  return value
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function arrayField(value: JsonRecord, key: string): unknown[] {
  const field = value[key]
  if (!Array.isArray(field)) throw protocolError(`${key} is not an array`)
  return field
}

function stringArrayField(value: JsonRecord, key: string): string[] {
  return arrayField(value, key).map((item) => {
    if (typeof item !== 'string') throw protocolError(`${key} contains a non-string value`)
    return item
  })
}

function stringField(value: JsonRecord, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') throw protocolError(`${key} is not a string`)
  return field
}

function optionalStringField(value: JsonRecord, key: string): { readonly [name: string]: string } | {} {
  const field = value[key]
  if (field === undefined) return {}
  if (typeof field !== 'string') throw protocolError(`${key} is not a string`)
  return { [key]: field }
}

function booleanField(value: JsonRecord, key: string): boolean {
  const field = value[key]
  if (typeof field !== 'boolean') throw protocolError(`${key} is not a boolean`)
  return field
}

function finiteNumberField(value: JsonRecord, key: string): number {
  const field = value[key]
  if (typeof field !== 'number' || !Number.isFinite(field)) throw protocolError(`${key} is not a finite number`)
  return field
}

function nonNegativeIntegerField(value: JsonRecord, key: string): number {
  const field = value[key]
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) {
    throw protocolError(`${key} is not a non-negative safe integer`)
  }
  return field
}

function nonEmptyString(value: string, label: string): string {
  if (value.trim() === '') throw new DshOfficialApiError('INVALID_REQUEST', `${label} must not be empty`, false)
  return value
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DshOfficialApiError('INVALID_CONFIG', `${label} must be a positive safe integer`, false)
  }
  return value
}

function protocolError(message: string): DshOfficialApiError {
  return new DshOfficialApiError('PROTOCOL', message, false)
}

function retryableBusinessCode(code: string): boolean {
  return code === 'cancelled' || code === 'internal'
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || normalized === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(normalized)
}

function diagnostic(error: unknown): string {
  return redactDiagnostic(error instanceof Error ? error.message : String(error))
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, 'sk-[redacted]')
    .replace(/([?&](?:api_?key|token|secret|password)=)[^&#\s]*/giu, '$1[redacted]')
}

function boundedText(value: string): string {
  return value.length <= MAX_ENTRY_TEXT_CHARS ? value : `${value.slice(0, MAX_ENTRY_TEXT_CHARS)}\n[truncated]`
}

export { DSH_API_VERSION }
