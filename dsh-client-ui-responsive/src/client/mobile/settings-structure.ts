/**
 * Publish stable hooks for the pinned rc.1 SettingsRoot cells without changing
 * its navigation, content, labels, icons, or interaction model.
 */
const MOBILE_FORM_ATTR = 'data-dsh-mobile-form'
const PANEL_SELECTOR = '[data-dsh-settings-dialog]'

const STRUCTURE_ATTRIBUTES = [
  'data-dsh-settings-nav-list',
  'data-dsh-settings-content',
  'data-dsh-settings-header',
  'data-dsh-settings-options',
] as const

type SettingsCells = {
  navList: HTMLElement
  content: HTMLElement
  header: HTMLElement
  options: HTMLElement
}

/** The pinned SettingsRoot tree: nav(title, list) beside content(header, options). */
function settingsCells(panel: HTMLElement): SettingsCells | null {
  if (panel.children.length !== 2) return null
  const [nav, content] = [...panel.children]
  if (nav?.tagName !== 'NAV' || content?.tagName !== 'DIV') return null
  if (nav.children.length !== 2 || content.children.length !== 2) return null
  const [title, navList] = [...nav.children]
  const [header, options] = [...content.children]
  if ([title, navList, header, options].some(node => node?.tagName !== 'DIV')) return null
  return {
    navList: navList as HTMLElement,
    content: content as HTMLElement,
    header: header as HTMLElement,
    options: options as HTMLElement,
  }
}

/** Add/remove only CSS hooks; all rendered controls remain owned by DSH. */
export class MobileSettingsStructure {
  private observer: MutationObserver | null = null
  private panel: HTMLElement | null = null
  private attached = false

  attach(): void {
    if (this.attached) return
    this.attached = true
    this.observer = new MutationObserver(this.sync)
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [MOBILE_FORM_ATTR, PANEL_SELECTOR.slice(1, -1)],
    })
    this.sync()
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.observer?.disconnect()
    this.observer = null
    this.release(this.panel)
    this.panel = null
  }

  private readonly sync = (): void => {
    const panel = document.documentElement.hasAttribute(MOBILE_FORM_ATTR)
      ? document.querySelector<HTMLElement>(PANEL_SELECTOR)
      : null
    if (panel !== this.panel) {
      this.release(this.panel)
      this.panel = panel
    }
    if (panel === null) return

    const cells = settingsCells(panel)
    if (cells === null) {
      this.release(panel)
      return
    }
    const tagged = [
      [cells.navList, STRUCTURE_ATTRIBUTES[0]],
      [cells.content, STRUCTURE_ATTRIBUTES[1]],
      [cells.header, STRUCTURE_ATTRIBUTES[2]],
      [cells.options, STRUCTURE_ATTRIBUTES[3]],
    ] as const
    for (const [element, attribute] of tagged) element.setAttribute(attribute, '')
  }

  private release(panel: HTMLElement | null): void {
    if (panel === null) return
    for (const attribute of STRUCTURE_ATTRIBUTES) {
      for (const element of panel.querySelectorAll('[' + attribute + ']')) element.removeAttribute(attribute)
    }
  }
}
