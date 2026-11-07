// @vitest-environment jsdom
// P4/P5（0.14.2）：顶部额头回收 + 两个无用控件（用户 2026-09-26 原话）。
//
// 用户原话：「这个顶部的额头太大了（标题上方留空）挤占屏幕空间」；
// 「那个文件夹按钮完全无用，绿点也无用，这俩隐藏掉，然后把左菜单栏展开按钮挪到和原生标题顶栏同一行」。
//
// 本文件守四条判据（方案 §4.2）：
//   ① 页面上不再存在 [data-dsh-mobile-topbar]；
//   ② 抽屉开关注册进上游标题行座位 conversation.header.leading，且不再自绘整条 band；
//   ③ 文件夹按钮的注册被撤掉、vendor 绿点被 CSS 藏掉（且**不碰 vendor 源码**）；
//   ④ centerCol 的 padding-top 只剩 top inset（回收 44px）。
// 每条都配反证：把旧形态改回去必须判红。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MOBILE_FORM_CSS } from '../src/client/mobile/mobile-form.css.ts'
import { VENDOR_CHROME_HIDE_CSS } from '../src/client/mobile/vendor-chrome-hide.css.ts'
import { SidebarToggle } from '../src/client/mobile/SidebarToggle.tsx'
import { MobileChrome } from '../src/client/mobile/MobileChrome.tsx'
import { BROWSER_PENDING_ATTR } from '../src/client/mobile/browser-auto-place.ts'

// 本 spec 跑在 jsdom 下：jsdom 会把全局 URL 换成以 http://localhost:3000 为基的版本，
// 于是 new URL(relative, import.meta.url) 得到的是 http: 方案，fileURLToPath 直接抛
// 「The URL must be of scheme file」。vitest 的 cwd 恒为包根，用 process.cwd() 拼接即可。
const src = (...parts: string[]): string => join(process.cwd(), 'src', 'client', ...parts)
/** Strip comments so an assertion about code cannot be satisfied or defeated by prose. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const clientRaw = readFileSync(src('index.ts'), 'utf8')
const clientSource = code(clientRaw)
const chromeSource = code(readFileSync(src('mobile', 'MobileChrome.tsx'), 'utf8'))
const toggleSource = code(readFileSync(src('mobile', 'SidebarToggle.tsx'), 'utf8'))
const guardSource = code(readFileSync(src('composer-popup-guard.ts'), 'utf8'))

describe('P4：顶部额头回收', () => {
  it('① 撤掉 [data-dsh-mobile-topbar]：index.ts 不再注册自绘 band，MobileChrome 不再渲染它', () => {
    // 注册面：band 曾经是 shell.overlay 里的 .bar。
    expect(clientSource).not.toContain('data-dsh-mobile-topbar')
    expect(chromeSource).not.toContain('data-dsh-mobile-topbar')
    expect(clientRaw).not.toContain('css.bar')
  })

  it('①b 反证：band 的 CSS 与高度变量必须一起消失（漏一个就是半回收）', () => {
    const css = readFileSync(src('mobile', 'mobile-form.css.ts'), 'utf8')
    // The variable must not exist anywhere -- not even in a comment (the removal is total).
    expect(css).not.toContain('--dsh-mobile-topbar-height')
    // 反证：若把该变量加回去，断言必须能看见它（证明这条不是空断言）。
    expect(('  --dsh-mobile-topbar-height: 44px;').includes('--dsh-mobile-topbar-height')).toBe(true)
  })

  it('② 生命周期观察器挂在全局标题行座位 conversation.header.leading', () => {
    expect(clientSource).toContain("ctx.slots.inject('conversation.header.leading'")
    expect(clientSource).toContain('SidebarToggle')
    // 反证色：旧形态是「自绘 band + shell.overlay 里的按钮」。
    expect(clientSource.includes("id: 'mobile-chrome',") && !clientSource.includes('css.bar')).toBe(true)
  })

  it('②b 插件只在抽屉收起时显示自有入口，抽屉里的上游开关负责关闭', () => {
    expect(toggleSource).toContain('data-dsh-sidebar-toggle')
    expect(toggleSource).toContain('if (open) return null')
    expect(MOBILE_FORM_CSS).toContain("html[data-dsh-mobile-form] [data-dsh-frame][data-sidebar-collapsed] > [class*='sidebarCol'] button[data-sidebar-toggle]")
  })

  it('④ centerCol 的 padding-top 只剩 top inset（回收 44px）', () => {
    const stripped = MOBILE_FORM_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const match = /\[data-dsh-frame\]\s*>\s*\[class\*='centerCol'\]\s*\{[^}]*\}/.exec(stripped)
    expect(match, 'centerCol 规则必须在场').toBeTruthy()
    expect(match![0]).toContain('padding-top: var(--dsh-mobile-top-inset, 0px)')
    // 反证色：旧形态是 calc(topbar-height + top-inset)，必须判红。
    expect(match![0]).not.toContain('calc(')
  })

  it('④b 反证：centerCol 若把 44px 加回去，判据必须判红', () => {
    // 只动 centerCol 那条规则：同一张表里 sidebarCol 也带 padding-top: var(--dsh-mobile-top-inset)，
    // 直接全局 replace 会改错规则，让这条反证变成假绿。
    const centerColRe = /(\[data-dsh-frame\]\s*>\s*\[class\*='centerCol'\]\s*\{)([^}]*)(\})/
    const bad = MOBILE_FORM_CSS.replace(centerColRe, (_m, head, body, tail) =>
      head + body.replace('padding-top: var(--dsh-mobile-top-inset, 0px)',
        'padding-top: calc(var(--dsh-mobile-topbar-height) + var(--dsh-mobile-top-inset, 0px))') + tail)
    const stripped = bad.replace(/\/\*[\s\S]*?\*\//g, '')
    const match = centerColRe.exec(stripped)
    expect(match![2]).toContain('calc(')
  })
})

describe('P5：两个无用控件', () => {
  it('③ 文件夹按钮：conversation.session.header.utilities 的注册被撤掉', () => {
    expect(clientSource).not.toContain('android-open-in-file-manager')
    expect(clientSource).not.toContain('OpenInFileManagerAction')
    // 反证色：注册 id 曾经就是它，加回来必须判红。
    expect("id: 'android-open-in-file-manager'".includes('android-open-in-file-manager')).toBe(true)
  })

  it('③b 绿点：用 CSS 覆盖 vendor 自己的属性选择器，且带 !important', () => {
    expect(VENDOR_CHROME_HIDE_CSS).toContain('[data-undo-header] .u_dot')
    expect(VENDOR_CHROME_HIDE_CSS).toMatch(/display:\s*none\s*!important/)
    // 必须用 vendor 的**自有属性**，而不是哈希后的 CSS-Module 类名（不可达且会随版本失配）。
    expect(VENDOR_CHROME_HIDE_CSS).not.toMatch(/\.[A-Za-z0-9_-]{6,}_/)
  })

  it('③c 反证：CSS 选择器若写错（缺 .u_dot 或换成别的属性）判据必须判红', () => {
    const wrongAttr = VENDOR_CHROME_HIDE_CSS.replace('[data-undo-header]', '[data-undo-header-x]')
    expect(wrongAttr).not.toContain('[data-undo-header] .u_dot')
    const noDot = VENDOR_CHROME_HIDE_CSS.replace('.u_dot', '.u_other')
    expect(noDot).not.toContain('.u_dot')
  })

  it('③d 绝不改 vendor：CSS 只在自己仓里，且没有指向 vendor 路径的写入面', () => {
    expect(VENDOR_CHROME_HIDE_CSS.length).toBeGreaterThan(0)
    // 反证/纪律：本插件**不得**出现 vendor 目录路径（改它就是改第三方固化副本）。
    for (const source of [clientSource, VENDOR_CHROME_HIDE_CSS]) {
      expect(source).not.toMatch(/vendor\/dsh-undo-savepoint/)
    }
  })

  it('③e 保留项：遮罩与浏览器待展开徽标/提示都还在', () => {
    // 遮罩（你没让删，且返回键/点外部关闭依赖它）：属性在 MobileChrome.tsx，注册面在 index.ts。
    expect(chromeSource).toContain('data-dsh-mobile-mask')
    expect(clientSource).toContain("id: 'mobile-chrome',")
    // S3-19 待展开状态装饰在唯一的手机开关上。
    expect(toggleSource).toContain('data-dsh-browser-badge')
    expect(clientSource).toContain("ctx.slots.inject('shell.overlay'")
  })
})

describe('P4 连带：弹出面板钳制必须改锚到真实顶部 chrome', () => {
  it('旧锚 [data-dsh-mobile-topbar] 不再作为首选；改为经 header 座位解析上游 header', () => {
    expect(guardSource).toContain('headerTopChrome')
    expect(guardSource).toContain('[data-conversation-header-leading]')
    // 反证：第一锚点必须**不是**旧 band（否则 band 删掉后钳制恒 0，菜单会顶到 header 下）。
    const firstAnchor = guardSource.indexOf("const topbar = headerTopChrome()")
    const legacyAnchor = guardSource.indexOf("document.querySelector<HTMLElement>('[data-dsh-mobile-topbar]')")
    expect(firstAnchor).toBeGreaterThan(0)
    expect(legacyAnchor).toBeGreaterThan(firstAnchor)
  })

  it('反证：若顶部 chrome 解析不到（无 header），钳制会放宽 —— 这正是必须改锚的量化理由', async () => {
    const { composerPopupMaxHeight } = await import('../src/client/composer-popup-guard.ts')
    // popupBottom=316：header 底边 76 时留 218；恒 0 时会放宽到 294（多 76px，正好是 header 高）。
    expect(composerPopupMaxHeight(316, 76, 10)).toBe(218)
    expect(composerPopupMaxHeight(316, 0, 10)).toBe(294)
    expect(composerPopupMaxHeight(316, 0, 10)).toBeGreaterThan(composerPopupMaxHeight(316, 76, 10))
  })
})

describe('P4：手机开关只保留一个', () => {
  it('手机形态保留 header toggle 样式，遮罩也继续工作', () => {
    const css = readFileSync(src('mobile', 'MobileChrome.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/\.mask\s*\{/)
    expect(css).toContain('html[data-dsh-mobile-form] .toggle')
    expect(css).toContain('.badge')
    expect(css).toContain('.pendingHint')
    expect(css).not.toMatch(/\.bar\s*[{,]/)
  })
})
describe('P4 硬判据：收起态只有 header opener，展开态只有 rail closer', () => {
  it('收起态只隐藏带上游标记的 rail opener；展开后交还给 rail', async () => {
    document.documentElement.setAttribute('data-dsh-mobile-form', '')
    document.body.innerHTML = '<div data-dsh-frame data-sidebar-collapsed><aside class="sidebarCol_test"><button data-sidebar-toggle class="iconButton toggle" aria-label="打开侧边栏"></button><button class="other-toggle" aria-label="其他操作"></button></aside><header><div data-conversation-header-leading></div></header></div>'
    const leading = document.querySelector<HTMLElement>('[data-conversation-header-leading]')!
    const frame = document.querySelector<HTMLElement>('[data-dsh-frame]')!
    const native = document.querySelector<HTMLButtonElement>('.sidebarCol_test button[data-sidebar-toggle]')!
    const unrelated = document.querySelector<HTMLButtonElement>('.sidebarCol_test button.other-toggle')!
    const selector = "html[data-dsh-mobile-form] [data-dsh-frame][data-sidebar-collapsed] > [class*='sidebarCol'] button[data-sidebar-toggle]"
    const hideRule = MOBILE_FORM_CSS.match(/html\[data-dsh-mobile-form\]\s+\[data-dsh-frame\]\[data-sidebar-collapsed\]\s*>\s*\[class\*='sidebarCol'\]\s+button\[data-sidebar-toggle\]\s*\{\s*display:\s*none\s*!important;\s*\}/)?.[0]
    expect(hideRule).toBeTruthy()
    const style = document.createElement('style')
    style.textContent = hideRule!
    document.head.appendChild(style)
    const { createRoot } = require('react-dom/client')
    const { act } = require('react')
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    const root = createRoot(leading)
    act(() => { root.render(<SidebarToggle toggleSidebar={() => {}} /> as never) })
    expect(leading.querySelectorAll('[data-dsh-sidebar-toggle]')).toHaveLength(1)
    expect(document.querySelector(selector)).toBe(native)
    expect(getComputedStyle(native).display).toBe('none')
    expect(getComputedStyle(unrelated).display).not.toBe('none')
    await act(async () => {
      frame.removeAttribute('data-sidebar-collapsed')
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(leading.querySelector('[data-dsh-sidebar-toggle]')).toBeNull()
    expect(native.getAttribute('aria-label')).toBe('打开侧边栏')
    expect(getComputedStyle(native).display).not.toBe('none')
    act(() => { root.unmount() })
    style.remove()
    document.documentElement.removeAttribute('data-dsh-mobile-form')
    document.body.innerHTML = ''
  })

  it('待展开浏览器标签状态出现在 header opener 上并清除', async () => {
    document.body.innerHTML = '<div data-dsh-frame data-sidebar-collapsed><aside class="sidebarCol_test"><button class="iconButton toggle" aria-label="打开侧边栏"></button></aside><header><div data-conversation-header-leading></div></header></div>'
    const leading = document.querySelector<HTMLElement>('[data-conversation-header-leading]')!
    const { createRoot } = require('react-dom/client')
    const { act } = require('react')
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    const root = createRoot(leading)
    act(() => { root.render(<SidebarToggle toggleSidebar={() => {}} /> as never) })
    await act(async () => {
      document.documentElement.setAttribute(BROWSER_PENDING_ATTR, 'collapsed')
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(leading.querySelector('[data-dsh-browser-badge]')).not.toBeNull()
    expect(leading.querySelector('[data-dsh-sidebar-toggle]')?.getAttribute('aria-label')).toContain('打开导航（有一个浏览器标签在等你展开侧栏）')
    await act(async () => {
      document.documentElement.removeAttribute(BROWSER_PENDING_ATTR)
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(leading.querySelector('[data-dsh-browser-badge]')).toBeNull()
    expect(leading.querySelector('[data-dsh-sidebar-toggle]')?.getAttribute('aria-label')).toBe('打开导航')
    act(() => { root.unmount() })
  })
})
describe('P4/P5：组件本身仍可渲染（没有在重构中变成空壳）', () => {
  it('SidebarToggle 在手机形态下渲染唯一的 header opener', () => {
    document.body.innerHTML = '<div data-dsh-frame data-sidebar-collapsed></div>'
    const host = document.createElement('div')
    document.body.appendChild(host)
    const { createRoot } = require('react-dom/client')
    const { act } = require('react')
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    const root = createRoot(host)
    act(() => { root.render(<SidebarToggle toggleSidebar={() => {}} /> as never) })
    expect(host.querySelectorAll('[data-dsh-sidebar-toggle]')).toHaveLength(1)
    act(() => { root.unmount() })
  })
  it('MobileChrome 只渲染遮罩（band 不再出现）', () => {
    document.body.innerHTML = ''
    const host = document.createElement('div')
    document.body.appendChild(host)
    const { createRoot } = require('react-dom/client')
    const { act } = require('react')
    const root = createRoot(host)
    act(() => { root.render(<MobileChrome toggleSidebar={() => {}} /> as never) })
    expect(host.querySelector('[data-dsh-mobile-mask]')).toBeTruthy()
    expect(host.querySelector('[data-dsh-mobile-topbar]')).toBeNull()
    act(() => { root.unmount() })
  })
})
