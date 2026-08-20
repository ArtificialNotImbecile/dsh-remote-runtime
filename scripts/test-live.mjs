/** Opt-in live SSH/runtime acceptance. Secrets are accepted from environment only and never printed. */
import { resolve } from 'node:path'
import { DshRemoteRuntimeCore } from '../lib/index.js'

const profileId = required('DSH_REMOTE_LIVE_PROFILE_ID')
const apiKey = required('DEEPSEEK_API_KEY')
const root = resolve(required('DSH_REMOTE_RUNTIME_ROOT'))
const core = new DshRemoteRuntimeCore({
  root,
  sshExecutable: process.env.DSH_REMOTE_SSH_COMMAND ?? 'ssh',
  commandTimeoutMs: 30_000,
  maxTranscriptBytes: 64 * 1024 * 1024,
})
const controller = new AbortController()

try {
  await core.initialize()
  const doctor = await core.doctor(profileId, controller.signal)
  if (!doctor.ready) throw new Error('live profile did not pass Doctor')
  await core.install(profileId, controller.signal)
  await core.importCredential({
    profileId,
    apiKey,
    ...(process.env.DEEPSEEK_BASE_URL === undefined ? {} : { baseUrl: process.env.DEEPSEEK_BASE_URL }),
  }, controller.signal)
  const connection = await core.start({ profileId }, controller.signal)
  const workspaces = await core.listHarnessWorkspaces(profileId, controller.signal)
  const sessions = await core.listSessions(profileId, controller.signal)
  const requestedSession = required('DSH_REMOTE_LIVE_SESSION_ID')
  const beforePrompt = await core.readTranscript(profileId, requestedSession, undefined, 100, controller.signal)
  const beforeSeq = beforePrompt.entries.reduce((maximum, entry) => Math.max(maximum, entry.seq), -1)
  await core.prompt({ profileId, sessionId: requestedSession, text: 'Reply with exactly DSH_REMOTE_LIVE_OK.', mode: 'queue' }, controller.signal)
  const modelReplyVerified = await waitForModelReply(core, profileId, requestedSession, beforeSeq, controller.signal)
  process.stdout.write(`${JSON.stringify({
    ready: doctor.ready,
    connected: connection.state === 'connected',
    workspaces: workspaces.length,
    sessions: sessions.length,
    modelReplyVerified,
  })}\n`)
} finally {
  await core.disconnect(profileId).catch(() => undefined)
  await core.close().catch(() => undefined)
}

function required(name) {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`)
  return value.trim()
}

async function waitForModelReply(core, profileId, sessionId, afterSeq, signal) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const transcript = await core.readTranscript(profileId, sessionId, undefined, 100, signal)
    if (transcript.entries.some(entry => entry.seq > afterSeq && entry.kind === 'assistant' && entry.text.trim() === 'DSH_REMOTE_LIVE_OK')) return true
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000))
  }
  throw new Error('remote Session did not produce the expected DeepSeek model reply')
}
