# Dispatch/AppLoad partial repaint candidate — Paper Pro 3.28.0.169

Status: **installed and machine-accepted; physical handwriting acceptance is
pending**.

This record covers the full-size Paper Pro (`reMarkable Ferrari`, serial
`0A247209DABC7917`) only. The local build and qualification made no device
call. The separate deployment owner supplied the read-only live preflight,
handled the failed-closed attempts described below, and completed the corrected
machine canary. No statement here substitutes for physical pen acceptance.

## Why this candidate exists

The current Dispatch client already batches input and emits small QTFB damage
rectangles. The exact installed AppLoad binary still embeds
`allowScaling: true`, and its native scaled-update path performs integer
division before multiplication. A partial pen rectangle therefore collapses
to a null rectangle and Qt treats it as a full-item repaint. Replacing AppLoad
with an unreleased or locally rebuilt binary would change the trust boundary
for every AppLoad application, so this candidate changes one QML binding only.

The binding retains scaling unless the window is exactly named `Dispatch`, is
full screen, disables windowed mode, has an attached QTFB key, and reports
source width/height exactly equal to the device width/height. This is both the
performance switch and the coordinate-safety guard.

## Exact local inputs and outputs

| Artifact | SHA-256 |
| --- | --- |
| stock xochitl 3.28.0.169 | `43a9d5d0acc5b998264c16586e11b848f3b83d2d63b5fd322b09c0977d94d3d4` |
| promoted firmware hashtable | `ecb0cfbd6828c374e48139064436a12f2c04778a90192b9dd85887edbdbe256a` |
| installed AppLoad preimage | `9a6d55d21852976e7c6cf34b1d09e5ca6e428547aa8c03d53d91b1bb9ff87b9a` |
| extracted AppLoad `window.qml` | `848b234015d2d8671648b6b661e57cdd3b51d80c537c38cb053e503cf3a95c30` |
| embedded installed AppLoad QMD | `274632b775df4005e06252fee0697a350d98224bdde9009da1616dfa0249a3f5` |
| Dispatch manifest | `4c0b0adba890becb4aa85678c3dc345a9d8909f65a5b9734b809b4746341a32c` |
| installed Dispatch executable | `d700b7c8c3df4d5750d0844169a0d50324f9d7fd2a8ac4f8667a40efa26ceab4` |
| source QMD | `424b1ca4859e38de5dc07e5e33a7c18a532a61fb821edbe9a3cbce3985e12e6e` |
| compiled QMD | `1eb2037f28c9891fbdc4a97d1e2916b8e923fe04004ae1ced03b5de73f59a60e` |
| current Dates QMD | `2d4681414ac00b534b2f21d179365601ce9e876c7cfbf6c6c8d25a2f8738e580` |
| ten-QMD baseline manifest | `1e89ad1fcde7920760ed2a7d44d892e9a0be46acc5d5e05ffaac7d087fbce138` |
| composed patched `window.qml` | `af8d378b319e6ad3633ae729425f5c4dbd3d385100835a7e23f90e8f7f9eafa7` |

The exact baseline is
`xovi-qmd/dispatch-appload-partial-repaint-3.28.0.169.baseline.sha256`.
It contains the seven established package `.169` QMDs plus the current inert Smart
QMD, Dates QMD, and RMStream QMD—ten entries total.

## Local validation completed

`ops/dry-run-dispatch-appload-latency-transaction.sh` completed with
`dry_run=passed` and `device_contact=none`. It:

1. rebuilt the compiled candidate from the exact AppLoad ELF and compared it
   byte-for-byte;
2. re-extracted 1,349 stock resources from the exact xochitl and 21 AppLoad
   resources from the exact extension;
3. rejected any drift in the hashtable, Dispatch binary/manifest, embedded
   AppLoad QMD, current ten QMDs, QMLDiff, or qrex inputs;
4. composed the complete stack with the candidate both before and after
   AppLoad's embedded QMD and obtained identical output;
5. parsed all 29 emitted QML files with `qmlformat`;
6. simulated atomic candidate install and exact rollback removal in a temporary
   qdir; and
7. built a reviewed stage manifest and proved one-byte AppLoad, hashtable, and
   Dispatch changes are rejected.

The exact ReMagic wrapper has no QMD-count allowlist. It starts Xovi, samples
one stable `xochitl` PID, and captures a bounded journal. Saved evidence from
the same QRR binary contains one deterministic `[qmldiff]: Loading file ...`
line for every current QMD and a processing line for
`/appload/qml/window.qml`. The guarded live postcheck therefore requires
exactly eleven load lines, every baseline name once, the new candidate once,
and the window processing marker; a generic AppLoad-success line alone is not
enough.

## Read-only live preflight supplied by the deployment owner

At corrected Wi-Fi address `10.100.102.101`, the pinned host fingerprint
matched before key authentication. Firmware, serial, build, xochitl, Xovi,
QRR, broker, AppLoad, framebuffer spy, hashtable, ReMagic/stock helpers and the
current ten-QMD inventory matched the local contract. The newly installed
Dispatch executable was the exact `d700b7...eab4` regular file at
`0:0:755`; its application directory was `0:0:755`; its manifest was the exact
`4c0b0a...1a32c` regular file at the deliberately preserved `501:20:644`.
The exact `start` script was `bf15dfd...9dc`; its source service tree contained
only the one `xochitl.service` directory plus the observed pinned AppleDouble
file. The service directory contained the QRR config `6036f777...ffd`, exact
absolute `extensions.d` and `exthome` symlinks, and the three observed pinned
AppleDouble files. All four root-owned pre/post start/stock hook directories
were empty. The vendor unit `23f537cf...9566` and stock override
`a9432caf...82d1` are separately pinned because rollback restarts through
them. `xochitl` remained PID `306456`, `NRestarts=0`, and `/` remained
read-only.

The first guarded `prepare` subsequently stopped safely before activation:
the exact live extension directory also contained three longstanding
AppleDouble regular files, `._appload.so`, `._qt-resource-rebuilder.so`, and
`._xovi-message-broker.so`, each `0:0:755`, 163 bytes, and SHA-256
`a502dbe0e569c3718c449b86480d0cd4cdc23e3a450814de360e5b0a5e08c5d3`.
The contract now admits and snapshots exactly those three names alongside the
four hashed runtime libraries. It still rejects `._framebuffer-spy.so` and any
other directory entry. That failed prepare did not install the candidate or
restart `xochitl`; a new full preflight is required before another prepare.

A second exact mismatch was also diagnosed without activation: the separate
Dates update at 11:16 UTC had legitimately replaced
`notebook-date-index.qmd`. Live and local artifact bytes both hash to
`2d4681414ac00b534b2f21d179365601ce9e876c7cfbf6c6c8d25a2f8738e580`;
the live file is `root:root:0600`. The ten-QMD baseline and offline composition
now use that artifact, and the device gate pins both its hash and observed
metadata. Every other QMD name/hash remains unchanged and exact.

This proves eligibility at that instant. It does not prove the candidate is
installed or that handwriting is faster.

## First guarded activation and exact false-negative

Guarded transaction `20260919T112530Z-28327` prepared recovery at
`/home/root/.smart-remarkable-recovery/dispatch-appload-latency/` and copied an
off-device safety archive with SHA-256
`adc1c016032f6fcca0109d7bc0e31f645e3597f93b3c11bb5fb47fd56c0a81de`.
The live wrapper then reported `xovi_live_test=passed`, one stable `xochitl`
PID `313901`, and `NRestarts=0`. Its captured journal contained exactly eleven
QMD load markers, every ten-QMD baseline name once, the candidate once, and
`Processing file /appload/qml/window.qml...`; no failed-load or candidate QML
error appeared.

The transaction nevertheless exited 1 immediately after the next ten baseline
checksum lines and before writing `after.snapshot` or `committed`. The failing
assertion was the final inventory comparison in `verify_qmd_set candidate`.
Bash variables are dynamically scoped unless declared `local`:
`verify_qmd_set` first assigned its eleven expected filenames to `expected`,
then called `exact_root_file`, which assigned the candidate SHA-256 to the same
caller-visible variable. The comparison therefore received the candidate hash
plus filename instead of eleven filenames. The EXIT handler armed the outer
rollback; it removed only the exact candidate and restored stock mode
successfully. This was a verifier false-negative, not evidence of a candidate
load or UI crash.

The corrected installer makes helper scratch variables function-local. Its
regression extracts and executes the real `hash_file`, `exact_root_file`,
`exact_owned_file`, `qmd_names`, and `verify_qmd_set` functions against the
exact reconstructed candidate inventory, and also proves that a caller's
`expected` sentinel survives. The failed stage was not reused: the installer
bytes and manifest changed, and the next activation used a newly reviewed,
fully qualified guarded transaction. Its successful machine receipt follows;
physical latency remains unproven until the user performs the A/B sample.

## Corrected guarded activation and machine acceptance

Fresh guarded transaction `20260919T113653Z-36865` used the corrected installer
and a newly reviewed stage rather than reusing the failed transaction. Its
stage manifest was
`0d2e3557a60a05285c34d90b23d2901d87c05a38eec5d9eb8fb4214ace8c9ea5`;
the independently downloaded off-device safety archive was
`8e1f35cd301e4752919d5386c96bfda633eb91cea4f3b4008a19c2f1cebc05bf`.
The candidate remained byte-identical at
`1eb2037f28c9891fbdc4a97d1e2916b8e923fe04004ae1ced03b5de73f59a60e`.

The transaction committed on `xochitl` PID `316882`. The retained runtime and
captured evidence established:

- exactly eleven QMD load markers, with every baseline QMD and the candidate
  present once;
- exactly one `/appload/qml/window.qml` processing marker and the AppLoad
  success marker;
- all pinned Xovi, QRR, broker, AppLoad, and framebuffer-spy mappings present;
- `NRestarts=0` and `/` mounted read-only; and
- inactive transaction, outer rollback, and nested ReMagic safety units, with
  no deployment lock remaining.

This is machine acceptance of installation and process health. It is not
evidence that the user-visible objective is met. The user must still perform
the repeatable pen sample and accept latency, stroke thickness/clarity,
coordinate alignment, clean Dispatch exit, and unchanged behavior in at least
one non-Dispatch AppLoad application. If any of those physical checks fails,
the candidate must not be considered fully promoted.

## Guarded promotion and rollback

Do not manually copy the QMD or run `/home/root/xovi/start` directly. After an
explicit promotion decision, use only:

```sh
ops/deploy-dispatch-appload-latency-candidate.sh VERIFIED_FERRARI_IPV4 --activate
```

The controller reruns every local gate before network access, stages only the
candidate, baseline, installer and rollback bytes plus their checksum manifest,
and pins the Ferrari host key. Device `prepare` revalidates the complete live
preimage, creates a root-private safety tar, and stops. The controller downloads
that tar and independently verifies its SHA-256 before acknowledging it.

Device `activate` must run as its named transient systemd unit. It rechecks the
unchanged snapshot, arms an independent 180-second rollback timer, atomically
adds the exact QMD, then invokes the pinned ReMagic wrapper, whose own stock
watchdog remains active. HUP, INT, or TERM exits the transaction and causes the
EXIT handler to arm rollback; it cannot resume mutation after a caught signal.
The rollback first kills the named transaction, removes only the exact
candidate, and requests the independently hashed stock script. An unknown
target is preserved for forensics while stock mode is still requested. Xovi is
not automatically reactivated after rollback.

## Remaining physical gate

Before activation, record a repeatable 5–10 second handwriting sample. After
the guarded canary succeeds, repeat the same sample and verify:

- materially lower pen-to-ink delay and no thick, broken, shifted, or clipped
  strokes;
- exactly native input alignment across the full canvas;
- clean Dispatch exit with no lingering process;
- the candidate filename appears exactly once among exactly eleven QMD load
  markers, no QRR failed-load marker appears, and the AppLoad window resource
  is processed;
- `xochitl` is stable with `NRestarts=0`, all extensions remain mapped, and
  `/` remains read-only; and
- another AppLoad application still uses its unchanged scaling behavior.

If any point fails, let the watchdog restore stock mode. Do not keep the
candidate based only on a successful restart or a rendered screen.
