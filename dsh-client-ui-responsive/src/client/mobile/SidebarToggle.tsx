/**
 * The phone drawer opener in the upstream conversation header.
 *
 * The upstream SidebarRoot keeps its own toggle inside the sidebar rail. On a
 * phone the sidebar is an off-canvas drawer, so this header control opens it;
 * once open, the in-drawer toggle remains the one control for closing it.
 */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { BROWSER_PENDING_ATTR } from './browser-auto-place.ts'
import css from './MobileChrome.module.css'

const TOGGLE_OPEN = '打开导航'
const TOGGLE_CLOSE = '关闭导航'

export interface SidebarToggleInjected {
  toggleSidebar(): void
}

export type SidebarToggleProps =
  & PropsRuntime<'conversation.header.leading'>
  & InjectFace<SidebarToggleInjected>

function frameElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-dsh-frame]')
    ?? document.querySelector<HTMLElement>('[data-rightbar-col]')?.parentElement
    ?? null
}

/** The settings overlay pins the collapsed drawer open, so its rail owns close. */
function drawerVisible(frame: HTMLElement | null): boolean {
  return frame !== null && (
    !frame.hasAttribute('data-sidebar-collapsed')
    || document.documentElement.hasAttribute('data-dsh-settings-open')
  )
}

function useSidebarOpen(): boolean {
  const [open, setOpen] = useState(() => drawerVisible(frameElement()))
  useEffect(() => {
    let frame: HTMLElement | null = null
    let frameObserver: MutationObserver | null = null
    const sync = (): void => { setOpen(drawerVisible(frame)) }
    const bindFrame = (): boolean => {
      frame = frameElement()
      if (frame === null) return false
      frameObserver = new MutationObserver(sync)
      frameObserver.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
      sync()
      return true
    }
    const settingsObserver = new MutationObserver(sync)
    settingsObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-dsh-settings-open'],
    })
    let waitingObserver: MutationObserver | null = null
    if (!bindFrame()) {
      waitingObserver = new MutationObserver(() => {
        if (bindFrame()) waitingObserver?.disconnect()
      })
    }
    waitingObserver?.observe(document.documentElement, { childList: true, subtree: true })
    return () => {
      waitingObserver?.disconnect()
      frameObserver?.disconnect()
      settingsObserver.disconnect()
    }
  }, [])
  return open
}

function useBrowserPending(): boolean {
  const [pending, setPending] = useState(false)
  useEffect(() => {
    const sync = (): void => { setPending(document.documentElement.hasAttribute(BROWSER_PENDING_ATTR)) }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [BROWSER_PENDING_ATTR] })
    return () => { observer.disconnect() }
  }, [])
  return pending
}

export function SidebarToggle({ toggleSidebar }: SidebarToggleProps) {
  const open = useSidebarOpen()
  const browserPending = useBrowserPending()
  if (open) return null
  return (
    <>
      <button
        type="button"
        className={css.toggle}
        data-dsh-sidebar-toggle=""
        aria-label={browserPending ? TOGGLE_OPEN + '（有一个浏览器标签在等你展开侧栏）' : TOGGLE_OPEN}
        aria-expanded="false"
        onClick={() => { toggleSidebar() }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path d="M2.5 4.5h13M2.5 9h13M2.5 13.5h13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        {browserPending && <span className={css.badge} data-dsh-browser-badge="pending" aria-hidden="true" />}
      </button>
      {browserPending && (
        <span className={css.pendingHint} data-dsh-browser-pending-hint="">
          有浏览器标签待展开
        </span>
      )}
    </>
  )
}
