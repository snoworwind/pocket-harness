# dsh-client-ui-responsive design

## Ownership

The upstream DSH client owns the visible application UI: AppFrame, responsive
columns, sidebar controls, conversation header and composer, menus, settings,
message cards, right-panel navigation, and global pages. This plugin does not
recreate or reflow those surfaces. DSH changes should flow through the pinned
upstream components and public services/slots.

The plugin is an Android capability adapter. It adds host-only actions and
settings through DSH slots, connects WebView state to Android bridges, and
renders feature-specific views where Android provides a capability DSH does
not have (the isolated BrowserHost tab and native file-open result surfaces).

## Android boundary

The WebView runs edge-to-edge. `AndroidSurfaceMarker` observes the upstream
`[data-rightbar-col]` anchor and tags only its owning frame with
`data-dsh-android-frame`; it also mirrors the 767px viewport threshold to
`html[data-dsh-mobile-form]` for the narrow-only directory-reference patch.
It does not tag settings, dialogs, columns, or controls.

`android-insets.css.ts` applies the system status-bar inset to the frame
boundary. `composer-insets.css.ts` reserves the system-navigation and IME inset
at the upstream composer seat. `KeyboardBoundary` handles Android WebViews
whose layout viewport does not shrink with the IME. These are the only styles
that change DSH-owned geometry; they do not set grid tracks, positions,
transforms, visibility, or breakpoints for DSH components.

The Android system-back bridge observes accessible modal semantics and DSH
service state, then dismisses the current DSH control or selects the prior
layout panel through `ctx.layout`. It does not inject a back button into DSH
pages. The theme bridge only synchronizes the Android `uiMode` signal when a
WebView fails to update `prefers-color-scheme` itself.

## Additive Android features

- Android display, notification, phone-control, model-capability, and developer
  settings use `settings.section` / `settings.general.item` slots.
- BrowserHost is registered as a right-sidebar tab and follows the official
  sidebar service and tab registry. Its native view is placed over its DSH tab
  viewport and yields to DSH menus, dialogs, and popovers.
- Unsupported file types use an extension-priority open-with tab and the
  Android chooser. Settings-document actions use the same shell chooser.
- Incoming files become an unsent attachment through the DSH conversation
  runtime. Notification taps open the requested Session through the Session
  service.
- Native export completion is reported through the additive export-result
  overlay; it does not hide or restructure upstream dialogs.

## Removed UI overrides

The adapter no longer owns a mobile drawer or sidebar opener; changes DSH's
settings tree; hides DSH controls; changes composer/menu sizing or Enter
behavior; decorates the sidebar with bubble tabs, reorder gestures, or swipe
previews; folds plugin header content; restyles terminal, trajectory, snapshot,
table, or session-log surfaces; or injects navigation buttons into global
panels. Those responsibilities return to DSH's original UI and responsive
behavior.

## Compatibility checks

The UI plugin pins its DSH peer dependencies to the engine version in the
project package manifest. Structural integration is limited to DSH slot/service
contracts plus the `data-rightbar-col`, `data-composer-seat`, and back-layer
accessibility/state hooks. Avoid CSS Module class names and inferred settings
subtrees. When an upstream hook changes, update the corresponding adapter test
and the WebView probe together.

The authoritative current state is the implementation under `src/client/`;
the local README documents the adapter boundary and its public build contract.
