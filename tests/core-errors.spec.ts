import { describe, expect, test } from 'vitest'
import { RemoteRuntimeError, asRemoteRuntimeError, redactDiagnostic } from '../src/errors.ts'

describe('structured remote errors', () => {
  test('serializes only the browser-safe failure contract', () => {
    const error = new RemoteRuntimeError('ssh-auth-failed', 'Authentication failed.', {
      phase: 'ssh',
      retryable: false,
      remediation: 'Configure an SSH key.',
      safeDetails: { diagnostic: 'safe summary' },
      cause: new Error('secret=do-not-render'),
    })

    expect(error.serialize()).toEqual({
      code: 'ssh-auth-failed',
      message: 'Authentication failed.',
      phase: 'ssh',
      retryable: false,
      remediation: 'Configure an SSH key.',
    })
    const json = JSON.stringify(error)
    expect(json).not.toContain('safe summary')
    expect(json).not.toContain('do-not-render')
  })

  test('redacts headers, query credentials, assignments, and proxy userinfo', () => {
    const input = [
      'Authorization: Bearer abc.def',
      'proxy-authorization=Basic ZHNobDp0b2tlbg==',
      'api_key=sk-example',
      'https://alice:p%40ss@proxy.example:8443',
      'https://api.example/v1?access_token=secret-value&mode=test',
    ].join('\n')
    const redacted = redactDiagnostic(input)

    expect(redacted).not.toContain('abc.def')
    expect(redacted).not.toContain('ZHNobDp0b2tlbg')
    expect(redacted).not.toContain('sk-example')
    expect(redacted).not.toContain('alice')
    expect(redacted).not.toContain('secret-value')
    expect(redacted).toContain('<redacted>')
  })

  test('preserves an existing structured error and safely wraps an unknown one', () => {
    const existing = new RemoteRuntimeError('known', 'Known.', { phase: 'runtime' })
    expect(asRemoteRuntimeError(existing, { code: 'fallback', message: 'Fallback.', phase: 'runtime' })).toBe(existing)

    const wrapped = asRemoteRuntimeError(new Error('provider body with token'), {
      code: 'runtime-failed',
      message: 'Remote runtime failed.',
      phase: 'runtime',
    })
    expect(wrapped.serialize()).toEqual({
      code: 'runtime-failed',
      message: 'Remote runtime failed.',
      phase: 'runtime',
      retryable: false,
    })
    expect(JSON.stringify(wrapped)).not.toContain('provider body')
  })
})
