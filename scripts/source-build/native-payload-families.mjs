// Reviewed publisher native payload families shared by runtime-specific auditors.
export const acknowledgedFamilies = [
  /^@img\+sharp-linux-(?:x64|arm64)@0\.35\.5\//,
  /^@img\+sharp-wasm32@0\.35\.3\//,
  /^@koromix\+koffi-(?:android|linux)-(?:arm64|x64)@3\.2\.1\//,
  /^node-pty@1\.2\.0-beta\.15_.*\//,
  /^node-addon-require-builtin-linux-(arm64|x64)-gnu@0\.1\.(?:4|6|9)\/node_modules\/node-addon-require-builtin-linux-\1-gnu\/prebuilt\/linux-\1-gnu-napi-v9\.node$/,
  /^@deepseek-ai\+node-addon-system-linux-(?:arm64|x64)@.*\//,
  /^@trycua\+cua-driver-linux-(arm64|x64)-gnu@0\.28\.0\/node_modules\/@trycua\/cua-driver-linux-\1-gnu\/cua_driver_node_runtime\.node$/,
  /^@ubjs\+node-linux-(arm64|x64)-gnu@0\.31\.0-3\/node_modules\/@ubjs\/node-linux-\1-gnu\/uniffi-runtime-napi\.linux-\1-gnu\.node$/,
  /^sherpa-onnx-linux-(arm64|x64)@1\.13\.8\/node_modules\/sherpa-onnx-linux-\1\/sherpa-onnx\.node$/,
]
export const isReviewedNativePath = (path) => acknowledgedFamilies.some((pattern) => pattern.test(path))

