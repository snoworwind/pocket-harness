# DSH native UI alignment

The Android client adapter now leaves the visible DSH interface under upstream
ownership. The mobile drawer, bubble navigation, composer/menu overrides,
settings-tree DOM markers, sidebar gestures, header folding, and injected panel
controls have been removed. Android insets and host bridges remain, along with
additive Android settings and BrowserHost/file features registered through DSH
slots and services.

Regression coverage targets the Android frame boundary, system insets, keyboard
handling, DSH-owned Back layers, settings-document chooser, BrowserHost
presentation, and the retained Android capabilities. The real WebView probe now
checks that the retired layout controls and styles are absent.
