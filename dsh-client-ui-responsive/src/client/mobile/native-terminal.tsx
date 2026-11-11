/**
 * 侧栏原生终端 tab（第一版落在 ui-responsive 内，避免新增独立包的基座构建依赖）。
 *
 * 分工：会话仍归 `webTerminals`（引擎侧 PTY/权限/审计不变），本文件只负责
 *  - 注册 `terminal-native` 右侧栏 tab 与 body；
 *  - 把 body 的几何上报给壳侧原生视图（termViewBounds）；
 *  - 把 `webTerminals` 的 render 帧（base64）喂给原生视图（termViewOutput），并回 ack；
 *  - 把原生视图的输入/尺寸回调写回模型（__dshTermInput / __dshTermResize）。
 *
 * 模型侧 `bash`/`terminal` 工具不经过这里。
 */
import { useEffect, useRef, useState } from 'react'
import { PluginArtworkTerminal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

export const NATIVE_TERMINAL_TAB_ID = 'android-native-terminal'
export const NATIVE_TERMINAL_TAB_KIND = 'terminal-native'

/** 壳侧桥（可选：非 Android 宿主/旧壳没有这些方法时静默降级）。 */
interface TerminalBridge {
  termViewOpen?: (config: string) => string
  termViewBounds?: (bounds: string) => string
  termViewVisible?: (visible: boolean) => string
  termViewOutput?: (encoded: string) => string
  termViewFocus?: () => string
  termViewClose?: () => string
}

function bridge(): TerminalBridge | undefined {
  return (window as unknown as { androidBridge?: TerminalBridge }).androidBridge
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function textFrameBase64(text: string): string {
  return encodeBase64(new TextEncoder().encode(text))
}

/** 原生终端 body；props 由 sidebar slot 注入（useTabInfo/useTerminal/view）。 */
function NativeTerminalBody(props: any): ReactNode {
  const { tab } = props.useTabInfo()
  const model = props.view(tab.id)
  const state = props.useTerminal(tab.id)
  const stage = useRef<HTMLDivElement | null>(null)
  const openedFor = useRef<string | undefined>(undefined)
  const lastRevision = useRef(0)
  const [unavailable, setUnavailable] = useState(false)
  const [diagnostic, setDiagnostic] = useState('')

  const reportRef = useRef<() => void>(() => {})
  const stateRef = useRef<any>(undefined)
  stateRef.current = state

  const openNative = (cols: number, rows: number): boolean => {
    const api = bridge()
    if (api?.termViewOpen === undefined) {
      setDiagnostic('androidBridge.termViewOpen 不存在（壳侧桥未接线）')
      setUnavailable(true)
      return false
    }
    const result = api.termViewOpen(JSON.stringify({ cols, rows, owner: String(tab.id) }))
    try {
      const parsed = JSON.parse(result)
      if (parsed?.ok === false) {
        const detail = typeof parsed.detail === 'string' && parsed.detail.length > 0 ? ` / ${parsed.detail}` : ''
        setDiagnostic(`${parsed.reason ?? 'unknown'}${detail}`)
        setUnavailable(true)
        return false
      }
      return true
    } catch {
      setDiagnostic(`返回值不是 JSON：${String(result).slice(0, 80)}`)
      setUnavailable(true)
      return false
    }
  }

  useEffect(() => {
    const mounted = model.mount?.()
    return () => {
      if (typeof mounted === 'function') mounted()
    }
  }, [model])

  // 输入/尺寸：壳侧原生视图回调到页面全局函数（同一时刻只服务一个可见终端）。
  useEffect(() => {
    const target = window as any
    target.__dshTermInput = (encoded: string) => {
      try {
        const text = new TextDecoder().decode(decodeBase64(encoded))
        if (text.length > 0) model.write(text)
      } catch {
        /* 非法载荷：忽略，终端保持可用 */
      }
    }
    target.__dshTermResize = (cols: number, rows: number) => {
      if (Number.isInteger(cols) && Number.isInteger(rows)) model.resize(cols, rows)
    }
    return () => {
      delete target.__dshTermInput
      delete target.__dshTermResize
      bridge()?.termViewClose?.()
    }
  }, [model])

  // 页面卸载/热重载时主动回收原生视图：React 卸载回调在整页刷新时不一定执行，
  // 否则 overlay 会留在壳侧直到 Activity 销毁。
  useEffect(() => {
    const close = (): void => { bridge()?.termViewClose?.() }
    window.addEventListener('pagehide', close)
    window.addEventListener('beforeunload', close)
    return () => {
      window.removeEventListener('pagehide', close)
      window.removeEventListener('beforeunload', close)
    }
  }, [])

  // 页面回到前台 / 从冻结恢复：原生视图可能已被回收，重新 open 并重报矩形。
  useEffect(() => {
    const resume = (): void => {
      if (document.visibilityState !== 'visible') return
      const info = stateRef.current?.info
      if (info === undefined) return
      if (openNative(info.cols, info.rows)) {
        bridge()?.termViewFocus?.()
        reportRef.current()
      }
    }
    window.addEventListener('pageshow', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('pageshow', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [model])

  // 页面导航/侧栏隐藏时关闭原生 overlay；返回终端时再打开。
  // back/popstate 不会让 React 卸载 body，若只靠卸载清理，overlay 会一直盖在新界面上。
  useEffect(() => {
    const element = stage.current
    if (element === null) return
    let suspended = false
    const reconcile = (): void => {
      const rect = element.getBoundingClientRect()
      const visible = document.visibilityState === 'visible' && rect.width > 1 && rect.height > 1 && element.offsetParent !== null
      if (!visible) { bridge()?.termViewClose?.(); return }
      if (suspended) return
      const info = stateRef.current?.info
      if (info === undefined) return
      if (openNative(info.cols, info.rows)) {
        bridge()?.termViewFocus?.()
        reportRef.current()
      }
    }
    // 页面级返回（popstate/hashchange）不会卸载 body；先关 overlay，等用户回到终端区域再重开。
    const navigateAway = (): void => {
      suspended = true
      bridge()?.termViewClose?.()
    }
    const wake = (): void => {
      suspended = false
      reconcile()
    }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(reconcile, { threshold: 0 })
    observer?.observe(element)
    document.addEventListener('visibilitychange', reconcile)
    window.addEventListener('popstate', navigateAway)
    window.addEventListener('hashchange', navigateAway)
    window.addEventListener('pointerdown', wake)
    window.addEventListener('focus', wake)
    return () => {
      observer?.disconnect()
      document.removeEventListener('visibilitychange', reconcile)
      window.removeEventListener('popstate', navigateAway)
      window.removeEventListener('hashchange', navigateAway)
      window.removeEventListener('pointerdown', wake)
      window.removeEventListener('focus', wake)
    }
  }, [model])

  // 打开原生视图 + 持续上报几何。
  useEffect(() => {
    const element = stage.current
    if (element === null) return
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      bridge()?.termViewBounds?.(JSON.stringify({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        visible: document.visibilityState !== 'hidden' && rect.width > 1 && rect.height > 1,
      }))
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(report)
    observer?.observe(element)
    window.addEventListener('resize', report)
    window.visualViewport?.addEventListener('resize', report)
    window.visualViewport?.addEventListener('scroll', report)
    reportRef.current = report
    report()
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', report)
      window.visualViewport?.removeEventListener('resize', report)
      window.visualViewport?.removeEventListener('scroll', report)
    }
  }, [])

  // 终端信息就绪后创建原生视图（cols/rows 取自 Host 的真实网格）。
  useEffect(() => {
    const info = state?.info
    if (info === undefined) return
    if (openedFor.current === info.id) return
    openedFor.current = info.id
    if (openNative(info.cols, info.rows)) {
      bridge()?.termViewFocus?.()
      // 原生视图创建时是 1x1/GONE；open 成功后必须立刻把当前矩形再送一次，
      // 否则会一直不可见（ResizeObserver 不会因为视图创建而再次触发）。
      reportRef.current()
      requestAnimationFrame(() => reportRef.current())
    }
  }, [state?.info])

  // 渲染帧：snapshot 先 reset（首帧）再整屏写入；output 增量写入。
  useEffect(() => {
    const render = state?.render
    if (render === undefined || render.revision <= lastRevision.current) return
    lastRevision.current = render.revision
    const frame = render.frame
    // 兜底：极端情况下 render 早于 info（例如恢复会话快照先到），先按默认网格开视图再写。
    if (openedFor.current === undefined) {
      openedFor.current = 'render-first'
      if (openNative(80, 24)) reportRef.current()
    }
    if (frame.type === 'snapshot') {
      bridge()?.termViewOutput?.(textFrameBase64(frame.screen))
    } else if (frame.type === 'output') {
      bridge()?.termViewOutput?.(textFrameBase64(frame.data))
    }
    model.acknowledge(render.revision)
  }, [state?.render, model])

  // 会话状态：未恢复/已不存在/达到上限时不要留一个永远转圈的空面板。
  if (state === undefined) return null
  if (state.issue === 'missingTerminal' || state.issue === 'terminalLimit') {
    const message = state.issue === 'missingTerminal'
      ? '终端已不存在（可能已被关闭或恢复失败）。'
      : '终端数量已达上限，请先关闭不用的终端。'
    return (
      <div style={{ position: 'absolute', inset: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, opacity: 0.8 }}>{message}</p>
        <button
          type="button"
          onClick={() => { (tab as any).actions?.openTab?.(NATIVE_TERMINAL_TAB_KIND, { replaceTab: true }) }}
        >
          新建原生终端
        </button>
      </div>
    )
  }

  // 降级：壳侧未编入原生内核或桥未接线时，给出明确入口去用上游 Web 终端，而不是空白面板。
  if (unavailable) {
    return (
      <div style={{ position: 'absolute', inset: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p style={{ margin: 0, opacity: 0.8 }}>原生终端不可用：当前壳侧未编入原生内核，或 termView 桥未接线。</p>
        {diagnostic.length > 0 ? <p style={{ margin: 0, opacity: 0.6, fontSize: 12 }}>诊断：{diagnostic}</p> : null}
        <button
          type="button"
          onClick={() => { (tab as any).actions?.openTab?.(NATIVE_TERMINAL_TAB_KIND, { replaceTab: true }) }}
        >
          新建原生终端
        </button>
      </div>
    )
  }
  return (
    <div
      ref={stage}
      data-native-terminal-stage=""
      style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
    >
      {state?.info === undefined ? (
        <div style={{ padding: 16, opacity: 0.7 }}>正在创建终端…</div>
      ) : null}
    </div>
  )
}

/** 新建前的 shell 选择（bash/zsh…）；选中后带 shellPath 打开原生终端 tab。 */
function NativeTerminalGuide(props: any): ReactNode {
  const { tab } = props.useTabInfo()
  const [shells, setShells] = useState<any[]>([])
  useEffect(() => {
    const controller = new AbortController()
    props.loadShells(controller.signal).then((choice: any) => {
      setShells(choice.shells ?? [])
    }).catch(() => {})
    return () => controller.abort()
  }, [])
  const open = (path: string): void => {
    if (path.length > 0) props.selectShell(path)
    const params = path.length > 0 ? { shellPath: path } : undefined
    ;(tab as any).actions?.openTab?.(NATIVE_TERMINAL_TAB_KIND, { replaceTab: true, params })
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderRadius: 20, background: '#22252a', color: '#e8e8e8', width: '100%', boxSizing: 'border-box' }}>
      <span style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.85 }}>
        <PluginArtworkTerminal size={24} />
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 14, lineHeight: 1.4 }}>原生终端</span>
        <span style={{ fontSize: 11, lineHeight: 1.4, opacity: 0.6 }}>在侧栏运行 shell，选择 bash 或 zsh</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
        {shells.length === 0 ? <span style={{ fontSize: 11, opacity: 0.6 }}>读取 shell…</span> : shells.map((shell: any) => (
          <button
            key={shell.path}
            type="button"
            onClick={() => open(shell.path)}
            style={{ padding: '6px 12px', borderRadius: 999, border: '1px solid #3a3f46', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12 }}
          >
            {shell.name}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 注册原生终端 tab（与上游 terminal 并存；替换时再禁用上游）。 */
export function registerNativeTerminal(ctx: ClientContext): void {
  ctx.inject(['sidebarRight', 'sidebarRightTabs', 'slots', 'webTerminals'], (scope: any) => {
    const view = (sessionId: string, key: string): any => {
      const occurrence = scope.sidebarRight.tabDomain.occurrence(sessionId, { id: key })
      const navigation = occurrence.navigation.getSnapshot()
      const params = navigation.params
      return scope.webTerminals.view(
        sessionId,
        key,
        navigation.address,
        params !== undefined && 'terminalId' in params ? params.terminalId : undefined,
        params !== undefined && 'shellPath' in params ? params.shellPath : undefined,
      )
    }
    scope.effect(() => scope.sidebarRightTabs.register({
      id: NATIVE_TERMINAL_TAB_ID,
      kind: NATIVE_TERMINAL_TAB_KIND,
      priority: 'extension',
      multiple: true,
      keepMounted: false,
      title: () => '原生终端',
      guide: [{
        id: 'new',
        order: 20,
        title: () => '原生终端',
        description: () => '在侧栏运行 shell（原生渲染；支持触摸滚动与 IME）',
      }],
    } as any), 'ui-responsive.native-terminal.type')
    scope.effect(() => scope.slots.inject('sidebar.right.tab.guide.entry', () => scope.slots.register({
      name: 'sidebar.right.tab.guide.entry',
      key: NATIVE_TERMINAL_TAB_ID,
      inject: (sessionId: string) => ({
        loadShells: (signal: AbortSignal) => scope.webTerminals.launchShells(sessionId, signal),
        selectShell: (path: string) => { scope.webTerminals.selectShell(path) },
      }),
    } as any, NativeTerminalGuide as any)), 'ui-responsive.native-terminal.guide')

    // 关闭 tab 必须同时关闭宿主侧 PTY；否则只是删了 UI tab，后续新开会被终端上限拒绝。
    scope.effect(() => scope.sidebarRight.registerCloseHandler(NATIVE_TERMINAL_TAB_KIND, (sessionId: string, tab: any) => {
      const occurrence = scope.sidebarRight.tabDomain.occurrence(sessionId, { id: tab.id })
      const navigation = occurrence.navigation.getSnapshot()
      const params = navigation.params
      const terminalId = params !== undefined && 'terminalId' in params ? params.terminalId : undefined
      scope.webTerminals.close(sessionId, tab.id, tab.contentId ?? navigation.address, terminalId)
    }), 'ui-responsive.native-terminal.close')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: NATIVE_TERMINAL_TAB_ID,
      inject: (sessionId: string) => ({
        view: (key: string) => view(sessionId, key),
        keyedHooks: { terminal: (key: string) => view(sessionId, key).state },
      }),
    } as any, NativeTerminalBody as any)), 'ui-responsive.native-terminal.body')
  })
}
