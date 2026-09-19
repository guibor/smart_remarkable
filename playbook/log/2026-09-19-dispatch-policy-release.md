# Shared Dispatch policy and Smart lasso release — 2026-09-19

Status: BLOCKED on the installed Codex runtime's missing final authorization
gate. All four server transactions were rolled back. No tablet mutation or
functional activation occurred. This is not a physical acceptance receipt.

## Scope and ownership

The two Smart lasso actions now consume the same maintained reading,
multilingual, enhancement and Astra/low defaults as Dispatch. The source owner
is `personal/anki-server/src/remarkable-agent-policy.ts`; the Smart bridge and
plugin import its deployed compiled module. Smart retains its own authenticated
origin binding, canonical `agent:main:main` session, bounded PDF renderer,
delivery receipts and original-page insertion guard. Sharing interpretation
does not merge every Dispatch workflow or grant additional tool authority.

- Answer here requests concise plain text and may insert only through the
  existing guarded tablet path. Unicode/over-budget or changed-page answers
  remain available through WhatsApp/PDF without unsafe local keystrokes.
- Send to agent keeps the normal remote response and never types in the note.
- The Paper Pro Move needs its own capture/input/launcher port. No Pro binary
  or device configuration is copied to it.

Coordination with the user's Remarkable Dispatch task preserved its separately
deployed ASCII Israel-time filename release (`7bdf27c`, docs `6750686`). Only
three anki-server artifacts and eighteen Smart bridge/plugin files are in this
server transaction; five filename/support/PDF artifacts are pinned unchanged.

## Validation and corrected deployment lessons

- anki-server build and six focused suites: 74 tests passed, including exact
  image enhancement regression and a fresh-process proof that prompt/model
  consumers do not load the native image library.
- Smart plugin: 116 tests. The prior 114-test generation also passed in an
  isolated server tree against the installed OpenClaw 2026.9.5 SDK. The bridge
  suite passes all 129 tests with the existing
  live session-store migration compatibility ported into this branch; its
  thirteen configuration/validation tests include that migration regression.
- Server controller: 30 tests, plus a Linux inherited-descriptor `flock`
  preflight proving exclusion, descriptor-close release and crash release.
- Pro local qualification composes all twelve QMDs plus embedded AppLoad,
  parses emitted QML and exercises rollback races, exact helper permissions,
  process identity/stability and original two-button protocol checks.
- `ops/check-dispatch-policy-loader.mjs` exercises the installed native
  captured-module loader without registering another plugin runtime. Both
  guidance destinations passed on the exact Gateway Node 24.21.0 executable.

Three guarded attempts restored the previous server generation before any tablet
mutation:

1. `20260919T165547Z`: the combined 52-second readiness window was too short.
   Original bytes were restored; after services recovered, `confirm-rollback`
   verified every original/protected hash and health before closing the guard.
2. `20260919T170423Z`: live plugin registration exposed a native-library issue
   absent from ordinary Node/JITI unit tests. OpenClaw's captured dependency
   tree relocated Sharp and lost its libvips shared-library relationship.
   Rollback completed and restored the previous 17-plugin Gateway.

A third guarded attempt, `20260919T171448Z`, loaded successfully on stable
Gateway/bridge/HTTP processes with zero restarts. Synthetic request
`smart-remarkable-dispatch-parity-1789838295489-ec452a2e` returned the exact
requested answer and an uploaded response PDF, but correctly reported both
WhatsApp deliveries failed. No native-send journal reservation was created:
the old route validator rejected OpenClaw 2026.9.5's new `entry.delivery`
representation before sending. It also exposed missing explicit session owner
on control events. The generation was rolled back for those compatibility fixes.
No test request is automatically resent under its old identity.

The fourth attempt, `20260919T172617Z`, returned the exact expected answer and
sent the final WhatsApp reply for
`smart-remarkable-dispatch-parity-1789839136825-9819eb0c`, but the acknowledgement
and PDF failed. A startup event-loop stall coincided with a WhatsApp disconnect;
the acknowledgement remains ambiguous and must not be resent automatically.
The installed host also deliberately redacts sessionKey from private active-run
events, so the new receive-side requirement rejected valid private operations.
An isolated test using the actual installed host event implementation reproduced
that redaction. The corrected adapter permits an absent public field while
retaining its private operation ID, run ID, plugin attribution and synchronous
receipt checks; explicit conflicting owners still fail. A read-only WhatsApp
stability check now precedes synthetic sends. The first rollback client timed
out before the unit's normal 60-second shutdown completed; the same guarded
rollback was resumed after the service stopped. Future stop/restart clients
allow 90 seconds without changing the service's own shutdown policy.

The final candidate imports Sharp lazily only inside the image-processing
function, after snapshotting input. Prompt/model consumers do not initialize
Sharp. The server controller now waits for loopback `/startupz` to return HTTP
200 and `ok: true, status: started` before starting the bridge. A bound TCP port
alone is insufficient; bridge capability health has a separate 90-second
window. No Gateway, authentication or service configuration changed.

## Last guarded transaction (rolled back)

Server transaction: `20260919T172617Z`.

- Off-host backup SHA-256:
  `6d6ad276c1af646b5522eefd1c5f28fbee9bcb94f7633467c6578c374878854a`.
- HTTP artifact: `5794426280e2f4303d319130d9c63dbb6902824c27269f50f480739235d7848b`.
- Shared policy: `0cd1356e0366f3164c029fc5b965021d923971f360bb72ff6cdb24d6990ed647`.
- Handwriting adapter: `437473a429f3e0bd927e9a45eb94db4aa8f26cea059f8086990977d5f66dc058`.
- Smart plugin generation: `0.6.0`.
- Controller: `40b94ddecb7139e570a43234ed53acf636fdfd6255f7d5809de776ba99adeea5`.

This transaction is closed as `rolled_back`; its rollback timer is no longer
armed and the normal Gateway watchdog timer is active. Current restored
services: anki-http PID `2142877`, Gateway `2142887`, Smart bridge `2143169`,
all active with zero automatic restarts. Bridge capability health is `ok`;
authenticated loopback and public Dispatch health are both HTTP 200/healthy.
The original main-http hash is restored to
`ce8d96fb2e901eb05ae01e81239e48320dc1a3f5ff8a2a842544931a3458e86f`.
All five protected filename/support/PDF hashes still match the concurrent
Dispatch filename release. The locally corrected controller now allows normal
60-second Gateway shutdown to finish; do not confuse that newer source with
the sealed historical controller hash above.

## Blocking Codex harness compatibility finding

The installed `@openclaw/codex` 2026.9.5 generated runtime at
`/home/mdf/.openclaw/npm/projects/openclaw-codex-8902d781d4__openclaw-generation__g-9daf3b4c2f48c41b/node_modules/@openclaw/codex/dist/.setup/run-attempt-rlA07pUv.mjs`
has SHA-256 `956450471ffe7684fc3fecec7862d14d421ef613767a505a130ed443b2bdd5fb`.
It invokes the best-effort prompt helper and native `startCodexTurn()` but
never `runBeforeAgentRun` / `before_agent_run`. The shared
`agent-harness-runtime-BdWWWNSh.mjs` explicitly catches prompt-hook exceptions.
This explains why the synthetic model turn continued after control errors.

The builtin and CLI harnesses invoke the existing fail-closed gate, but that
does not establish Codex compatibility. No supported replacement meets the
same final-model/system-prompt/session proof: prompt results have no denial
field; `llm_input` is observational; `before_dispatch` runs too early; forcing
an unsupported tools policy to cause an exception is not an acceptable gate.

The minimal proper follow-up is a reviewed runtime change invoking the existing
gate with the final instructions, projected prompt/messages, actual model and
canonical session before every native turn-start attempt, blocking on denial
or exception and preserving ordinary pass behavior. Runtime changes need
separate user direction. No runtime package was modified by this task.

Local prepared fixes after rollback include 116 plugin tests, 129 bridge tests,
30 server-controller tests and six WhatsApp readiness tests. Pro local
qualification remains valid but cannot stand in for server acceptance.

The independent 900-second server rollback is not disarmed until both synthetic
output-mode deliveries have receipt-backed success. Tablet activation follows
through the separately reviewed [Pro transaction](2026-09-19-smart-functional-plan.md).

## Acceptance to record

- Server committed generation, stable service identities and capability health.
- Synthetic write-back and remote-only acknowledgement/final/cloud receipts.
- Protected Dispatch filename artifacts and no-delivery filename smoke check.
- Pro functional transaction, exact twelve-QMD stack, unchanged independent
  settings, stock executable/root state and rollback cleanup.
- Physical pen/button, capture and actual local-insertion acceptance separately.
