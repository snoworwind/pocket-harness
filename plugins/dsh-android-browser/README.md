# `@dsh-android/dsh-android-browser`

Pocket Harness' isolated BrowserHost plugin. It exposes browser tools to the model and reports BrowserHost capabilities to the app's file sidebar. Source, package metadata, and the current plugin mount live in this repository.

## What it provides

- Browser tools: capability/tier inspection, open, snapshot, click, type, press, scroll, text lookup, wait, navigation, tab listing/follow/close, identity selection, viewport selection, and screenshot.
- A read-only `GET /api/android/browser/status` endpoint used by the sidebar. The endpoint is registered with the engine web server and enforces the route's authentication and loopback origin checks.
- A native BrowserHost WebView separate from the primary engine WebView. The page sidebar selects its stage and viewport; the host is not given the main WebView's JavaScript bridge.
- Per-session browser state, with compatibility-mode behavior on WebView providers that do not support multi-profile storage. That mode shares the Default cookie jar and is surfaced as reduced isolation.

## Source of truth

| Concern | File |
|---|---|
| Tool names, arguments, permission tiers and outputs | [`src/contract.ts`](src/contract.ts) |
| Cordis registration and authenticated status route | [`src/index.ts`](src/index.ts) |
| Tool handlers and BrowserHost calls | [`src/tools.ts`](src/tools.ts) |
| Tier and provider capability detection | [`src/tier.ts`](src/tier.ts) |
| Sidebar and native BrowserHost integration | `dsh-client-ui-responsive` and app `BrowserHost` / `AndroidBridge` |

The package is mounted by the local source profile. Do not infer whether it is included from this README; inspect `scripts/profile-web.cordis.patch.yml` and `package.json` when changing the source build.

## Current limits and acceptance

Desktop identity emulation can be detected by sites when User-Agent Client Hints or other platform signals are unavailable. Compatibility mode shares cookies by design. Cross-origin iframe control depends on the WebView's debugging/attachment support. These are capability limits, not proof of device acceptance.

The 0.14.10 candidate has not completed CDP, ADB user-operation, landscape, or ARM64 device acceptance. See [`release/v0.14.10/notes.md`](../../release/v0.14.10/notes.md) for the candidate boundary and [`docs/AGENTS/known-gaps.md`](../../docs/AGENTS/known-gaps.md) for open device work.
