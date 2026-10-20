/** Visibility rules shared by the virtual-display viewer's native surface publisher. */

const BLOCKING_OVERLAY_SELECTOR = '[role="menu"], [role="dialog"], [aria-modal="true"], [role="listbox"]'
const SIDEBAR_BUBBLES_SELECTOR = '[data-dsh-sidebar-bubbles="open"], [data-dsh-sidebar-bubbles="closing"]'

/** True while a visible DOM surface owns interaction above the native virtual-display surface. */
export function hasBlockingStageOverlay(doc: Document, view: Window): boolean {
  if (doc.querySelector(SIDEBAR_BUBBLES_SELECTOR) !== null || doc.querySelector('[data-dockkit-pointer]') !== null) return true

  return Array.from(doc.querySelectorAll<HTMLElement>(BLOCKING_OVERLAY_SELECTOR)).some((element) => {
    const bounds = element.getBoundingClientRect()
    if (bounds.right <= 0 || bounds.bottom <= 0 || bounds.left >= view.innerWidth || bounds.top >= view.innerHeight) return false

    for (let ancestor: HTMLElement | null = element; ancestor !== null; ancestor = ancestor.parentElement) {
      const style = view.getComputedStyle(ancestor)
      if (ancestor.hidden || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    }

    const style = view.getComputedStyle(element)
    return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' &&
      style.visibility !== 'hidden' && style.opacity !== '0'
  })
}

/** Publish visibility changes on the next frame; the caller retains its polling fallback. */
export function watchStageVisibility(doc: Document, view: Window, publish: () => void): () => void {
  let queued = 0
  const schedule = (): void => {
    if (queued !== 0) return
    queued = view.requestAnimationFrame(() => { queued = 0; publish() })
  }
  const Observer = (view as Window & { MutationObserver?: typeof MutationObserver }).MutationObserver
  const observer = typeof Observer === 'undefined' ? null : new Observer(schedule)
  try {
    const root = doc.documentElement
    if (root !== null) {
      observer?.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        // Watch visibility sources and the attributes that can introduce or dismiss an overlay.
        attributeFilter: [
          'style', 'class', 'hidden', 'open', 'aria-hidden', 'aria-modal', 'role',
          'data-sidebar-right-open', 'data-sidebar-right-collapsed', 'data-dockkit-pointer',
          'data-dsh-sidebar-bubbles',
        ],
      })
    }
  } catch {
    /* Polling and lifecycle events remain available if observation cannot attach. */
  }
  doc.addEventListener('visibilitychange', schedule)
  return () => {
    if (queued !== 0) view.cancelAnimationFrame(queued)
    queued = 0
    observer?.disconnect()
    doc.removeEventListener('visibilitychange', schedule)
  }
}
