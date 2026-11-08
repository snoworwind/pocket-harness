# dsh-client-ui-responsive

[English README](README.md)

DeepSeek Harness 原版 Web UI 的 Android 能力适配插件。

## UI 所有权

应用框架与响应式布局、两侧栏、设置页、会话标题和输入区、菜单、消息卡片及全局页面均由 DSH 上游负责。本插件不 fork、不重排、不覆盖这些界面，通过 DSH 服务和官方插槽添加 Android 能力。

## Android 接线

| 范围 | 适配内容 |
|---|---|
| 系统界面 | 状态栏/导航栏/输入法 inset、Android WebView 键盘边界、系统深浅色同步 |
| 设置 | 通过官方设置插槽添加 Android 显示、通知、手机控制、模型能力和开发者选项 |
| BrowserHost | 通过官方右侧栏标签注册隔离浏览器；原生内容在 DSH 菜单和对话框出现时让出显示层 |
| 原生文件 | 不支持文件类型的“打开方式”标签、配置文件系统选择器、外部文件经 DSH 会话输入区成为未发送附件草稿 |
| 宿主生命周期 | Android 系统返回层信号、导出结果回调、文件链接当前会话标记、通知会话落点 |

`AndroidSurfaceMarker` 只给 DSH 框架边界添加系统 inset 标记，并发布文件引用兼容补丁使用的窄屏事实；不会识别或标记设置页、对话框、列或控件。

## 构建与挂载

Pocket Harness 会将本插件与匹配版本的 DSH 引擎依赖一同构建。本插件与原版 `ui-layout` 并存，不替换或禁用它。

```yaml
- insert:
    - id: ui-responsive
      name: '@dsh-android/dsh-client-ui-responsive'
- id: open-in-app
  disabled: true
- id: ui-open-in-app
  disabled: true
```

构建后检查 `window.__DSH_BOOT__` 同时包含 `ui-layout` 与 `@dsh-android/dsh-client-ui-responsive`。

## 开发

```sh
node --version       # 要求 ^22.18.0 或 >=24.11.0
npm ci
npm run typecheck
npm run build
npx vitest run
```

浏览器包使用 `__ModuleLoader__.load` 契约；验证运行中服务器前先重建，因为注册表提供的是 `lib/client.js`。

设计说明：[docs/design.md](docs/design.md)。

## 许可

MIT。派生自 `@deepseek-ai/dsh-client-ui-layout`（MIT，© 2026 DeepSeek），详见 NOTICE。
