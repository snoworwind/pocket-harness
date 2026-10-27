# Regression fixture notices

The captured package artifacts in this directory are test inputs. They are not
copied into the Android snapshot or APK. They include published or source-built
DeepSeek Harness packages, the `@earendil-works/pi-ai` package, and metadata for
`@deepseek-ai/node-addon-system`.

Package-declared licenses and their notices are kept outside the fixture tree
so they are not mistaken for captured fixture directories:

- DeepSeek Harness packages: [MIT](../../../../docs/third-party-notices/patch-fixtures/LICENSES/DeepSeek-Harness-MIT.txt), copyright DeepSeek.
- `@earendil-works/pi-ai`: [MIT](../../../../docs/third-party-notices/patch-fixtures/LICENSES/pi-ai-MIT.txt), copyright Mario Zechner.
- `@deepseek-ai/node-addon-system`: [BSD-3-Clause](../../../../docs/third-party-notices/patch-fixtures/LICENSES/node-addon-system-BSD-3-Clause.txt), copyright node-addon-landlock-run contributors.

The fixture manifest records the captured package versions, source commit,
package paths, and hashes.
