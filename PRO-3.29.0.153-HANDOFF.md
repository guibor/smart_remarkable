# Pro .153 Smart/Dispatch local handoff

Status: **full eleven-QMD base qualified locally; controller sealed and frozen**.
No tablet/server connection or write was performed by this task. The maintenance
coordinator is the sole publisher/activator.

## Final artifacts and acceptance (2026-10-16)

Paths below are relative to `/Users/mdf/code/.worktrees/smart-remarkable-pro-3290153`.

- Controller: `ops/activate-pro-3.29.0.153-fullstack.sh`, SHA-256
  `e741290cb979b6f90ac13bd7e857ddc8b5d28470650d667ae6688407c7da022c`.
- Eleven-device-relative manifest: `ops/pro-3.29.0.153-qmd.sha256`, SHA-256
  `57a56233d20187ce7253d3f08a796056970bbeb2d9cb4a1632923bf12b9076ce`.
- Twelve-absolute-input manifest: `build/pro-3.29.0.153/ordered-full-stack.sha256`,
  SHA-256 `feaa3e971c9a9dd4152f7f9ff35fdd2f037cb04d4f014d529a301134e49a1b79`.
- Input resources: `build/pro-3.29.0.153/inputs`; eleven runtime QMDs:
  `build/pro-3.29.0.153/qmd`; report: `build/pro-3.29.0.153/qualification.json`.

All four full-stack variants (AppLoad first/last, apps last, Dates preview)
produce 29 resources and pass composition and semantic checks. Dispatch Qt,
Dates source/UI/flash/creation, and RMStream direct-control harnesses pass.
The controller provenance and .153 policy harness pass, including 32 atomic
races. Final Dates creation uses `NDI_COMPOSED` and `NDI_PREVIEW_COMPOSED`
pointing to the actual full-stack outputs, not the absent sibling default paths.

The coordinator subsequently reported the exact controller/base activated and
committed: UI PID 6240, Dates PID 6231, zero automatic restarts, all eleven QMDs.
This is coordinator-reported machine acceptance, not an independent device
check here or physical UI acceptance. Native overlays remain separately owned.
The coordinator retains complete stage and off-device backup receipts; abbreviated
hashes in its notification are not reproduced as complete verification evidence.

No Move qualification is supplied. Chiappa's independent QRR-only stack does
not qualify AppLoad, Dispatch/Smart binaries, or Pro private settings for Move.

## Table and app qualification

The table and payload-input blockers in the historical preparation notes below
are resolved. Both independent runtime dumps sort to SHA-256
`deb95682d991670d7dc006ddbb8e102ed9423f2f76ae1c878ad736f2885d8879`,
independently recomputed here. The selected raw .153 table is pinned to
`927a5cac7fbb4031a0f78c2ec59bc795c499e330d5029aaa993e99e7dd917417`.
Coordinator receipt: `profiles/pro-3.29.0.153-table.json`. All app-hook tests
pass against it with `structuralOnly:false`; candidate hashes below are unchanged.

Four runtime app outputs are ready in `build/pro-3.29.0.153/qmd/`:

| File | SHA-256 |
| --- | --- |
| dispatch-document-menu-3.29.0.153.qmd | `d8a2e16cc478d28325ecb17acbd885c2933e85b4c81ea4aecca1e858f00dcddf` |
| notebook-date-index.qmd | `3b8af61be70e7ba44027ec03487126b4881c76c441388d4710dbae3922371ac7` |
| rmstream-shortcut.qmd | `2df377801c4c577faaa7a85fff6851712e3fe8bbc5b77e69b78ef60f6422feb5` |
| smart-remarkable-llm.qmd | `5a39997620a99b2ef8fe54e5c166034df9861e3c2f78a9dfe711e10a4b7c622c` |

All accepted client, manifest, launcher, worker, Dates and RMStream panel
fingerprints were freshly verified unchanged by the coordinator. The supplied
Dates path was corrected to `build/`; no sibling files were changed here.
The seven final package peers were then composed successfully, the exact
manifest pinned, and the disabled entry point removed. The policy test refuses
pending pins and passes on the final frozen controller above.

## Earlier preparation notes (superseded by update above)

Worktree: `/Users/mdf/code/.worktrees/smart-remarkable-pro-3290153`.
Branch: `beta/pro/3.29.0.153`, based on .152 commit `c672ade`.
Target: Ferrari 3.29.0.153, build `20261009073202`, xochitl SHA-256
`9d6d844d793b6242345c7c25667451620c48b2cc28986a21049fa8d534042dd4`.

## Prepared artifacts

- `xovi-qmd/llm-button-inert-3.29.0.153.source.qmd`: both Smart buttons disabled,
  no handler/worker/network action. Functional promotion remains out of scope.
- `xovi-qmd/dispatch-document-menu-3.29.0.153.source.qmd`: functional notebook/PDF
  menu, existing accepted `qml/DispatchLauncher.qml` unchanged.
- `xovi-qmd/dispatch-document-menu-inert-3.29.0.153.source.qmd`: disabled menu canary.
- `ops/activate-pro-3.29.0.153-fullstack.sh`: exact new stock/version guard,
  inherited backup/owner/watchdog/atomic commit/stock rollback, additionally
  preserves surviving Dispatch profiles and icon in the settings hash snapshot.
  All entry actions currently exit 78 before accessing a device path. Table and
  eleven-QMD manifest pins are explicit PENDING sentinels.

Generated QMDs and `qualification.json` are in
`build/pro-3.29.0.153-dispatch-smart/`. **Diagnostic only**, because the freshly
captured .153 runtime table was not yet available. Do not publish them until
rebuilt/rechecked against the sealed .153 table:

| Candidate | Diagnostic SHA-256 |
| --- | --- |
| inert Smart | `5a39997620a99b2ef8fe54e5c166034df9861e3c2f78a9dfe711e10a4b7c622c` |
| functional Dispatch menu | `d8a2e16cc478d28325ecb17acbd885c2933e85b4c81ea4aecca1e858f00dcddf` |
| inert Dispatch menu | `81ef14b13a01698c05996aa30bf1e8c792528c002235e8634d0dca2cddea57c5` |

AppLoad0.6 native scaling/repaint remains enabled; no historical Dispatch
partial-repaint QMD belongs in the eleven external QMD base. Restyle/Companion/
WebPDF native overlays are separate follow-on controller ownership.

## Local checks completed

The five affected extracted resources are byte-identical between the supplied
.153 extraction and the exact .152 capture. Source changes are restricted to
the version guard. Generated candidate composition passes AppLoad-first/last,
functional/inert menu variants, QML parsing, .152/.169 wrong-version rejection,
and offscreen Dispatch lifecycle tests. Resource and candidate hashes are in
the JSON report. Existing .152 activation policy/race harness passes; the new
draft check proves the safety functions are byte-identical and all four entry
actions reject before touching device paths.

```sh
RM_PRO_HASHTAB=/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.29.0.152/hashtab \
  node tests/pro-3.29.0.153-dispatch-smart.mjs --structural-only
RM_ACTIVATION_VERSION=3.29.0.152 node tests/pro-3.29-activation-policy.mjs
node tests/pro-3.29.0.153-controller-preparation.mjs
```

The old table is deliberately explicit and diagnostic-only. The default new
test mode fails closed until its .153 runtime table hash is sealed in source.
Qt checks require working local CPU-feature detection; the restricted macOS
sandbox returned a false missing-NEON error, while the normal local check passed.

## Needed to finish sealing

Follow-up: the coordinator reverified all accepted Dispatch/Smart/launcher,
Dates writer/panel/helper and RMStream panel hashes unchanged. Four app-owned
QMDs and inert variants now build against the first .153 table
`927a5cac7fbb4031a0f78c2ec59bc795c499e330d5029aaa993e99e7dd917417` under
`build/pro-3.29.0.153/`. This is still candidate-only, pending canonical-equal
capture confirmation and the seven package peers. The actual Dates generated
directory is `build/`, not `.build/`; the test consumes it without modifying
the Dates worktree.

```sh
node tests/pro-3.29.0.153-apps-test.mjs --candidate-table --build-only
```

1. Fresh .153 runtime-derived `hashtab`, exact hash and capture receipt. Extraction
   alone is not that receipt.
2. Exactly seven final .153 package QMDs, retaining the accepted Gestik reset-view
   and Quick Timer features; final filenames and hashes. No native overlays in
   this directory.
3. Qualified .153 Dates and RMStream source/build paths (or final candidate QMDs)
   plus confirmation of their retained external payload hashes. The prior pins
   are not permission to overwrite newer live files.
4. Fresh accepted client/manifest/launcher/Smart-worker hashes and private-state
   preservation inventory from the coordinator. Current Dispatch client pin is
   `c4de9b5fce62c7fc62e24a2213aa1e863c410bb9efd2ce07ef64ef3bfe54bb72`;
   its manifest is `0b7ad7291071935a9e3c1b5e2e35820c77ed458f125cab9d97dda4d0e990c021`.
   Preserve the Dot-first profile and current credentials, not an old bundle.

Vendor unit `23f537cf...f9566`, override `a9432caf...082d1`, XOVI/QRR/AppLoad/
framebuffer/broker and Qt providers were reported freshly unchanged by the
coordinator. The controller still checks full exact hashes and must not have
these checks relaxed. Its failure-target shadow derivation remains byte-preserving.

After inputs arrive: rebuild, complete eleven-external-plus-embedded composition,
seal manifest/table pins, remove the explicit disabled-entry banner only after
tests pass, run the controller policy/race harness on the new file, and supply
exact hashes to the coordinator. Live recovery and physical checks remain
coordinator-owned; no server deployment is required by this firmware change.
