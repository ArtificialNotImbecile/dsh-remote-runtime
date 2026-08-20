import { describe, expect, it, vi } from 'vitest'
import { DshOfficialApiClient, DshOfficialApiError } from '../src/api-client.ts'

function rpcFetch(value: unknown, inspect?: (body: Record<string, unknown>, url: URL, init: RequestInit) => void) {
  return vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    inspect?.(body, new URL(input), init)
    return Response.json({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value },
    })
  })
}

describe('official DSH API client', () => {
  it('allows only loopback transports and sends the exact POST envelope without auth', async () => {
    expect(() => new DshOfficialApiClient({ baseUrl: 'http://example.com:3080' }))
      .toThrow(/loopback/u)
    const fetch = rpcFetch({ items: [], archivedSessionIds: [] }, (body, url, init) => {
      expect(url.href).toBe('http://127.0.0.1:54321/api/workspace.list')
      expect(init.method).toBe('POST')
      expect(init.headers).toEqual({ 'content-type': 'application/json' })
      expect(body).toMatchObject({
        type: 'client-request', method: 'workspace.list', payload: {},
      })
      expect(typeof body.rpcId).toBe('string')
      expect(JSON.stringify(init)).not.toMatch(/authorization|cookie/iu)
    })
    const client = new DshOfficialApiClient({ baseUrl: 'http://127.0.0.1:54321', fetch })
    await expect(client.listWorkspaces()).resolves.toEqual([])
  })

  it('projects session titles and complete transcript rows from official values', async () => {
    const values = new Map<string, unknown>([
      ['session.list', {
        items: [{
          sessionId: 's1', updatedAt: 42, running: false, blank: false, cwd: '/work',
          projections: { asOfSeq: 7, values: { title: 'Remote title' } },
        }],
      }],
      ['session.history', {
        events: [
          { event: { type: 'user/message', seq: 1, time: 10, data: { content: [{ type: 'text', text: 'hello' }] } } },
          { event: { type: 'assistant/message', seq: 2, time: 11, data: { message: { content: [
            { type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'world' },
          ] } } } },
          { event: { type: 'tool/call', seq: 3, time: 12, data: { name: 'read', arguments: '{"path":"a"}' } } },
        ],
        hasMore: true,
        projections: { asOfSeq: 3, values: { title: 'Remote title' } },
      }],
    ])
    const fetch = vi.fn(async (_input: string | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { rpcId: string; method: string }
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: values.get(body.method) } })
    })
    const client = new DshOfficialApiClient({ baseUrl: 'http://localhost:9876', fetch })
    await expect(client.listSessions()).resolves.toEqual([{
      sessionId: 's1', updatedAt: 42, running: false, blank: false, cwd: '/work', title: 'Remote title',
    }])
    const transcript = await client.readTranscript('s1', undefined, 50)
    expect(transcript).toMatchObject({ sessionId: 's1', title: 'Remote title', hasMore: true, beforeSeq: 1 })
    expect(transcript.entries).toEqual([
      { id: '1:user', seq: 1, time: 10, kind: 'user', text: 'hello' },
      { id: '2:assistant-0', seq: 2, time: 11, kind: 'thinking', text: 'thinking' },
      { id: '2:assistant-1', seq: 2, time: 11, kind: 'assistant', text: 'world' },
      { id: '3:tool/call', seq: 3, time: 12, kind: 'tool', text: '{"path":"a"}', toolName: 'read' },
    ])
  })

  it('preserves business codes while redacting credentials from diagnostics', async () => {
    const fetch = vi.fn(async (_input: string | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { rpcId: string }
      return Response.json({
        type: 'server-response', rpcId: body.rpcId,
        result: { ok: false, error: { code: 'internal', message: 'Bearer secret-token sk-abcdefghijk', details: {} } },
      })
    })
    const client = new DshOfficialApiClient({ baseUrl: 'http://127.0.0.1:10000', fetch })
    await expect(client.listSessions()).rejects.toMatchObject({ code: 'internal', retryable: true })
    await client.listSessions().catch((error: unknown) => {
      expect(error).toBeInstanceOf(DshOfficialApiError)
      expect(String(error)).not.toContain('secret-token')
      expect(String(error)).not.toContain('abcdefghijk')
    })
  })

  it('rejects oversized bodies before JSON projection', async () => {
    const fetch = vi.fn(async () => new Response('x'.repeat(256), {
      status: 200,
      headers: { 'content-length': '256' },
    }))
    const client = new DshOfficialApiClient({
      baseUrl: 'http://127.0.0.1:10001', fetch, maxResponseBytes: 128,
    })
    await expect(client.listSessions()).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
  })

  it('validates the exact remote version and prompt receipt semantics', async () => {
    const values = new Map<string, unknown>([
      ['host.describe', {
        version: '0.1.0-rc.8', cwd: '/work', provider: 'deepseek-official', model: 'deepseek-v4-flash',
        attachedSessions: 1, home: '/home/test', canOpenPath: false,
      }],
      ['session.prompt', { accepted: true }],
    ])
    const fetch = vi.fn(async (_input: string | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { rpcId: string; method: string; payload: unknown }
      if (body.method === 'session.prompt') {
        expect(body.payload).toEqual({ sessionId: 's1', mode: 'steer', content: [{ type: 'text', text: 'go' }] })
      }
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: values.get(body.method) } })
    })
    const client = new DshOfficialApiClient({ baseUrl: 'http://127.0.0.1:10002', fetch })
    await expect(client.assertCompatible()).resolves.toMatchObject({ version: '0.1.0-rc.8' })
    await expect(client.prompt('s1', 'go', 'steer')).resolves.toEqual({ accepted: true })
  })
})
