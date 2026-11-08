/**
 * Android edge-to-edge insets for the DSH-owned application frame.
 *
 * The top inset must move BOTH the in-flow grid (header, columns, composer) and
 * the absolutely positioned chrome. Upstream's mobile drawer opener lives in
 * `.leadingSeat` (`position: absolute; top: 11px`), whose offsets resolve against
 * the frame's *padding box*: `padding-top` shifts in-flow content but leaves the
 * absolute seat at the physical top, so the sidebar button sits inside the status
 * bar while the title row and right-hand actions are correctly offset (measured
 * on 0.14.12 / WebView 114). A transparent top border moves the padding edge
 * itself, so one declaration covers both cases without touching grid tracks,
 * positions or transforms.
 */
export const ANDROID_INSETS_CSS = `
:root {
  --dsh-android-top-inset: max(
    env(safe-area-inset-top, 0px),
    var(--dsh-android-system-top, 0px)
  );
}

[data-dsh-android-frame] {
  box-sizing: border-box;
  border-top: var(--dsh-android-top-inset, 0px) solid transparent;
}
`
