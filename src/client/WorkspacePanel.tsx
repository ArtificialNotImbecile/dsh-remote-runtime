/** Saved-workspace management and plain-SSH directory browser. */
import { useEffect, useMemo, useState } from 'react'
import type { RemoteProfileSummary, RemoteWorkspace, UpdateRemoteWorkspaceRequest } from '../types.ts'
import type { Loadable, RemoteDirectoryListing } from './controller.ts'
import { ChevronIcon, FolderIcon, PlusIcon, RefreshIcon, TrashIcon } from './icons.tsx'
import type { RemoteRuntimeLocaleKey } from './locales.ts'
import { StatusBadge } from './ProfileWizard.tsx'
import css from './RemoteRuntimeSettings.module.css'

type Translate = (key: RemoteRuntimeLocaleKey, values?: Record<string, unknown>) => string

export interface WorkspacePanelProps {
  readonly profile: RemoteProfileSummary
  readonly directory: Loadable<RemoteDirectoryListing>
  readonly harnessWorkspaces: Loadable<readonly import('../types.ts').RemoteHarnessWorkspace[]>
  readonly busy: boolean
  readonly t: Translate
  onBrowse(path?: string): Promise<void>
  onAdd(name: string, cwd: string, pinned: boolean): Promise<boolean>
  onUpdate(request: UpdateRemoteWorkspaceRequest): Promise<boolean>
  onRemove(workspace: RemoteWorkspace): Promise<boolean>
  onRefresh(): Promise<void>
  onUseForStart(cwd: string): void
}

export function WorkspacePanel(props: WorkspacePanelProps): React.ReactElement {
  const [browserOpen, setBrowserOpen] = useState(false)
  const [path, setPath] = useState(props.profile.defaultCwd ?? '/')
  const [name, setName] = useState('')
  const [pinned, setPinned] = useState(false)
  const [removeId, setRemoveId] = useState<string | null>(null)

  useEffect(() => {
    setBrowserOpen(false)
    setPath(props.profile.defaultCwd ?? '/')
    setName('')
    setPinned(false)
    setRemoveId(null)
  }, [props.profile.id])

  const saved = useMemo(
    () => [...props.profile.workspaces].sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.name.localeCompare(right.name)),
    [props.profile.workspaces],
  )

  async function openBrowser(): Promise<void> {
    setBrowserOpen(true)
    await props.onBrowse(path)
  }

  async function browse(target: string): Promise<void> {
    setPath(target)
    await props.onBrowse(target)
  }

  async function add(): Promise<void> {
    const added = await props.onAdd(name.trim() || leafName(path), path, pinned)
    if (!added) return
    setBrowserOpen(false)
    setName('')
    setPinned(false)
  }

  return (
    <section className={css.panel} aria-labelledby="dsh-remote-workspaces">
      <header className={css.panelHeader}>
        <div><p className={css.eyebrow}>{props.t('workspace.title')}</p><h3 id="dsh-remote-workspaces">{props.t('workspace.saved')}</h3></div>
        <div className={css.buttonRow}>
          <button className={css.buttonQuiet} type="button" disabled={props.busy} onClick={() => void props.onRefresh()}><RefreshIcon />{props.t('refresh')}</button>
          <button className={css.buttonSecondary} type="button" disabled={props.busy} onClick={() => void openBrowser()}><PlusIcon />{props.t('workspace.add')}</button>
        </div>
      </header>

      {saved.length === 0 ? <p className={css.emptyInline}>{props.t('workspace.empty')}</p> : (
        <ul className={css.workspaceList}>
          {saved.map(workspace => (
            <li key={workspace.id}>
              <div className={css.workspaceGlyph}><FolderIcon /></div>
              <div className={css.grow}>
                <strong>{workspace.name}</strong>
                <small title={workspace.cwd}>{workspace.cwd}</small>
              </div>
              {workspace.pinned ? <StatusBadge tone="connected">{props.t('workspace.pinned')}</StatusBadge> : null}
              <div className={css.compactActions}>
                <button type="button" disabled={props.busy} onClick={() => props.onUseForStart(workspace.cwd)}>{props.t('workspace.useForStart')}</button>
                <button type="button" disabled={props.busy} onClick={() => void props.onUpdate({
                  profileId: props.profile.id,
                  workspaceId: workspace.id,
                  pinned: !workspace.pinned,
                })}>{workspace.pinned ? props.t('workspace.unpin') : props.t('workspace.pin')}</button>
                {removeId === workspace.id ? (
                  <>
                    <button className={css.dangerText} type="button" disabled={props.busy} onClick={() => void props.onRemove(workspace).then(removed => { if (removed) setRemoveId(null) })}>{props.t('remove')}</button>
                    <button type="button" onClick={() => setRemoveId(null)}>{props.t('cancel')}</button>
                  </>
                ) : <button className={css.iconButton} type="button" aria-label={`${props.t('remove')} ${workspace.name}`} disabled={props.busy} onClick={() => setRemoveId(workspace.id)}><TrashIcon /></button>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {browserOpen ? (
        <div className={css.browser}>
          <div className={css.browserHeader}>
            <label className={css.pathInput}><span>{props.t('workspace.path')}</span><input value={path} onChange={event => setPath(event.target.value)} onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); void browse(path) }
            }} /></label>
            <button className={css.buttonQuiet} type="button" disabled={props.directory.status === 'loading'} onClick={() => void browse(path)}>{props.t('workspace.browse')}</button>
          </div>
          <div className={css.directoryList} aria-live="polite">
            {props.directory.status === 'loading' ? <LoadingLine /> : null}
            {props.directory.status === 'error' ? <RetryError error={props.directory.error?.message ?? ''} retry={() => void browse(path)} t={props.t} /> : null}
            {props.directory.status === 'ready' && props.directory.value !== null ? (
              <>
                {props.directory.value.parentPath === null ? null : (
                  <button type="button" onClick={() => void browse(props.directory.value!.parentPath!)}><FolderIcon /><span>..</span><small>{props.t('workspace.parent')}</small></button>
                )}
                {props.directory.value.entries.length === 0 ? <p>{props.t('workspace.directoryEmpty')}</p> : props.directory.value.entries.map(entry => (
                  <button key={entry.path} type="button" onClick={() => void browse(entry.path)}>
                    <FolderIcon />
                    <span>{entry.name}</span>
                    <span className={css.directoryTags}>{entry.gitRepository ? <StatusBadge tone="warning">{props.t('workspace.git')}</StatusBadge> : null}{entry.writable ? null : <StatusBadge tone="failed">{props.t('workspace.readOnly')}</StatusBadge>}</span>
                    <ChevronIcon />
                  </button>
                ))}
              </>
            ) : null}
          </div>
          <div className={css.formGrid}>
            <label className={css.field}><span>{props.t('workspace.name')}</span><input value={name} placeholder={leafName(path)} onChange={event => setName(event.target.value)} /></label>
            <label className={css.checkboxField}><input type="checkbox" checked={pinned} onChange={event => setPinned(event.target.checked)} /><span>{props.t('workspace.pinned')}</span></label>
          </div>
          <div className={css.rightActions}>
            <button className={css.buttonQuiet} type="button" onClick={() => setBrowserOpen(false)}>{props.t('cancel')}</button>
            <button className={css.buttonPrimary} type="button" disabled={props.busy || path.trim() === ''} onClick={() => void add()}>{props.t('workspace.add')}</button>
          </div>
        </div>
      ) : null}

      <div className={css.subsection}>
        <h4>{props.t('workspace.discovered')}</h4>
        {props.harnessWorkspaces.status === 'loading' ? <LoadingLine /> : null}
        {props.harnessWorkspaces.status === 'error' ? <RetryError error={props.harnessWorkspaces.error?.message ?? ''} retry={() => void props.onRefresh()} t={props.t} /> : null}
        {props.harnessWorkspaces.status === 'ready' && props.harnessWorkspaces.value !== null ? (
          props.harnessWorkspaces.value.length === 0 ? <p className={css.muted}>{props.t('workspace.empty')}</p> : (
            <ul className={css.discoveredList}>{props.harnessWorkspaces.value.map(workspace => (
              <li key={workspace.workspaceId}>
                <div><strong>{workspace.title}</strong><small>{workspace.path}</small></div>
                <span>{props.t('workspace.sessions', { count: workspace.sessionIds.length })}</span>
                <button type="button" onClick={() => props.onUseForStart(workspace.path)}>{props.t('workspace.useForStart')}</button>
              </li>
            ))}</ul>
          )
        ) : null}
      </div>
    </section>
  )
}

export function LoadingLine(): React.ReactElement {
  return <p className={css.loadingLine}><span aria-hidden="true" /> <span aria-hidden="true" /> <span aria-hidden="true" /></p>
}

export function RetryError(props: { readonly error: string; readonly t: Translate; retry(): void }): React.ReactElement {
  return <div className={css.inlineError} role="alert"><span>{props.error}</span><button type="button" onClick={props.retry}>{props.t('retry')}</button></div>
}

function leafName(path: string): string {
  return path.replace(/\/+$/u, '').split('/').at(-1) || 'workspace'
}
