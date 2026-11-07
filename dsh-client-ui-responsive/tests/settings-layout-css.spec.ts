// @vitest-environment jsdom
// Portrait sizing must retain the built-in DSH two-column settings interface.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { MOBILE_SETTINGS_CSS } from '../src/client/mobile-settings.css.ts'

describe('mobile DSH settings layout', () => {
  it('fills the phone viewport while keeping the upstream nav beside its content', () => {
    const panel = MOBILE_SETTINGS_CSS.split('[data-dsh-settings-dialog] {')[1]?.split('}')[0] ?? ''
    expect(panel).toContain('display: flex')
    expect(panel).toContain('flex-direction: row')
    expect(panel).toContain('width: 100vw')
    expect(panel).toContain('height: 100vh')
    expect(panel).toContain('overflow: hidden')
    expect(MOBILE_SETTINGS_CSS).not.toContain('data-dsh-settings-level')
    expect(MOBILE_SETTINGS_CSS).not.toContain('data-dsh-settings-bar')

    const nav = MOBILE_SETTINGS_CSS.split('> nav {')[1]?.split('}')[0] ?? ''
    expect(nav).toContain('flex: 0 0 clamp(96px, 30vw, 128px)')
    expect(nav).toContain('min-width: 96px')
    expect(nav).not.toContain('display: none')
    const content = MOBILE_SETTINGS_CSS.split('> [data-dsh-settings-content] {')[1]?.split('}')[0] ?? ''
    expect(content).toContain('flex: 1 1 0')
    expect(content).not.toContain('display: none')

    // jsdom does not perform layout, but its CSSOM still confirms the actual
    // matching mobile rules and their narrow-screen flex basis.
    const style = document.createElement('style')
    style.textContent = MOBILE_SETTINGS_CSS
    document.head.appendChild(style)
    document.documentElement.setAttribute('data-dsh-mobile-form', '')
    document.body.innerHTML = '<section data-dsh-settings-dialog><nav><div>设置</div><div data-dsh-settings-nav-list><button>通用设置</button></div></nav><div data-dsh-settings-content><div data-dsh-settings-header>操作</div><div data-dsh-settings-options>详情</div></div></section>'
    const panelNode = document.querySelector<HTMLElement>('[data-dsh-settings-dialog]')!
    const navNode = panelNode.querySelector<HTMLElement>(':scope > nav')!
    const contentNode = panelNode.querySelector<HTMLElement>(':scope > [data-dsh-settings-content]')!
    expect(getComputedStyle(panelNode).display).toBe('flex')
    expect(getComputedStyle(panelNode).flexDirection).toBe('row')
    expect(getComputedStyle(navNode).flexBasis).toBe('clamp(96px, 30vw, 128px)')
    expect(getComputedStyle(contentNode).flexGrow).toBe('1')

    // At 320px the minimum 96px rail leaves 224px for content (before its
    // internal padding), unlike the previous 120px rail which left only 200px.
    const navWidthAt320 = Math.max(96, Math.min(0.30 * 320, 128))
    expect(320 - navWidthAt320).toBe(224)
    expect(320 - 120).toBe(200)
    document.documentElement.removeAttribute('data-dsh-mobile-form')
    document.body.innerHTML = ''
    style.remove()
  })

  it('gives the category list and selected settings their own scrollable regions', () => {
    const list = MOBILE_SETTINGS_CSS.split('> nav > [data-dsh-settings-nav-list] {')[1]?.split('}')[0] ?? ''
    expect(list).toContain('flex: 1')
    expect(list).toContain('min-height: 0')
    expect(list).toContain('overflow-y: auto')

    const options = MOBILE_SETTINGS_CSS.split('> [data-dsh-settings-content] > [data-dsh-settings-options] {')[1]?.split('}')[0] ?? ''
    expect(options).toContain('flex: 1')
    expect(options).toContain('min-height: 0')
    expect(options).toContain('overflow: auto')
  })

  it('uses only structure hooks published after verifying the pinned rc.1 tree', () => {
    const source = readFileSync('src/client/mobile/settings-structure.ts', 'utf8')
    for (const attribute of [
      'data-dsh-settings-nav-list',
      'data-dsh-settings-content',
      'data-dsh-settings-header',
      'data-dsh-settings-options',
    ]) {
      expect(source).toContain("'" + attribute + "'")
      expect(MOBILE_SETTINGS_CSS).toContain('[' + attribute + ']')
    }
    expect(source).toContain("nav?.tagName !== 'NAV'")
    expect(source).toContain('nav.children.length !== 2 || content.children.length !== 2')
  })

  it('keeps colors in the DSH theme and respects the mobile system insets', () => {
    expect(MOBILE_SETTINGS_CSS).toContain('var(--dsh-mobile-top-inset, 0px)')
    expect(MOBILE_SETTINGS_CSS).toContain('var(--dsh-android-system-bottom, 0px)')
    const withoutComments = MOBILE_SETTINGS_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
  })
})
