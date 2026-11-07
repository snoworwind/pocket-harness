// @vitest-environment node
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
    expect(nav).toContain('flex: 0 0 clamp(120px, 38vw, 188px)')
    expect(nav).not.toContain('display: none')
    const content = MOBILE_SETTINGS_CSS.split('> [data-dsh-settings-content] {')[1]?.split('}')[0] ?? ''
    expect(content).toContain('flex: 1 1 0')
    expect(content).not.toContain('display: none')
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
