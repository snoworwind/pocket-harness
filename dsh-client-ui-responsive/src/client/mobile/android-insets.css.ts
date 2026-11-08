/** Android edge-to-edge insets for the DSH-owned application frame. */
export const ANDROID_INSETS_CSS = `
:root {
  --dsh-android-top-inset: max(
    env(safe-area-inset-top, 0px),
    var(--dsh-android-system-top, 0px)
  );
}

[data-dsh-android-frame] {
  box-sizing: border-box;
  padding-top: var(--dsh-android-top-inset, 0px);
}
`
