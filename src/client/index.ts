/** Browser entry: mount generated Remote methods and add one settings page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import dshRemoteRuntimeRemote from '@artificialnotimbecile/dsh-remote-runtime/remote'
import { RemoteRuntimeController, type DshRemoteRuntimeRemote } from './controller.ts'
import { en, NS, zh } from './locales.ts'
import { RemoteRuntimeSettings } from './RemoteRuntimeSettings.tsx'
import type { RemoteRuntimeInjected } from './slots.ts'

/** Host Remote carrier, settings slot, and locale service. */
export const inject = ['remote', 'slots', 'locale']

/** Mount the independent settings section without replacing shipped workspace or sidebar UI. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(dshRemoteRuntimeRemote)
  const remote = ctx.get('remote.dshRemoteRuntime') as DshRemoteRuntimeRemote | undefined
  if (remote === undefined) {
    await unmountRemote()
    throw new Error('dshRemoteRuntime Remote did not mount')
  }

  const unregisterLocale = ctx.locale.register(NS, { zh, en })
  const t = ctx.locale.bind(NS)
  const controller = new RemoteRuntimeController(remote)
  const injected = (): RemoteRuntimeInjected => ({
    hooks: { remoteRuntime: controller },
    activate: () => controller.activate(),
    refresh: () => controller.refresh(true),
    selectProfile: profileId => controller.selectProfile(profileId),
    createProfile: request => controller.createProfile(request),
    updateProfile: request => controller.updateProfile(request),
    removeProfile: profileId => controller.removeProfile(profileId),
    runDoctor: profileId => controller.runDoctor(profileId),
    install: profileId => controller.install(profileId),
    start: cwd => controller.start(cwd),
    stop: () => controller.stop(),
    disconnect: () => controller.disconnect(),
    importCredential: (apiKey, baseUrl) => controller.importCredential(apiKey, baseUrl),
    browseDirectory: path => controller.browseDirectory(path),
    addWorkspace: (name, cwd, pinned) => controller.addWorkspace(name, cwd, pinned),
    updateWorkspace: request => controller.updateWorkspace(request),
    removeWorkspace: workspaceId => controller.removeWorkspace(workspaceId),
    refreshProfileData: () => controller.refreshProfileData(),
    selectSession: sessionId => controller.selectSession(sessionId),
    retryTranscript: () => controller.retryTranscript(),
    loadOlderTranscript: () => controller.loadOlderTranscript(),
    prompt: (text, mode) => controller.prompt(text, mode),
    cancelTurn: () => controller.cancelTurn(),
    clearOperationError: () => controller.clearOperationError(),
  })

  const disposeSlot = ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-remote-runtime',
    order: 45,
    locale: NS,
    label: () => t('nav'),
    inject: injected,
  }, RemoteRuntimeSettings))

  ctx.on('connection/reset', () => controller.reset())

  return async () => {
    disposeSlot()
    controller.dispose()
    unregisterLocale()
    await unmountRemote()
  }
}

export { RemoteRuntimeSettings } from './RemoteRuntimeSettings.tsx'
export { RemoteRuntimeController } from './controller.ts'
export type { DshRemoteRuntimeRemote, RemoteRuntimeViewState } from './controller.ts'
