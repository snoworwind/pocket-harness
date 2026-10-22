// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NativeBrowserPlacement } from '../src/client/mobile/native-browser-auto-place.ts'

const KIND = 'android-browser'
const LEGACY_KIND = 'android-browser-legacy'
const UI_TAB = 'ui-a' as TabId

function reply(session: string, tabs: readonly object[] = [], ok = true): string {
  return JSON.stringify({ ok, available: ok, session, profileAvailable: ok, profileReason: '',
    profileIsolation: ok ? 'isolated' : 'unavailable', tabs, activeTabId: '' })
}

function browserTab(session: string, id: TabId) {
  return { sessionId: session as SessionId, tabId: id, kind: KIND }
}

afterEach(() => {
  vi.useRealTimers()
  delete window.androidBridge
  document.documentElement.removeAttribute('data-dsh-browser-pending')
  vi.restoreAllMocks()
})

describe('NativeBrowserPlacement deleted-session cleanup', () => {
  it('closes only the removed session after stable absence and removes its stale sidebar occurrence', () => {
    vi.useFakeTimers()
    let sessions = ['session-a', 'session-b']
    let tabs = [browserTab('session-a', UI_TAB)]
    const closeWorkspace: string[] = []
    window.androidBridge = { browserHostCommand: (raw) => {
      const { action, session } = JSON.parse(raw) as { action: string; session: string }
      if (action === 'workspaceClose') { closeWorkspace.push(session); return reply(session, []) }
      return reply(session, session === 'session-a' ? [
        { tabId: 'native-a', uiTabId: UI_TAB, url: 'https://example.com/', title: 'Example' },
      ] : [])
    } }
    const placement = new NativeBrowserPlacement({
      sessions: () => sessions as SessionId[],
      tabs: () => tabs as never,
      mounted: () => undefined,
      expanded: () => true,
      open: vi.fn(),
      close: (session, tabId) => { tabs = tabs.filter(tab => tab.sessionId !== session || tab.tabId !== tabId) },
      kind: KIND,
      legacyKind: LEGACY_KIND,
    })
    const detach = placement.attach()
    sessions = ['session-b']
    vi.advanceTimersByTime(2000)
    expect(closeWorkspace).toEqual([])
    vi.advanceTimersByTime(1000)

    expect(closeWorkspace).toEqual(['session-a'])
    expect(tabs).toEqual([])
    expect(document.documentElement.hasAttribute('data-dsh-browser-pending')).toBe(false)
    detach()
  })

  it('forgets a transiently absent session before the removal confirmation threshold', () => {
    vi.useFakeTimers()
    let sessions = ['session-a']
    const closeWorkspace = vi.fn((raw: string) => {
      const { action, session } = JSON.parse(raw) as { action: string; session: string }
      return action === 'workspaceClose' ? reply(session, []) : reply(session, [])
    })
    window.androidBridge = { browserHostCommand: closeWorkspace }
    const placement = new NativeBrowserPlacement({
      sessions: () => sessions as SessionId[], tabs: () => [], mounted: () => undefined,
      expanded: () => true, open: vi.fn(), close: vi.fn(), kind: KIND, legacyKind: LEGACY_KIND,
    })
    const detach = placement.attach()
    sessions = []
    vi.advanceTimersByTime(1000)
    sessions = ['session-a']
    vi.advanceTimersByTime(3000)
    expect(closeWorkspace.mock.calls.some(([raw]) => JSON.parse(raw).action === 'workspaceClose')).toBe(false)
    detach()
  })

  it('retries native workspace cleanup after a profile deletion refusal', () => {
    vi.useFakeTimers()
    let sessions = ['session-a']
    let deletionAttempts = 0
    window.androidBridge = { browserHostCommand: (raw) => {
      const { action, session } = JSON.parse(raw) as { action: string; session: string }
      if (action !== 'workspaceClose') return reply(session, [])
      deletionAttempts += 1
      return deletionAttempts === 1 ? reply(session, [], false) : reply(session, [])
    } }
    const placement = new NativeBrowserPlacement({
      sessions: () => sessions as SessionId[], tabs: () => [], mounted: () => undefined,
      expanded: () => true, open: vi.fn(), close: vi.fn(), kind: KIND, legacyKind: LEGACY_KIND,
    })
    const detach = placement.attach()
    sessions = []
    vi.advanceTimersByTime(3000)
    expect(deletionAttempts).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(deletionAttempts).toBe(2)
    detach()
  })
})
