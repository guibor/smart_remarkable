# Pro 3.29.0.148 local integration candidate

This branch is not deployed. It contains no device/server mutation. Exact stock
SHA-256: `4f433281c71a29d07921665b4724420735f3c88aceb431067f3a432b3f89f6a4`.
AppLoad v0.6.0 source: `7ec0830c97570bf5c607f3f458ea78edfa03e5a3`.
Release: <https://github.com/asivery/rm-appload/releases/tag/v0.6.0>.

## Upstream review

The release archive SHA-512 is
`754c5add1c34e73642c3ba823b0e9333165cf32bd2aea2331b38301f3c357954ec2f764c71409be38dfbdca20c3077c9eda0189c22af6344154c9d22b1f4b076`.
Library SHA-256 is
`5b2dd6c066da6932d88a1d62be1068ca5ba751f481636dd51f727221db62e3ad`;
embedded QMD is
`69147587485e8f90336f8e504f48ffebb39212b47572d9cd990b7cfd12ec692a`.
The extracted QMD matches the tagged source bytes. Binary disassembly confirms
`markedUpdate` calls the new multiply-before-divide rounded rectangle conversion.
Keep native `allowScaling: true`; remove our old partial-repaint QMD entirely.

All 202 Qt imports match copied 3.29 Qt 6.10.3 exports. Version requirements
Qt_6.10, GLIBC <=2.34 and GLIBCXX <=3.4.32 fit the target. This is symbol-level
evidence only, not loaded-module or physical-screen acceptance. Upstream has
3.29 adaptation while Vellum still declares a pre-3.29 range; neither warrants
automatic activation on the new stock PIE binary/recovery service contract.

External app aspect ratios are now numeric (Dispatch 0.75), external width is
0 and supportsRotation defaults false. The four-argument `launchExternal` API
and QTFB Init/UserInput layouts are unchanged. New smaller packet states 7/8
are safely ignored by the accepted client's non-input handling. The launcher
now matches native canvas focus and ownership-aware keyboard cleanup.

## Accepted restoration boundary

- Dispatch executable must remain
  `f9896596941caa77ae9a1ba88da8e1ca09cc4f08f0f52560b800b54efe8875cc`.
  The standalone repository's newer profile-client artifact is source-only and
  not a substitute. Read its actual saved/live accepted artifact, not dist/.
- Dispatch manifest must remain
  `4c0b0adba890becb4aa85678c3dc345a9d8909f65a5b9734b809b4746341a32c`.
- Smart worker remains
  `4c9605f7f9e6be898230c3c5d607fa36fc1ce815ad85cc8f6f04e625be314f1e`.
  Only the two inert visual buttons are in the new QMD stack.
- Keep Dates r6 writer/panel/helper and all history; keep RMStream direct
  controller and v0.1.5 app bytes. No AppLoad replacement app duplicates.
- Preserve root-only Dispatch settings.env, Smart .env and settings.conf,
  restricted tunnel key/known_hosts, and each tablet's separate Gestik settings.

Smart upstream main remains `cb787065281b7211b012bd5e5d9be751fe5adaef`; no new
upstream code is available for this port. Its locally prepared Dispatch policy
integration remains blocked: installed Codex 2026.9.5 does not invoke the final
admission hook and prompt-hook exceptions are nonblocking. Normal positive
responses do not prove that safety gate. No server work is part of this restore.

## Offline and runtime gates

Run `node tests/pro-3.29-apps-test.mjs --build-only` with `RM_PRO_HASHTAB` pointing
to the independently sealed target table. For full composition also set
`RM_PRO_PEERS` to exactly seven package QMDs. Outputs are under
`build/pro-3.29.0.148/qmd/`: four app patches plus seven package peers. AppLoad's
embedded QMD is separate; no custom partial-repaint file belongs there.
The script supports a diagnostic mapping but clearly labels it structural only.

Historical 3.28 test/install/controllers keep their original exact guards; they
are not 3.29 deploy routes. The maintenance repository owns the new independently
qualified rollback/watchdog and deployment transaction. Then check AppLoad
launch/close, Dispatch notebook launch/return/pen repaint, Dates creation and
calendar navigation, and RMStream explicit start/stop. No send or broadcast is
performed merely to restore firmware hooks. Move must be assessed independently.

## Activation-only controller

`ops/activate-pro-3.29-fullstack.sh` is the new exact-target controller. It does
not publish application files or install packages. The maintenance transaction
must first publish the seven package QMDs with their VELBUILD names, the four
app QMDs, new DispatchLauncher and official AppLoad 0.6 runtime in stock mode.
`ops/pro-3.29-qmd.sha256` pins exactly that installed inventory (no repaint patch).

Stage only `activate.sh` (this script, mode 0700), `qmd.sha256` (the pinned
inventory, mode 0600), and a two-line `SHA256SUMS` (mode 0600) inside a root-owned
0700 `/home/root/.codex-staging/pro329-apps-ID`. ID format is UTC timestamp plus
numeric suffix. Every action requires the stage, the reviewed manifest hash and
the same ID. Do not execute an unreviewed or silently modified stage.

1. `prepare` checks exact stock/runtime/payloads and captures a private
   `safety-backup.tgz` in `/home/root/.codex-backups/pro329-apps-ID`.
2. Copy the backup off-device, verify the emitted hash and archive readability,
   then create its root-only `mac-backup-verified` with the exact text
   `mac-backup:BACKUP_SHA256`. Existing broad maintenance backups remain necessary.
3. Run `activate` in `pro329-apps-install-ID.service` with Type=exec and
   KillMode=control-group. It creates an independent watchdog, shadows the pinned
   vendor unit and same-basename vendor drop-in under `/run` without their failure
   targets, checks the actual manager policy, starts existing Dates r6, and
   checks 30 seconds of stable runtime before publishing `ready`.
4. Within the 180-second independent deadline, freshly inspect the state and run
   the separate `commit` action from the Mac. Without this fresh client action,
   or after owner death/failure, the watchdog returns to stock. Its atomic
   decision prevents late commits from racing rollback. Preserve the recovery log.

Rollback never restores older notebook history/settings. It stops only the
writer it started. If stock is already healthy (for example, a pre-restart gate
failed), it restores the vendor policy without restarting xochitl. Otherwise it
masks vendor failure actions while restarting pinned stock. After stock proof,
it removes only the three exact owned volatile files and confirms the original
manager fragment/drop-in paths. Unknown files and symlinks are refused. No root remount,
permanent unit, autolaunched app, agent send or screen broadcast is involved.
Local policy tests cover pinned byte-preserving shadow generation, partial
publication, foreign-file refusal, stock-no-restart recovery, ordering/ownership/
late decisions and 32 hard-link races;
BusyBox portability excludes GNU find -printf and the absent install command.
Live recovery qualification is a separate maintenance-owner gate.
The watchdog itself restarts on failure, bounded to three persisted attempts.
Retries retain the original deadline and resume only the same rollback decision;
they do not reset the acceptance window. Exhaustion records manual intervention.

### Failure-policy correction and live evidence

The first controller tried to clear both vendor failure dependencies using an
empty `OnFailure=` assignment. Its live assertion rejected the still-present
targets **before any xochitl restart**; stock PID 3381 stayed healthy. This is a
systemd dependency rule, not an app/QMD failure: dependency lists cannot be reset
by empty drop-in assignments. See the official
[systemd unit documentation](https://github.com/systemd/systemd/blob/v253/man/systemd.unit.xml)
(unit load precedence, drop-in precedence, and the overriding-vendor-settings example).

The revised route strips only `OnFailure=` from the pinned full unit and vendor
drop-in, yielding SHA-256 `0cbc768bc2b28a15992e11185538c9ae7ce496fb354a75ab112ddd7f646ca863`
and `9b9b319cc0c9173bcfee48ed9210937d292f4a8cea5e26011e5d23ee624af83c`.
The maintenance owner's stock-only live probe
`20260921T191215Z-6913-systemd-policy-probe` passed: the real manager selected both
`/run` shadows, reported no failure targets, and returned to its original vendor
paths on cleanup. PID 3381 did not change. This proves policy semantics, not the
complete activation controller's owner-death fallback or physical app behavior.

On commit these `/run` shadows remain only until reboot. After reboot, use a
fresh exact-target inventory and this controller's prepare/backup/activate/commit
route. Do not run the old ReMagic/triple-tap activation wrapper: its 3.28 inventory
is not qualified for this stack, and no unattended replacement is installed.

Offline results on 2026-09-21: captured-table full composition passed in three
orders plus Dates preview, 29 resources each; generated QML parsing and old-
firmware rejection passed. Dispatch lifecycle and RMStream direct-control Qt
harnesses passed. Dates source/race/vet, 23 Node checks, recovery checks, Qt
UI/flash/native-callback and synthetic Qt-to-Go transport all passed.
