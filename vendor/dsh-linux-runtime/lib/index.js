/** Offline legacy runtime helpers; the product uses the APK-managed primary Debian guest. */
export { createManager, LinuxRuntimeManager, ExecutionGate } from '../modules/manager.js';
export { selectRuntime, validateManifest, validateAsset, MANIFEST_SCHEMA_VERSION, PACKAGE_VERSION } from '../modules/manifest.js';
export { installPluginAsset, assertOfficialAssetUrl, isAllowedAssetOrigin, verifyDownloadedAsset } from '../modules/asset-installer.js';

import { createManager } from '../modules/manager.js';
export function apply(ctx, config = {}) {
  const manager = config.manager ?? createManager(config);
  ctx.provide?.('linuxRuntimeManager', manager);
  ctx.effect?.(() => async () => { if (!config.manager) await manager.dispose(); });
  return manager;
}
