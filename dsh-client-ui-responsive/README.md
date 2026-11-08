# dsh-client-ui-responsive

[中文说明](README.zh.md)

Android capability adapter for the original [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
web interface.

## UI ownership

DSH owns the application frame and its responsive behavior, sidebars, settings,
conversation header and composer, menus, message cards, and global pages. This
plugin does not fork, restyle, or re-layout those surfaces. Android additions
are registered through DSH services and slots.

## Android integration

| Area | Adapter contribution |
|---|---|
| System chrome | Status/navigation/IME insets, the Android WebView keyboard boundary, and OS theme synchronization |
| Settings | Android display, notifications, phone controls, model capability, and developer options through official settings slots |
| BrowserHost | Android isolated browser tab in the official right-sidebar tab registry; native content yields to DSH menus and dialogs |
| Native files | Open-with tab for unsupported file types, settings-document chooser, and external files added as unsent DSH attachment drafts |
| Host lifecycle | System Back layer signal, export-result callback, current Session marker for file links, and notification Session routing |

`AndroidSurfaceMarker` only marks the DSH frame boundary for system insets and
publishes a narrow-viewport fact used by the file-reference compatibility
patch. It does not inspect or tag settings, dialogs, columns, or controls.

## Source and install

Pocket Harness builds this plugin with the matching DSH engine dependencies.
The plugin remains mounted beside the original `ui-layout`; it does not replace
or disable that package.

```yaml
- insert:
    - id: ui-responsive
      name: '@dsh-android/dsh-client-ui-responsive'
- id: open-in-app
  disabled: true
- id: ui-open-in-app
  disabled: true
```

After the build, verify `window.__DSH_BOOT__` contains both `ui-layout` and
`@dsh-android/dsh-client-ui-responsive`.

## Development

```sh
node --version       # requires ^22.18.0 or >=24.11.0
npm ci
npm run typecheck
npm run build
npx vitest run
```

The browser bundle uses the `__ModuleLoader__.load` contract; rebuild before
probing a live server because the registry serves `lib/client.js`.

Design rationale: [docs/design.md](docs/design.md).

## License

MIT. Derived from `@deepseek-ai/dsh-client-ui-layout` (MIT, © 2026 DeepSeek) —
see NOTICE.
