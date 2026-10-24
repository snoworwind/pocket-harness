# Needs Validation — Pocket Harness

> Audit date: 2026-10-25. Reviewed source commit (full SHA): `b5a583be458c8ed10a914f4486932b15af7c7182`.

The records below passed independent final-record review as source-grounded leads. Their verdict remains needs_validation: this audit did not establish the missing runtime, deployment, identity, or resource effect. No severity is assigned.

## 1. Linux asset preparation retains one staging tree per digest

Fingerprint: LinuxAssetPrepare/per-digest-staging-aggregate

Asset preparation removes the staging path for the current digest and publishes the validated archive and unpacked tree under that digest. No aggregate quota or cleanup of other digest directories is visible. Lower-trust reachability and practical storage impact remain unresolved.

**Claimed root cause**

Successful distinct asset digests accumulate in separate staging directories without a source-visible aggregate quota or pruning policy.

**Source trace**

- entrypoint: app/src/main/java/com/snoworwind/pocketharness/AndroidBridge.kt:199 (linuxAssetPrepare bridge) — The bridge passes an asset specification to the native preparation path.
- sink: app/src/main/java/com/snoworwind/pocketharness/LinuxAssetPrepare.kt:177 (digest staging publication) — A successful preparation renames the work tree into the digest-specific staging directory.

**Verified source evidence**

- app/src/main/java/com/snoworwind/pocketharness/LinuxAssetPrepare.kt:161 — Preparation deletes only the current digest staging directory before doing work.
- app/src/main/java/com/snoworwind/pocketharness/LinuxAssetPrepare.kt:151 — The validated archive is deliberately retained alongside the unpacked tree.
- app/src/main/java/com/snoworwind/pocketharness/LinuxAssetPrepare.kt:177 — The completed work tree is published as staging/<sha256>.

**Exact blockers**

- Whether a lower-trust principal can repeatedly reach the bridge is unresolved; the source describes a main-WebView facade and the Linux feature is not enabled by default.
- The number and size of distinct valid assets reachable in deployment, and any resulting availability impact, are not established.
- No isolated build or device runtime was available for a bounded fixture.

**Bounded local validation**

In an approved OS-enforced sandbox, use a fake asset opener and two small synthetic manifests with distinct digests, then inspect only the temporary staging directory to see whether both archive/tree pairs remain and whether any aggregate limit applies.

**Safe owner-observed deployment check**

Have the owner confirm whether lower-trust content can invoke the bridge and what asset size/cardinality limits apply in the shipped Linux environment. Do not fetch real assets or fill device storage.


## 2. Device-transfer rules omit the active profile configuration

Fingerprint: android-backup:active-profile-secret-in-transfer

Backup rules exclude credential, session, and workspace paths but do not list the active profile patch or legacy settings path. EngineManager notes that profile patches can contain provider keys. The manifest also sets allowBackup=false; source does not establish OEM/device-transfer behavior.

**Claimed root cause**

The device-transfer exclusion list omits active profile configuration files that may contain provider credentials, while the actual platform transfer behavior is not represented in the repository.

**Source trace**

- entrypoint: app/src/main/AndroidManifest.xml:29 (application backup configuration) — The application points to backup and data-extraction rule files while setting its backup policy.
- sink: app/src/main/res/xml/data_extraction_rules.xml:18 (device-transfer exclusions) — The transfer exclusions list sensitive runtime paths but not profiles/<profile>/cordis.patch.yml or settings.yaml.

**Verified source evidence**

- app/src/main/AndroidManifest.xml:29 — The manifest declares allowBackup=false.
- app/src/main/res/xml/data_extraction_rules.xml:18 — The device-transfer rule block begins without an exclusion for profile configuration.
- app/src/main/java/com/snoworwind/pocketharness/EngineManager.kt:1535 — The source notes that profile patches can contain provider keys.

**Exact blockers**

- Whether the supported Android/OEM transfer path copies these app-private files despite allowBackup=false is a platform and device fact outside this checkout.
- No approved transfer device or disposable profile was available; no real profile configuration was inspected.

**Safe owner-observed deployment check**

Have the Android owner verify the exact supported Android and OEM transfer behavior using a disposable profile with a synthetic nonsecret marker, and report whether the omitted profile path is copied. Do not inspect or transfer real credentials.


## 3. Configuration export may copy provider keys to shared Documents

Fingerprint: android-config-export:unredacted-active-profile-copy

The user-initiated export selects the active profile patch or legacy settings file and copies it without redaction into the public Documents export directory. The engine warns that the configuration may contain provider keys; the UI displays the destination but says the export contains no API keys. Whether this exposes credentials depends on the active file contents and who can read the shared copy.

**Claimed root cause**

The active configuration is copied to public Documents without redaction while the UI gives an unconditional no-keys assurance; actual secret presence and external readability depend on runtime and device state.

**Source trace**

- entrypoint: dsh-client-ui-responsive/src/client/dev-section/DevSection.tsx:334 (Developer settings export control) — The user can invoke the configuration export from the settings UI.
- propagation: app/src/main/java/com/snoworwind/pocketharness/EngineManager.kt:1550 (configurationTransfer) — The export branch passes the active configuration to SnapshotUserData for export.
- sink: app/src/main/java/com/snoworwind/pocketharness/SnapshotUserData.kt:147 (replaceConfiguration) — The unredacted temporary copy is atomically moved to the export destination.

**Verified source evidence**

- app/src/main/java/com/snoworwind/pocketharness/SnapshotUserData.kt:109 — The selected source is the active profile patch when present or migrated, otherwise the legacy settings file.
- app/src/main/java/com/snoworwind/pocketharness/SnapshotUserData.kt:146 — The source bytes are copied to a temporary file without content redaction.
- app/src/main/java/com/snoworwind/pocketharness/SnapshotUserData.kt:147 — The temporary copy is moved to the export destination.
- app/src/main/java/com/snoworwind/pocketharness/EngineManager.kt:39 — The export root is Android's public Documents directory.
- app/src/main/java/com/snoworwind/pocketharness/EngineManager.kt:1554 — The native result warns that the active configuration may contain provider keys and advises protecting the shared copy.
- dsh-client-ui-responsive/src/client/dev-section/DevSection.tsx:258 — The UI displays only the exported path or error and does not display the returned warning hint.
- dsh-client-ui-responsive/src/client/dev-section/DevSection.tsx:340 — The UI unconditionally states that the export contains no API keys.

**Exact blockers**

- The checked-in source does not establish whether an installed active configuration contains provider credentials.
- No particular unauthorized reader is evidenced; Android storage policy and other-app permissions determine access.
- No approved isolated Android device was available for a synthetic export and cross-principal read check.

**Bounded local validation**

On an approved isolated device, export a synthetic configuration containing a nonsecret marker and compare source and exported bytes. Check readability using ordinary and broad-storage test apps only. Do not read or copy real provider credentials.

**Safe owner-observed deployment check**

Have the owner verify whether the active profile contains credentials without recording their values, then check what the UI displays and which test identities can read a synthetic exported file on the supported Android version.


## 4. Repeated incoming shares lack an aggregate storage budget

Fingerprint: android:incoming-share:aggregate-storage-budget

The exported VIEW/SEND intake copies accepted files into private incoming storage with a 200 MiB per-file cap. A single-thread queue has no visible aggregate request bound, and session-referenced files are exempt from cleanup. Practical repeated-share impact is unobserved.

**Claimed root cause**

Incoming-share processing has only a per-file limit and no source-visible aggregate quota for queued or retained files.

**Source trace**

- entrypoint: app/src/main/AndroidManifest.xml:110 (exported MainActivity intent filters) — MainActivity is exported; the activity declaration below also includes VIEW and SEND filters.
- propagation: app/src/main/java/com/snoworwind/pocketharness/FileIncoming.kt:561 (processIncomingIntent) — Accepted intents queue asynchronous work.
- sink: app/src/main/java/com/snoworwind/pocketharness/FileIncoming.kt:179 (copyIn) — Each accepted file is copied into the private incoming workspace under its individual limit.

**Verified source evidence**

- app/src/main/java/com/snoworwind/pocketharness/FileIncoming.kt:163 — The copy limit is 200 MiB per file.
- app/src/main/java/com/snoworwind/pocketharness/FileIncoming.kt:179 — Accepted input bytes are copied into the private incoming workspace.
- app/src/main/java/com/snoworwind/pocketharness/FileIncoming.kt:386 — Incoming IO uses a single-thread executor with no source-visible queue bound.
- app/src/main/java/com/snoworwind/pocketharness/FileIncoming.kt:312 — TTL cleanup derives deletion candidates using both pending and queued session paths.

**Exact blockers**

- No isolated device check established that a separate app can repeatedly invoke the packaged activity with valid read grants to its provider.
- The practical retained byte total and any meaningful app-storage availability effect have not been observed.

**Bounded local validation**

On an isolated emulator, use a dummy content provider and separate caller app to send at most eight harmless files of at most 1 MiB each (8 MiB total). Record accepted bytes, queued work, and session references; verify cleanup behavior without applying storage pressure.

**Safe owner-observed deployment check**

Have the owner verify the final merged manifest and retention behavior with dummy shared files in a disposable test profile, using a predetermined low total-byte cap and stopping before storage pressure.


## 5. PR workflow secret exposure depends on GitHub settings

Fingerprint: github.github/workflows/pr-gate.yml/pr-workflow-secret-isolation

The checked-in PR Gate has contents:read, disables checkout credential persistence, and does not reference secrets. A separate main-branch signer maps repository secrets. Whether a PR revision can access those secrets depends on GitHub workflow semantics, contributor trust, and repository policy.

**Claimed root cause**

If GitHub executes a PR-proposed workflow revision with signing secrets available, a same-repository PR author outside the trusted signer group could disclose them; those external conditions are unknown.

**Source trace**

- entrypoint: .github/workflows/pr-gate.yml:6 (pull_request trigger) — A pull request triggers the PR Gate workflow.
- sink: .github/workflows/build-apk-source.yml:987 (isolated signing step) — The signing step maps signing secrets into its environment.

**Verified source evidence**

- .github/workflows/pr-gate.yml:13 — The PR workflow declares contents:read.
- .github/workflows/pr-gate.yml:42 — Checkout disables persisted credentials.
- .github/workflows/build-apk-source.yml:969 — Signing is conditioned on refs/heads/main.
- .github/workflows/build-apk-source.yml:987 — Signing credentials are passed to the signing step.

**Exact blockers**

- The checkout cannot establish whether GitHub executes a PR-proposed workflow revision with repository/organization secrets available.
- The identities permitted to create same-repository PRs and their authorization for the signing key are unknown.

**Safe owner-observed deployment check**

Have a repository owner inspect GitHub Actions PR workflow and secret policies, the identities who can create same-repository PRs, and the scope/approval controls for signing secrets. Do not run a test workflow or expose secret values.


## 6. Linux shell callback does not visibly enforce session policy

Fingerprint: linux-bash:session-policy-bypass

The linux_bash callback forwards command, cwd, and timeout to a PRoot manager without passing session context. Sibling shell paths check session policy. The active engine dispatcher is absent, so an outer enforcement gate cannot be ruled out.

**Claimed root cause**

The Linux shell callback has no source-visible session-policy check before launching commands, unlike the Android and Termux shell paths.

**Source trace**

- entrypoint: vendor/dsh-linux-runtime/lib/index.js:56 (registered linux_bash tool) — The plugin registers the model-facing Linux shell tool.
- propagation: vendor/dsh-linux-runtime/lib/index.js:89 (execute callback) — The callback forwards command, cwd, and timeout without session context.
- sink: vendor/dsh-linux-runtime/modules/manager.js:1335 (managed PRoot execution) — The manager passes the generated PRoot specification to _runManaged to execute the supplied bash command.

**Verified source evidence**

- vendor/dsh-linux-runtime/lib/index.js:89 — The callback does not pass execution context or sandbox policy.
- vendor/dsh-linux-runtime/modules/manager.js:1331 — The manager builds PRoot arguments using the supplied command.
- plugins/dsh-android-bridge/src/index.ts:1669 — Android shell explicitly checks session policy.
- dsh-shell-termux/src/index.ts:266 — Termux shell rejects non-full-access sessions before starting bash.

**Exact blockers**

- The active engine tool dispatcher and pre-execute middleware are absent, so source review cannot establish whether a global session gate runs first.
- No bounded dispatcher-to-callback observation was possible under the required sandbox.

**Bounded local validation**

When an approved OS-enforced sandbox is available, use the engine dispatcher with a synthetic read-only session and a fake Linux manager that only records invocations. Verify whether the dispatcher rejects before the fake runner is called; do not invoke a real shell.

**Safe owner-observed deployment check**

Have the engine owner inspect the active dispatcher and pre-execute middleware for linux_bash and report whether a synthetic read-only session is rejected before the callback.


## 7. Active capability probes lack a plugin-side request-count cap

Fingerprint: model-capability:active-probe-level-cardinality

The tool schema accepts a levels array without maxItems, preserves duplicate recognized values, and sends one provider request per surviving level plus a negative control. Dispatcher argument bounds and provider quotas are not established.

**Claimed root cause**

The plugin accepts model-controlled active-probe levels without truncation/deduplication and issues a request for each; any outer request-count cap is unknown.

**Source trace**

- entrypoint: plugins/dsh-model-capability/src/index.ts:873 (model probe schema) — The levels argument is an array without a visible maximum item count.
- propagation: plugins/dsh-model-capability/src/index.ts:326 (active probe selection) — A nonempty supplied levels array is retained.
- sink: plugins/dsh-model-capability/src/capability-probe.ts:578 (provider request loop) — The probe sends one request for each accepted level.

**Verified source evidence**

- plugins/dsh-model-capability/src/capability-probe.ts:621 — Filtering recognized levels does not remove duplicate entries.
- plugins/dsh-model-capability/src/capability-probe.ts:578 — Each retained entry triggers a separate request.
- plugins/dsh-model-capability/src/index.ts:310 — The local gate requires active=true and confirm=true.

**Exact blockers**

- The shipped dispatcher may cap argument cardinality or require approval bound to final arguments; that implementation is not in this checkout.
- Provider billing and quota limits are outside this source review; no provider-backed request was made.

**Bounded local validation**

In a bounded isolated fixture, use duplicate recognized levels and fake fetch/provider configuration, then count fake requests through the registered tool. Inspect shipped dispatcher argument limits without contacting a provider.

**Safe owner-observed deployment check**

Have the owner inspect dispatcher argument/approval limits and configured route quotas without sending probe traffic.


## 8. Active provider probes rely on model-supplied confirmation flags

Fingerprint: model-capability:active-probe-user-approval

Plugin-local checks accept active=true and confirm=true, then may issue authenticated provider requests. The source does not establish whether the host dispatcher requires separate human approval bound to the final full arguments.

**Claimed root cause**

Plugin-local active-probe authorization treats model-controlled booleans as sufficient; a host dispatcher may add a distinct approval boundary.

**Source trace**

- entrypoint: plugins/dsh-model-capability/src/index.ts:862 (model-visible probe tool) — The tool schema exposes active and confirm arguments.
- propagation: plugins/dsh-model-capability/src/index.ts:310 (plugin-local gate) — The function proceeds when active is true and confirm equals true.
- sink: plugins/dsh-model-capability/src/capability-probe.ts:578 (provider request) — The active probe sends requests to the configured provider endpoint.

**Verified source evidence**

- plugins/dsh-model-capability/src/index.ts:871 — The schema accepts a model-controlled active boolean.
- plugins/dsh-model-capability/src/index.ts:872 — The schema accepts a model-controlled confirm boolean.
- plugins/dsh-model-capability/src/index.ts:311 — The local gate does not call an approval service.

**Exact blockers**

- The shipped dispatcher approval policy and argument binding are absent from the checkout and are decisive to whether model booleans can cause a request without user intent.

**Safe owner-observed deployment check**

Have the owner verify the shipped engine version and confirm that active probe calls cannot reach a provider unless a human approves the final normalized tool name and complete argument object. Use source/configuration inspection only; do not send audit traffic.


## 9. Global capability revoke may leave another agent's tools visible

Fingerprint: plugins/dsh-android-bridge/src/capability-gate.ts/global-relock-scope

The off revoke clears shared persisted unlock state but appears to rebuild restrictions only for the requesting agent. Another active agent may retain stale tool visibility. Separate execution checks remain, and no consequential bypass was established.

**Claimed root cause**

The shared unlock state is globally cleared while in-memory restriction fibers are updated only for the caller agent.

**Source trace**

- entrypoint: plugins/dsh-android-bridge/src/capability-gate.ts:385 (capability tool execute) — The revoke call is associated with the current agent.
- propagation: plugins/dsh-android-bridge/src/capability-gate.ts:293 (relock) — The off path clears shared groups and looks up only the supplied agent's lock table.
- sink: plugins/dsh-android-bridge/src/capability-gate.ts:315 (lockAgent rebuild) — The restrictions are rebuilt for that agent alone.

**Verified source evidence**

- plugins/dsh-android-bridge/src/capability-gate.ts:203 — Active restriction fibers are tracked in a WeakMap by agent.
- plugins/dsh-android-bridge/src/capability-gate.ts:315 — The relock path visits only the current agent.
- plugins/dsh-android-bridge/src/index.ts:1038 — Device execution separately checks danger-full-access mode.

**Exact blockers**

- Cordis fiber disposal and model tool-list/dispatch behavior across concurrent agents are not resolved by source.
- Stale visibility alone does not prove execution bypass because separate session/channel gates remain.

**Bounded local validation**

In a bounded Cordis fixture, create two agents with a harmless synthetic gated tool, unlock both, revoke group off from one, then inspect the other agent's tool list and attempt only the side-effect-free test dispatch.

**Safe owner-observed deployment check**

Have the owner observe the same two-agent case using only a harmless no-op tool and separately verify execution session/channel checks.


## 10. Overlay tarballs lack source-controlled integrity verification

Fingerprint: scripts/build-snapshot-013.mjs/overlay-integrity

The overlay resolver accepts bytes when registry SHA-512 metadata is absent and returns existing cache files without verification before extraction. The intended registry trust root and cache-writer boundary are unknown.

**Claimed root cause**

The overlay resolver trusts optional registry-provided integrity and unverified cached tarball bytes rather than a source-controlled digest.

**Source trace**

- entrypoint: scripts/build-snapshot-013.mjs:225 (registry metadata fetch) — The builder obtains package metadata from a configured registry.
- propagation: scripts/build-snapshot-013.mjs:233 (overlay tarball resolution) — It fetches tarball bytes from the metadata URL.
- sink: scripts/build-snapshot-013.mjs:257 (staged engine extraction) — The resolved tarball is extracted into the staged runtime tree.

**Verified source evidence**

- scripts/build-snapshot-013.mjs:218 — The cache-hit branch returns existing bytes without verification.
- scripts/build-snapshot-013.mjs:234 — The digest check is conditional on registry-provided dist.sha512.
- scripts/snapshot-config/engine-overlay.json:25 — The source manifest pins package names/versions but lacks a per-package tarball digest.

**Exact blockers**

- The required isolated registry fixture could not run because the OS-enforced sandbox is unavailable.
- Source does not establish the intended registry integrity root or who can write the actual build worker cache before consumption.

**Bounded local validation**

In an approved network-denied sandbox with a stub registry and scratch-only cache, use a harmless dummy tarball and confirm whether omitted registry digest and cache-hit bytes are accepted and extracted. Do not use a real registry or publish artifacts.

**Safe owner-observed deployment check**

Have the build owner confirm the documented integrity root and who can write any shared engine-overlay cache on actual build workers.


## 11. Configured npm mirror reaches package-manager bootstrap

Fingerprint: scripts/source-build/run-local-source-chain.mjs/corepack-mirror-bootstrap

The local source chain propagates a caller-supplied mirror into npm and Corepack registry settings, then installs and invokes Corepack. Whether pinned tool versions accept plain HTTP or independently authenticate bootstrap bytes is unknown.

**Claimed root cause**

The local build chain propagates a configurable registry to package-manager bootstrap without a source-visible scheme allowlist or Corepack digest.

**Source trace**

- entrypoint: scripts/source-build/run-local-source-chain.mjs:280 (mirror CLI/environment input) — The caller mirror is read from --npm-mirror or DSH_NPM_MIRROR.
- propagation: scripts/source-build/run-local-source-chain.mjs:298 (child environment) — The mirror populates npm_config_registry and COREPACK_NPM_REGISTRY.
- sink: scripts/source-build/build-engine.sh:67 (Corepack bootstrap install) — The script installs Corepack through npm in the inherited environment.

**Verified source evidence**

- scripts/source-build/run-local-source-chain.mjs:280 — Mirror input is accepted without source-visible scheme validation.
- scripts/source-build/run-local-source-chain.mjs:338 — Workflow shell steps receive the constructed environment.
- scripts/source-build/build-engine.sh:67 — Corepack is installed globally before enabling/invoking it.

**Exact blockers**

- The checkout does not establish whether the pinned npm accepts a plain-HTTP registry or its integrity checks for Corepack.
- The checkout does not establish whether Corepack authenticates pnpm bootstrap independently; the isolated tool behavior check did not run.

**Bounded local validation**

In an approved network-denied sandbox, use a loopback-only registry fixture and harmless dummy packages to check exact pinned npm/Corepack handling and integrity. Do not contact external registries or create deliverable artifacts.


## 12. Dependency sync approval depends on the external tool dispatcher

Fingerprint: undo-restore:sync-deps-action-confirmation

The model-visible undo_restore option sync_deps reaches pnpm install when dependency files are restored. The plugin prompt asks for confirmation, but the checked-out source does not establish whether the installed dispatcher requires and binds actual approval.

**Claimed root cause**

The plugin handler has no source-visible check that approval covers the final undo_restore mode, snapshot ID, and sync_deps option before dependency installation.

**Source trace**

- entrypoint: vendor/dsh-undo-savepoint/lib/index.js:481 (undo_restore execute handler) — The handler receives mode, snapshot ID, and sync_deps arguments.
- propagation: vendor/dsh-undo-savepoint/lib/index.js:485 (restore dispatch) — The handler forwards sync_deps into restore without a visible approval check.
- sink: vendor/dsh-undo-savepoint/lib/core.mjs:2103 (dependency installation) — When dependency files were restored and syncDeps is true, reconciliation calls pnpm.

**Verified source evidence**

- vendor/dsh-undo-savepoint/lib/index.js:197 — The plugin prompt requests user confirmation but is not a deterministic handler check.
- vendor/dsh-undo-savepoint/lib/index.js:477 — The schema exposes sync_deps as a boolean.
- vendor/dsh-undo-savepoint/lib/core.mjs:2103 — The install path invokes runPnpm under the dependency-file and syncDeps conditions.

**Exact blockers**

- The installed @deepseek-ai/dsh-tools dispatcher and active approval configuration are absent, so approval requirement and final-argument binding are unknown.

**Bounded local validation**

In a disposable isolated profile with dummy dependency manifests, dispatch undo_restore through the exact installed dispatcher and use a stub pnpm executable that only records arguments. Compare no approval, mismatched approval, and exact approval; allow no package installation or network.

**Safe owner-observed deployment check**

Have the DSH owner inspect the deployed dispatcher and confirm approval is required and bound to requester plus the final normalized tool and complete arguments.


## 13. Snapshot import retains a large aggregate of decoded ZIP entries

Fingerprint: undo.import.aggregate-buffer-cap

Import accepts archives up to 1 GiB, and the custom parser can retain decoded entries up to a 4 GiB aggregate cap in memory. Source does not establish lower-trust archive selection or actual process impact.

**Claimed root cause**

The parser retains all decoded entry buffers before import completes, with an aggregate cap not tied to the deployed process memory limit.

**Source trace**

- entrypoint: vendor/dsh-undo-savepoint/lib/index.js:620 (undo_import tool handler) — The handler passes a caller-selected archive path to importSnapshots.
- propagation: vendor/dsh-undo-savepoint/lib/core.mjs:2907 (archive read) — The archive is read into a Buffer after a 1 GiB size check.
- sink: vendor/dsh-undo-savepoint/lib/zip.mjs:184 (decoded buffer retention) — Each decoded entry is retained in an output array up to the aggregate limit.

**Verified source evidence**

- vendor/dsh-undo-savepoint/lib/core.mjs:2900 — Import defines a 1 GiB compressed archive size limit.
- vendor/dsh-undo-savepoint/lib/zip.mjs:133 — The parser caps aggregate decoded output at 4 GiB.
- vendor/dsh-undo-savepoint/lib/zip.mjs:184 — Decoded buffers remain in the returned array until parsing completes.

**Exact blockers**

- The deployed Node memory limit and supervisor/process isolation are unknown.
- The source does not establish whether a lower-trust party can cause archive selection without meaningful user authorization.
- No sandboxed memory measurement was possible.

**Bounded local validation**

When the required sandbox is available, use a synthetic archive fixture under strict memory/time limits and record peak memory and failure scope without writing imported entries or using a live engine.

**Safe owner-observed deployment check**

Have the runtime owner report Node memory limits and whether a lower-trust party can cause archive import without user authorization; do not submit an archive to a deployed service.


## 14. A lower-tier session may reach virtual-display destruction

Fingerprint: vdisplay-destroy-session-mode-bypass

The destroy tool passes the caller session to the control service, but vdDestroy is absent from the tier-required operation set. Native destroy may select and release a display belonging to another session. Device impact on content running there is unobserved.

**Claimed root cause**

vdDestroy is omitted from the session-tier gate and native destroy lacks caller ownership enforcement, possibly allowing a lower-tier session to destroy another session's virtual display.

**Source trace**

- entrypoint: plugins/dsh-android-vdisplay/src/index.ts:291 (android_vdisplay_destroy tool) — The model tool calls vdDestroy with its execution context.
- propagation: plugins/dsh-android-bridge/src/index.ts:1233 (controlExec tier authorization) — The service checks session tier only for operations listed in TIER_REQUIRED_OPS.
- sink: app/src/main/java/com/snoworwind/pocketharness/VdisplayController.kt:491 (display release) — After selecting a registered display, the controller removes its record and releases the display without checking caller ownership.

**Verified source evidence**

- plugins/dsh-android-bridge/src/index.ts:548 — TIER_REQUIRED_OPS omits vdDestroy.
- app/src/main/java/com/snoworwind/pocketharness/VdisplayController.kt:478 — The controller explicitly allows any session to destroy a display.
- app/src/main/java/com/snoworwind/pocketharness/VdisplayController.kt:488 — If no caller-owned display is selected, destruction falls back to the first registered display.
- app/src/main/java/com/snoworwind/pocketharness/VdisplayController.kt:431 — Display creation configures FLAG_DESTROY_CONTENT_ON_REMOVAL; its runtime effect on a running task is unobserved.

**Exact blockers**

- No isolated Android observation established that a lower-tier session can invoke destroy against another session's display and disrupt a running dummy app.

**Bounded local validation**

In an isolated emulator, create a display for dummy session A, launch a disposable app there, and invoke only android_vdisplay_destroy from session B below danger-full-access. Record display state and app behavior; do not use real apps or data.


## 15. Persisted snapshot paths may expose snapshots across profiles

Fingerprint: vendor-dsh-undo-savepoint:global-settings-overrides-profile-store

One shared DSH_HOME settings file can persist manualDir/autoDir values that override profile-specific default roots. Listing and restore do not compare the manifest profile with the active profile. Whether profiles are distinct security principals or shared paths are intended remains unresolved.

**Claimed root cause**

Shared persisted store overrides can point multiple profiles at the same snapshot roots, while listing and restore omit profile identity checks.

**Source trace**

- entrypoint: vendor/dsh-undo-savepoint/lib/index.js:485 (undo_restore tool) — The tool invokes restore using configuration for the active profile.
- propagation: vendor/dsh-undo-savepoint/lib/index.js:253 (profile configuration) — Persisted store paths take precedence over profile-specific defaults.
- propagation: vendor/dsh-undo-savepoint/lib/core.mjs:1534 (snapshot listing) — Listing scans configured roots without filtering manifest profile.
- sink: vendor/dsh-undo-savepoint/lib/core.mjs:2052 (restore destination) — Restore targets the current profile root without comparing the recorded snapshot profile.

**Verified source evidence**

- vendor/dsh-undo-savepoint/lib/core.mjs:55 — The default settings path is under DSH_HOME, shared across profiles using that home.
- vendor/dsh-undo-savepoint/lib/index.js:1133 — Settings updates persist the manual and auto roots to the settings file.
- vendor/dsh-undo-savepoint/lib/index.js:253 — Persisted manual/auto roots override profile-specific roots.
- vendor/dsh-undo-savepoint/lib/core.mjs:1534 — Listing scans configured roots without filtering on the manifest profile field.
- vendor/dsh-undo-savepoint/lib/core.mjs:2052 — Restore targets the active profile root without comparing the snapshot profile.

**Exact blockers**

- The source does not establish whether profiles are security principals with isolated model/API access or whether a shared configured snapshot directory is intended.

**Bounded local validation**

In a disposable fixture with a temporary DSH_HOME, configure profiles A and B to use the same persisted manualDir/autoDir, create a harmless profile-A snapshot, then inspect profile B listing and restore destination using temporary files only.

**Safe owner-observed deployment check**

Ask the product owner whether profiles are separate security principals and whether persisted shared snapshot directories are intended; do not access deployed user data.


## 16. Automatic pruning may delete blobs still used by message undo

Fingerprint: vendor-dsh-undo-savepoint:prune-auto-deletes-message-undo-blobs

Message hooks store beforeHash content in the shared blob store. Automatic pruning builds live references only from snapshot manifests and deletes blobs outside that set; a later undoMessage reports missing content. The practical result was not observed.

**Claimed root cause**

pruneOrphanBlobs omits message-batch beforeHash references when deciding which blob files to delete.

**Source trace**

- entrypoint: vendor/dsh-undo-savepoint/lib/index.js:945 (pre-execution hook) — The hook captures eligible workspace file contents before a tool operation.
- propagation: vendor/dsh-undo-savepoint/lib/core.mjs:2265 (prune reference set) — Automatic pruning collects snapshot hashes but does not read message batches.
- propagation: vendor/dsh-undo-savepoint/lib/core.mjs:2276 (blob deletion) — Automatic pruning removes a blob after its hash is absent from the snapshot-only reference set.
- sink: vendor/dsh-undo-savepoint/lib/core.mjs:2586 (message undo restore) — undoMessage later attempts to read the missing beforeHash blob.

**Verified source evidence**

- vendor/dsh-undo-savepoint/lib/index.js:968 — The pre-execution hook persists beforeHash in the message batch.
- vendor/dsh-undo-savepoint/lib/core.mjs:2266 — pruneOrphanBlobs adds only snapshot file hashes.
- vendor/dsh-undo-savepoint/lib/core.mjs:2276 — An unreferenced blob is removed.
- vendor/dsh-undo-savepoint/lib/core.mjs:2587 — A failed blob read skips restoring original content.

**Exact blockers**

- The claimed prune-then-undo behavior was not observed in a bounded local fixture because the required OS-enforced sandbox is unavailable.

**Bounded local validation**

In an approved isolated DSH_UNDO_ROOT fixture, create a message batch and dummy beforeHash blob with no snapshot reference, call pruneAuto, then undoMessage. Record whether the blob is removed and undo reports missing content; stop after that result.


## 17. Approval does not visibly bind the marketplace package source

Fingerprint: vendor/dshmarketplace-plugin/lib/index.js/install-source-approval-binding

The approval hook displays descriptive catalogue metadata keyed by fullName. Installation later performs another lookup by fullName and derives the command target from the returned install field. Source does not show immutable source/digest binding; host approval and package-manager integrity are unknown.

**Claimed root cause**

The approval decision is not visibly bound to the catalogue install locator or an immutable digest used by the later install execution.

**Source trace**

- entrypoint: vendor/dshmarketplace-plugin/lib/index.js:1 (pre-execute approval and install registration) — The module registers a pre-execute approval hook and a model-visible install tool.
- propagation: vendor/dshmarketplace-plugin/lib/index.js:1 (approval prompt construction) — The approval prompt includes descriptive metadata and URL but not the installation locator or digest.
- sink: vendor/dshmarketplace-plugin/lib/index.js:1 (package manager invocation) — Execution re-looks up fullName, derives the install target, and invokes dsh plugin add.

**Verified source evidence**

- vendor/dshmarketplace-plugin/lib/index.js:1 — The approval hook returns an ask decision from catalogue metadata.
- vendor/dshmarketplace-plugin/lib/index.js:1 — The catalogue cache expires after 300 seconds; execution performs a later lookup and invokes the selected install command.
- vendor/dshmarketplace-plugin/lib/index.js:1 — The command syntax is checked, but the source does not bind a digest or approved row locator.

**Exact blockers**

- The host approval dispatcher is outside this source path; it is unknown whether acceptance binds to the same invocation/arguments and catalogue data.
- The package manager's source resolution and integrity behavior are outside the reviewed source.
- No isolated approval-to-execution harness ran because the required OS-enforced sandbox is unavailable.

**Bounded local validation**

When compliant sandboxing is available, mock the catalogue and use a dummy runner to capture the approval prompt, change the locator after cache expiry, and observe whether the real dispatcher can invoke the dummy runner with changed data. Do not run the package manager or contact external services.

**Safe owner-observed deployment check**

Have the owner inspect the pinned host approval dispatcher and package-manager configuration to confirm exact tool-argument binding and source integrity through installation.


## Candidates withheld pending fresh final verification

These remain candidate coverage units and are not findings. Phase 5 reviewers requested material trace, boundary, or execution-input corrections; the strict budget left no fresh verifier to approve the corrected records. They were therefore excluded from findings.json and are listed here only to make the incomplete coverage explicit.

### EngineManager:shared-diagnostics-incomplete-redaction

Coverage unit: Engine logs, audit logs, and console env / streaming-truncation-derived-copy

Pending final verification: The reviewer corrected the storage-selection condition and reader boundary; the stricter wording needs a fresh independent final-record verification.

### LogCollector:secret-redaction-chunk-boundary

Coverage unit: Engine logs, audit logs, and console env / streaming-truncation-derived-copy

Pending final verification: The reviewer corrected per-read/tick sink semantics and supplied a more exact multi-chunk fixture; that input and trace correction need a fresh independent final-record verification.

### RootAccess:root-grant-revocation-dispatch-window

Coverage unit: AI root grant and privileged shell fallback / ai-root-grant-shell-fallback

Pending final verification: The reviewer replaced a private helper as the alleged entrypoint with the model shell dispatch path and clarified AI consent versus Root Manager authorization; the corrected trace needs a fresh independent verification.

### android-client-failure:console-provenance

Coverage unit: Android automatic undo recovery / android-undo-emergency-recovery

Pending final verification: The reviewer extended the trace through recovery selection, UndoGate, and the quarantine patch write; the corrected impact path needs a fresh independent final-record verification.

### android-saf:unbound-primary-document-id

Coverage unit: SAF workspace and shared-directory selection / saf-workspace-path-selection

Pending final verification: The reviewer moved the untrusted input entrypoint to the SAF result callback and specified a provider-identity mismatch fixture; this materially changes the source trace and needs a fresh independent verification.

### undo.export.plaintext-encryption-staging

Coverage unit: vendor/dsh-undo-savepoint/lib/core.mjs#exportSnapshots / undo-snapshot-export

Pending final verification: The reviewer identified a concrete password-conversion failure input after plaintext archive creation; this changes the execution input and needs a fresh independent final-record verification.
