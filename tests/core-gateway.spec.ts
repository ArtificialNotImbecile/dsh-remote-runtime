import { createServer } from 'node:net'
import net, { type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import type { ProxyAuditEvent } from '../src/audit.ts'
import {
  ClientGateway,
  isPublicAddress,
  pinnedHttpTarget,
  resolvePublicAddresses,
} from '../src/gateway.ts'
import { RemoteRuntimeError } from '../src/errors.ts'

const TOKEN = 'a'.repeat(43)
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

describe('authenticated public-only client gateway', () => {
  test.each([
    ['127.0.0.1', false],
    ['10.0.0.1', false],
    ['100.64.0.1', false],
    ['169.254.169.254', false],
    ['172.31.255.255', false],
    ['192.168.1.1', false],
    ['192.0.2.1', false],
    ['198.51.100.1', false],
    ['203.0.113.1', false],
    ['224.0.0.1', false],
    ['::1', false],
    ['fc00::1', false],
    ['fe80::1', false],
    ['2001:db8::1', false],
    ['::ffff:127.0.0.1', false],
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['2606:4700:4700::1111', true],
  ])('classifies %s as public=%s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected)
  })

  test('rejects an entire DNS answer set when even one address is private', async () => {
    await expect(resolvePublicAddresses('mixed.example', async () => [
      { address: '8.8.8.8' },
      { address: '127.0.0.1' },
    ])).rejects.toMatchObject({ code: 'proxy-private-target' } satisfies Partial<RemoteRuntimeError>)
    await expect(resolvePublicAddresses('empty.example', async () => []))
      .rejects.toMatchObject({ code: 'proxy-dns-empty', retryable: true })
  })

  test('requires proxy authentication before resolving or connecting', async () => {
    let lookups = 0
    const gateway = new ClientGateway({
      token: TOKEN,
      lookup: async () => { lookups += 1; return [{ address: '8.8.8.8' }] },
    })
    const address = await gateway.start()
    closers.push(() => gateway.close())

    const response = await rawProxyRequest(address.port, 'CONNECT api.deepseek.com:443 HTTP/1.1\r\nHost: api.deepseek.com:443\r\n\r\n')
    expect(response).toContain('407 Proxy Authentication Required')
    expect(lookups).toBe(0)
  })

  test('denies a private literal and emits metadata-only audit', async () => {
    const audits: ProxyAuditEvent[] = []
    const gateway = new ClientGateway({ token: TOKEN, onAudit: (entry) => audits.push(entry) })
    const address = await gateway.start()
    closers.push(() => gateway.close())

    const response = await rawProxyRequest(address.port, [
      'CONNECT 127.0.0.1:443 HTTP/1.1',
      'Host: 127.0.0.1:443',
      `Proxy-Authorization: ${authorization()}`,
      '',
      '',
    ].join('\r\n'))
    expect(response).toContain('403 Forbidden')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ host: '127.0.0.1', port: 443, decision: 'deny', method: 'CONNECT' })
    expect(audits[0]).not.toHaveProperty('headers')
  })

  test('pins a CONNECT to the validated IP instead of resolving the target again', async () => {
    const echo = await echoServer()
    let connectorAddress = ''
    let connectorPort = 0
    const audits: ProxyAuditEvent[] = []
    const gateway = new ClientGateway({
      token: TOKEN,
      allowedPorts: [echo.port],
      lookup: async () => [{ address: '8.8.8.8' }],
      connect: (address, port) => {
        connectorAddress = address
        connectorPort = port
        return net.connect({ host: '127.0.0.1', port: echo.port })
      },
      onAudit: (entry) => audits.push(entry),
    })
    const gatewayAddress = await gateway.start()
    closers.push(() => gateway.close())

    const socket = net.connect({ host: '127.0.0.1', port: gatewayAddress.port })
    const received: Buffer[] = []
    socket.on('data', (chunk) => received.push(Buffer.from(chunk)))
    socket.write([
      `CONNECT api.deepseek.com:${echo.port} HTTP/1.1`,
      `Host: api.deepseek.com:${echo.port}`,
      `Proxy-Authorization: ${authorization()}`,
      '',
      '',
    ].join('\r\n'))
    await waitFor(() => Buffer.concat(received).includes(Buffer.from('200 Connection Established')))
    socket.write('ping')
    await waitFor(() => Buffer.concat(received).includes(Buffer.from('ping')))
    socket.end()
    await waitFor(() => audits.length === 1)

    expect(connectorAddress).toBe('8.8.8.8')
    expect(connectorPort).toBe(echo.port)
    expect(audits[0]).toMatchObject({
      host: 'api.deepseek.com',
      resolvedAddress: '8.8.8.8',
      port: echo.port,
      decision: 'allow',
    })
  })

  test('pins the absolute URL sent to an upstream HTTP proxy', () => {
    expect(pinnedHttpTarget(new URL('http://packages.example/a?b=1'), '8.8.8.8', 8080))
      .toBe('http://8.8.8.8:8080/a?b=1')
    expect(() => pinnedHttpTarget(new URL('https://packages.example/a'), '8.8.8.8', 443))
      .toThrowError(RemoteRuntimeError)
  })
})

function authorization(): string {
  return `Basic ${Buffer.from(`dsh:${TOKEN}`, 'utf8').toString('base64')}`
}

function rawProxyRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('error', reject)
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.once('connect', () => socket.end(request))
  })
}

async function echoServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.pipe(socket))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('echo server did not bind')
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { server, port: address.port }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
