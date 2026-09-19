# Dispatch document-menu candidate — Paper Pro 3.28.0.169

Status: **device-free qualification passed; not installed**.

This record covers only the full-size Paper Pro (`reMarkable Ferrari`, serial
`0A247209DABC7917`) on firmware `3.28.0.169`, build `20260806095513`. The work
in this record made no tablet connection and performed no deploy, commit, or
push. The deployment owner separately reported the live tablet healthy with
read-only root, stable xochitl, eleven QMDs, the accepted Dispatch latency QMD,
and final eraser-capable Dispatch executable. Those observations are a future
prepare precondition, not evidence that this shortcut is installed.

## Integration decision

An AppLoad `external.manifest.json` can expose an application tile but has no
hook for xochitl's document three-dot menu. The safe route is therefore a
separate exact-firmware QMLDiff, not a manifest edit and not a replacement
AppLoad binary.

The functional QMD has three small hooks:

1. `/qt/qml/xofm/libs/toolbar/qml/SettingsMenu.qml` adds a `Dispatch` row with
   stock `qrc:/ark/icons/send`. Both `visible` and `shouldShow` require exact
   `documentType` `note` or `pdf`, excluding EPUB/ebook even on inserted note
   pages.
2. `/qml/common/Values.qml` carries a content-free
   `dispatchOpenRequested()` signal.
3. `/qml/device/view/main/MainView.qml` creates a lazy controller only after a
   tap and only while a visible unlocked document view is active.

The external `DispatchLauncher.qml` uses the exact installed AppLoad v0.5.0
contract. It validates `external::remarkable-dispatch`, recursively scans the
shaped window tree, reuses exactly one healthy Dispatch window, and rejects
stale or multiple windows. A new launch receives the real
`navigator.apploadVKB`, native 1620×2160 dimensions, full-screen state, and the
exact four-argument call `launchExternal(id, qtfbKey, [], ({}))`; only a
positive PID is accepted. It never uses the process-wide broadcast launcher.
It maximizes a newly created non-full-screen window only once because AppLoad's
method is a toggle, and it never toggles an already-full-screen reused window.

The controller loader uses z=30000 while AppLoad's Dispatch window uses
z=20000. This keeps a bounded launch error visible without changing the
latency patch. The existing partial-repaint QMD remains an independent file and
is checked byte-for-byte throughout build, composition, install simulation,
and rollback.

## Exact artifacts

| Artifact | SHA-256 |
| --- | --- |
| functional source QMD | `561630343088049c58a35b4ae7143471dfcdcd703b267c87a2e1a86220d95819` |
| inert source QMD | `8265c28ff41aa634915e3ce99691fea3b65b08366868f386731077a0197300ec` |
| functional compiled QMD | `883f275b59736e92cf55e0d49c39a649ed3ea66f2bb7500a88d54659f655aece` |
| inert compiled QMD | `5a685b3142a339b370436c8f6563344d4b4684ddbab3f288f812ab6087a32fc1` |
| external launcher panel | `bf05247511a245fdc84fae41e03a8a2b749ad1d3ef622470a59da76646e8b0f7` |
| eleven-input baseline manifest | `0f19ada5bd92364e61a2abeefae79a14171fbebc0f498813123fe3e60d7eed9d` |
| accepted latency QMD, preserved | `1eb2037f28c9891fbdc4a97d1e2916b8e923fe04004ae1ced03b5de73f59a60e` |
| composed patched AppLoad `window.qml`, preserved | `af8d378b319e6ad3633ae729425f5c4dbd3d385100835a7e23f90e8f7f9eafa7` |
| installed AppLoad preimage | `9a6d55d21852976e7c6cf34b1d09e5ca6e428547aa8c03d53d91b1bb9ff87b9a` |
| embedded installed AppLoad QMD | `274632b775df4005e06252fee0697a350d98224bdde9009da1616dfa0249a3f5` |
| final Dispatch executable required by installer | `f9896596941caa77ae9a1ba88da8e1ca09cc4f08f0f52560b800b54efe8875cc` |
| unchanged Dispatch manifest | `4c0b0adba890becb4aa85678c3dc345a9d8909f65a5b9734b809b4746341a32c` |

The source and compiled QMD identities are deterministic against the reviewed
firmware hashtable. The inert artifact inserts the same disabled stock-icon row
but has no signal, loader, or launch code.

## Device-free evidence

The following commands completed successfully from this worktree:

```sh
./ops/build-dispatch-document-menu-candidate.sh
./ops/dry-run-dispatch-document-menu-transaction.sh
```

The complete test:

- extracted 1,349 resources from exact stock xochitl and 21 resources from
  exact AppLoad;
- included AppLoad's embedded QMD plus the exact eleven live QMD inputs;
- applied the functional candidate in actual filename order and all twelve
  combinations of AppLoad-first/AppLoad-last with every relative
  Dates/RMStream/Dispatch order;
- applied the inert candidate to the same exact stack;
- parsed every emitted QML file with `qmlformat`;
- retained Dates, RMStream, BetterTOC and exact patched AppLoad window bytes;
- proved the QMD contributes zero output on `3.28.0.168`;
- passed the offscreen QML lifecycle harness for no-auto-launch, wrong/missing
  and ambiguous model entries, exact launch arguments/environment, native
  dimensions, healthy window reuse, stale/multiple window rejection, virtual
  keyboard cleanup, launch exceptions/non-positive PID, and component
  load/create failure;
- simulated baseline → inert → functional → inert → exact baseline and
  preserved latency QMD `1eb2037f...9a60e` at each cut;
- built the exact six-file stage receipt and proved a one-byte candidate change
  fails verification; and
- reported `device_contact=none`.

## Guarded future transaction

The target-side installer pins the Ferrari identity, exact firmware/build,
stock xochitl, Xovi, QRR, broker, AppLoad, framebuffer-spy, hashtable,
ReMagic/start/stock helpers, vendor unit and override, service tree/symlinks,
empty hook directories, observed AppleDouble files, every `.qmd`/`.qrr`/`.rcc`
composition input, Dispatch app directory/manifest, and final executable. It
refuses a running Dispatch process or any competing known mutation unit. Its
before/rechecked snapshots include every mutable surface used by activation or
stock rollback.

`prepare` creates only root-private recovery data and a safety archive. The Mac
must copy that archive off-device, compare the hash, and write the exact
acknowledgement before `activate`. Activation can run only in its named
transient unit, arms an independent 180-second rollback, writes through
recovery-directory temporary files, invokes the existing pinned ReMagic
watchdog, and requires exactly twelve unique load markers. HUP, INT, TERM, any
failed assertion, or the independent timer requests rollback.

Rollback freezes the transaction before inspecting bytes. An inert rollback
removes only the exact inert QMD and exact launcher panel, including the safe
empty-panel-directory interruption state. A functional rollback removes only
the exact functional QMD and atomically restores its exact saved inert
predecessor; the panel was never changed. Unknown bytes are preserved and
marked for manual inspection. Both paths independently rehash the accepted
latency QMD and all eleven baseline inputs, then request the pinned stock
xochitl path after any activation attempt. Xovi is intentionally not
reactivated automatically after rollback.

After a fresh read-only preflight and explicit deployment approval, the two
separate commands are:

```sh
ops/deploy-dispatch-document-menu-candidate.sh \
  VERIFIED_FERRARI_IPV4 --inert --activate

# Only after physical notebook/PDF/EPUB visual acceptance of the printed ID:
ops/deploy-dispatch-document-menu-candidate.sh \
  VERIFIED_FERRARI_IPV4 --functional \
  --confirm-inert-visible=INERT_TRANSACTION_ID --activate
```

Do not skip the inert phase, reuse an old stage, copy either QMD manually, or
start `/home/root/xovi/start` directly.

## Physical acceptance still required

After the inert canary, verify the disabled row appears once with the stock
send icon in a notebook and PDF, does not appear in an EPUB, and the stock UI
remains stable. Only then promote its exact transaction ID.

After functional promotion, verify one tap launches Dispatch, a second tap
reuses rather than duplicates it, the error strip is not present, low-latency
writing and erasing still work, coordinates and stroke quality remain correct,
and exit is clean. Require twelve exact QMD load markers, no affected-resource
QML errors, one stable xochitl PID, `NRestarts=0`, inactive temporary guards,
and read-only `/`.

## Icon decision

The document-menu route intentionally installs no icon asset; it uses the
stock send SVG, which is already a 48×48 monochrome resource. The separate
AppLoad tile keeps its existing PNG. If that tile is redesigned later, use a
512×512 RGB/RGBA black/white icon with 40–48 px clear margin, minimum 24–32 px
strokes, and a simple note/handwriting plus send-arrow motif. A tile refresh is
outside this transaction and must not be coupled to the QMD promotion.
