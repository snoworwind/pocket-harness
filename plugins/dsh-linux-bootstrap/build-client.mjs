#!/usr/bin/env node
import { build } from 'esbuild'

await build({
  entryPoints: ['client/index.js'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  outfile: 'lib/client.js',
  sourcemap: false,
  target: 'chrome87',
  external: [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
    '@deepseek-ai/dsh-client-schema-form', '@deepseek-ai/dsh-client-ui-settings',
  ],
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "@dsh-android/linux-bootstrap", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
})
console.log('client bundle written: lib/client.js')
