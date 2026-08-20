/** Responsive rc.8 settings.section contribution for managed remote runtimes. */
import { useEffect, useState } from 'react'
import type { RemoteConnectionStatus, RemoteProfileSummary, UpdateRemoteProfileRequest } from '../types.ts'
import type { RemoteRuntimeViewState } from './controller.ts'
import { AlertIcon, ExternalIcon, KeyIcon, PlusIcon, RefreshIcon, ServerIcon, TerminalIcon, TrashIcon } from './icons.tsx'
import { DoctorReportView, ProfileWizard, StatusBadge } from './ProfileWizard.tsx'
import { SessionPanel } from './SessionPanel.tsx'
import type { RemoteRuntimeSettingsProps } from './slots.ts'
import { WorkspacePanel } from './WorkspacePanel.tsx'
import css from './RemoteRuntimeSettings.module.css'

type DetailTab = 'overview' | 'workspaces' | 'sessions'

export function RemoteRuntimeSettings(props: RemoteRuntimeSettingsProps): React.ReactElement {
  const state = props.useRemoteRuntime(snapshot => snapshot)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [tab, setTab] = useState<DetailTab>('overview')
  const [editOpen, setEditOpen] = useState(false)
  const [removeConfirm, setRemoveConfirm] = useState(false)
  const [startCwd, setStartCwd] = useState('')

  useEffect(() => props.activate(), [])

  const profile = state.snapshot.profiles.find(item => item.id === state.selectedProfileId) ?? null
  const connection = state.snapshot.statuses.find(item => item.profileId === state.selectedProfileId) ?? null
  const busy = state.operation !== null

  useEffect(() => {
    setTab('overview')
    setEditOpen(false)
    setRemoveConfirm(false)
    setStartCwd(profile?.defaultCwd ?? '')
  }, [profile?.id])

  return (
    <div className={css.root}>
      <header className={css.pageHeader}>
        <div className={css.titleGroup}>
          <div className={css.logo}><TerminalIcon /></div>
          <div><h1>{props.t('title')}</h1><p>{props.t('subtitle')}</p></div>
        </div>
        <div className={css.buttonRow}>
          {state.lastUpdatedAt === null ? null : <small>{props.t('updated', { time: formatTime(state.lastUpdatedAt) })}</small>}
          <button className={css.buttonQuiet} type="button" disabled={state.status === 'loading'} onClick={() => void props.refresh()}><RefreshIcon />{props.t('refresh')}</button>
          <button className={css.buttonPrimary} type="button" onClick={() => setWizardOpen(true)}><PlusIcon />{props.t('profile.add')}</button>
        </div>
      </header>

      {state.operationError === null ? null : (
        <div className={css.operationError} role="alert">
          <AlertIcon />
          <div><strong>{props.t('operation.failed')}</strong><span>{state.operationError.message}</span>{state.operationError.remediation === undefined ? null : <small>{state.operationError.remediation}</small>}</div>
          <button type="button" onClick={props.clearOperationError}>{props.t('operation.dismiss')}</button>
        </div>
      )}
      {state.error === null || state.snapshot.profiles.length === 0 ? null : (
        <div className={css.operationError} role="alert">
          <AlertIcon />
          <div><strong>{props.t('loadFailed')}</strong><span>{state.error.message}</span></div>
          <button type="button" onClick={() => void props.refresh()}>{props.t('retry')}</button>
        </div>
      )}

      {state.status === 'loading' && state.snapshot.profiles.length === 0 ? (
        <div className={css.pageState}><span className={css.spinner} aria-hidden="true" /><p>{props.t('loading')}</p></div>
      ) : state.status === 'error' && state.snapshot.profiles.length === 0 ? (
        <div className={css.pageState} role="alert"><AlertIcon /><h2>{props.t('loadFailed')}</h2><p>{state.error?.message}</p><button className={css.buttonPrimary} type="button" onClick={() => void props.refresh()}>{props.t('retry')}</button></div>
      ) : state.snapshot.profiles.length === 0 ? (
        <div className={css.emptyState}><div><ServerIcon /></div><h2>{props.t('empty.title')}</h2><p>{props.t('empty.body')}</p><button className={css.buttonPrimary} type="button" onClick={() => setWizardOpen(true)}><PlusIcon />{props.t('profile.add')}</button></div>
      ) : (
        <div className={css.layout}>
          <aside className={css.profileRail} aria-label={props.t('profile.list')}>
            <header><span>{props.t('profile.list')}</span><small>{state.snapshot.profiles.length}</small></header>
            <div className={css.profileRows}>
              {state.snapshot.profiles.map(item => {
                const itemStatus = state.snapshot.statuses.find(status => status.profileId === item.id) ?? null
                return (
                  <button key={item.id} className={item.id === profile?.id ? css.profileSelected : undefined} type="button" disabled={busy} aria-current={item.id === profile?.id ? 'true' : undefined} onClick={() => props.selectProfile(item.id)}>
                    <span className={`${css.statusDot} ${css[`status_${itemStatus?.state ?? 'unknown'}`] ?? ''}`} aria-hidden="true" />
                    <span><strong>{item.name}</strong><small>{item.sshHost}{item.sshPort === undefined ? '' : `:${item.sshPort}`}</small></span>
                    <StatusBadge tone={item.network.mode === 'client-proxy' ? 'checking' : 'disconnected'}>{item.network.mode === 'client-proxy' ? props.t('egress.proxy') : props.t('egress.direct')}</StatusBadge>
                  </button>
                )
              })}
            </div>
          </aside>

          {profile === null ? null : (
            <main className={css.detail}>
              <div className={css.detailHeader}>
                <div>
                  <div className={css.connectionLine}><span className={`${css.statusDot} ${css[`status_${connection?.state ?? 'unknown'}`] ?? ''}`} aria-hidden="true" /><StatusBadge tone={connection?.state ?? 'disconnected'}>{props.t(`status.${connection?.state ?? 'unknown'}`)}</StatusBadge></div>
                  <h2>{profile.name}</h2>
                  <p>{profile.sshHost}{profile.sshPort === undefined ? '' : `:${profile.sshPort}`} · {profile.defaultCwd ?? props.t('profile.none')}</p>
                </div>
                <div className={css.buttonRow}>
                  <button className={css.buttonQuiet} type="button" onClick={() => setEditOpen(current => !current)}>{props.t('profile.edit')}</button>
                  {removeConfirm ? (
                    <div className={css.confirmStrip}><span>{props.t('profile.removeConfirm')}</span><button className={css.buttonDanger} type="button" disabled={busy} onClick={() => void props.removeProfile(profile.id).then(() => setRemoveConfirm(false))}>{props.t('remove')}</button><button className={css.buttonQuiet} type="button" onClick={() => setRemoveConfirm(false)}>{props.t('cancel')}</button></div>
                  ) : <button className={css.iconButton} type="button" aria-label={props.t('profile.remove')} onClick={() => setRemoveConfirm(true)}><TrashIcon /></button>}
                </div>
              </div>

              {connection?.state === 'failed' ? <FailureBanner status={connection} /> : null}
              {editOpen ? <EditProfileForm profile={profile} busy={busy} t={props.t} onSave={async request => { if (await props.updateProfile(request)) setEditOpen(false) }} /> : null}

              <nav className={css.tabs} aria-label={props.t('profile.details')}>
                {(['overview', 'workspaces', 'sessions'] as const).map(item => (
                  <button key={item} type="button" aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{item === 'overview' ? props.t('profile.details') : item === 'workspaces' ? props.t('workspace.title') : props.t('session.title')}</button>
                ))}
              </nav>

              {tab === 'overview' ? (
                <Overview
                  profile={profile}
                  connection={connection}
                  startCwd={startCwd}
                  busy={busy}
                  state={state}
                  t={props.t}
                  onStartCwd={setStartCwd}
                  onDoctor={() => props.runDoctor(profile.id)}
                  onInstall={() => props.install(profile.id)}
                  onStart={() => props.start(startCwd)}
                  onStop={props.stop}
                  onDisconnect={props.disconnect}
                  onCredential={props.importCredential}
                  onRetryProfile={props.refreshProfileData}
                />
              ) : null}

              {tab === 'workspaces' ? (
                <WorkspacePanel
                  profile={profile}
                  directory={state.directory}
                  harnessWorkspaces={state.harnessWorkspaces}
                  busy={busy}
                  t={props.t}
                  onBrowse={props.browseDirectory}
                  onAdd={props.addWorkspace}
                  onUpdate={props.updateWorkspace}
                  onRemove={workspace => props.removeWorkspace(workspace.id)}
                  onRefresh={props.refreshProfileData}
                  onUseForStart={cwd => { setStartCwd(cwd); setTab('overview') }}
                />
              ) : null}

              {tab === 'sessions' ? (
                <SessionPanel
                  sessions={state.sessions}
                  selectedSessionId={state.selectedSessionId}
                  transcript={state.transcript}
                  connection={connection}
                  busy={busy}
                  t={props.t}
                  onRefresh={props.refreshProfileData}
                  onSelect={props.selectSession}
                  onRetryTranscript={props.retryTranscript}
                  onLoadOlder={props.loadOlderTranscript}
                  onPrompt={props.prompt}
                  onCancel={props.cancelTurn}
                />
              ) : null}
            </main>
          )}
        </div>
      )}

      <ProfileWizard
        open={wizardOpen}
        busy={busy}
        report={state.doctor.value}
        error={state.operationError}
        t={props.t}
        onClose={() => setWizardOpen(false)}
        onCreate={props.createProfile}
        onDoctor={async created => { await props.runDoctor(created.id) }}
        onInstall={async created => { await props.install(created.id) }}
      />
    </div>
  )
}

function Overview(props: {
  readonly profile: RemoteProfileSummary
  readonly connection: RemoteConnectionStatus | null
  readonly startCwd: string
  readonly busy: boolean
  readonly state: RemoteRuntimeViewState
  readonly t: RemoteRuntimeSettingsProps['t']
  onStartCwd(value: string): void
  onDoctor(): Promise<unknown>
  onInstall(): Promise<unknown>
  onStart(): Promise<unknown>
  onStop(): Promise<unknown>
  onDisconnect(): Promise<unknown>
  onCredential(apiKey: string, baseUrl?: string): Promise<boolean>
  onRetryProfile(): Promise<void>
}): React.ReactElement {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const runtime = props.connection?.runtime ?? null
  const runtimeInstalled = runtime?.installed === true
    || props.state.doctor.value?.profileId === props.profile.id && props.state.doctor.value.runtimeInstalled
  const workspaces = props.profile.workspaces

  useEffect(() => {
    setApiKey('')
    setBaseUrl('')
  }, [props.profile.id])

  return (
    <div className={css.overviewGrid}>
      <section className={`${css.panel} ${css.spanTwo}`}>
        <header className={css.panelHeader}><div><p className={css.eyebrow}>{props.t('runtime.title')}</p><h3>{props.t('runtime.title')}</h3></div>{props.connection?.localUrl === undefined ? null : <a className={css.buttonSecondary} href={props.connection.localUrl} target="_blank" rel="noreferrer"><ExternalIcon />{props.t('runtime.open')}</a>}</header>
        <div className={css.factGrid}>
          <Fact label={props.t('runtime.version')} value={runtime?.runtimeVersion ?? props.t('profile.none')} />
          <Fact label={props.t('runtime.dshVersion')} value={runtime?.dshVersion ?? props.t('profile.none')} />
          <Fact label={props.t('runtime.nodeVersion')} value={runtime?.nodeVersion ?? props.t('profile.none')} />
          <Fact label={props.t('runtime.remotePort')} value={props.connection?.remotePort?.toString() ?? props.t('profile.none')} />
          <Fact className={css.spanTwo} label={props.t('runtime.artifact')} value={runtime?.artifactSha256 ?? props.t('runtime.notInstalled')} mono />
        </div>
        <label className={css.field}><span>{props.t('profile.cwd')}</span><select value={props.startCwd} onChange={event => props.onStartCwd(event.target.value)}><option value={props.profile.defaultCwd ?? ''}>{props.profile.defaultCwd ?? props.t('profile.none')}</option>{workspaces.filter(workspace => workspace.cwd !== props.profile.defaultCwd).map(workspace => <option key={workspace.id} value={workspace.cwd}>{workspace.name} · {workspace.cwd}</option>)}</select></label>
        <div className={css.buttonRow}>
          <button className={css.buttonQuiet} type="button" disabled={props.busy} onClick={() => void props.onDoctor()}>{props.t('doctor.run')}</button>
          <button className={css.buttonSecondary} type="button" disabled={props.busy} onClick={() => void props.onInstall()}>{props.t('runtime.install')}</button>
          <button className={css.buttonPrimary} type="button" disabled={props.busy || !runtimeInstalled} onClick={() => void props.onStart()}>{props.t('runtime.start')}</button>
          <button className={css.buttonQuiet} type="button" disabled={props.busy} onClick={() => void props.onDisconnect()}>{props.t('runtime.disconnect')}</button>
          <button className={css.buttonDanger} type="button" disabled={props.busy} onClick={() => void props.onStop()}>{props.t('runtime.stop')}</button>
        </div>
      </section>

      <section className={css.panel}>
        <header className={css.panelHeader}><div><p className={css.eyebrow}>{props.t('doctor.title')}</p><h3>{props.t('doctor.title')}</h3></div><button className={css.iconButton} type="button" aria-label={props.t('retry')} onClick={() => void props.onDoctor()}><RefreshIcon /></button></header>
        {props.state.doctor.status === 'loading' ? <p className={css.muted}>{props.t('operation.running')}</p> : props.state.doctor.status === 'error' ? <div className={css.inlineError}><span>{props.state.doctor.error?.message}</span><button type="button" onClick={() => void props.onDoctor()}>{props.t('retry')}</button></div> : <DoctorReportView report={props.state.doctor.value} t={props.t} />}
      </section>

      <section className={css.panel}>
        <header className={css.panelHeader}><div><p className={css.eyebrow}>{props.t('egress.title')}</p><h3>{props.profile.network.mode === 'client-proxy' ? props.t('egress.proxy') : props.t('egress.direct')}</h3></div><StatusBadge tone="warning">{props.t('egress.immutable')}</StatusBadge></header>
        <dl className={css.definitionList}>
          <div><dt>{props.t('profile.root')}</dt><dd>{props.profile.remoteRoot ?? props.t('profile.none')}</dd></div>
          <div><dt>{props.t('egress.ports')}</dt><dd>{props.profile.network.clientProxy.allowedPorts.join(', ') || props.t('profile.none')}</dd></div>
          <div><dt>{props.t('egress.noProxy')}</dt><dd>{props.profile.network.clientProxy.noProxy.join(', ') || props.t('profile.none')}</dd></div>
          <div><dt>{props.t('egress.upstream')}</dt><dd>{props.profile.network.clientProxy.upstreamProxyEnv ?? props.t('profile.none')}</dd></div>
        </dl>
      </section>

      <section className={`${css.panel} ${css.spanTwo}`}>
        <header className={css.panelHeader}><div><p className={css.eyebrow}>{props.t('credential.title')}</p><h3>{props.t('credential.title')}</h3></div>{props.state.credential.status === 'ready' ? <StatusBadge tone={props.state.credential.value?.configured ? 'connected' : 'disconnected'}>{props.state.credential.value?.configured ? props.t('credential.configured') : props.t('credential.missing')}</StatusBadge> : null}</header>
        {props.state.credential.status === 'error' ? <div className={css.inlineError}><span>{props.state.credential.error?.message}</span><button type="button" onClick={() => void props.onRetryProfile()}>{props.t('retry')}</button></div> : null}
        <p className={css.muted}><KeyIcon />{props.t('credential.notice')}</p>
        <div className={css.credentialForm}>
          <label className={css.field}><span>{props.t('credential.apiKey')}</span><input type="password" autoComplete="off" value={apiKey} placeholder={props.t('credential.placeholder')} onChange={event => setApiKey(event.target.value)} /></label>
          <label className={css.field}><span>{props.t('credential.baseUrl')}</span><input value={baseUrl} placeholder="https://api.deepseek.com" onChange={event => setBaseUrl(event.target.value)} /></label>
          <button className={css.buttonPrimary} type="button" disabled={props.busy || apiKey.trim() === ''} onClick={() => void props.onCredential(apiKey, baseUrl).then(imported => { if (imported) setApiKey('') })}>{props.t('credential.import')}</button>
        </div>
      </section>
    </div>
  )
}

function EditProfileForm(props: { readonly profile: RemoteProfileSummary; readonly busy: boolean; readonly t: RemoteRuntimeSettingsProps['t']; onSave(request: UpdateRemoteProfileRequest): Promise<void> }): React.ReactElement {
  const [name, setName] = useState(props.profile.name)
  const [host, setHost] = useState(props.profile.sshHost)
  const [port, setPort] = useState(props.profile.sshPort?.toString() ?? '')
  const [cwd, setCwd] = useState(props.profile.defaultCwd ?? '')
  const validPort = port.trim() === '' || (Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65_535)
  return (
    <form className={css.editForm} onSubmit={event => {
      event.preventDefault()
      if (!validPort) return
      void props.onSave({
        id: props.profile.id,
        name: name.trim(),
        sshHost: host.trim(),
        sshPort: port.trim() === '' ? null : Number(port),
        defaultCwd: cwd.trim() === '' ? null : cwd.trim(),
      })
    }}>
      <p className={css.spanTwoHint}>{props.t('profile.editHint')}</p>
      <label className={css.field}><span>{props.t('profile.name')}</span><input value={name} onChange={event => setName(event.target.value)} /></label>
      <label className={css.field}><span>{props.t('profile.host')}</span><input value={host} onChange={event => setHost(event.target.value)} /></label>
      <label className={css.field}><span>{props.t('profile.port')}</span><input type="number" min="1" max="65535" value={port} aria-invalid={!validPort} onChange={event => setPort(event.target.value)} /></label>
      <label className={css.field}><span>{props.t('profile.cwd')}</span><input value={cwd} onChange={event => setCwd(event.target.value)} /></label>
      <button className={css.buttonPrimary} type="submit" disabled={props.busy || name.trim() === '' || host.trim() === '' || !validPort}>{props.t('save')}</button>
    </form>
  )
}

function FailureBanner(props: { readonly status: RemoteConnectionStatus }): React.ReactElement {
  return <div className={css.failureBanner} role="alert"><AlertIcon /><div><strong>{props.status.message}</strong>{props.status.remediation === undefined ? null : <small>{props.status.remediation}</small>}</div></div>
}

function Fact(props: { readonly label: string; readonly value: string; readonly mono?: boolean; readonly className?: string | undefined }): React.ReactElement {
  return <div className={`${css.fact} ${props.className ?? ''}`}><span>{props.label}</span><strong className={props.mono ? css.mono : undefined} title={props.value}>{props.value}</strong></div>
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
