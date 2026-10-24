# Pocket Harness Security Audit

> **Status: INCOMPLETE — validation_budget_exhausted.** The strict budget was fully spent (80/80 agent invocations). Six candidates received material Phase 5 correction requests and were withheld because no fresh independent verifier remained. Do not treat those candidates as findings.

## Run scope and method

- Profile: deep; scope: repository-wide Android shell, runtime snapshot and plugins, self-contained companion copies, local IPC and bridge protocols, data lifecycle, build/release automation, web/download surfaces, and security-relevant configuration.
- Reviewed source ref: b5a583be458c8ed10a914f4486932b15af7c7182 on main; the worktree was clean at audit start. No source files were changed.
- Prior structured run: none. Historical Markdown audits were treated as context, not as verified carry-over.
- Execution policy: source review and bounded local checks only. The required OS-enforced sandbox was unavailable, so no target code, tests, builds, Android device, emulator, external service, or network behavior was executed or observed.
- Budget: 80 planned, 80 spent — 4 reconnaissance, 23 hunters, 7 critics, 23 candidate validators, and 23 final record verifiers. No retries or replacement verifiers remained.
- This is a partial pass. The final critic (wave 7) found one additional runtime-cache cleanup lifecycle and returned stop=false. The remaining budget could not fund a hunter wave and its critics while preserving verification reserves.

## Security posture

No confirmed vulnerability was established. Seventeen source-grounded needs-validation records passed independent final-record review; each depends on a runtime, provider, deployment, identity, or sandbox fact that this source-only pass could not resolve. Six additional candidates remain in the coverage ledger but were withheld from findings.json after material Phase 5 corrections needed another independent review. These are leads, not confirmed vulnerabilities, and no severity is assigned.

## Confirmed findings

None. This audit did not reproduce a concrete boundary violation with an affected principal and observed security result.

## Needs-validation records

| Fingerprint | Lead | Source trace | Decisive unresolved fact |
|---|---|---|---|
| LinuxAssetPrepare/per-digest-staging-aggregate | Linux asset preparation retains one staging tree per digest | app/src/main/java/com/snoworwind/pocketharness/AndroidBridge.kt:199 → app/src/main/java/com/snoworwind/pocketharness/LinuxAssetPrepare.kt:177 | Whether a lower-trust principal can repeatedly reach the bridge is unresolved; the source describes a main-WebView facade and the Linux feature is not enabled by default.; The number and size of distinct valid assets reachable in deployment, and any resulting availability impact, are not established.; No isolated build or device runtime was available for a bounded fixture. |
| android-backup:active-profile-secret-in-transfer | Device-transfer rules omit the active profile configuration | app/src/main/AndroidManifest.xml:29 → app/src/main/res/xml/data_extraction_rules.xml:18 | Whether the supported Android/OEM transfer path copies these app-private files despite allowBackup=false is a platform and device fact outside this checkout.; No approved transfer device or disposable profile was available; no real profile configuration was inspected. |
| android-config-export:unredacted-active-profile-copy | Configuration export may copy provider keys to shared Documents | dsh-client-ui-responsive/src/client/dev-section/DevSection.tsx:334 → app/src/main/java/com/snoworwind/pocketharness/SnapshotUserData.kt:147 | The checked-in source does not establish whether an installed active configuration contains provider credentials.; No particular unauthorized reader is evidenced; Android storage policy and other-app permissions determine access.; No approved isolated Android device was available for a synthetic export and cross-principal read check. |
| android:incoming-share:aggregate-storage-budget | Repeated incoming shares lack an aggregate storage budget | app/src/main/AndroidManifest.xml:110 → app/src/main/java/com/snoworwind/pocketharness/FileIncoming.kt:179 | No isolated device check established that a separate app can repeatedly invoke the packaged activity with valid read grants to its provider.; The practical retained byte total and any meaningful app-storage availability effect have not been observed. |
| github.github/workflows/pr-gate.yml/pr-workflow-secret-isolation | PR workflow secret exposure depends on GitHub settings | .github/workflows/pr-gate.yml:6 → .github/workflows/build-apk-source.yml:987 | The checkout cannot establish whether GitHub executes a PR-proposed workflow revision with repository/organization secrets available.; The identities permitted to create same-repository PRs and their authorization for the signing key are unknown. |
| linux-bash:session-policy-bypass | Linux shell callback does not visibly enforce session policy | vendor/dsh-linux-runtime/lib/index.js:56 → vendor/dsh-linux-runtime/modules/manager.js:1335 | The active engine tool dispatcher and pre-execute middleware are absent, so source review cannot establish whether a global session gate runs first.; No bounded dispatcher-to-callback observation was possible under the required sandbox. |
| model-capability:active-probe-level-cardinality | Active capability probes lack a plugin-side request-count cap | plugins/dsh-model-capability/src/index.ts:873 → plugins/dsh-model-capability/src/capability-probe.ts:578 | The shipped dispatcher may cap argument cardinality or require approval bound to final arguments; that implementation is not in this checkout.; Provider billing and quota limits are outside this source review; no provider-backed request was made. |
| model-capability:active-probe-user-approval | Active provider probes rely on model-supplied confirmation flags | plugins/dsh-model-capability/src/index.ts:862 → plugins/dsh-model-capability/src/capability-probe.ts:578 | The shipped dispatcher approval policy and argument binding are absent from the checkout and are decisive to whether model booleans can cause a request without user intent. |
| plugins/dsh-android-bridge/src/capability-gate.ts/global-relock-scope | Global capability revoke may leave another agent's tools visible | plugins/dsh-android-bridge/src/capability-gate.ts:385 → plugins/dsh-android-bridge/src/capability-gate.ts:315 | Cordis fiber disposal and model tool-list/dispatch behavior across concurrent agents are not resolved by source.; Stale visibility alone does not prove execution bypass because separate session/channel gates remain. |
| scripts/build-snapshot-013.mjs/overlay-integrity | Overlay tarballs lack source-controlled integrity verification | scripts/build-snapshot-013.mjs:225 → scripts/build-snapshot-013.mjs:257 | The required isolated registry fixture could not run because the OS-enforced sandbox is unavailable.; Source does not establish the intended registry integrity root or who can write the actual build worker cache before consumption. |
| scripts/source-build/run-local-source-chain.mjs/corepack-mirror-bootstrap | Configured npm mirror reaches package-manager bootstrap | scripts/source-build/run-local-source-chain.mjs:280 → scripts/source-build/build-engine.sh:67 | The checkout does not establish whether the pinned npm accepts a plain-HTTP registry or its integrity checks for Corepack.; The checkout does not establish whether Corepack authenticates pnpm bootstrap independently; the isolated tool behavior check did not run. |
| undo-restore:sync-deps-action-confirmation | Dependency sync approval depends on the external tool dispatcher | vendor/dsh-undo-savepoint/lib/index.js:481 → vendor/dsh-undo-savepoint/lib/core.mjs:2103 | The installed @deepseek-ai/dsh-tools dispatcher and active approval configuration are absent, so approval requirement and final-argument binding are unknown. |
| undo.import.aggregate-buffer-cap | Snapshot import retains a large aggregate of decoded ZIP entries | vendor/dsh-undo-savepoint/lib/index.js:620 → vendor/dsh-undo-savepoint/lib/zip.mjs:184 | The deployed Node memory limit and supervisor/process isolation are unknown.; The source does not establish whether a lower-trust party can cause archive selection without meaningful user authorization.; No sandboxed memory measurement was possible. |
| vdisplay-destroy-session-mode-bypass | A lower-tier session may reach virtual-display destruction | plugins/dsh-android-vdisplay/src/index.ts:291 → app/src/main/java/com/snoworwind/pocketharness/VdisplayController.kt:491 | No isolated Android observation established that a lower-tier session can invoke destroy against another session's display and disrupt a running dummy app. |
| vendor-dsh-undo-savepoint:global-settings-overrides-profile-store | Persisted snapshot paths may expose snapshots across profiles | vendor/dsh-undo-savepoint/lib/index.js:485 → vendor/dsh-undo-savepoint/lib/core.mjs:2052 | The source does not establish whether profiles are security principals with isolated model/API access or whether a shared configured snapshot directory is intended. |
| vendor-dsh-undo-savepoint:prune-auto-deletes-message-undo-blobs | Automatic pruning may delete blobs still used by message undo | vendor/dsh-undo-savepoint/lib/index.js:945 → vendor/dsh-undo-savepoint/lib/core.mjs:2586 | The claimed prune-then-undo behavior was not observed in a bounded local fixture because the required OS-enforced sandbox is unavailable. |
| vendor/dshmarketplace-plugin/lib/index.js/install-source-approval-binding | Approval does not visibly bind the marketplace package source | vendor/dshmarketplace-plugin/lib/index.js:1 → vendor/dshmarketplace-plugin/lib/index.js:1 | The host approval dispatcher is outside this source path; it is unknown whether acceptance binds to the same invocation/arguments and catalogue data.; The package manager's source resolution and integrity behavior are outside the reviewed source.; No isolated approval-to-execution harness ran because the required OS-enforced sandbox is unavailable. |

Each retained lead has a bounded local plan and, where applicable, a safe owner-observed deployment check in NEEDS-VALIDATION.md. Do not use real credentials or user data when resolving them.

## Candidates withheld pending fresh final verification

The following fingerprints remain candidate coverage units, not findings. Their Phase 5 reviewers proposed material changes to the source trace, boundary conditions, or local input. The budget left no fresh verifier to approve the corrected record, so each was removed from findings.json.

| Fingerprint | Coverage unit | Phase 5 gap |
|---|---|---|
| EngineManager:shared-diagnostics-incomplete-redaction | Engine logs, audit logs, and console env / streaming-truncation-derived-copy | The reviewer corrected the storage-selection condition and reader boundary; the stricter wording needs a fresh independent final-record verification. |
| LogCollector:secret-redaction-chunk-boundary | Engine logs, audit logs, and console env / streaming-truncation-derived-copy | The reviewer corrected per-read/tick sink semantics and supplied a more exact multi-chunk fixture; that input and trace correction need a fresh independent final-record verification. |
| RootAccess:root-grant-revocation-dispatch-window | AI root grant and privileged shell fallback / ai-root-grant-shell-fallback | The reviewer replaced a private helper as the alleged entrypoint with the model shell dispatch path and clarified AI consent versus Root Manager authorization; the corrected trace needs a fresh independent verification. |
| android-client-failure:console-provenance | Android automatic undo recovery / android-undo-emergency-recovery | The reviewer extended the trace through recovery selection, UndoGate, and the quarantine patch write; the corrected impact path needs a fresh independent final-record verification. |
| android-saf:unbound-primary-document-id | SAF workspace and shared-directory selection / saf-workspace-path-selection | The reviewer moved the untrusted input entrypoint to the SAF result callback and specified a provider-identity mismatch fixture; this materially changes the source trace and needs a fresh independent verification. |
| undo.export.plaintext-encryption-staging | vendor/dsh-undo-savepoint/lib/core.mjs#exportSnapshots / undo-snapshot-export | The reviewer identified a concrete password-conversion failure input after plaintext archive creation; this changes the execution input and needs a fresh independent final-record verification. |

## Hardening notes and positive source patterns

Source review found several useful controls already present:

- Automatic recovery requires shell-observed health for known-good snapshots, binds snapshot IDs to the current install fingerprint, and fails closed when the ownership manifest or snapshot is unavailable.
- Native SafeMode binds mutations to the exact Hard entry and package bundle identities, verifies recovery copies/backups, persists state before live configuration changes, and restarts only a shell-owned process.
- Diagnostic sharing uses a fixed file allowlist, fail-closed sanitization, bounded archive inputs, and read-only URI grants.
- Model capability discovery uses request timeouts, response-size bounds, redirect rejection, and secret redaction. Settings updates use revision compare-and-swap and avoid replacing nonempty user values.
- Linux and Termux shell paths apply configured-root or session-mode checks in their visible code; the Linux tool dispatcher remains outside the checked-in source, so the candidate is not resolved.
- The bridge and host contain path allowlists and reject parent traversal in several workspace paths; the SAF provider-ID-to-primary-path behavior remains a separate unresolved candidate.

The ledger also contains hardening suggestions from hunters. These are not confirmed findings and should be prioritized only after owners resolve the blockers in NEEDS-VALIDATION.md.

## Coverage

- Covered: 24 units.
- Candidate: 20 units (17 final-record-verified needs-validation records plus 6 candidates withheld pending fresh verification; fingerprints may share a unit).
- Blocked: 4 units.
- Deferred: 3 units.
- Blocked units: Main WebView preview opacity; notification event-result idempotency; plugin HTTP route requestRejection semantics; and the undo REST route requestRejection implementation/configuration.
- Deferred units: root ownership repair and maintenance lease lifecycle; reusable engine-base cache workflow; runtime-cache cleanup execution.
- No clean-coverage claim: the final critic found one additional runtime-cache cleanup lifecycle, and no hunter pass fit the remaining strict budget.
- Counts and unit details come from coverage-ledger.json. No paths were intentionally marked out of scope.

See FINDINGS-DETAIL.md for the confirmed-finding result and NEEDS-VALIDATION.md for the source traces, blockers, and safe validation plans.
