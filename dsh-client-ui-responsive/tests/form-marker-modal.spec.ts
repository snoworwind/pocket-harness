// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { AndroidSurfaceMarker } from '../src/client/mobile/form-marker.ts'

const markers: AndroidSurfaceMarker[] = []
const settle = async (): Promise<void> => { await Promise.resolve() }

function attach(): AndroidSurfaceMarker {
  const marker = new AndroidSurfaceMarker()
  marker.attach()
  markers.push(marker)
  return marker
}

afterEach(() => {
  for (const marker of markers.splice(0)) marker.detach()
  document.documentElement.innerHTML = '<head></head><body></body>'
})

describe('AndroidSurfaceMarker', () => {
  it('publishes only the narrow-viewport fact used by the mobile file patch', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    attach()

    expect(document.documentElement.hasAttribute('data-dsh-mobile-form')).toBe(true)
    expect(document.documentElement.hasAttribute('data-dsh-modal-open')).toBe(false)
    expect(document.querySelector('[data-dsh-settings-dialog]')).toBeNull()
  })

  it('marks the DSH frame for Android insets without changing DSH layout attributes', async () => {
    const frame = document.createElement('div')
    const right = document.createElement('aside')
    right.setAttribute('data-rightbar-col', '')
    frame.append(right)
    document.body.append(frame)

    attach()
    await settle()

    expect(frame.hasAttribute('data-dsh-android-frame')).toBe(true)
    expect(frame.hasAttribute('data-dsh-frame')).toBe(false)
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    expect(frame.querySelector('[data-dsh-settings-dialog]')).toBeNull()
  })

  it('moves the platform marker when DSH replaces its frame', async () => {
    const first = document.createElement('div')
    const right = document.createElement('aside')
    right.setAttribute('data-rightbar-col', '')
    first.append(right)
    document.body.append(first)
    attach()
    await settle()

    const second = document.createElement('div')
    const nextRight = document.createElement('aside')
    nextRight.setAttribute('data-rightbar-col', '')
    second.append(nextRight)
    first.replaceWith(second)
    await settle()

    expect(first.hasAttribute('data-dsh-android-frame')).toBe(false)
    expect(second.hasAttribute('data-dsh-android-frame')).toBe(true)
  })

  it('removes only Android-owned facts on detach', async () => {
    const frame = document.createElement('div')
    const right = document.createElement('aside')
    right.setAttribute('data-rightbar-col', '')
    frame.append(right)
    document.body.append(frame)
    const marker = attach()
    await settle()
    marker.detach()
    markers.splice(markers.indexOf(marker), 1)

    expect(document.documentElement.hasAttribute('data-dsh-mobile-form')).toBe(false)
    expect(frame.hasAttribute('data-dsh-android-frame')).toBe(false)
  })
})
