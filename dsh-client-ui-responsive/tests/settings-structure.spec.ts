// @vitest-environment jsdom
// The phone layout must annotate, not replace, the pinned DSH SettingsRoot UI.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MobileSettingsStructure } from '../src/client/mobile/settings-structure.ts'

function buildPanel(): HTMLElement {
  document.body.innerHTML = ''
  const panel = document.createElement('section')
  panel.setAttribute('data-dsh-settings-dialog', '')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')

  const nav = document.createElement('nav')
  const title = document.createElement('div')
  title.textContent = '设置'
  const list = document.createElement('div')
  for (const label of ['通用设置', '模型', '内置插件']) {
    const row = document.createElement('button')
    row.type = 'button'
    row.textContent = label
    row.addEventListener('click', () => {
      for (const item of list.querySelectorAll('button')) item.removeAttribute('aria-current')
      row.setAttribute('aria-current', 'true')
    })
    list.appendChild(row)
  }
  nav.append(title, list)

  const content = document.createElement('div')
  const header = document.createElement('div')
  const openConfig = document.createElement('button')
  openConfig.textContent = '打开配置文件'
  const close = document.createElement('button')
  close.textContent = '关闭'
  header.append(openConfig, close)
  const options = document.createElement('div')
  const permission = document.createElement('div')
  permission.textContent = '权限'
  const language = document.createElement('div')
  language.textContent = '语言'
  options.append(permission, language)
  content.append(header, options)

  panel.append(nav, content)
  document.body.appendChild(panel)
  return panel
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

let marker: MobileSettingsStructure | undefined

beforeEach(() => {
  document.documentElement.setAttribute('data-dsh-mobile-form', '')
})

afterEach(() => {
  marker?.detach()
  marker = undefined
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-dsh-mobile-form')
})

describe('mobile DSH settings structure hooks', () => {
  it('tags the upstream nav and content cells without adding controls or changing labels', () => {
    const panel = buildPanel()
    const originalText = panel.textContent
    const originalButtons = [...panel.querySelectorAll('button')]
    marker = new MobileSettingsStructure()
    marker.attach()

    expect(panel.querySelector(':scope > nav > div:first-child')?.textContent).toBe('设置')
    expect(panel.querySelector(':scope > nav > [data-dsh-settings-nav-list]')?.children).toHaveLength(3)
    expect(panel.querySelector(':scope > [data-dsh-settings-content] > [data-dsh-settings-header]')?.textContent)
      .toBe('打开配置文件关闭')
    expect(panel.querySelector(':scope > [data-dsh-settings-content] > [data-dsh-settings-options]')?.textContent)
      .toBe('权限语言')
    expect(panel.textContent).toBe(originalText)
    expect([...panel.querySelectorAll('button')]).toEqual(originalButtons)
    expect(panel.querySelector('[data-dsh-settings-bar], [data-dsh-settings-back], [data-dsh-settings-nav-desc]'))
      .toBeNull()

    const category = originalButtons[1]!
    category.click()
    expect(category.getAttribute('aria-current')).toBe('true')
  })

  it('does not annotate settings while the phone layout is inactive', () => {
    document.documentElement.removeAttribute('data-dsh-mobile-form')
    const panel = buildPanel()
    marker = new MobileSettingsStructure()
    marker.attach()
    expect(panel.querySelector('[data-dsh-settings-nav-list]')).toBeNull()
    expect(panel.children).toHaveLength(2)
  })

  it('fails open when the pinned upstream structure changes', async () => {
    const panel = buildPanel()
    marker = new MobileSettingsStructure()
    marker.attach()
    expect(panel.querySelector('[data-dsh-settings-options]')).not.toBeNull()

    panel.querySelector(':scope > [data-dsh-settings-content] > div:last-child')!.remove()
    await settle()
    expect(panel.querySelector('[data-dsh-settings-nav-list], [data-dsh-settings-content], [data-dsh-settings-header], [data-dsh-settings-options]'))
      .toBeNull()
  })

  it('retags replacement React nodes and removes every hook on detach', async () => {
    const panel = buildPanel()
    marker = new MobileSettingsStructure()
    marker.attach()

    const replacement = document.createElement('nav')
    replacement.innerHTML = '<div>设置</div><div><button>通用设置</button></div>'
    panel.querySelector(':scope > nav')!.replaceWith(replacement)
    await settle()
    expect(replacement.querySelector('[data-dsh-settings-nav-list]')).not.toBeNull()

    marker.detach()
    marker = undefined
    expect(panel.querySelector('[data-dsh-settings-nav-list], [data-dsh-settings-content], [data-dsh-settings-header], [data-dsh-settings-options]'))
      .toBeNull()
  })
})
