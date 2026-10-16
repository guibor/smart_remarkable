# Dot integration checkpoint — 2026-10-16

Branch: `beta/pro/3.29.0.153`, as requested. This is **not a tablet release**.

## What is implemented

- Dedicated actual-Dot HTTPS selection engine, not an API-model substitute.
- Same-frame selected/current-page PNGs with action, notebook title, page ID,
  page number and viewport completeness; source is explicitly Smart Remarkable.
- Canonical cross-language request fingerprint; same-ID/body retry after
  interrupted acceptance; bounded polling and reply digest validation.
- Send-only never invokes the local answer callback. Dot cannot invoke legacy
  arbitrary SVG/erase tools or acquire the legacy physical-pen injector.
- Strict private config parser and a firmware/model-guarded buttons-only runner.
- Single-view-only QMD controls, persistent page-owner lease, invalidation on
  navigation/new selection/unsupported view/expiry, and distinct fresh final
  challenge. The stock selection child can be destroyed without losing ownership.
- Experimental fixed-size print layout, bounded glyph tracing, RTL embedding,
  blank-area/view/input guards. Its pen emitter remains disabled.
- Shared server interpretation policy deployed by the Dispatch owner at commit
  `2156761`, release `20261016-dot-selection-v6`. It applies to ordinary Dispatch
  and both selection actions; model/history remain owned by actual ChatGPT Dot.

## Verification and limitations

- 109 Rust library tests and 5 application tests passed. Final all-target
  `cargo check --offline --all-targets` passed (pre-existing warnings remain).
- Environment parser tests and shell syntax checks passed.
- Exact `.153` compatibility and complete 13-QMD composition passed in both
  supported native-last/native-after-TOC orders; all generated QML parses.
- Actual persistent-owner JS tests cover destroyed selection, two phases,
  replay, navigation away/back, modal/context change, new selection, expiry,
  missing challenge and send-only non-writing.
- Pure English/Hebrew rendering previews were generated; Hebrew direction and
  punctuation checked. Mac font fallback is not exact tablet-font qualification.
- Earlier cross-built Linux examples ran only the no-writing virtual-pen probe.
  Generated cross-build caches were subsequently removed to relieve Mac disk
  pressure. Source and sealed pre-existing release inputs were preserved.

### Live Dot transport probe

`examples/dot-roundtrip.rs --send-synthetic-test` sent one explicitly labelled
synthetic image, not real notebook data. The private key traveled via an SSH
pipe, never command arguments, checked-in config or tool output.

Request ID: `67d75de6-5afc-4414-a959-069992e62d78`.

The real API accepted the request with a valid matching fingerprint. Read-only
server inspection reported `awaiting_dot`, `answered=0`, notification `sent`,
attempts `1`. The client exhausted its 180-second local reply window without a
verified reply and correctly failed the end-to-end test. No reply was fabricated,
no subscription was rebound, and no notebook insertion was attempted. A later
Dot response may still enter normal conversation/PDF history. This checkpoint
does not establish answer, cloud delivery, physical sync or phone visibility.

### Local renderer qualification blocker

The no-pen-down probe created `Smart Dot answer pen` as `/dev/input/event4` for
ten seconds. Running xochitl opened event0–event3 but **did not open event4**.
No position or pen-down events were sent. The virtual device disappeared after
the probe. Its executable and the unused pure-layout executable were removed
from `/tmp` after verifying their known SHA-256 values.

Stock QML provides root-document text editing, not a proven free-position text
box. HWC deletes source items and uses `MergeWithPreviousAction` for conversion;
that undo grouping must not be copied for independent answers. Native
`addDrawingLine` consumes native stroke objects; no safe JS point-array factory
has been qualified. Do not enable the experimental emitter, inject into the
physical pen as a shortcut, or write directly into live notebook files.

## Device preservation

Verified Paper Pro / Ferrari at `10.100.102.101`, firmware `3.29.0.153`.
UI PID `15545`, automatic restarts `0`; native owner and watchdog
`20261016T094539Z-2` both active after the probe. No reboot, UI restart, package
replacement, private setting change, notebook write, permanent unit or boot
change was performed. Move untouched. Separately installed Dot app belongs to
its own task/repository and must be preserved in subsequent inventories.

## Next implementation gates

1. Diagnose why the delivered event did not yield an actual Dot reply, without
   impersonating Dot, silently changing its conversation, or resubmitting the
   same selection under a new ID. One server notification is not acceptance.
2. Qualify a genuinely additive local answer path on an expendable test notebook.
   Preserve source ink/text, undo semantics, user input and exact page identity.
3. Only then package the worker/scripts/private config and new QMD together.
   The current native supervisor pins old Smart files: do not hot-swap them.
4. Normally stop the current native controller, verify recovery to healthy base,
   perform a separately guarded Smart base update with new preimages/rollback,
   and capture a **fresh** base for a newly sealed Companion/native cohort.
   Never edit/replay the old immutable handoff or use the `.169` updater.
5. Test real lasso → Dot → guarded local answer and distinguish it from normal
   PDF fallback. Port to Move separately after Pro acceptance.
