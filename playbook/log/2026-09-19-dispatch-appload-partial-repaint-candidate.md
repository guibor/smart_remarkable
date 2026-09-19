# Dispatch/AppLoad partial repaint candidate — Paper Pro 3.28.0.169

Status: **locally qualified and live-preflight eligible; not installed**.

This record covers the full-size Paper Pro (`reMarkable Ferrari`, serial
`0A247209DABC7917`) only. No command from this candidate work contacted or
modified the tablet. The separate deployment owner supplied the read-only live
preflight quoted below.

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
| ten-QMD baseline manifest | `d09c244e58bf4097e273c4175aa29fbe4bfacae5e42d58a9f73f25f737d4fd04` |
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

This proves eligibility at that instant. It does not prove the candidate is
installed or that handwriting is faster.

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
