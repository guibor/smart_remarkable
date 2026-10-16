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
