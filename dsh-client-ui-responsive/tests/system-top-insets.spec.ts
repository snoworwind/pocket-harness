import { describe, expect, it } from 'vitest'
import { ANDROID_INSETS_CSS } from '../src/client/mobile/android-insets.css.ts'
import { COMPOSER_INSETS_CSS } from '../src/client/composer-insets.css.ts'

describe('Android edge-to-edge insets', () => {
  it('insets the DSH-owned frame boundary through its padding edge and preserves grid tracks', () => {
    const css = ANDROID_INSETS_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toContain('[data-dsh-android-frame]')
    expect(css).toContain('box-sizing: border-box')
    // A transparent top border (not padding) moves the padding edge itself, so the
    // absolutely positioned mobile drawer seat (upstream: top:11px) is offset too.
    expect(css).toContain('border-top: var(--dsh-android-top-inset, 0px) solid transparent')
    expect(css).not.toContain('padding-top')
    expect(css).not.toContain('grid-template')
    expect(css).not.toContain('position:')
    expect(css).not.toContain('transform:')
    expect(css).not.toContain('sidebarCol')
    expect(css).not.toContain('centerCol')
  })

  it('uses system/safe-area values at the top and system/IME values at the composer', () => {
    expect(ANDROID_INSETS_CSS).toContain('env(safe-area-inset-top, 0px)')
    expect(ANDROID_INSETS_CSS).toContain('var(--dsh-android-system-top, 0px)')
    expect(COMPOSER_INSETS_CSS).toContain('env(safe-area-inset-bottom, 0px)')
    expect(COMPOSER_INSETS_CSS).toContain('var(--dsh-android-system-bottom, 0px)')
    expect(COMPOSER_INSETS_CSS).toContain('var(--dsh-android-ime-bottom, 0px)')
  })
})
