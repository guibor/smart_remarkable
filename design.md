# Design

Smart Remarkable is a user-space assistant that leaves reMarkable's stock `xochitl` process running. It reads the current framebuffer from `xochitl`, sends a normalized screenshot to the user's OpenClaw agent, and returns the result through virtual pen, touch, or keyboard devices backed by the kernel's existing `/dev/uinput` support. The production listener supports `pen-release` for one-shot/automatic sessions and `pen-hold` for explicit sessions; hold timing, normalized jitter radius, and minimum lasso extent are validated configuration values. A hold is classified only on lift, contacts begun while busy stay ineligible, and xochitl's detected marquee remains the final proof of a real lasso.

## Runtime flow

The repository implements three trigger policies behind the same AppLoad
application:

- `once` maps to `pen-release --no-loop`: a completed stock lasso submits on
  pen-up, and the worker exits after the first valid selection.
- `session-hold` maps to looping `pen-hold`: a lasso submits only if its path
  is large enough and the pen remains nearly stationary at the closed-loop
  endpoint for the configured dwell before pen-up. This is the default.
- `session-auto` maps to looping `pen-release`: every completed stock lasso
  is eligible on pen-up. Because ordinary selection edits can be submitted,
  this policy is deliberately opt-in.

`scripts/mode-settings.sh` reads the root-owned
`/home/root/.config/smart-remarkable/settings.conf` as strict data. It never
sources or evaluates the file. Defaults are an 800 ms hold, 12 normalized
pixels of endpoint tolerance, a 24-pixel minimum for the path's larger axis, a
ten-minute one-shot lifetime, and a one-hour session lifetime. Invalid modes,
unknown keys, symlinked settings, malformed numbers, and out-of-range values
fail closed.

The exact hold sequence is:

1. The user selects xochitl's native lasso, puts the pen down, draws a loop,
   and closes it without lifting.
2. At the closing point, the user keeps the tip touching and within the
   configured radius for at least the configured dwell. Movement outside the
   radius restarts the dwell measurement.
3. The user lifts. `PenGestureTracker` classifies the gesture only at this
   point, after which screenshot processing confirms that xochitl actually
   painted a selection marquee. An immediate lift remains an ordinary
   selection and does not submit in `session-hold`.

The single non-QTFB **Smart Remarkable** tile toggles a transient
`smart-remarkable-session.service`. `remagic/appload-launch.sh` loads the
current mode only to select the bounded `RuntimeMaxSec`; PID 1 owns the worker
with `Restart=no`, `KillMode=control-group`, disabled core dumps,
`BindsTo=xochitl.service`, and `Conflicts=riddle-takeover.service`. No service
is enabled at boot. The runner first creates root-only mode-0700 state under
`/run/smart-remarkable`, clears stale volatile markers, and starts the Rust
listener. The listener publishes `/run/smart-remarkable/ready` only when it
can accept a local selection; every fallible engine/tool setup step completes
before publication, and a listener-owned `TriggerReadinessGuard` removes the
marker on normal return, error, panic unwind, or task abort. Main supervises
listener death with priority over a simultaneously completed request. If the
listener fails during a prepared transaction, main cancels processing,
boundedly waits or aborts it, and only then emits the idempotent selection
restore chord, so a detached capture cannot later close a restored selection.
This local capture gate does not depend on the network. The runner then starts
the forwarding-only SSH tunnel on local port
`18791` and probes the bridge. It publishes a distinct root-only
`bridge-ready` marker only after the capability-backed health probe succeeds.
Rust waits for this remote marker only after the exact crop has been captured
and the stock selection has closed. A tunnel setup failure or later SSH exit
removes remote readiness, reaps only that SSH child, and retries with bounded
parent-owned health probes and the native Dropbear `-K` keepalive while the
worker retains the crop only in RAM.
The Rust bridge wait is bounded to fifteen minutes. A normal listener exit
terminates the current tunnel and preserves the listener status; the transient
unit remains the outer lifetime and power-loss boundary. The exit trap removes
every local and remote readiness, trigger, acknowledgement, busy, admission
lock, and isolated-home artifact. Both production wrappers use the tablet's BusyBox
`mkdir`/`chown`/`chmod` commands and do not assume GNU `install`.
`scripts/openclaw-runtime-env.sh` parses the root-only six-line `.env` as
strict data; it rejects duplicate, missing, unknown, malformed, or non-pinned
values and never sources or evaluates the file. The SSH tunnel runs under
`env -i` with only an isolated volatile `HOME` and fixed `PATH`, so it cannot
inherit the bridge bearer, an SSH agent, password helpers, or caller routing.
The Rust worker runs under a separate `env -i` and empty volatile `HOME`, with
only the narrow bearer and fixed `RUST_LOG`; this prevents inherited
`SMART_REMARKABLE_*` variables or a persistent home configuration from
enabling screenshot saving, the debug web server, alternate output, or
unapproved routes.
The tunnel authenticates as the dedicated password-locked server account
`smart-remarkable-tunnel`, not as the ordinary OpenClaw owner. Its validated
OpenSSH `Match User` policy allows only client-local TCP forwarding to literal
`127.0.0.1:18792`; it disables remote TCP and both StreamLocal directions,
sets `MaxSessions 0`, and disables PTY, agent/X11 forwarding, tunnels, and
user rc. The per-key line independently uses `restrict`, an exact
`permitopen`, and a forced false command. This server policy is necessary
because OpenSSH 8.9 cannot express local-TCP-only forwarding in
`authorized_keys` alone.
The compatibility-named `scripts/run-armed-once.sh` is now the generic
three-mode worker; `scripts/run-selected-once.sh` remains the constrained SSH
recovery path.

Every explicit stock-button launch is serialized by a separate root-only
fd-backed lifecycle lock under `/run`; the runner never removes that lock while
a launcher owns it. If the current exact busy generation exists, a second tap
is rejected without stopping anything. Otherwise the launcher stops any idle
transient session and starts a fresh one before publishing the descriptor, so
an active unit cannot expire just after the local marquee closes. Explicit
button units receive at least one fresh hour even when the configured tile mode
is `once`; no unit is enabled at boot and the ordinary AppLoad tile remains a
toggle. The fd lock acquisition is bounded, and after a stop the launcher waits
for the `--collect` unit's `LoadState` to become `not-found` before reusing the
fixed transient name. The guarded installer also parses the runner's exact SSH
options on the live firmware without opening a connection: it pins Dropbear
2025.88, checks native `-K` help, and checks each required extended option via
`-o help`. Unsupported OpenSSH-only options are forbidden.

The two native buttons are independent, explicit sources. Once their
device canary has passed, the user completes an ordinary lasso, lifts, and
taps either the stock sparkling-notebook icon (answer here) or stock sparkles
icon (send to agent) in the stock selection menu immediately after
**Copy**—there is no hold and no four-finger gesture. Answer here means
`write_back`: OpenClaw delivers through WhatsApp and the tablet inserts the
same final answer as stock text. Send to agent means `whatsapp_only`:
OpenClaw delivers through WhatsApp and the tablet performs no text, pen, or
touch output. Both modes also upload one deterministic answer PDF to the
configured reMarkable Cloud library and report its receipt status in the final
WhatsApp message. Each button sets its own stock `selected` state and snapshots the
pending selection before scheduling launch with `Qt.callLater`, while shared
pending state rejects another button tap. The deferred callback first
revalidates the same mode, snapshot, and visible handler so the selected state
can paint before AppLoad's synchronous process-start boundary.
When the stock handler becomes visible, a deferred `ensureAppLoadHelper` call
dynamically imports one `AppLoadLibrary`, parents it to the selection handler,
and caches it for the descriptor plus both acknowledgement launches.
`launchArgument` reuses that helper, calls
`launchExternal("external::smart-remarkable", -1, [argument], ({}))`, and
accepts only a positive PID. It deliberately does not emit
`AppLoadLauncher.launchApplication`: that singleton signal is received by
every loaded AppLoad QML view, while AppLoad's non-QTFB handler starts the
external process and then writes the PID to an undefined window object. The
direct library path therefore avoids broadcast fan-out, window creation, and
the observed post-spawn QML error. Prewarming removes repeated dynamic QML
compilation and global-handle churn from the tap, prepare, and close paths. It
still performs AppLoad's synchronous
`QProcess::waitForStarted` check on the stock UI thread, but the launched shell,
transient service, worker, tunnel, and remote work all continue in the child;
no persistent or boot service is introduced. One `clearPendingMode` path runs
on menu visibility changes, timeout, failed or non-positive AppLoad launch, or
local validation failure, so a failed attempt cannot latch the other icon or
leave stock controls hidden.

The deployed `0.8.0-openclaw` button path is protocol v3. Its strict v2
adapter remains only for the guarded app-first migration and rollback
boundary; it is not a substitute for v3 context. At tap time the v3 QML
derives the exact `ink`, `image`, or `mixed` kind, maps all
four selection corners into the selection-root view, and records fixed-point
axis-aligned bounds. It also maps the selection root into the physical scene
and accepts only the stable `normal` or `rot180` transforms; 90-degree,
mirrored, sheared, non-finite, empty, degenerate, or out-of-bounds selections
fail closed. `DeviceSceneView` supplies the exact document UUID, page id/index,
mapped page-view bounds, and honest `full_page`/`viewport_only` completeness.
The initial descriptor contains those fields plus version, response mode,
kind, orientation, selection bounds, and capture time.
`scripts/selection-protocol.sh` strictly parses this data, and
the root-owned AppLoad launcher reads 32 bytes from `/dev/urandom` through the
device-proven `/usr/bin/hexdump -n 32 -v -e '1/1 "%02x"'` interface, accepts
only exactly 64 lowercase hexadecimal characters, and adds that fresh 256-bit
nonce before
atomically publishing each marker: the nonce-bearing busy marker first and the
one corresponding trigger second. The Rust parser accepts only the canonical bounded form while it is
younger than 40 seconds, below QML's 45-second pending timeout.

QML and the launcher also expose content-free `SR_WAND` stage diagnostics. QML
records admission/revalidation/launch boundaries and elapsed process-start time;
the launcher records descriptor parsing, local readiness, lock acquisition,
nonce creation, and busy/trigger publication. The stages never include the
descriptor, geometry, nonce, recognized text, image bytes, or selected content.

Capture and close form a two-phase, same-nonce local transaction. Rust first
emits `Ctrl+Alt+Shift+8`. QML immediately re-reads the live kind, transform,
selection bounds, and v3 document/page snapshot; only an exact match hides the stock chrome by reversibly binding
`selectionRoot.controlsAreVisible=false`, which leaves the selected content
rendered without tint, border, or menu. QML then returns the exact snapshot to
AppLoad, which can acknowledge it only against the active nonce-bearing busy
descriptor. Rust consumes that prepare acknowledgement before reading the
framebuffer with the descriptor's explicit orientation and cropping the
descriptor bounds. After the immutable prepared PNG exists in memory, Rust
emits `Ctrl+Alt+Shift+9`. QML revalidates the same live snapshot again, calls
the stock `SceneSelectionHandler.close()` path, and acknowledges only after
the handler is no longer visible. Rust requires that exact close
acknowledgement before it may wait for the bridge or submit remotely. Any
failure before `close()` emits `Ctrl+Alt+Shift+7` where possible, restoring the
original stock binding and leaving the selection recoverable. If stock close
succeeds but close-ack publication or consumption fails, the handler remains
closed and remote submission is suppressed; Smart cannot recreate the
selection, but the underlying content is unchanged. The protocol never invokes
Copy, Cut, Delete, movement, or simulated touch coordinates.
Handshake modifier/key releases are one balanced evdev batch with no embedded
`SYN_REPORT`; `VirtualDevice::emit` owns the single terminating sync. Every
reported prepare emission failure is treated as potentially side-effecting and
immediately attempts the idempotent restore chord before returning.

### Selection and current-page context bundle

The richer OpenClaw input is the canonical v3 result of that local transaction,
not a second capture path. The exact 3.28.0.164 QMLDiff patches both the stock
`DeviceSceneView.qml` owner and `SceneSelectionHandler.qml` consumer. The owner
passes the current document UUID, page id, zero-based page index, and mapped
page-view bounds explicitly; the selection handler does not walk its parent
tree or guess an active document. Protocol v3 binds those values alongside
kind, orientation, selection bounds, capture time, and the launcher nonce at
click, prepare acknowledgement, and close acknowledgement. A navigation or
identity change therefore fails before remote submission. Protocol v2 remains
strictly parseable only for the guarded app-first migration/rollback boundary
and is never silently upgraded into a context-bearing request.

### Guarded server promotion

Plugin, bridge, and journal-protocol changes are promoted as one quiesced
transaction while the tablet buttons are inert. The controller snapshots the
exact previous bridge/plugin trees, immutable configuration hash, request and
receipt journal trees, unit definitions, and restart counts before swapping
same-filesystem paths. It starts the candidate Gateway and bridge only after
on-server tests pass, then proves the already-running production Gateway with
a hard-timeboxed direct `GatewayClient` capability query plus current-PID
journal and exact-manifest evidence. It never runs OpenClaw's runtime plugin
inspector because that command creates a second plugin registry and can leave
resource-intensive workers. Any failed post-swap guard restores the exact
preimages and re-proves the old runtime before service resumption.

The system watchdog timer is `Persistent=true`. If it became overdue while
paused, resuming it may legitimately launch the one-shot immediately instead
of first reporting `SubState=waiting`. The guarded sequence therefore requires
the timer to be enabled and active, observes both a fresh timer trigger and a
fresh service invocation, requires clean one-shot completion, and only then
requires the timer to be active/waiting again. Missing trigger evidence, a
failed one-shot, or a non-waiting final timer still fails closed. Production
transaction `20260801T213248Z-32250` installed plugin `0.4.0`, origin-v4,
response-envelope v3, journal schema v3, and the matching bridge under this
contract; the older `0.3.0` trees remain its rollback preimages.

After the prepare acknowledgement, `processing_task` resolves the human-facing
reMarkable document display name from the exact UUID's `.metadata` file below
the fixed xochitl data directory. The reader accepts only a canonical UUID and
a bounded, stable, owner-matching regular file opened without following links;
it parses only the required JSON field, normalizes and bounds the UTF-8 value,
and rejects control characters. The UUID remains in root-only volatile
handshake state. The display name exists only in request memory and is neither
logged nor written to the tablet.

One `Screenshot` read produces both visual inputs before the stock selection
closes:

- `selected_region` is the exact descriptor crop and the primary user input.
  It receives the existing kind-aware preparation: ink whitening and bounded
  enlargement, or RGB-preserving image/mixed enlargement.
- `current_page_view` is encoded from the same normalized frame without ink
  whitening. When the complete mapped page bounds fit inside the framebuffer,
  those bounds are cropped and metadata says `full_page`; otherwise the
  current visible framebuffer is sent and metadata says `viewport_only`.
  Smart never zooms, navigates, exports, or performs another screenshot to
  pretend an off-screen logical page was captured.

The OpenClaw transport serializes one exact `selection-page-v1` body: a single
text frame, one role-tagged selection PNG, one role-tagged current-page PNG,
and bounded document/page metadata (`document_display_name`, `page_id`,
zero-based `page_index`, one-based `page_number`, `page_image_scope`, and
`page_image_completeness`). A matching header prevents an old bridge from
accepting the new body. The local duplicate fingerprint and the bridge's
idempotency fingerprint bind both PNGs and every canonical metadata field;
transport retries reuse the exact serialized body and request id. Engine
cleanup releases both images and the metadata on every terminal path, while
the durable server journal retains only the resulting digest, status, and safe
response—not either image or the display name.

The bridge accepts exactly that content order and two fixed roles, applies
per-image and aggregate limits, and constructs the Gateway attachments itself
as `remarkable-selection.png` and `remarkable-current-page.png`. Its trusted
capture manifest explains that the selection is the focal request and the
page/title are supporting user data, never authority. The server-owned
OpenClaw hook uses page context, the title, canonical conversation, and durable
memory to resolve references and make a strong useful best-effort response. It
does not default to a generic clarification, restatement, or market scan when
a reasonable harmless interpretation exists. Ambiguous context still cannot
authorize an upload, message, or other external side effect, and completion
claims still require evidence. The strict response envelope remains
selection-attributed: `received_text` describes only the lasso; surrounding
page/title context can influence only `response_text`.

This feature expands the firmware-specific QML surface by one exact stock
resource, so it uses a paired generation and a special no-taps app-first
migration. First, install the `0.8.0-openclaw` application while the exact v2
functional QMD and old server remain. The new app deliberately accepts only
the allowlisted `v2-migration-functional` QMD in this state, preserves its
historical one-image request shape, and suppresses v2 local write-back because
v2 cannot prove document/page identity. Before any tap, the new contract then
moves that exact v2 functional QMD to the new inert canary. Requests are
quiesced while plugin `0.4.0`, origin-v4, journal schema v3, and the matching
bridge are promoted together. Only after capability-backed server readiness may
the v3 functional QMD pass offline composition, refresh-functional canary,
watchdog, and rollback. No stock binary, system partition, boot state, or
persistent vendor-root service changes.

App-first staging retains one deliberately separate rollback/migration route
for the historical QMD hash
`2b9188af0c3fd726743e36ee1a3c86244cf6327ad22eeef1aa7a291a7add059d`.
Its historical `--selection-button=write_back` and
`--selection-button=whatsapp_only` calls receive a fresh random
`legacy-v1` generation, use marquee detection, and close on
`ModelExecutionStatus::RemoteAccepted` as that old QML expects. This route is
not accepted as v2 geometry or acknowledgement evidence. It became inactive
when guarded transaction `20260731T162912Z-38343` promoted the prior v2 QMD
`28a253e1d16d4aa5e2852afa40699d3bc13b3fb2ab1e9cdc0a953deec9953ef6`,
but remains an approved rollback/migration state until a later artifact
generation deliberately removes it.

`xovi-qmd/compatibility-3.28.0.164.env` is also the cross-artifact deployment
contract. `ops/artifact-compatibility-contract.sh` parses its exact key set as
data and binds one protocol generation to the functional source/QMD plus the
installed worker, AppLoad launcher, run-armed runner, and selection-protocol
helper. `UNRESOLVED` is permitted only as an offline implementation marker;
application installation and functional or refresh-functional QMD promotion
require all six reviewed SHA-256 values. The approved 3.28.0.164 legacy
functional rollback QMD is
`LEGACY_BUTTON_QMD_SHA256=2b9188af0c3fd726743e36ee1a3c86244cf6327ad22eeef1aa7a291a7add059d`;
the separate
`PREVIOUS_BUTTON_QMD_SHA256=0fea5e9d78cb085528f0cde5af672abb9c3ca2b327127f43dc6e54605a688412`
is only the historical 3.28.0.163
recovery reference and is never used to classify the active migration state.

The normal guarded forward order is a compatible functional app/QMD, inert
QMD, then the next functional QMD. For this direct-launch refresh, an isolated old-HEAD
worktree retained the old contract that classified deployed QMD
`28a253e1d16d4aa5e2852afa40699d3bc13b3fb2ab1e9cdc0a953deec9953ef6`
as its exact `new-functional`; guarded transaction
`20260731T222234Z-48219` used that contract to commit inert QMD
`81b6050a739cd79e60b71bc78e504fae6d30ac996e6d0dde9970859bccdaadd5`
before the new contract or application installer was allowed to run. This
avoids weakening the new contract with an extra predecessor classification.
Both device installers share `/run/smart-remarkable-llm-button/deployment.lock`.
The `0.8.0-openclaw` application installer additionally accepts the exact
`v2-migration-functional` Smart QMD for the bounded app-first v3 transition; it
also accepts absent, exact legacy-functional, exact new-inert, or exact
new-functional state. If new-functional is active, the existing app must
already match the same complete contract so an automatic install rollback
cannot restore a skewed client. Conversely, every
non-initial QMD transition rechecks the exact installed client, including its
complete staged manifest, immediately before `ARMED`. Intentional rollback is
the reverse: first restore a contract-approved legacy/inert/absent QMD state,
then restore an authenticated older app. Never roll the app back beneath a new
functional QMD.

The coordinator uses an atomic admission flag and a channel of capacity one,
so only one request owns the pipeline. A pen contact that begins while busy
stays ineligible even if processing ends before pen-up, and a button pressed
while busy fails at the launcher rather than becoming a surprise queued
request. The launcher publishes the busy marker before the trigger; after any
terminal result, Rust reopens its internal admission gate before it consumes
and verifies that exact busy generation last. Pen modes fingerprint the
selected crop and suppress the still-active selection from duplicate
submission; a no-marquee pen candidate makes no model call and rearms.

For an admitted selection, screenshot processing groups every contiguous
Paper Pro `/dev/dri/card0` mapping and includes large detached anonymous
allocations, probes bounded frame-header chains, and reads the accepted frame.
Legacy pen and transition routes may still detect the active marquee, while
v3 buttons use only their revalidated kind/orientation/selection plus
document/page descriptor. The allowlisted v2 migration route retains only its
strict kind/orientation/rectangle descriptor and cannot gain v3 authority.
The raw crop is never sent directly: `ink` is converted to luma, its gray
selection fill is whitened without erasing dark ink, and it is boundedly
Lanczos-upscaled; `image` and `mixed` preserve RGB and tonal detail while using
the same aspect-preserving enlargement. The selection kind is bound into the
fingerprint and remote request. Neither source nor prepared crop is written to
a tablet file. Full-screen input remains unchanged.

While the v3 selection is prepared and before it closes, `write_back` retains
the complete normalized full-page bytes in memory. The first post-close capture
must exactly equal that prepared original; a page reached during close is never
accepted as a replacement baseline. If this rebind is unavailable or differs,
canonical OpenClaw/WhatsApp work continues with the guard left `Required`, but
local insertion is suppressed. Every production insertion callback accepts
only an `Exact` v3 guard; v2 migration, legacy-v1, and pen-lasso routes cannot
prove the full document/page binding and therefore remain locally
write-suppressed in this generation.

Immediately before insertion, Smart recaptures with the trusted orientation,
requires exact page identity, and verifies the firmware-pinned stock Text
selection. Palette detection requires the repeated stock signature; cleanup
inspects and verifies closure rather than blindly toggling an unknown state.
Placement is moved clear of stock chrome. Only a disjoint pinned 80×80 toolbar
region plus a non-empty caret-like vertical change in the narrow 16×64 target
region may differ. Before the placement proof and through every emitted key, a
nonexclusive monitor queries current pen-button and all multitouch tracking
slots and observes new physical contacts without `EVIOCGRAB`, so `xochitl`
continues to receive complete gestures. The complete response is rejected
before the first key unless every character is supported and it fits 2,048
UTF-8 bytes, 600 keys, and the approximately 6.5-second budget. Body style and
each shifted or unshifted character use one balanced batch. Any changed view,
current/new physical contact, missing placement, unsupported input, replay, or
tool/caret/palette error preserves the canonical WhatsApp result and suppresses
or stops tablet insertion.

The launcher forwards only to a loopback-bound reMarkable bridge on the
OpenClaw server. The tablet authenticates with a narrow bridge token; the full
Gateway operator credential and the WhatsApp target never leave the server.
The bridge refuses WhatsApp destination overrides and derives the target only
from the direct `agent:main:main` origin in OpenClaw's canonical session store.
The v3 tablet sends one strict `selection-page-v1` OpenAI-shaped body: one
non-empty text part followed by the role-tagged selected-region and
current-page PNGs, plus exact document/page metadata. Headers bind that context
version, response mode, `ink`/`image`/`mixed` selection kind, and a unique
request id in the exact `smart-remarkable-` namespace. Before reserving journal
capacity, the candidate bridge requires the exact plugin-0.5/origin-v5
capability receipt for the current authenticated Gateway connection generation,
including the response-PDF method, `response-pdf-cloud-v1` policy,
`remarkable_cloud` destination, ordered `selection-page-v1`,
`selection`/`current_page`, and selection-kind arrays. Disconnect or
reconnect invalidates readiness; `/health` and the next admission re-probe, and
all request-specific RPCs stay pinned to the admitted generation. The bridge
then converts the request to native Gateway `chat.send` with fixed-name
`remarkable-selection.png` and `remarkable-current-page.png` attachments,
`sessionKey=agent:main:main`, explicit server-owned WhatsApp routing,
`deliver=false`, disabled command interpretation, and the request id as its
idempotency key. Before that call, the bridge invokes
`smart_remarkable.bind_origin` with origin-v5, the same request id, response
mode, trusted selection kind, `selection-page-v1`, and captured transcript. The plugin stores one immutable
pending admission as a realm-neutral JSON string in OpenClaw's host run
context and activates it only when the prompt hook sees the exact request run,
canonical route, and preflight-captured transcript. This host-owned scalar is
visible across OpenClaw's separate startup, active-hook, and pinned-tool
registries.

OpenClaw closes ordinary plugin API methods after registration, so late bind
and clear Gateway handlers do not call the public run-context facade directly.
Plugin version 0.5.0 retains the private agent-event control subscription
during `register`. Each late get, set, or clear stays in the originating
plugin instance's bounded private map while the adapter emits only a random
operation ID on its plugin-owned stream. The synchronous subscription callback
uses OpenClaw's host-bound `getRunContext`, `setRunContext`, or
`clearRunContext` for the event run ID. Set and clear require exact read-back;
missing or delayed receipts, unavailable host methods, mismatches, exceptions,
and capacity overflow fail closed. Operations, admission values,
capabilities, and cleanup handles never enter the event, run ID, prompt, or
transcript. Bind and clear require `operator.admin`. This depends on the
audited synchronous event ordering in exactly pinned OpenClaw 2026.7.1; a
version upgrade is blocked until that lifecycle is reviewed again.

Because this is a non-bundled plugin, live OpenClaw configuration must
explicitly grant both `allowPromptInjection=true` and
`allowConversationAccess=true` under the exact plugin entry. Registration
verifies the plugin id and both flags before exposing any method, hook, or
tool. The prompt hook activates only the exact pending authority and appends
kind-aware server guidance. After final prompt construction,
`before_agent_run` re-reads the active host scalar and blocks the run unless
the exact request/transcript/agent/session still matches and that exact
guidance is present in the final system prompt. Ordinary runs return an
explicit pass result for OpenClaw 2026.7.1's pinned gate behavior.

Before every new bind, the startup-side bounded index reconciles
each of its reservations against that shared host scalar. A still-live active
record keeps its capacity slot even after the original pending deadline;
expired, missing, or malformed host records are cleared before their slots are
released.
`systemInputProvenance={kind:"external_user",sourceChannel:"remarkable",
sourceTool:"smart_remarkable"}` is also persisted for audit, while
`originatingChannel` stays `whatsapp` so later WhatsApp continuity and
delivery routing are unchanged. A handwritten lookalike marker has no
authority: prompt guidance and reMarkable-only tool execution both require
the plugin-owned active admission whose run id exactly matches the active run.

Immediately before binding, the bridge reads canonical history and captures
its current `sessionId`. It deliberately does not send that value in
`chat.send`: OpenClaw 2026.7.1 treats caller-supplied session ids as reusable
routing input rather than a compare-and-swap precondition, so a stale value
could resurrect or rotate session state. Completion first reconciles bounded
history at the canonical key. If the key was remapped, a no-follow,
size-bounded JSONL reader first examines only the captured transcript file. An
exact `<request-id>:user` anchor there retains precedence and must be followed
by a protocol-valid assistant response before any later user turn. If
canonical history names a successor while that captured response is pending,
an unscoped live event is ineligible; only the captured durable transcript can
complete it. If that
captured transcript has become exactly one finalized reset archive, a separate
negative-proof reader uses one pre-read descriptor stat both to enforce the
regular-file/64 MiB limit and to bound the read, then requires matching final
identity and size, fatal UTF-8 decoding, strict bounded JSONL, exactly one
session header, line-size enforcement before narrow ASCII JSON-whitespace
blank handling, an unchanged candidate set, a reopened-path identity match,
and zero request anchors. An active transcript cannot provide this negative
proof. Only then may the newly canonical bounded
`chat.history` prove a post-admission automatic canonical-session successor
with exactly one matching request anchor, the exact persisted Smart reMarkable
external-user provenance, and the same strict response interval. An
unavailable, malformed, ambiguous, active, changed, or anchored captured
transcript never authorizes successor-session history. This recovers the
observed reset shape without broad transcript scanning or unsafe repinning.

This `chat.send` run is the only owner of canonical transcript entries. The
bridge appends response-envelope v3, a fixed versioned protocol that requires
the canonical assistant final to contain exactly two bounded, non-whitespace
strings:
`{"received_text":"...","response_text":"..."}`. `received_text` is a literal
kind-aware account of the selected content and uses `[unclear]` rather
than guessing;
`response_text` is the ordinary answer. The bridge parses the same envelope
from either an exact live final event or strictly attributable bounded-history
recovery. The stock marquee has already closed at the local immutable-crop
boundary, independently of Gateway acceptance. A premature
request-callback error or a missed final event cannot discard an already
queued canonical turn: the bridge polls bounded history for the target
`<request-id>:user` entry and accepts only its following assistant text before
another user entry. The request and client timeouts remain finite but allow
ordinary long-running OpenClaw tool work: ten minutes on the bridge and a
small final-delivery margin on the tablet HTTP client. The response renderer
reserves 512 bytes below WhatsApp's 32 KiB native limit for its fixed PDF
status line, so adding a receipt cannot invalidate an otherwise accepted
answer.

It separately calls the plugin-owned
`smart_remarkable.deliver` Gateway method for one idempotent,
delivery-checked receipt acknowledgement saying that OpenClaw is reading and
working, then for one atomic final formatted as `I read:`, a quoted literal
transcription, a blank line, `response_text`, and one fixed PDF-upload status.
`[unclear]` becomes an
explicit inability-to-read statement rather than a fabricated quote. The
quote and answer share the existing `<request-id>:final` native receipt and
idempotency identity, so this does not add a third send or crash window. That
method derives the direct WhatsApp
route server-side, uses OpenClaw's public durable channel outbound API without
a `mirror` or session context, and returns success only with a native WhatsApp
provider receipt. This avoids duplicate delivery-mirror transcript messages,
does not rely on unverified automatic delivery, and does not change the
canonical session's persistent verbose setting.

After recovering the strict response envelope, the bridge also calls
`smart_remarkable.deliver_response_pdf` on the same authenticated Gateway
generation with only the request ID, active origin-binding handle, and the two
validated strings. The plugin rechecks the exact active run, captured
transcript, main agent, canonical session, binding handle, and fixed
`response-pdf-cloud-v1` policy. It then creates a private transaction under
OpenClaw state and renders a one-column PDF from a Pandoc JSON AST: untrusted
text appears only as literal `Str` nodes and is never parsed as Markdown,
HTML, or TeX. Pandoc and XeLaTeX are invoked at pinned absolute paths without
a shell, inside bounded private HOME/XDG/TEXMF/TMP directories, with Pandoc
sandboxing, XeLaTeX shell escape disabled, deterministic metadata, strict
time/output/version/PDF validation, and cleanup on every result. A deterministic
request-derived ASCII name avoids title, path, and filename injection.

The generated snapshot reuses the existing no-shell `rm-sync` upload and
durable artifact-receipt machinery. Identical in-flight calls coalesce; a
completed receipt returns `cached: true`; conflicting reuse and ambiguous
outcomes fail closed rather than creating a second document. At most two
distinct PDF operations may run at once in the Gateway process; excess work is
rejected before rendering to protect server capacity. The bridge waits
for this terminal receipt before sending the WhatsApp final so that WhatsApp
can say whether reMarkable Cloud accepted the PDF. Upload failure is additive:
the fixed failure status and schema-v4 journal outcome do not erase a
receipt-confirmed WhatsApp answer or an otherwise safe `write_back` result.
The destination is the configured reMarkable Cloud library, so every tablet
on that account may sync it; neither the current request schema nor the
forward-only SSH tunnel can target only the originating physical tablet or
append a PDF into the source notebook.

For every verified v3 reMarkable run, the plugin's prompt hook treats the lasso
as the focal request and uses its kind, same-frame page view, document-id-bound name,
specific still-active canonical user instructions, and durable memory to
resolve references and likely intent. It makes the strongest reasonable
harmless interpretation, carries it to a concrete useful result, states a
consequential assumption and close alternative when helpful, and asks only
when materially different interpretations require a real user choice. It does
not merely acknowledge, restate, default to a market scan, or ask a generic
clarification. Captured or quoted text, page/title data, and assistant
suggestions remain context rather than authority. Inference never authorizes a
side effect, and no action is reported complete without evidence.
When an explicit governing instruction asks to create, export, send, or place
a document, produce a PDF or EPUB inside the OpenClaw workspace and use
`remarkable_deliver_document`. The tool is registered only for the canonical
main agent and its `before_tool_call` gate independently requires the same
run-scoped origin context. It resolves and opens a regular non-symlink
workspace file, enforces bounded size plus matching PDF/EPUB extension and
magic, snapshots it to private plugin state, and invokes the already-installed
`rm-sync upload` executable through `execFile` with a fixed minimal
environment and no shell. A durable artifact journal binds request id,
artifact key, content hash, name, and destination before upload; an ambiguous
reservation never retries automatically. Only validated cloud document
id/hash JSON becomes a success receipt. This richer, model-created artifact is
separate from the automatic response summary PDF; an explicit document request
may therefore create both when that is what the user asked for.

For `write_back`, the bridge returns only the delivery-validated
`response_text`; the main-owned `draw_text` callback first requires the exact
prepared-original/post-close view binding and guarded placement, then requires
verified stock Text/palette activation and a caret-like placement delta. It
rejects unsupported or over-budget text before output and observes physical
input before each balanced key batch. Only after those checks does typing
begin, and it types only the answer below the selection, never the WhatsApp
transcription prefix. Any guard, interaction, or activation failure preserves
WhatsApp as the canonical result and suppresses or stops tablet insertion.
For `whatsapp_only`, the client still validates
both the working acknowledgement and final provider receipts but never
dispatches `draw_text`; a missing acknowledgement fails the request even if
the later final happened to arrive. A cached bridge response is explicitly
marked `replayed`; the client validates it but suppresses `draw_text` even in
`write_back`, preferring a possible omitted insertion after a lost response
over duplicate notebook text. The
OpenAI-compatible `x-openclaw-message-channel` header is no longer treated as
delivery: it represented only synthetic ingress context. Engine content,
crop/image slots, request mode, and tool state are cleared before admission is
released for another request.

The persistent bridge journal validates the same request-id namespace and uses
schema v4 to bind the fingerprint, response mode, selection kind, exact
`selection-page-v1` context, both images, and canonical metadata. A completed
schema-v4 response also contains the exact safe uploaded/failed PDF outcome and
can replay without new Gateway, WhatsApp, render, or upload work. Any schema-v1,
schema-v2, or schema-v3 reservation or completion remains a capacity-consuming HTTP-409
barrier: it is never replayed, resubmitted, deleted, or treated as absent.
Origin-v5/plugin-0.5, the renderer, and the schema-v4 bridge therefore require
one quiesced guarded server promotion while the tablet buttons are idle; the
current-generation capability probe is the readiness gate after Gateway reload.

For firmware 3.28.0.164, the deployed native-button integration is a two-button
QMLDiff patch rather than the upstream raw `llmbutton.so`.
`xovi-qmd/llm-button-3.28.0.164.source.qmd` inserts one stock
QML block containing the firmware's stock sparkling-notebook and sparkles
resources into the exact
`SceneSelectionHandler.qml` tree immediately after `selectionDuplicate`
(Copy). On tap the chosen button marks itself selected, schedules one deferred
same-snapshot launch, and accepts only a positive PID from direct non-QTFB
`launchExternal`. The deployed revision prewarms and caches one parent-owned
dynamic `AppLoadLibrary` per selection handler, so the three launch phases do
not recompile the helper. This bypasses
`AppLoadLauncher`'s process-wide broadcast and the external-no-GUI receiver's
undefined-window assignment while exposing the prepare, close, and restore
transaction described above. Keeping AppLoad out of the host file's static
imports reduces the chance that an unavailable module prevents the stock
selection component from loading.
`xovi-qmd/llm-button-inert-3.28.0.164.source.qmd` inserts the same two visual
buttons disabled and with no actions. `xovi-qmd/compatibility-3.28.0.164.env`
records exact firmware, xochitl, hashtable, Xovi, qt-resource-rebuilder,
message-broker, AppLoad, artifact, and target-resource hashes.

The safe activation design is staged: fresh read-only live fingerprint,
device-side compatibility check, inert visual canary, bounded xochitl health
monitoring with a preserved `/home` rollback, then functional promotion only
after the inert phase remains healthy. On the host,
`ops/install-llm-button-canary.sh` requires regular non-symlink stock
`SceneSelectionHandler.qml` and `DeviceSceneView.qml` inputs beneath the
explicit `QML_REFERENCE_ROOT`, then runs the compiled QMD through
`qmldiff apply-diffs` with the SHA-pinned live hashtable. Both expected patched
resources must emerge as regular, non-symlink, nonempty files in the
transaction's private temporary directory and each must parse successfully via
local `qmlformat --ignore-settings` before any remote write. This
parser/application gate is intentionally stronger than hashtable compatibility
alone. The live fingerprint also requires
Xovi's generated `extensions.d` and `exthome` symlinks to be root-owned,
point at their exact `/home/root/xovi` targets, and be the only non-metadata
entries beside the two exact `.conf` files. Any mismatch or unhealthy restart
removes the candidate and restores the known stock Xovi state. The transaction
must not remount `/`, write firmware or boot configuration, load a kernel
module, or install the raw Qt-ABI extension.

Every negative precondition in the application and QML canary installers is
implemented as an explicit conditional failure, not a bare shell `!` command.
This matters under `set -e`: commands used with `!` are exempt from errexit,
so active conflicting services, a running worker, a still-active watchdog, or
forbidden credential keys must each enter an explicit error branch before any
transaction can proceed. Device-side explicit rejection branches call the
transaction rollback handler rather than `exit`, including after the
application directory has been swapped, so cleanup cannot be bypassed.

PID 1 owns a uniquely named transaction and watchdog. The installer writes an
`ARMED` marker before the QMD rename; after the controlled restart the
transaction writes `HEALTHY`, the controller performs a delayed independent
check and acknowledges it, and the watchdog alone writes `VALIDATED` after
rechecking the committed PID, exact QMD hash, mapped Xovi components, and
read-only root. The controller accepts success only after the watchdog exits
and the exact validated state remains. A disconnect, timeout, crash, or
malformed marker instead leaves the watchdog as the sole rollback owner.

For an already-qualified functional button, the same transaction has two
explicit refresh phases. `refresh-inert` requires the exact old functional
QMD plus exactly one matching serial/firmware/xochitl/transaction-bound
qualification marker before replacing it with the new disabled after-Copy
canary. The matching marker may come from the original `functional` promotion
or the most recent `refresh-functional` promotion; retained historical markers
do not qualify unless their transaction id and complete identity match the
operator-supplied confirmation. `refresh-functional` then requires that exact
new inert QMD and its newly emitted transaction marker. Either
armed failure rolls back conservatively to stock/no-QMD rather than trying to
continue with an unvalidated prior injection.

The target tablet currently carries seven other ReMagic QMDs: Better TOC,
Better TOC Collapse, Gestik, Ghostbuster, Pen Layer Memory, Quick Settings
Timer, and TOC From Selection. They are not accepted generically: the
compatibility allowlist pins every filename and SHA-256, and
`mod_files_are_exact` requires each one to be a root-owned regular mode-0644
file. The predicate directly enumerates visible, hidden, and double-dot
`.qmd`, `.qrr`, and `.rcc` paths, so a missing required file, changed or
symlinked file, or additional artifact aborts before `ARMED`. Required
allowlist keys are tracked from parsed file contents rather than inherited
environment variables. This lets the button coexist with the exact installed
ReMagic set without weakening the unknown-extension boundary.

The current contract deliberately pins BetterTOC's reviewed 3.28.0.164 r3
QMD (`903e40e97d6d48923c6f76f77b5ff7f20ac156ee2b01ee266f51e4487dfe68fb`).
An earlier `0.8.0` candidate still pinned r2 and therefore stopped at the
device-side pre-arm fingerprint after the independent BetterTOC upgrade. That
failure made no QMD rename and no `xochitl` restart. Preserving r3 requires a
new exact application contract and manifest; it does not add a multi-version
or wildcard coexistence rule.

There is no direct provider API call or publicly exposed OpenClaw operator
endpoint. `setup_uinput` is fail-closed: when `/dev/uinput` is missing, it
returns an error unless module loading was explicitly opted into with
`SMART_REMARKABLE_ALLOW_UINPUT_MODULE_LOAD=1`; the production wrappers refuse
even earlier. The optional web server, screenshot/output files, and full
request/response logging remain disabled, so Smart Remarkable keeps no local
transcript or page images. History and durable memory live only in OpenClaw's
canonical server session.

## Deployment validation

The installed 3.28.0.164 update is exact-firmware scoped. Its stock `xochitl`
SHA-256 is
`113bf7ea62ad171ea03c77c1f90e0666bcff163242a22ebca84372533b270c1c`,
build ID is `71ec3f61e3ce341d7b5fc4c56ca698980ff64cfb`, and rebuilt
hashtable SHA-256 is
`75c4e7b7353fdc4c3ee8840adfa42f61f19a02111a7c1492a99b7cfb57e12236`.
The approved legacy-v1 rollback QMD is
`2b9188af0c3fd726743e36ee1a3c86244cf6327ad22eeef1aa7a291a7add059d`;
its historical disabled canary was
`81b6050a739cd79e60b71bc78e504fae6d30ac996e6d0dde9970859bccdaadd5`.
The prior v2 functional source/compiled pair is
`130353dbba7fd31b764f0835b610d59d9c25c7f1cc2b2c52e9285379f23ec1b8`
and `28a253e1d16d4aa5e2852afa40699d3bc13b3fb2ab1e9cdc0a953deec9953ef6`.
The previously deployed direct-launch source/compiled pair was
`6aa2e491cffa568458c696e9035dca31f02b66786e30ad6f12f67dbfaa5b1fb9`
and `3ad5c084765a980b017da4b5e87670312242212ea362a456b7ab487d2ca9b451`.
Its selection-protocol and launcher hashes were respectively
`e124286e273474782f1632402711ae30ab6643afe8f05e85aecc9ce43cfc1e74`
and `79845482e8a47c84ee73b02f1641e60f83c81cd44504914f1aa49a1d797107e1`.
The preceding BusyBox/cached-helper revision changed those four hashes to
source `a4af1eeff5f011479e68e8fc14fe385e6a5070e8ff3051e0df69ff18c93a5b03`,
compiled QMD `495db83da318801d24ae3d4d63120c7e9d1568145e3298efccecea583f5c17c4`,
protocol `4317dafd6fcc3a1cd5fd21b427be7465621f570443112a390840004a0d23203a`,
and launcher `df7177e7d75b15a521e5ed748c8ea01f867deb3953f0cf3ac1dc5dd58f8aa88b`.
It was packaged as Smart Remarkable `0.7.2-openclaw`. Two later physical taps
proved its ink and Capture request paths before the separate session-lifetime
failure motivated `0.7.3`. Each pinned
QMD pair passes exact-hashtable compatibility and applies to the
extracted resource tree; with the seven supported ReMagic QMDs, the selected
Smart QMD composes in device filename order into 22 patched resources.

The deployed `0.7.3-openclaw` recovery revision leaves the approved
source/compiled QMD and selection protocol unchanged. Its aarch64 worker is
`d9e045c8eee9a442def7bf6218cfbf81797a3133cdd49673746931a1b0e222bb`
with build ID `3acb24c18156394f0352ad24572bdfe813e07507`; its launcher is
`e8d8729997f4975de54a9a3e6c20d219c4aeb069bc9268a758b3b81bd53582f3`,
its reconnecting runner is
`72588acb490cb17b7a2b8ca3bce4dc938862cff95da922267074d5c14f5b232c`,
and its complete compatibility contract is
`fab7ddfb35b0b005f382d2a2e8450b44b1e1a38adb1189546b3e7da860cf331d`.
The binary retains `/lib/ld-linux-aarch64.so.1`, maximum GLIBC 2.28, and no
RPATH/RUNPATH. The exact-device migration used the still-installed `0.7.2`
contract for refresh-inert transaction `20260801T115255Z-35025`, installed app
transaction `20260801T115433Z` with staged manifest
`afa3ee5e5e7edd24c3c059fc1015ba42294083e185e661d7ed2775d0908773aa`,
then promoted the unchanged functional QMD with current-contract transaction
`20260801T115608Z-37109`. Final `xochitl` PID `57254`, `NRestarts=0`, and
read-only root prove guarded deployment. A request-free transient-session smoke
test reached both `ready` and `bridge-ready`, verified the exact worker in
memory, produced no busy/trigger/ack markers, and stopped cleanly. Two later
physical `whatsapp_only` ink taps each emitted one content-free QML/launcher
stage chain, were consumed once by Rust, and completed as server request IDs
`smart-remarkable-fa26-18c7b415578ef44d-0` and
`smart-remarkable-102b9-18c7b68a6b9a9b5c-0`. The user confirmed the interaction
worked. Post-request state retained `xochitl` PID `57254`, `NRestarts=0`,
read-only root, and no busy/trigger/ack residue. This accepts the ordinary wand
path without claiming the deliberate tunnel-loss or complete orientation/kind
matrix.

The complete `0.8.0-openclaw` generation is deployed: application, visually
accepted inert checkpoint, server plugin/bridge, and functional v3 QMD. A
physical v3 wand request remains a separate acceptance gate. The generation
pins worker SHA-256
`4c9605f7f9e6be898230c3c5d607fa36fc1ce815ad85cc8f6f04e625be314f1e`
and build ID `16bc36a982fbb2465375641a2006e3936b511394`.
Its launcher, unchanged reconnecting runner, and v3 selection-protocol helper
are respectively
`6660d1f01510d9e92910f9fbdcbd23a4fe4c40aac3d5a74a27213fe3faea14cd`,
`72588acb490cb17b7a2b8ca3bce4dc938862cff95da922267074d5c14f5b232c`,
and `a11af20d55fc668c59e367d49e834844ed1e9a041cd400de481690811afb750c`.
The functional source/compiled QMD identities are
`1b01d2a123ac5d16763b140c2342c14bbd99243455fc81debdad85165707644d` and
`5cf5156df227a1ecdf3fb421b2cc57e55564bf31ab9d434a7f16c21b40ef0dc2`;
the inert source/compiled identities are
`85577aabce320c983de04ef0928851a9567839ba95494bd2d58dbf14f50b7b25` and
`635752321485a4dfb702b24fdf9b1f836f329a1399ebcc06f4b19dc4035a625a`.
Application transaction `20260801T185142Z` installed that worker with
r3-aware contract
`9a847c23e2a25d4554d10072c7f3ba706c01ae7743922463767c2e968b374215`
and staged manifest
`54f2c2cb0b9c9d828ed7aaa429ac7f351cd4bb384d0d496ba46ae83417e7233a`.
Refresh-inert transaction `20260801T185306Z-95906` committed and independently
validated inert compiled QMD
`635752321485a4dfb702b24fdf9b1f836f329a1399ebcc06f4b19dc4035a625a`
on `xochitl` PID `84925`, with zero restarts, no live deployment lock or
assistant unit, and read-only root. Server transaction
`20260801T213248Z-32250` installed plugin `0.4.0`, origin-v4, response envelope
v3, journal schema v3, and the matching bridge with direct current-process
capability proof and a completed fresh watchdog invocation. Functional
transaction `20260801T213623Z-74175` then committed the exact compiled v3 QMD
on `xochitl` PID `88214`, with `NRestarts=0`, inactive transaction/takeover
units, unchanged co-resident QMD hashes, and read-only root.

The historical firmware-recovery sequence first used disabled transaction
`20260730T184327Z-34344` and functional transaction
`20260730T184443Z-34618` to restore the legacy QMD. Guarded transaction
`20260731T162912Z-38343` later promoted the exact prior-v2 compiled QMD
`28a253e1d16d4aa5e2852afa40699d3bc13b3fb2ab1e9cdc0a953deec9953ef6`
and deployed worker
`c73586e65fe6acc5333b95c5934a9f5298ec5126de1069504ed09182c05e08a5`;
its recorded `xochitl` PID was `26925` with `NRestarts=0`. That establishes
which v2 bytes were live. It does not establish a successful button round
trip: AppLoad logged its external-no-GUI undefined-window error after spawning,
and the Rust listener did not receive the expected trigger. The global
`AppLoadLauncher` signal can also reach multiple loaded AppLoad receivers,
making one tap capable of starting competing launchers before that error.

For the direct-launch refresh, the old contract was retained in an isolated
old-HEAD worktree long enough to classify the exact deployed prior-v2 bytes.
Guarded refresh-inert transaction `20260731T222234Z-48219` then committed the
exact inert QMD before the new application contract was introduced. This is a
safe intermediate boundary: the new application was then installed with staged
manifest
`5690a3e627c5fa82f02dba631616522ebdf0278c6d91eb2bbccf0db339b20a54`
and unchanged worker
`c73586e65fe6acc5333b95c5934a9f5298ec5126de1069504ed09182c05e08a5`.
Guarded refresh-functional transaction `20260731T222432Z-49869` finally
committed corrected QMD
`3ad5c084765a980b017da4b5e87670312242212ea362a456b7ab487d2ca9b451`.
The recorded final `xochitl` PID is `39042` with `NRestarts=0`. Physical
attempts at `08:38:13` and `08:54:38` then proved that a valid descriptor
entered the launcher but the installed BusyBox `/usr/bin/od` rejected `-A`.
Nonce creation therefore failed before the busy marker, trigger marker, Rust
listener, bridge, or OpenClaw. AppLoad had already reported a positive child
PID, so QML could not observe the later shell failure and retained pending state
until its 45-second timer; this is the source of the apparent long lag in those
attempts. Handwritten/Capture round trips remain the separate acceptance gate.

The corrective deployment reused the established old-contract transition so a
protocol-skewed functional button was never exposed. Old-contract
refresh-inert transaction `20260801T091905Z-53220` committed the disabled QMD;
application staged manifest
`360f2a54f5efb1272dd21e2dcc421b5a8e329b9ffabdbd7ff95b3185e3360188`
then installed Smart Remarkable `0.7.2-openclaw` with the new launcher and
protocol helper. Refresh-functional transaction `20260801T092129Z-55163`
committed compiled QMD
`495db83da318801d24ae3d4d63120c7e9d1568145e3298efccecea583f5c17c4`.
Final health evidence recorded stock `xochitl` PID `48260`, `NRestarts=0`, and
read-only root. This establishes exact guarded deployment, not a post-fix wand
request, Rust consumption, bridge request, or OpenClaw receipt.

The lifecycle-recovery deployment repeated that ordering without changing the
functional QMD. Old-contract refresh-inert transaction
`20260801T115255Z-35025` established the compatibility boundary; app transaction
`20260801T115433Z` installed staged manifest
`afa3ee5e5e7edd24c3c059fc1015ba42294083e185e661d7ed2775d0908773aa`;
current-contract refresh-functional transaction `20260801T115608Z-37109`
restored functional QMD
`495db83da318801d24ae3d4d63120c7e9d1568145e3298efccecea583f5c17c4`.
The final request-free tunnel smoke test left the Smart session inactive,
`xochitl` PID `57254` at `NRestarts=0`, and root read-only. Subsequent physical
request acceptance completed two one-tap/one-turn ink requests while preserving
those stock-process and filesystem invariants.

The current two-button client passes its applicable native tests across the
library, application, and integration targets, with one unrelated upstream
font-render output-path test filtered. The current candidate bridge and
no-mirror delivery plugin suite passes 221 Node tests; this is local behavior
evidence, while server transaction `20260801T213248Z-32250` and its direct live
probes separately prove only the still-installed plugin `0.4.0` generation.
All six
settings/runtime/protocol/artifact shell suites pass. The native tests cover
strict nonce/orientation/freshness parsing, exact acknowledgement binding,
distinct legacy generations, explicit-orientation framebuffer normalization,
prepared-original page binding, verified chrome/caret delta masks,
text-activation failure suppression, balanced keyboard batches,
listener-failure restore, current/new physical-contact detection,
deterministic kind-aware crop preparation, malformed-image rejection, and the
real marquee fixture. The protocol shell test supplies deterministic structural
latency coverage: the launcher contains no bridge probe or remote marker gate,
the runner starts the worker before SSH and the health probe, and
prepare/capture/close all precede Rust's bridge-ready wait. This is device-free
ordering evidence; physical UI timing remains part of the v3 acceptance gate.
The bridge tests include strict transcription/answer envelopes, exact atomic
WhatsApp rendering, answer-only writeback, missing-live-final history
recovery, user-anchor attribution barriers, durable pre-`chat.send`
reservation, cross-process races, per-caller replay labeling, a hard
no-eviction capacity, ownership-marker races, an eagerly writable private
systemd state directory, explicit provider `sent` receipts, the strict request
namespace, schema-v1/schema-v2/schema-v3 migration barriers under schema v4,
exact two-image role/order and metadata validation, selection-page
fingerprints, response-envelope v3, origin-v5/plugin-0.5 capability binding,
automatic response-PDF authorization/render/upload/replay/failure behavior,
explicit sensitive-hook policy,
final-prompt admission gating, current-generation capability re-probing,
reconnect-race refusal, and dynamic health failure before journal reservation.
The deployed v2 aarch64 worker SHA-256 is
`c73586e65fe6acc5333b95c5934a9f5298ec5126de1069504ed09182c05e08a5`
with build ID `63c2a311d60699e22a22ee54e90094cce2e587f8`; it is an
ELF64 little-endian AArch64 PIE using `/lib/ld-linux-aarch64.so.1`, has no
RPATH/RUNPATH, and requires no GLIBC symbol newer than 2.28. The prior deployed
v2 QMD used source
`130353dbba7fd31b764f0835b610d59d9c25c7f1cc2b2c52e9285379f23ec1b8`
and compiled bytes
`28a253e1d16d4aa5e2852afa40699d3bc13b3fb2ab1e9cdc0a953deec9953ef6`.
The previously deployed direct-launch revision kept that worker and changed the functional
QMD source/compiled pair to
`6aa2e491cffa568458c696e9035dca31f02b66786e30ad6f12f67dbfaa5b1fb9`
and `3ad5c084765a980b017da4b5e87670312242212ea362a456b7ab487d2ca9b451`.
Those functional bytes were promoted by transaction
`20260731T222432Z-49869`; physical interaction exposed the nonce-generation
failure described above. The replacement QMD/protocol/launcher generation has
now passed its complete local, guarded-device, and ordinary physical wand gate.
The prior 3.28.0.163
QMLDiff artifacts passed offline compatibility and apply-diff checks against
that firmware's exact extracted resources. Its functional two-button
QMD is
`0fea5e9d78cb085528f0cde5af672abb9c3ca2b327127f43dc6e54605a688412`;
the disabled canary is
`0e5eec4ffa03b2b0fdbc6b42519165f93ae77a00c01cf77d92db8993d934978e`.
The tablet ran that exact functional stock-icon QMD before the 3.28.0.164
update. The user visually
accepted disabled transaction `20260728T095031Z-58185`; guarded transaction
`20260728T104334Z-63134` then promoted only that accepted layout and wrote the
device-bound marker `validated:refresh-functional:78929`. In that historical
deployment, `xochitl` remained
on PID `78929` with zero automatic restarts, the root filesystem stayed
read-only, and both canary units exited.

The server bridge/plugin, dedicated restricted SSH account, and current
aarch64 worker are installed. Server transaction
`20260728T094046Z-7054958` promoted plugin version `0.2.2` and the tested
bridge with a complete same-filesystem rollback. The bridge is healthy on PID
`492930`; OpenClaw Gateway is healthy on PID `492755`, both with zero
restarts. The refreshed tablet worker retains the reviewed binary hash above
and has staged-manifest SHA-256
`845e1fa437fb86b8be2b60efe7a95b0600f46c5b314223e1b68e8d569b3df502`.
A post-promotion, request-free launcher smoke test started the bounded
core-disabled worker, proved the restricted private bridge tunnel healthy,
created no trigger, and toggled the worker off. Smart Remarkable and T.M.R.
returned inactive while `xochitl` stayed on PID `78929` with zero restarts
and `/` stayed read-only.

A harmless live `whatsapp_only` request then produced the canonical envelope
`{"received_text":"Bridge smoke test\nPlease reply READY","response_text":"READY"}`.
Both acknowledgement and atomic final received native WhatsApp `sent`
receipts, while the tablet-facing body contained only the fixed WhatsApp-only
receipt. A second deployed-adapter canary,
`smart-remarkable-origin-canary-20260728T094530Z`, ran in canonical
`agent:main:main`, recorded `sourceChannel: remarkable` plus reMarkable
external-user provenance, and received acknowledgement and final WhatsApp
`sent` receipts. The remaining live gate is a disposable handwritten
selection through each physical icon, including answer-only stock-text
insertion for notebook-with-sparkles, followed by one harmless document
delivery.

### Historical one-button deployment baseline

The three-mode bundle is installed at
`/home/root/xovi/exthome/appload/smart-remarkable`. Its aarch64 binary has
SHA-256 `7af19e4aa795180caab47afa8d8cffa1355badd596a28594032c3bfa6cf7d6ff`
and needs no GLIBC symbol newer than 2.28. The root-owned mode-600 settings
default to `session-hold`; a no-request transient-session smoke test verified
the readiness marker, one-hour systemd bound, T.M.R. conflict, clean
cancellation, unchanged `xochitl` PID, zero restarts, and read-only root.

The first inert-button transaction refused before `ARMED` because the initial
active-drop-in allowlist omitted Xovi's two generated symlinks. It left the
QMD absent, `xochitl` on the same PID with zero restarts, and `/` read-only.
After the predicate was corrected to require the exact links and independently
reviewed again, inert transaction `20260724T150700Z-68965` committed QMD
SHA-256 `8fa36651d350eaffc19890730362e2bc7437e21848f9d27397205c8b01cc168a`.
The watchdog validated PID `36281`, both transient units exited, the global
lock was removed, `xochitl` remained active with zero automatic restarts, and
the root remained read-only. The user then confirmed the disabled item was
visible and the lasso menu remained stable. Server and tablet logs proved that
tapping that inert item created no trigger, model request, or canonical-session
turn; a separately started AppLoad session remained at `Waiting for PenHold`.

Functional transaction `20260724T155040Z-86105` promoted that exact location
to QMD SHA-256
`b897962d221e552e8fa74c5b7b99373b0a04c8582f06b0da70390a74f1ca15f6`.
The watchdog validated PID `40231`, both transient units exited, the global
lock was absent, Smart and T.M.R. were inactive, `xochitl` was active with zero
automatic restarts, and `/` remained read-only. Live button-request and
multi-mode interaction acceptance remain pending.

The first live tap on that functional QMD did complete one canonical request.
At 15:57 UTC Smart captured `Rect { x: 235, y: 443, w: 228, h: 188 }`,
ignored repeated taps while the request was active, and completed `draw_text`.
The server recorded exactly one `agent:main:main` turn with `whatsapp` channel
context and no duplicate turn in the checked window. This proved the original
trigger path, but its button preceded Cut and kept the marquee visible too
long, motivating the after-Copy capture-confirmed feedback handshake.

The revised functional QMD has SHA-256
`0aaef0c1d75cdaf5634fc490cae3659f0d764ca4f4d0911eea4ceb0c7535b6c8`;
the revised disabled canary is
`a53f8b9f2e33867fdc86ec7c41e0f107c99a6004db1d1554243b03cfa3c628c7`.
Both pass compatibility/application against the live hashtable and exact
extracted tree, producing
`Cut → Copy → LLM → Convert to text → Delete`. The installed aarch64
binary is
`7af19e4aa795180caab47afa8d8cffa1355badd596a28594032c3bfa6cf7d6ff`
and requires no GLIBC symbol newer than 2.28. The revised worker is installed.
Refresh-inert transaction
`20260724T163819Z-18257` committed the disabled revised QMD; its watchdog
validated `xochitl` PID `46307`, zero restarts, inactive assistants, cleared
transaction units/lock, and a read-only root.

An ordinary subsequent start came up in plain stock mode, which explained why
the button disappeared: the QMD remained on disk but Xovi was not mapped into
the new `xochitl` process. Xovi was reactivated only under a bounded
stock-rollback watchdog. Refresh-functional transaction
`20260724T173524Z-61264` then committed the after-Copy functional QMD. Two
delayed postchecks validated `xochitl` PID `5247` with zero restarts, mapped
Xovi, qt-resource-rebuilder, and AppLoad, exact functional-QMD, worker, and
Pen Layer Memory hashes, inactive assistant and canary units, no deployment
lock, and a read-only root. The current interactive feedback behavior still
needs a disposable-page no-submit/live tap acceptance test; installation and
stock-UI health are complete.

An installed-binary smoke test submitted a synthetic handwritten PNG through the forwarding-only tunnel with exact `agent:main:main` and `whatsapp` routing, received the requested `SMART_WHATSAPP_SHARED_OK` marker, and removed its temporary input/output files. A separate AppLoad-launcher test started the transient worker, verified the tunnel, service containment, ten-minute deadline, disabled core dumps, `xochitl` binding, and T.M.R. conflict, then invoked the same launcher again and confirmed complete cancellation. Both tests left `xochitl` active and the root filesystem read-only.

The final installed binary also passed two current-device acceptance tests. First, a no-submit trigger with no active selection captured the screen, returned `NoSelection`, and remained armed instead of silently exiting. Second, the user completed a native lasso; Smart tolerated the intermediate pen-up candidates, detected the finished marquee as `Rect { x: 464, y: 261, w: 147, h: 56 }`, sent only that crop to the canonical OpenClaw session, executed `draw_text`, inserted the response as stock reMarkable text, and exited. Post-run verification found `xochitl` still active on the same PID with zero restarts, no Smart/Riddle/tunnel process, no trigger file, no retained capture or log, and `/` still mounted read-only.

Exactly one Smart Remarkable application directory and manifest remain below AppLoad's scan root. Three timestamped rollback bundles are preserved in root-only `/home/root/.smart-remarkable-recovery`; they are not enumerated as applications. AppLoad may retain its old in-memory list until the user taps **Reload** once, after which only the active tile is displayed.

Xovi had remained installed but was not mapped after a restart, so the existing supported Xovi start transaction was used once to restore it. `xochitl` logged that the external AppLoad hooks loaded, and a live stock-sidebar capture visibly confirmed the **AppLoad** entry. AppLoad is an injected sidebar view, not a standalone daemon: after a restart the user activates Xovi with the installed triple-power toggle, then opens **My files → left sidebar → AppLoad**. AppLoad's **Reload** operation only rebuilds its dynamic manifest list; it does not open a notebook.

Firmware 3.28.0.163's stock `/usr/bin/screenshot` helper must not be used as a validation path. In this deployment it sent `USR2`, causing one automatic `xochitl` restart instead of writing a PNG. Smart Remarkable therefore reads `/proc/<xochitl>/mem` without modifying it. One live layout showed three distinct `card0` allocation groups: only the middle group carried the valid chained frame, while the first and last began with zero headers. A later layout had two graphics groups whose linked chain ended in an empty slot, plus a standalone anonymous `0xd73000`-byte allocation with the terminal `0xd73002` header at offset `+8`. That signature is derived from the native 6528-byte stride times 2160 rows, rounded to 4 KiB; chain lengths store the allocation advance plus two. The locator therefore accepts only the exact terminal header, requires smaller intermediate advances to be page-aligned, bounds chain traversal and arithmetic, and reads the complete 14,061,312-byte frame before acceptance. This makes selection capture independent of both allocation order and allocator detachment while rejecting unrelated anonymous memory and future unknown layouts.

An earlier deployment on a Paper Pro running firmware 3.28.0.162 separately proved native lasso-to-editable-stock-text output with the answer `10`. The current-device test above supersedes the later temporary deferral and validates the supported AppLoad arm-then-lasso workflow on firmware 3.28.0.163.

## Modules

- `src/main.rs`: parses CLI/configuration, creates the provider and device
  objects, registers drawing tools, coordinates the application lifecycle, and
  owns the exact-only write-back guard. Guarded text is typed only after
  prepared-original page binding, verified Text/palette activation, a narrow
  caret delta, an idle physical-input monitor, and complete bounded character
  validation. It also supervises trigger-listener lifetime; listener failure
  cancels and settles/aborts processing before the idempotent QML restore.
- `src/coordinator.rs`: runs the trigger, screenshot, model, progress, and
  tool-execution pipeline. It distinguishes canonical v3, strict v2-migration,
  pinned legacy button generations, manual touch, and pen-lasso input; owns
  single-request admission; performs the prepare/capture/close acknowledgement
  transaction; creates the focal selection and faithful page view from one
  immutable framebuffer; installs the bounded document/page context; retains
  the prepared full-page view and exact-rebinds the first post-close view;
  continues canonical delivery with insertion suppressed when rebind fails;
  and clears both images, metadata, and tool scratch state on every terminal
  path. V2 migration, legacy, and pen-lasso paths remain locally
  write-suppressed rather than receiving an unprovable exact guard.
- `src/touch.rs`: reads real touch events, classifies eligible release or
  held-endpoint Paper Pro pen contacts without grabbing the stylus device,
  strictly consumes root-only nonce-bearing v3, v2-migration, or `legacy-v1`
  trigger files, validates exact prepare/close acknowledgements including the
  v3 document/page snapshot, waits for separate bridge readiness,
  verifies/removes the matching busy generation last, and owns local readiness
  through an RAII guard. It also verifies the stock Text/palette state and
  provides the nonexclusive write-back input monitor, including current
  pen-button and all multitouch-slot state before output.
- `src/document_context.rs`: resolves only the v3 descriptor's exact
  document-UUID `.metadata` file below the fixed xochitl data root. It rejects
  symlinks, unexpected owner/mode/link count, unstable identity or size,
  oversized/invalid JSON, and empty, non-NFC, control-bearing, or oversized
  `visibleName` values; it returns only the bounded display name and logs no
  UUID or title.
- `src/screenshot.rs`: groups all of `xochitl`'s Paper Pro graphics mappings,
  includes detached anonymous frame allocations, validates bounded
  frame-header candidates and full-frame readability without modifying process
  memory, normalizes the accepted frame to 768x1024, applies the trusted
  `normal`/`rot180` orientation without the screenshot-corner heuristic, and
  retains exact normalized-view bytes used by write-back. Its delta helpers
  prove that changes are confined to disjoint firmware-pinned chrome/caret
  masks and that the target contains a minimum vertical caret-like run.
- `src/util.rs`: includes strict kind-aware in-memory selection preprocessing:
  PNG decode, ink-only grayscale/background normalization, RGB-preserving
  image/mixed handling, aspect-preserving Lanczos enlargement, and PNG
  re-encoding. Decode or kind failures abort before submission instead of
  falling back to raw bytes.
- `src/pen.rs` and `src/keyboard.rs`: create temporary uinput devices and
  translate model output into pen strokes or keyboard events. The keyboard
  emits balanced QML-private prepare, close, and restore chords with one
  library-owned terminating sync; a reported prepare failure always attempts
  restore. Guarded body-style and per-character output use balanced batches,
  reject unsupported/over-budget answers before the first key, and never use a
  touch coordinate to dismiss the selection.
- `src/llm_engine/`: implements OpenClaw, OpenAI, Anthropic, and Google
  transports behind the common `LLMEngine` interface. `SelectionPageContext`
  carries the two same-frame images and bounded document/page metadata only for
  OpenClaw; direct providers retain their historical single-image shape.
  Provider debug logs report only model/item counts and response-block sizes,
  never selected-page image payloads, metadata, or model text.
- Google transport failures are mapped to URL-free messages before they reach
  the coordinator because that provider places its API key in the request
  query string.
- `src/llm_engine/openai.rs`: provides both the direct OpenAI tool-call
  transport and a narrow OpenClaw-bridge mode. Bridge mode authenticates only
  with `OPENCLAW_BRIDGE_TOKEN`, sends an exact `smart-remarkable-` request ID
  plus explicit response-mode, trusted selection-kind, and
  `selection-page-v1` headers; serializes one text part followed by the ordered
  role-tagged selection and page PNGs plus exact metadata; never
  accepts client-controlled session/channel routing, emits the historical
  remote-accepted status when successful HTTP headers arrive, validates
  request/mode/kind/delivery metadata in the final JSON, and dispatches the
  text tool only for a non-replayed `write_back`. Bridge-mode transport and
  response-body interruptions are retried through a separate transport window
  of at most fifteen minutes with the exact same serialized request and request
  ID. Together with the preceding, independently bounded fifteen-minute bridge
  readiness wait, this can retain one context bundle in RAM for roughly thirty minutes
  in the worst case. Pre-acceptance 502, 503, and 504 responses use that same
  retry identity with capped backoff. Redirects are disabled so neither crop
  nor sensitive bearer can leave the pinned loopback route, and only exact
  HTTP 200 emits acceptance. A 4xx response remains terminal: in particular,
  an incomplete durable reservation after a bridge-process restart is not
  resubmitted. Acceptance is emitted at most once; direct provider requests
  are not given this retry policy. `src/main.rs`, not the transport, owns the
  final view/placement/activation guard before typing.
- `src/config.rs` and `prompts/`: merge runtime configuration and define provider/tool instructions. `selection_openclaw.json` asks OpenClaw for concise plain text that is safe to type into a stock text box; `selection_openclaw_whatsapp.json` asks for an ordinary canonical OpenClaw response when no notebook insertion is requested; `selection_print.json` remains the direct-provider print prompt.
- `bridge/`: implements the loopback-only, narrow-token HTTP adapter. It
  validates the strict one-prompt/two-role-PNG `selection-page-v1` request,
  bounded document/page metadata, exact request-ID namespace, and trusted
  selection kind. It proves the exact plugin `0.5.0`/origin-v5 capability
  contract, including the response-PDF RPC, policy, and destination, for
  the current authenticated Gateway generation before persistently reserving
  the request identity, then captures the current transcript as an exact recovery and authority
  locator, binds trusted reMarkable origin/session state, and submits one canonical
  `chat.send deliver=false` run with durable external-user/reMarkable
  provenance, the fixed `per-sender|main|main` routing contract, and normal
  WhatsApp routing. It never supplies the captured transcript ID to
  `chat.send`, because that can repin OpenClaw's current session. It flushes
  acceptance only after an exact run-ID match, treats live output as a
  candidate until the captured transcript contains the exact request anchor,
  and reconciles either same-session current history or the exact active/reset
  captured transcript. It refuses to resubmit any incomplete reservation after
  restart and uses the plugin-owned no-mirror delivery method for the ordered
  acknowledgement and final. After strict completion it requests the one
  authenticated response PDF, waits for its terminal receipt, reports that
  status in WhatsApp, and records the safe outcome. The schema-v4 request
  journal stores hashes, mode, selection kind, context version, state, and a
  bounded cached response plus PDF receipt metadata, but never either PNG, PDF
  bytes, the prompt, or the raw document-display-name request field. The cached
  safe response may naturally mention that title. Schema-v1, schema-v2, and
  schema-v3 entries remain fail-closed capacity barriers. Its atomically
  claimed fixed-capacity slots are never automatically evicted; a leaked slot
  safely reduces capacity. The production bridge is a system service that
  drops to `User=mdf`, eagerly prepares its single private writable
  `StateDirectory` before opening `/health`; health then dynamically requires
  current-generation capability readiness. The service makes the rest of the server
  home read-only. A system service is required because the server's systemd
  249 user manager does not enforce `ProtectHome=` or `ProtectSystem=`.
- `bridge/src/response-envelope.mjs`: owns the versioned canonical reply instruction, strict two-field JSON parser, normalization and byte limits, `[unclear]` handling, and WhatsApp quote-plus-answer rendering with a fixed reserve for the server-added PDF status.
- `bridge/src/source-provenance.mjs`: defines the versioned trusted origin,
  exact capability/bind/clear/response-PDF RPC names, strict request namespace,
  pinned plugin/version/selection-kind/PDF-policy contract, durable
  `systemInputProvenance`, and strict bridge-side receipt validation.
- `bridge/src/transcript-recovery.mjs`: reads only the transcript ID captured
  during preflight, using a validated filename component, active-file
  precedence, at most 128 exact reset-archive names, `O_NOFOLLOW`, a 64 MiB
  file bound, an 8 MiB line bound, exact first-record session identity, and one
  unique request-user anchor.
  Missing journal ancestors are created individually with an immediate
  parent-directory fsync, preserving the reservation hierarchy for both the
  production state directory and deeper manual-run paths. Root, entry, and
  record symlinks are each rejected before a cached response can be read.
- `bridge/openclaw-plugin/`: defines the tightly scoped
  `smart_remarkable.deliver`, `smart_remarkable.capabilities`,
  `smart_remarkable.bind_origin`, `smart_remarkable.clear_origin`, and
  `smart_remarkable.deliver_response_pdf` Gateway
  methods, model-admission/prompt/tool-call hooks, and
  `remarkable_deliver_document` agent tool. Delivery accepts only a bounded
  request ID, kind, and text; derives the direct `agent:main:main` WhatsApp
  route inside OpenClaw; coalesces exact retries; sends through the public
  durable channel outbound API without transcript-mirror metadata; and exposes
  only normalized provider receipts or fixed errors. Delivery remains
  `operator.write`; origin bind, clear, and response-PDF delivery require
  `operator.admin`. Origin binding stores a
  server-generated capability and separate cleanup handle as a scalar host
  run-context record before model admission. The candidate version-0.5.0 generation
  requires explicit live prompt-injection and conversation-access policy, then reaches
  that host state after registration through its synchronous agent-event
  adapter. The event contains only a random operation ID; the complete bounded
  command remains private to its originating plugin instance, and exact host
  read-back is required before success. Pending records expire after
  twelve minutes; the exact prompt-hook run and captured transcript activate
  authority for at most fifteen minutes. A later gate blocks model admission
  unless that active identity and exact server guidance survive final prompt
  construction, and every bridge outcome explicitly
  clears it with the exact handle. The bind-side 128-record cap rejects new
  local reservations instead of evicting them. It reconciles those slots
  against host state before each bind, retaining active records until their
  fixed deadline and clearing expired or malformed host entries before
  releasing capacity. Only
  the exact active captured-transcript/main-agent/main-session run can upload a
  workspace-contained regular PDF or EPUB through the existing
  `remarkable-sync` CLI. Private snapshots, strict format/path/config checks,
  no-shell execution, bounded results, and a durable fail-closed receipt
  journal prevent prompt-forged or duplicate cloud uploads. That journal opens
  directories and records without following links, validates ownership,
  identity, private mode, link count, size, and UTF-8 before accepting cached
  success.
- `bridge/openclaw-plugin/response-pdf.mjs`: creates a private deterministic
  response-summary PDF from only the strict selection transcription and answer.
  It uses a structured Pandoc JSON AST with no raw nodes, pinned no-shell
  Pandoc/XeLaTeX execution, private caches, fixed styling and naming, strict
  text/dependency/time/output/PDF checks, and an idempotent cleanup handle.
- `scripts/run-selected-once.sh`: provides the constrained SSH-triggered Paper
  Pro launcher. It validates both tunnel ports, starts and health-checks a
  restricted SSH port forward to the loopback bridge rather than the
  privileged Gateway, triggers one native selection request, and cleans up
  both helper processes on every exit path. Both production runners reject
  caller-supplied binary arguments, require the exact regular root-owned
  mode-0600 bridge key, unset SSH agent/password-helper variables, and invoke
  Dropbear with an isolated `/run` home containing only a copied pinned
  `known_hosts` file. This prevents default or agent identities and caller
  flags from enabling extra forwarding, debug endpoints, local output files,
  or secret-bearing arguments. They also require the installed environment to
  be a non-symlink root-owned mode-0600 file and pin the server address,
  dedicated tunnel user, local port, and remote bridge port rather than
  accepting an inherited route.
  Before sourcing any helper, each runner also requires its resolved directory
  to be the exact root-owned AppLoad installation and each helper to be a
  non-symlink root-owned mode-0755 regular file. Tunnel health probes run under
  `env -i`, so the bridge bearer is not needlessly present in the `wget`
  process environment.
- `scripts/mode-settings.sh`: strictly parses the root-only, non-secret mode file as data and maps `once`, `session-hold`, or `session-auto` to a trigger policy and bounded service lifetime.
- `scripts/selection-protocol.sh`: strictly parses canonical QML requests,
  QML acknowledgement snapshots, and nonce-bearing active descriptors without
  evaluation; bounds digit counts before BusyBox integer conversion; enforces
  fixed fields and coordinate bounds; reads 256 bits from
  `/dev/urandom`; and exposes only validated values to the root launcher.
- `tests/mode-settings-test.sh` and `tests/fixtures/`: exercise all three mode mappings and the fail-closed invalid-mode path without a tablet or credential.
- `scripts/run-armed-once.sh`: provides the compatibility-named AppLoad worker.
  It refuses to load any fallback kernel module, starts the configured Rust
  listener before network setup, owns root-only volatile local-ready,
  remote-ready, trigger, acknowledgement, and busy state under `/run`,
  then validates and opens the restricted key-only local `18791` to remote
  loopback `18792` bridge tunnel. A dead tunnel removes remote readiness,
  reaps only the SSH child, and reconnects while Rust retains at most one crop
  in memory; a finished listener terminates the tunnel while preserving its
  status.
- `remagic/appload-launch.sh` and `remagic/external.manifest.json`: define the
  single non-QTFB AppLoad tile and toggle a time-limited transient session
  without changing boot state. The launcher refuses to source its mode helper
  or selection-protocol helper unless both resolve inside the exact root-owned
  AppLoad installation. A v2 descriptor can be published only after local
  listener readiness; the launcher does not probe or wait for the bridge. It
  serializes the complete transient-unit lifecycle with a separate fd lock,
  refuses to stop an exact busy generation, and gives each accepted explicit
  button request a fresh one-hour minimum lifetime. Lock acquisition is bounded,
  and the fixed transient name is reused only after a stopped `--collect` unit
  reports `LoadState=not-found`. It
  creates a kernel-random nonce through the exact device-supported `hexdump`
  interface, verifies its canonical lowercase-hex representation, publishes
  busy before the trigger, rejects another request until Rust verifies terminal
  cleanup, and accepts QML
  acknowledgements only when their snapshot exactly matches that nonce's
  active descriptor. Content-free `SR_WAND` stages identify the last completed
  launcher boundary without disclosing request data. Historical
  `--selection-button` arguments are accepted only as the explicit pinned-QMD
  `legacy-v1` migration route.
- `xovi-qmd/`: contains the disabled visual-canary source/artifact, the
  reviewable firmware-specific v3 functional source, the pinned v2/legacy-v1
  rollback artifact, and the immutable compatibility contract. The functional
  source rehashes through the pinned QMLDiff tool and exact firmware hashtable
  to the byte-identical compiled direct-launch artifact recorded by the
  finalized contract. That artifact and the seven exact co-resident QMDs pass
  compatibility and compose to 22 resources. The earlier direct-launch
  generation failed physical nonce creation; its BusyBox/cached-helper and
  lifecycle repairs later passed two physical v2 wand requests. The v3
  application, inert QMD, server generation, and functional QMD are now
  deployed through transactions `20260801T185142Z`,
  `20260801T185306Z-95906`, `20260801T213248Z-32250`, and
  `20260801T213623Z-74175`, respectively. Physical v3 request acceptance is
  still separate. Both menus place the firmware's stock
  notebook-with-sparkles answer-here action and stock sparkles agent action
  immediately after Copy. The v3 source derives
  live kind, fixed-point view geometry, and stable scene orientation; rechecks
  that snapshot at both the prepare and close phases; hides only the stock
  `controlsAreVisible` flag through a reversible binding; and returns exact
  prepare/close acknowledgements through AppLoad. Pending state is centralized,
  its initial launch is deferred one event-loop turn for paint, and the
  deployed revision prewarms one parent-owned dynamic helper for reuse across
  `AppLoadLibrary.launchExternal` calls, each of which must return a positive
  PID. State clears
  on visibility loss, timeout, launch failure, or revalidation failure. The
  QMD never emits AppLoad's global launcher signal or enters its no-GUI window
  path. Offline QMLDiff compatibility/application against the extracted
  exact 3.28.0.164 resource tree must succeed before either device canary. The
  patch has no credential or direct OpenClaw access; the AppLoad launcher
  remains the only bridge to the session worker.
- `ops/artifact-compatibility-contract.sh`: is the shared strict parser and
  exact installed-client/QMD classifier used by both device transactions. It
  rejects missing, duplicate, unknown, unsafe, partially finalized, or
  protocol-skewed contract data before mutation.
- `ops/install-smart-openclaw.sh` and `ops/device-install-smart-openclaw.sh`:
  assemble the local AppLoad bundle, preflight `/home` capacity, and require
  the live tablet's exact `hexdump` command to produce one canonical 64-character
  nonce before mutation. They stream only
  the server-generated narrow bridge bearer directly from its mode-0600
  server file into a transaction-private mode-0600 tablet file, verify its
  SHA-256 at both ends, and atomically install or roll back the application
  below `/home`. The full Gateway credential, canonical session, and WhatsApp
  route are never copied to the Mac or tablet. The installed mode-0600
  environment names only the narrow bearer, a dedicated bridge-only Dropbear
  identity, and local/remote tunnel ports; the older Riddle key and its direct
  Gateway forwarding permission are not reused. The controller rejects
  lexical path traversal and also requires the server token path to resolve
  unchanged below `/home`; both installer halves require the dedicated tablet
  identity to be a non-symlink regular file owned by root with mode 0600.
  Before transfer or extraction they require every mutable application and
  settings parent to be the exact non-symlink root-owned directory, require
  transaction paths to be absent rather than dangling symlinks, and validate
  the root-only recovery directory. This keeps application mutations
  physically below `/home`. The device installer validates the deployment ID
  as an exact UTC timestamp before using it to derive any transaction path or
  installing cleanup traps.
  `ops/build-staged-sha256-manifest.sh` deterministically sorts every staged
  regular-file path and hashes its final bytes, so tracked state is contextual
  rather than authoritative and explicitly staged untracked inputs cannot
  disappear from provenance. `STAGED-FILES.sha256` covers every other bundled
  file, including `INSTALL-PROVENANCE.txt`; the controller passes the
  manifest's own hash and the device-installer hash separately. Before
  mutation, the device half verifies the archive, its exact path-only member
  list before extraction, its own transferred bytes, the manifest hash, the
  exact manifest-to-extracted-file-set match, and every listed checksum. It
  writes and syncs a `phase=prepared` recovery record before moving either
  application directory, so a power loss after the old app is renamed or
  after the new app becomes active still leaves an auditable recovery map.
  After the atomic swap it repeats the checks and atomically replaces that
  record with `phase=installed`. The root-owned mode-0600
  `/home/root/.smart-remarkable-recovery/install-<id>.provenance` record
  containing the archive, binary, installer, and manifest hashes plus the
  complete staged-file manifest. A failed transaction removes only metadata
  created by that transaction. The controller also refuses to package a
  worker whose hash differs from the independently reviewed two-button binary
  recorded in this design and `prd.org`.
  The bundle now includes the byte-identical compatibility contract, shared
  parser, and selection-protocol helper. The device half holds the shared QMD
  deployment lock across classification and swap, records the active QMD and
  prior-app manifest/contract observations, and records
  `rollback_order=qmd-before-app` in recovery metadata.
  The installer creates the separate mode-600 settings file only when absent,
  validates and preserves any existing one, and removes a newly created file
  if the transaction rolls back. Deployment stages and preserved rollbacks
  live under root-only `/home/root/.smart-remarkable-recovery`, outside
  AppLoad's one-directory-per-application scan root.
- `tests/staged-file-manifest-test.sh`: proves deterministic ordering and
  regeneration, detects content changes in an untracked-named staged input,
  rejects staged symlinks, verifies the manifest, and syntax-checks both
  installer halves without contacting a device.
- `tests/smart-openclaw-recovery-metadata-test.sh`: executes the installer's
  real metadata helper in a temporary transaction layout, proves the synced
  `prepared` record predates either application rename, preserves it across
  simulated power-loss checkpoints, and verifies the atomic `installed`
  transition and embedded manifests.
- `tests/artifact-compatibility-contract-test.sh`: exercises strict contract
  loading, unresolved-versus-complete generation states, QMD classification,
  duplicate/unknown/malformed rejection, exact bundle membership, both sides
  of the shared lock, the installed-client-before-`ARMED` gate, legacy launcher
  aliases, and actual artifact hashes automatically once the contract is
  finalized. It does not contact a server or device.
- Both halves of that installer independently pin the intended tablet serial,
  firmware version and build timestamp, and exact `xochitl` SHA-256 before
  mutation. An SSH alias accidentally pointing at the user's other
  reMarkable therefore fails closed.
- The device-side transaction uses only commands present in the tablet's
  BusyBox userspace; it creates the settings directory with guarded
  `mkdir`/`chown`/`chmod` operations rather than assuming GNU `install`.
- `ops/install-llm-button-canary.sh` and
  `ops/device-install-llm-button-canary.sh`: run the exact-device inert,
  functional, refresh-inert, or refresh-functional QML transaction. The
  controller verifies the live hashtable with
  local QMLDiff, acquires the device-wide deployment lock, starts the
  systemd-owned watchdog/transaction pair, acknowledges a healthy candidate,
  and accepts only a watchdog-validated commit. The device half performs the
  complete fresh fingerprint, guarded QMD swap, controlled `xochitl` restart,
  bounded health sampling, and exact-stock rollback. Functional authority is
  unavailable until the complete application/QMD contract matches the exact
  installed client; refresh-inert accepts only the explicitly classified
  legacy-functional or new-functional pre-state rather than conflating the
  historical `PREVIOUS` reference with the installed 3.28.0.164 legacy QMD.
- `README.md`: leads with the supported two-button stock-text/WhatsApp OpenClaw/AppLoad workflow, reports local versus installed state explicitly, and clearly separates it from the upstream experimental pen-stroke and raw injected-button paths.
- `ops/openclaw-gateway-watchdog.sh`: keeps the private gateway available without restarting it during its plugin-heavy startup. It honors a 90-second startup grace and, after a genuine unhealthy state, waits for readiness after restart instead of assuming the port opens in ten seconds.

## Main functions

- `main` in `src/main.rs`: loads environment/configuration, handles diagnostics, and enters the Smart Remarkable orchestration loop.
- The `draw_text` registration and `after_successful_activation` in
  `src/main.rs`: accept only an exact prepared-original view guard, verify stock
  Text/palette activation plus the narrow caret delta, start the nonexclusive
  input monitor, and stop before or during keyboard output on every guard,
  interaction, unsupported-character, or budget failure.
- `await_processing_while_listener_alive` and
  `settle_processing_after_listener_failure` in `src/main.rs`: prioritize a
  dead trigger listener over simultaneous request completion, cancel and
  boundedly settle or abort processing, then restore any still-prepared stock
  selection before the worker exits.
- `write_back_cursor_is_verified` in `src/main.rs`: accepts only changes inside
  the disjoint pinned toolbar and 16×64 target regions and requires the target
  to contain a minimum vertical caret-like run.
- `create_engine` in `src/main.rs`: selects the provider transport; `openclaw` uses the OpenAI-compatible wire format but final-text response handling and OpenClaw-specific environment variables.
- `OpenAI::new_openclaw` in `src/llm_engine/openai.rs`: creates the loopback bridge transport using `OPENCLAW_BRIDGE_BASE_URL`/`OPENCLAW_BRIDGE_TOKEN`; the tablet does not receive Gateway, session, channel, account, or recipient authority.
- `OpenAI::send_openclaw_with_recovery` in `src/llm_engine/openai.rs`: rebuilds
  only interrupted bridge HTTP connections inside one overall deadline while
  preserving the exact request ID, body, response mode, and selection kind;
  this lets the server's live job map or durable completion journal return one
  idempotent result after a lost connection.
- `parseResponseEnvelope` and `renderResponseEnvelope` in `bridge/src/response-envelope.mjs`: turn the one canonical structured final into a validated literal transcription, answer-only tablet result, and one delivery-bounded WhatsApp message.
- `SelectionService.submit` in `bridge/src/selection-service.mjs`: durably
  reserves the idempotency key, captures the current transcript for recovery
  and authority, binds trusted reMarkable origin/session state, sends the
  canonical WhatsApp-routed turn with the fixed routing contract but without a
  caller-supplied transcript ID, waits for ordered acknowledgement/final
  receipts, reconciles same-session current history, prefers exact
  request-anchored active/reset transcript output after a remap, and admits a
  newly canonical successor history only after exactly one finalized captured
  reset archive is strictly and stably proven unanchored and the new history
  contains the exact request anchor plus persisted Smart reMarkable
  provenance. It verifies any live candidate against the eligible history
  anchor, requests one binding-scoped response PDF, waits for its strict cloud
  receipt, sends the final WhatsApp answer with that status, and commits the
  mode-specific schema-v4 safe response.
- `createRunContextControl` in
  `bridge/openclaw-plugin/run-context-control.mjs`: registers the plugin-owned
  subscription while the API is open, then adapts late synchronous
  get/set/clear requests to host callback methods. It emits only a random
  operation ID, keeps commands and receipts bounded and private, requires an
  exact synchronous receipt and read-back, and clears both maps in a `finally`
  path.
- `recoverTranscriptMessages` in `bridge/src/transcript-recovery.mjs`: opens
  only the preflight-captured active JSONL or bounded exact-name OpenClaw reset
  archives without following links, validates the first session record and
  unique request anchor, and returns the exact user/assistant interval without
  reading another session's transcript.
- `proveCapturedResetTranscriptUnanchored` in
  `bridge/src/transcript-recovery.mjs`: provides the narrower negative proof
  needed for an automatic canonical-session successor. It rejects any active
  transcript or non-unique reset set, requires a stable no-follow read with
  fatal UTF-8 and strict bounded JSONL, rechecks the candidate set and reopened
  path identity, and returns true only for the exact captured-session reset
  archive with zero request anchors.
- `createOriginBindingHandlers` and `createRemarkableOriginHooks` in
  `bridge/openclaw-plugin/remarkable-upload.mjs`: store the server-generated
  per-run authority plus selection kind, `selection-page-v1`, and captured
  transcript identity; add proactive capture/page/title/history/memory guidance
  only when the prompt hook reports that exact transcript; recheck the exact
  active identity and final guidance in `before_agent_run`; and authorize the
  upload tool only at the exact run/transcript/agent/session-key boundary.
- `createRemarkableResponsePdfHandler` in
  `bridge/openclaw-plugin/remarkable-upload.mjs`: validates the exact bridge
  RPC, rechecks its opaque active-origin handle and canonical run identity,
  renders one deterministic response PDF, and routes it through the durable
  cloud-upload receipt path with in-flight coalescing and fail-closed replay.
- `renderResponsePdf` in `bridge/openclaw-plugin/response-pdf.mjs`: validates
  bounded, well-formed, nonblank Unicode input, builds the fixed Pandoc JSON AST, runs the
  pinned renderer with installed fixed `DejaVu Sans`, `Noto Sans Hebrew`, and
  `Noto Sans Arabic` faces in private bounded state, marks
  English/Hebrew/Arabic paragraphs and runs with
  native structured language/direction attributes, validates the resulting regular
  PDF and hash, and returns an upload snapshot plus idempotent cleanup.
- `createRemarkableUploadTool` in
  `bridge/openclaw-plugin/remarkable-upload.mjs`: validates and privately
  snapshots a workspace PDF or EPUB, invokes the pinned reMarkable Cloud CLI
  without a shell or unrelated credentials, validates its receipt, and uses a
  durable fail-closed artifact journal to avoid duplicate uploads.
- `OpenAI::request_builder` in `src/llm_engine/openai.rs`: for v3 bridge mode,
  emits the strict namespaced request ID, response mode, selection kind, and
  `selection-page-v1` header plus one text part, ordered role-tagged selection
  and current-page images, and exact document/page metadata. The strict v2
  migration adapter retains its one-image body, and direct provider requests
  remain unchanged.
- `acquire_lifecycle_lock` in `remagic/appload-launch.sh`: validates a
  root-only `/run` lock file and takes an auto-releasing fd lock around the
  complete inspect/stop/start/button-admission transition so concurrent
  launchers cannot stop each other's fresh unit.
- `wait_for_session_unit_unloaded` in `remagic/appload-launch.sh`: boundedly
  waits for PID 1 to garbage-collect the prior transient name before a fresh
  `systemd-run` call, failing before descriptor publication on any unexpected
  load state or timeout.
- `stop_session_unit_if_present` in `remagic/appload-launch.sh`: stops the idle
  transient and tolerates only the narrow race where `RuntimeMaxSec` already
  made it inactive or unloaded; every other stop failure aborts before a fresh
  descriptor can be published.
- `captureSnapshot` in the firmware-pinned QML source: derives the live
  selection kind, maps all four selection corners into fixed-point view bounds,
  accepts only the stable `normal` or `rot180` scene transform, and binds the
  explicit `DeviceSceneView` document UUID, page id/index, mapped page-view
  bounds, and honest page-image completeness.
- `requestMode`, `ensureAppLoadHelper`, and `launchArgument` in the
  firmware-pinned QML source: commit and revalidate one pending snapshot across
  a deferred paint turn, prewarm and cache one parent-owned dynamic AppLoad
  helper per selection handler, then invoke the required non-QTFB
  `AppLoadLibrary.launchExternal` operation and accept only its positive PID
  without broadcasting or creating a window.
- `smart_parse_selection_request`, `smart_parse_selection_snapshot`, and
  `smart_parse_active_selection_descriptor` in
  `scripts/selection-protocol.sh`: parse each distinct protocol shape as strict
  data; `smart_generate_selection_nonce` obtains 32 bytes from the kernel RNG
  through the device-proven `hexdump` formatter and accepts only their exact
  64-character lowercase-hex representation.
- `SelectionDescriptor::parse_at` and `SelectionRequest::parse_at` in
  `src/touch.rs`: enforce canonical v3 nonce/kind/orientation/geometry,
  document UUID, page identity/index, page-view bounds/completeness, and time;
  retain strict v2 only for the allowlisted app-first migration; and keep the
  pinned-QMD `legacy-v1` generation deliberately distinct. No generation falls
  back to another or to marquee-derived geometry.
- `wait_for_selection_acknowledgement` and `wait_for_bridge_ready` in
  `src/touch.rs`: consume exact nonce-bound
  prepare/close acknowledgements and, only after local close, wait for the
  separate remote capability marker.
- `Touch::publish_trigger_readiness` and `TriggerReadinessGuard` in
  `src/touch.rs`: publish local admission only after fallible setup and remove
  it automatically whenever the listener future leaves scope.
- `Touch::select_text_tool_with_orientation` in `src/touch.rs`: verifies the
  stock palette opens, selects Text, and inspects and verifies palette closure
  before returning; uncertain cleanup fails closed.
- `WriteBackInputMonitor::start` and `interaction_detected` in `src/touch.rs`:
  query current pen and multitouch-slot contact state, then observe new input
  nonexclusively throughout guarded typing.
- `finish_selection_handshake` in `src/touch.rs`: consumes and verifies the
  exact busy generation after in-process admission has reopened, so a button
  tap cannot queue across the busy-to-idle transition.
- `trigger_task` in `src/coordinator.rs`: waits for a trigger, uses `try_admit`
  to atomically admit at most one request, and emits a canonical v3 selection,
  strict v2-migration selection, explicit legacy transition selection, or
  source-aware physical event. Its channel has capacity one and contacts begun
  while busy are discarded rather than queued.
- `should_collect_selection_taps` in `src/coordinator.rs`: permits four-corner collection only for real physical touch triggers; native LLM/Draw trigger files reuse the active stock selection.
- `processing_task` in `src/coordinator.rs`: executes the nonce-bound
  prepare-ack/capture/close-ack transaction; for v3, obtains the focal crop and
  faithful current-page view from one framebuffer, resolves the bounded display
  name, assembles `SelectionPageContext`, and rejects debug screenshot
  persistence. It retains the prepared full-page view, exact-rebinds the first
  post-close view, waits for remote readiness, suppresses repeated pen
  submission, calls the model, and clears both images, metadata, and tool state
  on completion. Failed rebind continues canonical delivery with insertion
  suppressed. V2 migration preserves the historical one-image bridge request
  but forces WhatsApp-only; only the pinned legacy route uses marquee detection
  and remote-accepted close.
- `load_document_display_name` in `src/document_context.rs`: performs the
  stable, bounded, owner-checked, no-follow metadata read for the exact v3
  document UUID and returns only a non-empty NFC `visibleName`.
- `Screenshot::base64_selection_and_page` in `src/screenshot.rs`: encodes the
  selection and current page-view rectangles from the same immutable frame;
  selection preprocessing happens later and the page image remains visually
  faithful.
- `bind_verified_post_close_view` in `src/coordinator.rs`: compares the first
  post-close normalized bytes with the prepared original and never blesses a
  newly reached page as a replacement baseline.
- `prepare_selection_png_b64` in `src/util.rs`: decodes and enlarges a selected
  PNG in memory; it applies the established clean grayscale/background path
  only to `ink`, preserves RGB/tonal detail for `image` and `mixed`, returns an
  error for malformed input, and never writes the image to disk.
- `Keyboard::prepare_captured_selection`,
  `Keyboard::dismiss_captured_selection`, and
  `Keyboard::restore_prepared_selection` in `src/keyboard.rs`: emit the private
  prepare, close, and failure-restore modifier chords consumed only by the
  pending firmware-pinned QML button. QML hides only stock chrome and calls
  `selectionRoot.close()` without a clipboard, delete, movement, or touch
  action. Prepare treats every reported emission error as potentially
  side-effecting and attempts the idempotent restore.
- `Keyboard::key_cmd_body_guarded` and
  `Keyboard::string_to_keypresses_guarded` in `src/keyboard.rs`: check the
  physical-input monitor immediately before each complete balanced batch and
  never strand Ctrl or Shift across a guard boundary.
- `Touch::wait_for_trigger` in `src/touch.rs`: returns after a physical gesture or trigger file and records which source fired.
- `Touch::wait_for_pen_lasso_trigger` in `src/touch.rs`: reads the Paper Pro pen stream non-exclusively, rejects tap-sized contacts and gestures begun while busy, and applies either immediate-release or held-endpoint policy before emitting `PenLasso`.
- `PenGestureTracker` in `src/touch.rs`: reduces typed pen events into a bounded path extent and quick/held release using the configured dwell and jitter radius. It classifies only on lift; xochitl's detected marquee remains the final lasso check.
- `ProcessingOutcome` in `src/coordinator.rs`: distinguishes a completed request from a no-marquee pen candidate or duplicate still-active selection, allowing the worker to remain armed without making another model call.
- `take_button_trigger` in `src/touch.rs`: atomically consumes an LLM/Draw trigger file before the next hardware-event wait, preventing busy touch streams from starving one-shot activation.
- `Screenshot::take_screenshot` in `src/screenshot.rs`: resolves the live stock-UI framebuffer independently of `card0` allocation order, reads it, and normalizes it.
- `Screenshot::take_screenshot_with_orientation` in `src/screenshot.rs`:
  normalizes an explicit descriptor frame using the trusted QML `normal` or `rot180`
  transform instead of inferring orientation from screenshot corner content.
- `Screenshot::normalized_view`,
  `NormalizedView::changed_pixels_are_confined`, and
  `NormalizedView::has_vertical_change_run` in `src/screenshot.rs`: retain and
  compare exact decoded normalized RGBA bytes, constrain allowed deltas to
  pinned disjoint masks, and verify the target's caret-like vertical signal.
- `Screenshot::parse_framebuffer_candidates` in `src/screenshot.rs`: collapses adjacent `card0` mappings into allocation groups, pairs each group end with its contiguous readable span, and includes sufficiently large detached anonymous mappings.
- `Screenshot::calculate_frame_pointer_from` in `src/screenshot.rs`: follows the Paper Pro frame-length chain with hop and arithmetic bounds and rejects invalid or nonadvancing headers.
- `Screenshot::probe_framebuffer_range` in `src/screenshot.rs`: requires the entire expected frame range to be readable before a candidate is accepted.
- `setup_uinput` in `src/util.rs`: reuses `/dev/uinput` when present and therefore skips bundled module loading on firmware 3.28.
