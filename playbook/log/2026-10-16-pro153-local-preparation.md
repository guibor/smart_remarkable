# .153 Smart/Dispatch source and controller preparation

Created `beta/pro/3.29.0.153` in a new isolated worktree from .152 `c672ade`.
No tablet/server operations. See `PRO-3.29.0.153-HANDOFF.md` for artifacts,
diagnostic hashes, tests and outstanding coordinator inputs.

The new exact stock executable was hashed locally. All five touched resources
match .152 byte-for-byte. Functional/inert Dispatch menu and inert Smart QMDs
pass local composition, parsing, version rejection and launcher lifecycle gates.
This used an explicitly labelled prior diagnostic table, not runtime approval.

New controller is syntax-valid but unsealed and exits 78 before all actions.
Backup/watchdog/atomic-decision/rollback functions remain byte-identical to the
policy-tested previous controller. Private snapshot now also retains Dispatch
profiles/icon, preserving the Dot-first configuration. The existing standalone
client, bridge servers, worker and firmware are not changed.

Next: exact new runtime table, final seven peers and current Dates/RMStream
inputs, full eleven-QMD composition and manifest sealing before coordinator
publication. Machine and physical acceptance remain distinct and unperformed.

Follow-up: coordinator reverified accepted app payloads unchanged and supplied
the first .153 table. Four app QMDs and previews rebuilt successfully with
candidate-only status. New full-cohort test consumes Dates `build/` (corrected
from supplied `.build/`) and .153 RMStream source without sibling writes.
Full composition/sealing still waits for the final package peers and table proof.

Table proof subsequently arrived: both sorted dumps independently hash to
`deb95682d991670d7dc006ddbb8e102ed9423f2f76ae1c878ad736f2885d8879`.
Selected raw .153 table pinned at `927a5cac...917417`; app-hook tests and four-app
build-only gate pass without diagnostic mode. All payload hashes were freshly
confirmed unchanged by the coordinator. Only seven final peers/full-cohort
composition remain before controller sealing; no external operation here.

## Final qualification and coordinator receipt

All seven peers arrived and the full eleven-QMD plus embedded AppLoad composition
passed four variants, 29 resources each. Dispatch, Dates and RMStream harnesses
passed; Dates creation explicitly selects the full-composition and preview paths.
Controller provenance and the .153 policy harness pass, including 32 atomic races.
Removed the disabled entry guard only after qualification; sealed manifest
`57a56233d20187ce7253d3f08a796056970bbeb2d9cb4a1632923bf12b9076ce` and froze
controller `e741290cb979b6f90ac13bd7e857ddc8b5d28470650d667ae6688407c7da022c`.
See the handoff for absolute-input manifest and generated artifact paths.

The coordinator reports committed base activation, UI 6240 / Dates 6231,
NRestarts 0, eleven QMDs; native overlays proceed under its separate ownership.
This task did not connect to or write any tablet/server. Physical acceptance is
still separate. No ready Move AppLoad/Dispatch/Smart qualification is asserted.
