/** SHA-256 of validated manifest JSON, approved in source review together with its assets.
 * The former latest endpoint returns 404 (2026-10-17); no trusted release is available.
 * Empty pins deliberately reject installation rather than trust a new publisher manifest.
 */
export const LINUX_MANIFEST_PINS: readonly string[] = []
