/**
 * Fit the pinned rc.1 SettingsRoot to a phone while keeping its built-in web UI:
 * the upstream category navigation stays beside the upstream content column.
 */
export const MOBILE_SETTINGS_CSS: string = `
  html[data-dsh-mobile-form] [data-dsh-settings-dialog] {
    position: relative;
    display: flex;
    flex-direction: row;
    align-items: stretch;
    box-sizing: border-box;
    width: 100vw;
    max-width: none;
    height: 100vh;
    max-height: none;
    min-width: 0;
    min-height: 0;
    padding: var(--dsh-mobile-top-inset, 0px) 0 max(env(safe-area-inset-bottom, 0px), var(--dsh-android-system-bottom, 0px));
    border-radius: 0;
    overflow: hidden;
  }

  /* Keep the original DSH navigation rail compact on phones so the selected
     section retains useful width even on narrow portrait screens. */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog] > nav {
    display: flex;
    flex: 0 0 clamp(96px, 30vw, 128px);
    flex-direction: column;
    box-sizing: border-box;
    width: clamp(96px, 30vw, 128px);
    min-width: 96px;
    min-height: 0;
    gap: 12px;
    padding: 12px 8px 8px;
    overflow: hidden;
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog] > nav > [data-dsh-settings-nav-list] {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    gap: 4px;
    overflow-x: hidden;
    overflow-y: auto;
  }

  /* Preserve the built-in row, selected state, icon and label styling. */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog] > nav button {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    height: auto;
    min-height: 40px;
    padding: 8px;
    gap: 6px;
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog] > [data-dsh-settings-content] {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  /* Keep DSH's config-file and close actions in its original content header. */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog] > [data-dsh-settings-content] > [data-dsh-settings-header] {
    display: flex;
    flex: none;
    align-items: center;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    height: auto;
    min-height: 54px;
    padding: 8px;
  }

  /* The selected section keeps its upstream controls and scrolls inside its column. */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog] > [data-dsh-settings-content] > [data-dsh-settings-options] {
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: 0 12px 24px;
    overflow: auto;
  }
`
