/** Three-stage profile creation: persist first, then explicitly diagnose/install. */
import { useEffect, useId, useState } from 'react'
import type { CreateRemoteProfileRequest, DoctorReport, RemoteEgressMode, RemoteProfileSummary, RemoteRuntimeFailure } from '../types.ts'
import type { RemoteRuntimeLocaleKey } from './locales.ts'
import { CheckIcon } from './icons.tsx'
import css from './RemoteRuntimeSettings.module.css'

type Translate = (key: RemoteRuntimeLocaleKey, values?: Record<string, unknown>) => string
type Step = 'host' | 'network' | 'setup'

const STEPS: readonly Step[] = ['host', 'network', 'setup']

export interface ProfileWizardProps {
  readonly open: boolean
  readonly busy: boolean
  readonly report: DoctorReport | null
  readonly error: RemoteRuntimeFailure | null
  readonly t: Translate
  onClose(): void
  onCreate(request: CreateRemoteProfileRequest): Promise<RemoteProfileSummary | null>
  onDoctor(profile: RemoteProfileSummary): Promise<void>
  onInstall(profile: RemoteProfileSummary): Promise<void>
}

export function ProfileWizard(props: ProfileWizardProps): React.ReactElement | null {
  const titleId = useId()
  const [step, setStep] = useState<Step>('host')
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [cwd, setCwd] = useState('')
  const [root, setRoot] = useState('')
  const [mode, setMode] = useState<RemoteEgressMode>('remote-direct')
  const [ports, setPorts] = useState('80, 443')
  const [noProxy, setNoProxy] = useState('')
  const [proxyEnv, setProxyEnv] = useState('')
  const [created, setCreated] = useState<RemoteProfileSummary | null>(null)

  useEffect(() => {
    if (props.open) return
    setStep('host')
    setName('')
    setHost('')
    setPort('')
    setCwd('')
    setRoot('')
    setMode('remote-direct')
    setPorts('80, 443')
    setNoProxy('')
    setProxyEnv('')
    setCreated(null)
  }, [props.open])

  if (!props.open) return null

  const portNumber = port.trim() === '' ? undefined : Number(port)
  const portValid = portNumber === undefined || (Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65_535)
  const hostReady = name.trim() !== '' && host.trim() !== '' && portValid

  async function create(): Promise<void> {
    const request: CreateRemoteProfileRequest = {
      name: name.trim(),
      sshHost: host.trim(),
      ...(portNumber === undefined ? {} : { sshPort: portNumber }),
      ...(cwd.trim() === '' ? {} : { defaultCwd: cwd.trim() }),
      ...(root.trim() === '' ? {} : { remoteRoot: root.trim() }),
      network: {
        mode,
        clientProxy: {
          allowedPorts: parsePorts(ports),
          noProxy: splitList(noProxy),
          ...(proxyEnv.trim() === '' ? {} : { upstreamProxyEnv: proxyEnv.trim() }),
        },
      },
    }
    const profile = await props.onCreate(request)
    if (profile === null) return
    setCreated(profile)
    setStep('setup')
  }

  return (
    <div className={css.modalBackdrop} role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget && !props.busy) props.onClose()
    }}>
      <section className={css.modal} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
        if (event.key === 'Escape' && !props.busy) props.onClose()
      }}>
        <header className={css.modalHeader}>
          <div>
            <p className={css.eyebrow}>DSH Remote Runtime</p>
            <h2 id={titleId}>{props.t('wizard.title')}</h2>
          </div>
          <button className={css.iconButton} type="button" aria-label={props.t('close')} disabled={props.busy} onClick={props.onClose}>×</button>
        </header>

        <ol className={css.wizardSteps}>
          {STEPS.map((item, index) => {
            const done = STEPS.indexOf(step) > index || (created !== null && item !== 'setup')
            return (
              <li key={item} className={item === step ? css.currentStep : done ? css.doneStep : undefined} aria-current={item === step ? 'step' : undefined}>
                <span>{done ? <CheckIcon /> : index + 1}</span>
                {props.t(`wizard.step.${item}`)}
              </li>
            )
          })}
        </ol>

        <div className={css.modalBody}>
          {props.error === null ? null : <div className={css.inlineError} role="alert"><span>{props.error.message}{props.error.remediation === undefined ? '' : ` ${props.error.remediation}`}</span></div>}
          {step === 'host' ? (
            <div className={css.formGrid}>
              <p className={css.spanTwoHint}>{props.t('wizard.hostHint')}</p>
              <Field label={props.t('profile.name')}>
                <input autoFocus value={name} placeholder={props.t('wizard.namePlaceholder')} onChange={event => setName(event.target.value)} />
              </Field>
              <Field label={props.t('profile.host')}>
                <input value={host} placeholder={props.t('wizard.hostPlaceholder')} onChange={event => setHost(event.target.value)} />
              </Field>
              <Field label={props.t('profile.port')}>
                <input type="number" min="1" max="65535" value={port} aria-invalid={!portValid} placeholder={props.t('wizard.portPlaceholder')} onChange={event => setPort(event.target.value)} />
              </Field>
              <Field label={props.t('profile.cwd')}>
                <input value={cwd} placeholder={props.t('wizard.cwdPlaceholder')} onChange={event => setCwd(event.target.value)} />
              </Field>
              <Field className={css.spanTwo} label={props.t('profile.root')}>
                <input value={root} placeholder={props.t('wizard.rootPlaceholder')} onChange={event => setRoot(event.target.value)} />
              </Field>
            </div>
          ) : null}

          {step === 'network' ? (
            <div className={css.stack}>
              <div>
                <h3>{props.t('wizard.egressTitle')}</h3>
                <p className={css.warningText}>{props.t('wizard.egressLocked')}</p>
              </div>
              <fieldset className={css.choiceGrid}>
                <legend className={css.srOnly}>{props.t('wizard.egressTitle')}</legend>
                <EgressChoice
                  checked={mode === 'remote-direct'}
                  title={props.t('wizard.direct')}
                  body={props.t('wizard.directBody')}
                  onChange={() => setMode('remote-direct')}
                />
                <EgressChoice
                  checked={mode === 'client-proxy'}
                  title={props.t('wizard.proxy')}
                  body={props.t('wizard.proxyBody')}
                  onChange={() => setMode('client-proxy')}
                />
              </fieldset>
              {mode === 'client-proxy' ? (
                <div className={css.formGrid}>
                  <Field label={props.t('wizard.allowedPorts')}>
                    <input value={ports} onChange={event => setPorts(event.target.value)} />
                  </Field>
                  <Field label={props.t('wizard.noProxy')}>
                    <input value={noProxy} placeholder="registry.internal, 10.0.0.5" onChange={event => setNoProxy(event.target.value)} />
                  </Field>
                  <Field className={css.spanTwo} label={props.t('wizard.proxyEnv')}>
                    <input value={proxyEnv} placeholder="HTTPS_PROXY" onChange={event => setProxyEnv(event.target.value)} />
                  </Field>
                  <p className={css.spanTwoHint}>{props.t('wizard.proxyNotice')}</p>
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 'setup' && created !== null ? (
            <div className={css.stack}>
              <div className={css.successBanner}><CheckIcon /><span>{props.t('profile.created')}</span></div>
              <p>{props.t('wizard.doctorFirst')}</p>
              <DoctorReportView report={props.report} t={props.t} />
            </div>
          ) : null}
        </div>

        <footer className={css.modalFooter}>
          {step === 'host' ? (
            <>
              <button className={css.buttonQuiet} type="button" onClick={props.onClose}>{props.t('cancel')}</button>
              <button className={css.buttonPrimary} type="button" disabled={!hostReady} onClick={() => setStep('network')}>{props.t('next')}</button>
            </>
          ) : null}
          {step === 'network' ? (
            <>
              <button className={css.buttonQuiet} type="button" onClick={() => setStep('host')}>{props.t('back')}</button>
              <button className={css.buttonPrimary} type="button" disabled={props.busy} onClick={() => void create()}>{props.t('wizard.create')}</button>
            </>
          ) : null}
          {step === 'setup' && created !== null ? (
            <>
              <button className={css.buttonQuiet} type="button" disabled={props.busy} onClick={() => void props.onDoctor(created)}>{props.t('doctor.run')}</button>
              <button className={css.buttonSecondary} type="button" disabled={props.busy || props.report?.ready !== true} onClick={() => void props.onInstall(created)}>{props.t('runtime.install')}</button>
              <button className={css.buttonPrimary} type="button" disabled={props.busy} onClick={props.onClose}>{props.t('wizard.finish')}</button>
            </>
          ) : null}
        </footer>
      </section>
    </div>
  )
}

export function DoctorReportView(props: { readonly report: DoctorReport | null; readonly t: Translate }): React.ReactElement {
  if (props.report === null) return <p className={css.muted}>{props.t('doctor.notRun')}</p>
  return (
    <div>
      <p className={props.report.ready ? css.successText : css.warningText}>
        {props.report.ready ? props.t('doctor.ready') : props.t('doctor.notReady')}
      </p>
      <ul className={css.checkList}>
        {props.report.checks.map(check => (
          <li key={check.id}>
            <StatusBadge tone={check.status}>{props.t(`doctor.${check.status}`)}</StatusBadge>
            <span><strong>{check.message}</strong>{check.remediation === undefined ? null : <small>{check.remediation}</small>}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function StatusBadge(props: { readonly tone: string; readonly children: React.ReactNode }): React.ReactElement {
  return <span className={`${css.badge} ${css[`badge_${props.tone}`] ?? ''}`}>{props.children}</span>
}

function Field(props: { readonly label: string; readonly className?: string | undefined; readonly children: React.ReactNode }): React.ReactElement {
  return <label className={`${css.field} ${props.className ?? ''}`}><span>{props.label}</span>{props.children}</label>
}

function EgressChoice(props: { readonly checked: boolean; readonly title: string; readonly body: string; onChange(): void }): React.ReactElement {
  return (
    <label className={`${css.choiceCard} ${props.checked ? css.choiceSelected : ''}`}>
      <input type="radio" name="dsh-remote-egress" checked={props.checked} onChange={props.onChange} />
      <span><strong>{props.title}</strong><small>{props.body}</small></span>
    </label>
  )
}

function splitList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function parsePorts(value: string): number[] {
  return [...new Set(splitList(value).map(Number).filter(port => Number.isInteger(port) && port >= 1 && port <= 65_535))]
}
