/**
 * Publish the two facts the Android host adapter still needs:
 * a narrow viewport for the small engine compatibility patch, and the DSH
 * frame root for Android system-inset/IME handling.
 *
 * This marker deliberately does not classify dialogs, settings structure,
 * layout columns or controls. Those remain DSH-owned UI details.
 */
export const MOBILE_FORM_MAX_WIDTH = 767
const MOBILE_FORM_QUERY = `(max-width: ${MOBILE_FORM_MAX_WIDTH}px)`
const MOBILE_FORM_ATTR = 'data-dsh-mobile-form'
const ANDROID_FRAME_ATTR = 'data-dsh-android-frame'

export class AndroidSurfaceMarker {
  private media: MediaQueryList | null = null
  private observer: MutationObserver | null = null
  private frame: HTMLElement | null = null

  attach(): void {
    this.media = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_FORM_QUERY) : null
    this.media?.addEventListener?.('change', this.syncForm)
    this.syncForm()
    this.observer = new MutationObserver(this.syncFrame)
    this.observer.observe(document.documentElement, { childList: true, subtree: true })
    this.syncFrame()
  }

  detach(): void {
    this.media?.removeEventListener?.('change', this.syncForm)
    this.media = null
    this.observer?.disconnect()
    this.observer = null
    this.frame?.removeAttribute(ANDROID_FRAME_ATTR)
    this.frame = null
    document.documentElement.removeAttribute(MOBILE_FORM_ATTR)
  }

  private readonly syncForm = (): void => {
    const matches = this.media === null ? window.innerWidth <= MOBILE_FORM_MAX_WIDTH : this.media.matches
    document.documentElement.toggleAttribute(MOBILE_FORM_ATTR, matches)
  }

  private readonly syncFrame = (): void => {
    const frame = document.querySelector<HTMLElement>('[data-rightbar-col]')?.parentElement ?? null
    if (frame === this.frame) return
    this.frame?.removeAttribute(ANDROID_FRAME_ATTR)
    this.frame = frame
    frame?.setAttribute(ANDROID_FRAME_ATTR, '')
  }
}
