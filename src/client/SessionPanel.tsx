/** Remote Session list, paged transcript, and explicit prompt controls. */
import { useEffect, useState } from 'react'
import type { RemoteConnectionStatus, RemoteSessionSummary, RemoteSessionTranscript } from '../types.ts'
import type { Loadable } from './controller.ts'
import { RefreshIcon, TerminalIcon } from './icons.tsx'
import type { RemoteRuntimeLocaleKey } from './locales.ts'
import { StatusBadge } from './ProfileWizard.tsx'
import { LoadingLine, RetryError } from './WorkspacePanel.tsx'
import css from './RemoteRuntimeSettings.module.css'

type Translate = (key: RemoteRuntimeLocaleKey, values?: Record<string, unknown>) => string

export interface SessionPanelProps {
  readonly sessions: Loadable<readonly RemoteSessionSummary[]>
  readonly selectedSessionId: string | null
  readonly transcript: Loadable<RemoteSessionTranscript>
  readonly connection: RemoteConnectionStatus | null
  readonly busy: boolean
  readonly t: Translate
  onRefresh(): Promise<void>
  onSelect(sessionId: string): void
  onRetryTranscript(): Promise<void>
  onLoadOlder(): Promise<void>
  onPrompt(text: string, mode: 'queue' | 'steer'): Promise<boolean>
  onCancel(): Promise<boolean>
}

export function SessionPanel(props: SessionPanelProps): React.ReactElement {
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<'queue' | 'steer'>('queue')

  useEffect(() => setPrompt(''), [props.selectedSessionId])

  async function send(): Promise<void> {
    if (await props.onPrompt(prompt, mode)) setPrompt('')
  }

  const selected = props.sessions.value?.find(session => session.sessionId === props.selectedSessionId) ?? null
  const connected = props.connection?.state === 'connected'

  return (
    <section className={`${css.panel} ${css.sessionPanel}`} aria-labelledby="dsh-remote-sessions">
      <header className={css.panelHeader}>
        <div><p className={css.eyebrow}>{props.t('session.title')}</p><h3 id="dsh-remote-sessions">{props.t('session.title')}</h3></div>
        <button className={css.buttonQuiet} type="button" disabled={props.sessions.status === 'loading'} onClick={() => void props.onRefresh()}><RefreshIcon />{props.t('session.refresh')}</button>
      </header>

      <div className={css.sessionGrid}>
        <div className={css.sessionList} aria-label={props.t('session.title')}>
          {props.sessions.status === 'loading' && props.sessions.value === null ? <LoadingLine /> : null}
          {props.sessions.status === 'error' ? <RetryError error={props.sessions.error?.message ?? ''} retry={() => void props.onRefresh()} t={props.t} /> : null}
          {props.sessions.status === 'ready' && props.sessions.value?.length === 0 ? <p className={css.emptyInline}>{props.t('session.empty')}</p> : null}
          {(props.sessions.value ?? []).map(session => (
            <button
              key={session.sessionId}
              className={session.sessionId === props.selectedSessionId ? css.sessionSelected : undefined}
              type="button"
              aria-current={session.sessionId === props.selectedSessionId ? 'true' : undefined}
              onClick={() => props.onSelect(session.sessionId)}
            >
              <span className={`${css.sessionDot} ${session.running ? css.sessionRunning : ''}`} aria-hidden="true" />
              <span className={css.grow}>
                <strong>{session.title?.trim() || shortId(session.sessionId)}</strong>
                <small>{session.cwd ?? shortId(session.sessionId)}</small>
              </span>
              <span className={css.sessionMeta}>
                {session.blank ? props.t('session.blank') : session.running ? props.t('session.running') : props.t('session.idle')}
                <time dateTime={new Date(session.updatedAt).toISOString()}>{formatTime(session.updatedAt)}</time>
              </span>
            </button>
          ))}
        </div>

        <div className={css.transcript} aria-live="polite">
          {props.selectedSessionId === null ? (
            <div className={css.transcriptEmpty}><TerminalIcon /><p>{props.t('session.select')}</p></div>
          ) : props.transcript.status === 'loading' && props.transcript.value === null ? (
            <div className={css.transcriptEmpty}><LoadingLine /><p>{props.t('session.loading')}</p></div>
          ) : props.transcript.status === 'error' && props.transcript.value === null ? (
            <div className={css.transcriptEmpty}><RetryError error={props.transcript.error?.message ?? props.t('session.failed')} retry={() => void props.onRetryTranscript()} t={props.t} /></div>
          ) : props.transcript.value !== null ? (
            <>
              <header className={css.transcriptHeader}>
                <div><strong>{props.transcript.value.title?.trim() || selected?.title || shortId(props.transcript.value.sessionId)}</strong><small>{shortId(props.transcript.value.sessionId)}</small></div>
                {props.transcript.value.hasMore ? <button className={css.buttonQuiet} type="button" disabled={props.transcript.status === 'loading'} onClick={() => void props.onLoadOlder()}>{props.t('session.loadOlder')}</button> : null}
              </header>
              {props.transcript.status === 'error' ? <RetryError error={props.transcript.error?.message ?? props.t('session.failed')} retry={() => void props.onRetryTranscript()} t={props.t} /> : null}
              <div className={css.transcriptEntries}>
                {props.transcript.value.entries.length === 0 ? <p className={css.muted}>{props.t('session.empty')}</p> : props.transcript.value.entries.map(entry => (
                  <article key={entry.id} className={`${css.transcriptEntry} ${css[`entry_${entry.kind}`] ?? ''}`}>
                    <header>
                      <StatusBadge tone={entry.kind}>{props.t(`entry.${entry.kind}`)}</StatusBadge>
                      {entry.toolName === undefined ? null : <code>{entry.toolName}</code>}
                      <time dateTime={new Date(entry.time).toISOString()}>{formatTime(entry.time)}</time>
                    </header>
                    <pre>{entry.text}</pre>
                  </article>
                ))}
              </div>
              <div className={css.composer}>
                <label><span className={css.srOnly}>{props.t('session.prompt')}</span><textarea rows={3} value={prompt} placeholder={props.t('session.promptPlaceholder')} onChange={event => setPrompt(event.target.value)} onKeyDown={event => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send() }
                }} /></label>
                <div className={css.composerActions}>
                  <label><span className={css.srOnly}>{props.t('session.prompt')}</span><select value={mode} onChange={event => setMode(event.target.value as 'queue' | 'steer')}><option value="queue">{props.t('session.queue')}</option><option value="steer">{props.t('session.steer')}</option></select></label>
                  {selected?.running ? <button className={css.buttonDanger} type="button" disabled={props.busy} onClick={() => void props.onCancel()}>{props.t('session.cancel')}</button> : null}
                  <button className={css.buttonPrimary} type="button" disabled={props.busy || !connected || prompt.trim() === ''} onClick={() => void send()}>{props.t('session.send')}</button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`
}

function formatTime(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
