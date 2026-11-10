/**
 * Android capability adapter for the original DSH web interface.
 *
 * DSH owns the frame, responsive layout, settings, composer, menus, cards and
 * navigation chrome. This plugin adds Android-only bridges and feature panels
 * through DSH's public services and slots. The only global layout adjustments
 * are system-bar/IME insets required by the edge-to-edge WebView.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ExportResultDialog } from './ExportResultDialog.tsx'
import { DevSection } from './dev-section/DevSection.tsx'
import { PhoneControlSection } from './dev-section/phone-control.tsx'
import { NotifySettingsSection } from './dev-section/notify-settings.tsx'
import { ModelCapabilitySection } from './dev-section/model-capability.tsx'
import { DEV_SECTION_CSS } from './dev-section/dev-section.css.ts'
import { GeneralSettings } from './general-settings/GeneralSettings.tsx'
import { ThemeBridge } from './theme-bridge.ts'
import { KeyboardBoundary } from './keyboard-boundary.ts'
import { AndroidSurfaceMarker, MOBILE_FORM_MAX_WIDTH } from './mobile/form-marker.ts'
import { ANDROID_INSETS_CSS } from './mobile/android-insets.css.ts'
import { SnapshotPanelsObserver } from './snapshot-panels-observer.ts'
import { registerNativeTerminal } from './mobile/native-terminal.tsx'
import { SNAPSHOT_PANELS_CSS } from './snapshot-panels.css.ts'
import { COMPOSER_INSETS_CSS } from './composer-insets.css.ts'
import { ExportResultChannel, reportUserFacingResult, type ExportResultPayload } from './export-result.ts'
import { SettingsDocumentAction } from './mobile/settings-document.ts'
import { BackStackSignal } from './mobile/back-stack.ts'
import { SessionMarker, type SessionsFace } from './mobile/session-marker.ts'
import { EXTERNAL_OPEN_ID, externalOpenDefinition } from './mobile/external-open-paths.ts'
import { ExternalOpenTab } from './mobile/external-open.tsx'
import {
  BROWSER_TAB_ID, BROWSER_TAB_KIND, LEGACY_BROWSER_TAB_ID, LEGACY_BROWSER_TAB_KIND,
  BrowserTab, BrowserTabMenu, browserTabDefinition, legacyBrowserTabDefinition,
} from './mobile/browser-tab.tsx'
import { NativeBrowserPlacement } from './mobile/native-browser-auto-place.ts'
import { createBrowserControllers } from './mobile/upstream-browser/browser/BrowserController.ts'
import type { BrowserInjected } from './mobile/upstream-browser/browser/BrowserController.ts'
import { createBrowserStore } from './mobile/upstream-browser/browser/store.ts'
import { BrowserTitle } from './mobile/upstream-browser/view/BrowserTitle.tsx'
import { en as browserEn, zh as browserZh } from './mobile/upstream-browser/locales.ts'
import type { AndroidBrowserBodyProps } from './mobile/browser-tab.tsx'
import type { NativeBrowserControlsInjected } from './mobile/native-browser-adapter.ts'
import { IncomingDraftConsumer } from './mobile/incoming-draft.ts'
import { createIncomingDraftRuntime, type IncomingDraftRuntimeServices } from './mobile/incoming-runtime.ts'
import { openSessionForNotify, type SessionOpenFace } from './mobile/notify-landing.ts'

// Contract exports only (export-convergence rule): the plugin surface is
// `apply` and `inject`; the breakpoint constant is shared with the mobile
// directory-reference patch and its viewport probe.
export { MOBILE_FORM_MAX_WIDTH }

declare global {
  interface Window {
    /** Android shell session-export outcome bridge (success / failure). */
    __dshExportResult?: (payload: ExportResultPayload) => void
  }
}

/** Services this plugin consumes from the DSH composition. */
export const inject = ['slots', 'theme', 'sessions', 'workspaces', 'uiWorkspace', 'layout', 'conversation']

/** Append one Android integration stylesheet and return its disposer. */
function injectStyle(id: string, css: string): () => void {
  const style = document.createElement('style')
  style.setAttribute('data-plugin', id)
  style.textContent = css
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** Client plugin body: Android services over DSH-owned interface components. */
export function apply(ctx: ClientContext): void {
  // SnapshotPanel is owned by the header actions seat, so promote that header (and drop the
  // title row's containment) only while it is open; see snapshot-panels-observer.ts.
  ctx.effect(() => injectStyle('snapshot-panels', SNAPSHOT_PANELS_CSS), 'ui-responsive: snapshot panel paint')
  ctx.effect(() => {
    const observer = new SnapshotPanelsObserver()
    observer.attach()
    return () => { observer.detach() }
  }, 'ui-responsive: snapshot panel ancestor ownership')

  // The only layout CSS is platform chrome: safe areas and the Android IME.
  ctx.effect(() => injectStyle('android-insets', ANDROID_INSETS_CSS), 'ui-responsive: Android system insets')
  ctx.effect(() => injectStyle('composer-insets', COMPOSER_INSETS_CSS), 'ui-responsive: Android composer insets')
  ctx.effect(() => {
    const marker = new AndroidSurfaceMarker()
    marker.attach()
    return () => { marker.detach() }
  }, 'ui-responsive: Android frame and narrow-viewport facts')
  ctx.effect(() => {
    const boundary = new KeyboardBoundary()
    boundary.attach()
    return () => { boundary.detach() }
  }, 'ui-responsive: Android keyboard boundary')

  // Android system theme is authoritative on WebViews that do not update the
  // prefers-color-scheme media query after an OS uiMode change.
  ctx.effect(() => {
    const bridge = new ThemeBridge()
    bridge.install()
    return () => { /* the global hook is idempotent and lives for the page */ }
  }, 'ui-responsive: Android theme bridge')

  // Android settings are additive DSH sections. Existing DSH sections retain
  // their own components, order and responsive behavior.
  ctx.effect(() => injectStyle('dev-section', DEV_SECTION_CSS), 'ui-responsive: Android developer section styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'android-dev',
    order: 99,
    label: () => '开发者选项',
    children: { 'settings.dev.item': { kind: 'list', scope: 'root' } },
  }, DevSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'android-notify', order: 97, label: () => '通知',
  }, NotifySettingsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'android-phone-control', order: 98, label: () => '手机控制',
  }, PhoneControlSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'android-model-capability', order: 96, label: () => '模型能力',
  }, ModelCapabilitySection))
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'android-general', order: 90, label: () => 'Android 显示',
  }, GeneralSettings))

  // The native export result and feature-specific BrowserHost surfaces are
  // additive entries. They do not replace DSH's frame or right-sidebar UI.
  const exportChannel = new ExportResultChannel()
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'export-result',
    inject: () => ({ hooks: { exportResult: exportChannel }, close: () => { exportChannel.close() } }),
  }, ExportResultDialog))

  ctx.effect(() => {
    const action = new SettingsDocumentAction()
    action.attach()
    return () => { action.detach() }
  }, 'ui-responsive: Android settings-document chooser')

  ctx.effect(() => {
    const tabs = ctx.get('sidebarRightTabs')
    if (tabs === undefined) return () => {}
    let ranking = false
    const claimedByAnother = (address: string): boolean => {
      if (ranking) return false
      ranking = true
      try {
        return tabs.candidates(address).some(definition =>
          definition.id !== EXTERNAL_OPEN_ID && definition.priority !== 'fallback')
      } finally {
        ranking = false
      }
    }
    return tabs.register(externalOpenDefinition(claimedByAnother))
  }, 'ui-responsive: Android open-with tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: EXTERNAL_OPEN_ID,
  }, ExternalOpenTab))

  // BrowserHost is an Android-specific capability panel. Its controller and
  // placement follow the DSH right-sidebar service and tab registry.
  ctx.inject(['locale', 'sidebarRight', 'sidebarRightTabs'], scope => {
    const namespace = 'androidSidebarBrowser'
    const t = scope.locale.bind(namespace)
    const store = createBrowserStore()
    const openTabs = scope.sidebarRight.openTabs
    const placement = new NativeBrowserPlacement({
      sessions: () => scope.sessions.list.getSnapshot().ids,
      tabs: () => openTabs.getSnapshot(),
      mounted: () => scope.sidebarRight.mounted.getSnapshot(),
      expanded: () => scope.sidebarRight.isExpanded(),
      open: session => { scope.sidebarRight.openTabIn(session, BROWSER_TAB_KIND, { revealIfOpened: false }) },
      close: (session, tabId) => { scope.sidebarRight.closeIn(session, tabId) },
      kind: BROWSER_TAB_KIND, legacyKind: LEGACY_BROWSER_TAB_KIND,
    })
    const controllers = new Map<AndroidBrowserBodyProps['sessionId'], BrowserInjected & NativeBrowserControlsInjected>()
    scope.effect(() => scope.locale.register(namespace, { zh: browserZh, en: browserEn }), 'ui-responsive.browser.copy')
    scope.effect(() => scope.sidebarRightTabs.register(browserTabDefinition(t)), 'ui-responsive.browser.type')
    scope.effect(() => scope.sidebarRightTabs.register(legacyBrowserTabDefinition(t)), 'ui-responsive.browser.legacy-type')
    for (const kind of [BROWSER_TAB_KIND, LEGACY_BROWSER_TAB_KIND]) {
      scope.effect(() => scope.sidebarRight.registerCloseHandler(kind, (session, tab) => {
        if (scope.sessions.list.getSnapshot().ids.includes(session)) placement.for(session).closeUi(tab.id)
      }), 'ui-responsive.browser.explicit-close')
    }
    scope.effect(() => async () => {
      placement.dispose()
      await Promise.all([...controllers.values()].map(controller => controller.dispose()))
      controllers.clear()
    }, 'ui-responsive.browser.frames')
    for (const key of [BROWSER_TAB_ID, LEGACY_BROWSER_TAB_ID]) {
      scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
        name: 'sidebar.right.pane.tab', key, locale: namespace, store,
        inject: (session, actions) => {
          const existing = controllers.get(session)
          if (existing !== undefined) { existing.rebind(actions); return existing }
          const native = placement.for(session)
          const neutral = createBrowserControllers(actions, native.createPage,
            tabId => openTabs.getSnapshot().some(tab => tab.sessionId === session && tab.tabId === tabId))
          const controller: BrowserInjected & NativeBrowserControlsInjected = {
            ...neutral,
            keyedHooks: { ...neutral.keyedHooks, nativeBrowserState: native.controlSource },
            setBrowserVisible: (tabId, visible) => { native.setVisible(tabId, visible) },
            setBrowserIdentity: (tabId, desktop) => { native.setIdentity(tabId, desktop) },
            setBrowserViewport: (tabId, width, height) => { native.setViewport(tabId, width, height) },
            refreshBrowserStatus: tabId => { native.refreshStatus(tabId) },
            setBrowserCompat: (tabId, enabled) => { native.setCompat(tabId, enabled) },
            closeBrowserTab: tabId => { scope.sidebarRight.closeIn(session, tabId) },
          }
          controllers.set(session, controller)
          return controller
        },
      }, BrowserTab)), 'ui-responsive.browser.body')
      scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
        name: 'sidebar.right.pane.tab.title', key, store,
      }, BrowserTitle)), 'ui-responsive.browser.title')
    }
    scope.effect(() => scope.slots.inject('sidebar.right.tab.menu.item', () => scope.slots.register({
      name: 'sidebar.right.tab.menu.item', id: 'android-browser.native-controls', locale: namespace,
      inject: (session: SessionId): NativeBrowserControlsInjected => {
        const native = placement.for(session)
        return {
          keyedHooks: { nativeBrowserState: native.controlSource },
          setBrowserVisible: (tabId, visible) => { native.setVisible(tabId, visible) },
          setBrowserIdentity: (tabId, desktop) => { native.setIdentity(tabId, desktop) },
          setBrowserViewport: (tabId, width, height) => { native.setViewport(tabId, width, height) },
          refreshBrowserStatus: tabId => { native.refreshStatus(tabId) },
          setBrowserCompat: (tabId, enabled) => { native.setCompat(tabId, enabled) },
          closeBrowserTab: tabId => { scope.sidebarRight.closeIn(session, tabId) },
        } satisfies NativeBrowserControlsInjected
      },
    }, BrowserTabMenu)), 'ui-responsive.browser.menu')
    scope.effect(() => placement.attach(), 'ui-responsive.browser.native-tab-placement')
  })

  // 侧栏原生终端（第一版落在 ui-responsive；会话仍归 webTerminals）。
  registerNativeTerminal(ctx)

  // System Back crosses the WebView/Activity boundary synchronously. Keep the
  // page-side layer signal, but let the current DSH controls dismiss each UI.
  ctx.effect(() => {
    const backStack = new BackStackSignal({
      toggleSidebar: () => { ctx.layout.toggleSidebar() },
      activePanelId: () => ctx.layout.panelInfo.getSnapshot().activePanelId,
      leaveMainPanel: () => { ctx.layout.selectPanel(null) },
    })
    backStack.attach()
    const unsubscribe = ctx.layout.panelInfo.subscribe(() => { backStack.refresh() })
    return () => { unsubscribe(); backStack.detach() }
  }, 'ui-responsive: Android system-back bridge')

  // Publish the current Session id for the host compatibility layer's file-link
  // bridge; the value always comes from the DSH session snapshot.
  ctx.effect(() => {
    const marker = new SessionMarker(ctx.sessions as unknown as SessionsFace)
    marker.attach()
    return () => { marker.detach() }
  }, 'ui-responsive: current session fact for host file links')

  // The native export completes outside the page thread; report its outcome to
  // an additive DSH overlay through the existing shell callback.
  ctx.effect(() => {
    const onResult = (event: Event): void => {
      const payload = (event as CustomEvent<ExportResultPayload>).detail
      if (payload === null || typeof payload !== 'object') return
      if (typeof payload.ok !== 'boolean' || typeof payload.title !== 'string' || typeof payload.detail !== 'string') return
      exportChannel.show(payload)
    }
    const bridge = (payload: ExportResultPayload): void => { reportUserFacingResult(payload) }
    window.__dshExportResult = bridge
    window.addEventListener('dsh:export-result', onResult)
    return () => {
      window.removeEventListener('dsh:export-result', onResult)
      delete window.__dshExportResult
    }
  }, 'ui-responsive: Android export-result bridge')

  // External open/share adds an unsent attachment draft through the DSH
  // conversation runtime after the temporary Session scope exists.
  ctx.effect(() => {
    document.documentElement.setAttribute('data-dsh-incoming-draft-consumer', 'active')
    const sessions = (): ReturnType<IncomingDraftRuntimeServices['sessions']> =>
      ctx.sessions as unknown as ReturnType<IncomingDraftRuntimeServices['sessions']>
    const workspaces = (): ReturnType<IncomingDraftRuntimeServices['workspaces']> =>
      ctx.get('workspaces') as ReturnType<IncomingDraftRuntimeServices['workspaces']>
    const uiWorkspace = (): ReturnType<IncomingDraftRuntimeServices['uiWorkspace']> =>
      ctx.get('uiWorkspace') as ReturnType<IncomingDraftRuntimeServices['uiWorkspace']>
    const conversation = (): ReturnType<IncomingDraftRuntimeServices['conversation']> =>
      ctx.conversation as unknown as ReturnType<IncomingDraftRuntimeServices['conversation']>
    const consumer = new IncomingDraftConsumer(
      (path, init) => fetch(path, init),
      createIncomingDraftRuntime({ sessions, workspaces, uiWorkspace, conversation }),
    )
    const poll = (): void => { void consumer.poll() }
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') poll() }, 4000)
    const onVisible = (): void => { if (document.visibilityState === 'visible') poll() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    poll()
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      document.documentElement.removeAttribute('data-dsh-incoming-draft-consumer')
    }
  }, 'ui-responsive: Android external attachment drafts')

  // Android notification taps route to the selected DSH Session in-page.
  ctx.effect(() => {
    const open = (sessionId: unknown): boolean =>
      openSessionForNotify(ctx.sessions as unknown as SessionOpenFace, sessionId)
    ;(window as unknown as Record<string, unknown>).__dshOpenSession = open
    return () => { delete (window as unknown as Record<string, unknown>).__dshOpenSession }
  }, 'ui-responsive: Android notification landing')
}
