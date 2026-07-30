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
is enabled at boot. The worker opens the forwarding-only SSH tunnel on local
port `18791`, creates root-only mode-0700 state under
`/run/smart-remarkable`, and starts the Rust listener. Its trap removes the
readiness and trigger files and terminates the tunnel on every exit path.
The listener and tunnel run as supervised sibling children. BusyBox
`wait -n -p` identifies the first one to finish: a tunnel exit immediately
removes `ready` and stops the listener, while a normal listener exit stops the
tunnel and preserves the listener's status for transient-unit diagnostics.
Before opening the tunnel, the worker also removes stale files from its own
volatile state directory. This closes the abnormal-exit race in which an old
`ready` marker could make AppLoad deliver the first button trigger before the
new listener was actually ready. Both production wrappers set up runtime
directories with the tablet's BusyBox `mkdir`/`chown`/`chmod` commands and
do not assume GNU `install`.
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

The two native buttons are independent, explicit sources. Once their
device canary has passed, the user completes an ordinary lasso, lifts, and
taps either the stock sparkling-notebook icon (answer here) or stock sparkles
icon (send to agent) in the stock selection menu immediately after
**Copy**—there is no hold and no four-finger gesture. Answer here means
`write_back`: OpenClaw delivers through WhatsApp and the tablet inserts the
same final answer as stock text. Send to agent means `whatsapp_only`:
OpenClaw delivers through WhatsApp and the tablet performs no text, pen, or
touch output. Each button sets its own stock `selected` state before asking
AppLoad to launch, while shared pending state rejects another button tap.
One `clearPendingMode` path runs on menu visibility changes, timeout, failed
AppLoad launch, and accepted-request selection dismissal, so a failed attempt
cannot silently latch the other icon.

The buttons ask AppLoad to invoke
`external::smart-remarkable --selection-button=write_back` or
`external::smart-remarkable --selection-button=whatsapp_only`. If the
transient service is inactive, AppLoad starts the configured trigger policy
and waits up to 25 seconds for `/run/smart-remarkable/ready`; if it is active,
AppLoad uses its existing listener only when the literal
`http://127.0.0.1:18791/health` forward also succeeds. An active unit with
stale readiness is stopped and started through the ordinary guarded path
once; a second unhealthy result fails closed. It then creates exactly one corresponding
root-only volatile trigger. The listener consumes trigger files before
blocking on another hardware event and uses the still-active stock marquee
rather than collecting manual rectangle corners.

The marquee is also the crop detector, so QML deliberately does not close it
at tap time. The selected crop is sent to the bridge while the marquee remains
visible. The bridge flushes successful HTTP headers only after native Gateway
`chat.send` has accepted the idempotent request. That acceptance emits a
request-scoped status back through the engine; only then does the worker send
the private `Ctrl+Alt+Shift+9` chord through its existing virtual keyboard.
The shortcut is enabled only while one of these buttons is selected and the
marquee is visible; it schedules `selectionRoot.close()`, the exact stock
`SceneSelectionHandler` cleanup path. This clears selection state and hides
the handler but does not clone, delete, move, or alter the underlying strokes.
A capture, bridge-authentication, or pre-acceptance error returns before the
chord, leaving the selection and its recoverable stock actions visible. No
touch coordinates or touch lock participate in this feedback handshake.

The coordinator uses an atomic admission flag and a channel of capacity one,
so only one request owns the pipeline. A pen contact that begins while busy
stays ineligible even if processing ends before pen-up, and a button pressed
while busy is consumed and dropped rather than becoming a surprise queued
request. Pen modes fingerprint the selected crop and suppress the still-active
selection from being submitted again; an explicit press of either stock
answer-here or agent icon is allowed to resubmit intentionally. A no-marquee candidate makes no
model call and rearms. For an admitted selection, screenshot processing groups
every contiguous Paper Pro `/dev/dri/card0` mapping and includes large detached
anonymous allocations, probes bounded frame-header chains, reads the accepted
frame, and detects the active marquee. The raw marquee crop is not sent
directly: the selection image is converted to luma, its gray selection fill is
whitened without erasing dark ink, and a small crop is Lanczos-upscaled with
its aspect ratio preserved. This prepared in-memory PNG is the image
fingerprinted and submitted to OpenClaw; neither the original nor prepared
crop is written to a tablet file. Full-screen input remains unchanged.

The launcher forwards only to a loopback-bound reMarkable bridge on the
OpenClaw server. The tablet authenticates with a narrow bridge token; the full
Gateway operator credential and the WhatsApp target never leave the server.
The bridge refuses WhatsApp destination overrides and derives the target only
from the direct `agent:main:main` origin in OpenClaw's canonical session store.
The tablet sends the existing OpenAI-compatible image/body shape plus a strict
response-mode header and unique request id. The bridge converts that request
to native Gateway `chat.send` with the cropped PNG as an attachment,
`sessionKey=agent:main:main`, explicit server-owned WhatsApp routing,
`deliver=false`, disabled command interpretation, and the request id as its
idempotency key. Before that call, the bridge invokes
`smart_remarkable.bind_origin` with the protocol version, same request id,
response mode, and captured transcript. The plugin stores one immutable
pending admission as a realm-neutral JSON string in OpenClaw's host run
context and activates it only when the prompt hook sees the exact request run,
canonical route, and preflight-captured transcript. This host-owned scalar is
visible across OpenClaw's separate startup, active-hook, and pinned-tool
registries.

OpenClaw closes ordinary plugin API methods after registration, so late bind
and clear Gateway handlers do not call the public run-context facade directly.
Plugin version 0.2.2 registers a private agent-event control subscription
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
size-bounded JSONL reader examines only the captured transcript file and
requires one exact `<request-id>:user` anchor followed by a protocol-valid
assistant response before any later user turn. This recovers the observed
successful-but-remapped run without broad transcript scanning or unsafe
repinning.

This `chat.send` run is the only owner of canonical transcript entries. The
bridge appends a fixed, versioned response protocol that requires
the canonical assistant final to contain exactly two bounded strings:
`{"received_text":"...","response_text":"..."}`. `received_text` is a literal
transcription in the user's language and uses `[unclear]` rather than guessing;
`response_text` is the ordinary answer. The bridge parses the same envelope
from either an exact live final event or strictly attributable bounded-history
recovery. Once Gateway acceptance has closed the stock marquee, a premature
request-callback error or a missed final event cannot discard an already
queued canonical turn: the bridge polls bounded history for the target
`<request-id>:user` entry and accepts only its following assistant text before
another user entry. The request and client timeouts remain finite but allow
ordinary long-running OpenClaw tool work: ten minutes on the bridge and a
small final-delivery margin on the tablet HTTP client.

It separately calls the plugin-owned
`smart_remarkable.deliver` Gateway method for one idempotent,
delivery-checked receipt acknowledgement saying that OpenClaw is reading and
working, then for one atomic final formatted as `I read:`, a quoted literal
transcription, a blank line, and `response_text`. `[unclear]` becomes an
explicit inability-to-read statement rather than a fabricated quote. The
quote and answer share the existing `<request-id>:final` native receipt and
idempotency identity, so this does not add a third send or crash window. That
method derives the direct WhatsApp
route server-side, uses OpenClaw's public durable channel outbound API without
a `mirror` or session context, and returns success only with a native WhatsApp
provider receipt. This avoids duplicate delivery-mirror transcript messages,
does not rely on unverified automatic delivery, and does not change the
canonical session's persistent verbose setting.

For a verified reMarkable run, the plugin's prompt hook adds one turn-scoped
instruction: when the handwritten request asks to create, export, send, or
place a document, produce a PDF or EPUB inside the OpenClaw workspace and use
`remarkable_deliver_document`. The tool is registered only for the canonical
main agent and its `before_tool_call` gate independently requires the same
run-scoped origin context. It resolves and opens a regular non-symlink
workspace file, enforces bounded size plus matching PDF/EPUB extension and
magic, snapshots it to private plugin state, and invokes the already-installed
`rm-sync upload` executable through `execFile` with a fixed minimal
environment and no shell. A durable artifact journal binds request id,
artifact key, content hash, name, and destination before upload; an ambiguous
reservation never retries automatically. Only validated cloud document
id/hash JSON becomes a success receipt. WhatsApp remains the place where
OpenClaw quotes what it received and reports the upload; reMarkable Cloud is
only the requested artifact destination.

For `write_back`, the bridge returns only the delivery-validated
`response_text`; the local `draw_text` callback selects reMarkable's stock text
tool and types that answer below the selection, never the WhatsApp-only
transcription prefix. For `whatsapp_only`, the client still validates
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

For firmware 3.28.0.164, the selected native-button candidate is a two-button
QMLDiff patch rather than the upstream raw `llmbutton.so`.
`xovi-qmd/llm-button-3.28.0.164.source.qmd` inserts one stock
QML block containing the firmware's stock sparkling-notebook and sparkles
resources into the exact
`SceneSelectionHandler.qml` tree immediately after `selectionDuplicate`
(Copy). On tap the chosen button marks itself selected, dynamically resolves AppLoad, and
exposes the capture-confirmation shortcut described above;
keeping AppLoad out of the host file's static imports reduces the chance that
an unavailable module prevents the stock selection component from loading.
`xovi-qmd/llm-button-inert-3.28.0.164.source.qmd` inserts the same two visual
buttons disabled and with no actions. `xovi-qmd/compatibility-3.28.0.164.env`
records exact firmware, xochitl, hashtable, Xovi, qt-resource-rebuilder,
message-broker, AppLoad, artifact, and target-resource hashes.

The safe activation design is staged: fresh read-only live fingerprint,
device-side compatibility check, inert visual canary, bounded xochitl health
monitoring with a preserved `/home` rollback, then functional promotion only
after the inert phase remains healthy. The live fingerprint also requires
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
The functional QMD is
`2b9188af0c3fd726743e36ee1a3c86244cf6327ad22eeef1aa7a291a7add059d`;
the disabled canary is
`81b6050a739cd79e60b71bc78e504fae6d30ac996e6d0dde9970859bccdaadd5`.
Both pass exact-hashtable compatibility and apply to the extracted resource
tree. Together with the seven supported ReMagic QMDs, they compose in device
filename order into 22 patched resources with no compatibility or locator
error.

The exact 3.28.0.164 bytes are now live. A firmware update had removed the
volatile Xovi service drop-ins while leaving `/home/root/xovi` intact, so the
installed `remagic-live-test-safe.sh` first masked the dangerous stock
failure escalation in `/run`, armed a timed stock rollback, sampled Xovi for
30 seconds, and required AppLoad's success marker. It passed without a
crash/automatic restart; `NRestarts` stayed zero while the deliberate Xovi
activation created a new `xochitl` process. Disabled transaction
`20260730T184327Z-34344` then
committed QMD
`81b6050a739cd79e60b71bc78e504fae6d30ac996e6d0dde9970859bccdaadd5`;
functional transaction `20260730T184443Z-34618` promoted only that canary to
QMD
`2b9188af0c3fd726743e36ee1a3c86244cf6327ad22eeef1aa7a291a7add059d`.
Both transaction/watchdog pairs cleared. Their final records are
`success:functional:9449` and `validated:functional:9449`.

All seven co-resident package QMDs plus Smart Remarkable loaded, the Xovi,
QRR, broker, and AppLoad mappings matched the allowlist, and the AppLoad
success marker was present. Final `xochitl` PID is `9449`, `NRestarts=0`,
root is read-only, and the Riddle/Smart workers are inactive. Gestik's final
live and protected settings both match the standalone Mac preimage at
`826211118322c6a84d899a9cf2f11e3e24d5223ac11ee96efaf47e45a47f5938`.
This proves installation and runtime stability; physical handwritten
answer-here and WhatsApp-only button round trips remain a separate human
acceptance gate.

The current two-button client passes 48 native library tests with one unrelated
upstream font-render test filtered. The bridge and no-mirror delivery plugin
suite contains 130 Node tests, and the settings/runtime/protocol shell suites
pass. The
native tests include deterministic luma/background normalization, bounded
Lanczos enlargement, malformed-image rejection, and the real marquee fixture.
The bridge tests include strict transcription/answer envelopes, exact atomic
WhatsApp rendering, answer-only writeback, missing-live-final history
recovery, user-anchor attribution barriers, durable pre-`chat.send`
reservation, cross-process races, per-caller replay labeling, a hard
no-eviction capacity, ownership-marker races, an eagerly writable private
systemd state directory, and explicit provider `sent` receipts. The current
aarch64 worker SHA-256 is
`0bce9522c47aa2becc2f07171ed59ade012061ff33bd5cdbc11ec1c94eefde50`;
it requires no GLIBC symbol newer than 2.28. The prior 3.28.0.163
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

- `src/main.rs`: parses CLI/configuration, creates the provider and device objects, registers drawing tools, and coordinates the application lifecycle.
- `src/coordinator.rs`: runs the trigger, screenshot, model, progress, and tool-execution pipeline. It distinguishes manual touch selection from native button-file and pen-lasso selection, owns single-request admission and duplicate-selection policy, confirms a button crop before requesting stock selection dismissal, clears per-request scratch state, and keeps a worker armed after a no-marquee pen candidate.
- `src/touch.rs`: reads real touch events, detects corner/four-finger gestures, classifies eligible release or held-endpoint Paper Pro pen contacts without grabbing the stylus device, consumes root-only `/run` button trigger files, and emits simulated touch input when a tool needs it.
- `src/screenshot.rs`: groups all of `xochitl`'s Paper Pro graphics mappings, includes detached anonymous frame allocations, validates bounded frame-header candidates and full-frame readability without modifying process memory, normalizes the accepted frame to 768x1024, and detects native selection marquees.
- `src/util.rs`: includes strict in-memory selection preprocessing: PNG decode, grayscale/background normalization, aspect-preserving Lanczos enlargement, and PNG re-encoding. Decode failures abort before submission instead of falling back to raw bytes.
- `src/pen.rs` and `src/keyboard.rs`: create temporary uinput devices and translate model output into pen strokes or keyboard events. The keyboard also emits the QML-private capture-confirmation chord; it never uses a touch coordinate to dismiss the selection.
- `src/llm_engine/`: implements OpenClaw, OpenAI, Anthropic, and Google transports behind the common `LLMEngine` interface. Provider debug logs report only model/item counts and response-block sizes, never selected-page image payloads or model text.
- Google transport failures are mapped to URL-free messages before they reach
  the coordinator because that provider places its API key in the request
  query string.
- `src/llm_engine/openai.rs`: provides both the direct OpenAI tool-call transport and a narrow OpenClaw-bridge mode. Bridge mode authenticates only with `OPENCLAW_BRIDGE_TOKEN`, sends a unique request ID and explicit `write_back` or `whatsapp_only` header, never accepts client-controlled session/channel routing, treats flushed HTTP success headers as remote acceptance, validates request/mode/delivery metadata in the final JSON, and dispatches stock text only for `write_back`.
- `src/config.rs` and `prompts/`: merge runtime configuration and define provider/tool instructions. `selection_openclaw.json` asks OpenClaw for concise plain text that is safe to type into a stock text box; `selection_openclaw_whatsapp.json` asks for an ordinary canonical OpenClaw response when no notebook insertion is requested; `selection_print.json` remains the direct-provider print prompt.
- `bridge/`: implements the loopback-only, narrow-token HTTP adapter. It
  validates the one-prompt/one-PNG request, persistently reserves the request
  ID, captures the current transcript as an exact recovery and authority
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
  acknowledgement and final. The request journal stores hashes, mode, state,
  and a bounded cached response but never the selected PNG. Its atomically
  claimed fixed-capacity slots are never automatically evicted; a leaked slot
  safely reduces capacity. The production bridge is a system service that
  drops to `User=mdf`, eagerly prepares its single private writable
  `StateDirectory` before opening `/health`, and makes the rest of the server
  home read-only. A system service is required because the server's systemd
  249 user manager does not enforce `ProtectHome=` or `ProtectSystem=`.
- `bridge/src/response-envelope.mjs`: owns the versioned canonical reply instruction, strict two-field JSON parser, normalization and byte limits, `[unclear]` handling, and atomic WhatsApp quote-plus-answer rendering.
- `bridge/src/source-provenance.mjs`: defines the versioned trusted origin,
  exact bind/clear RPC names, durable `systemInputProvenance`, and strict
  bridge-side receipt validation.
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
  `smart_remarkable.deliver`, `smart_remarkable.bind_origin`, and
  `smart_remarkable.clear_origin` Gateway methods, prompt/tool-call hooks, and
  `remarkable_deliver_document` agent tool. Delivery accepts only a bounded
  request ID, kind, and text; derives the direct `agent:main:main` WhatsApp
  route inside OpenClaw; coalesces exact retries; sends through the public
  durable channel outbound API without transcript-mirror metadata; and exposes
  only normalized provider receipts or fixed errors. Delivery remains
  `operator.write`; origin bind and clear require `operator.admin`. Origin binding stores a
  server-generated capability and separate cleanup handle as a scalar host
  run-context record before model admission. The version-0.2.2 plugin reaches
  that host state after registration through its synchronous agent-event
  adapter. The event contains only a random operation ID; the complete bounded
  command remains private to its originating plugin instance, and exact host
  read-back is required before success. Pending records expire after
  twelve minutes; the exact prompt-hook run and captured transcript activate
  authority for at most fifteen minutes, and every bridge outcome explicitly
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
- `tests/mode-settings-test.sh` and `tests/fixtures/`: exercise all three mode mappings and the fail-closed invalid-mode path without a tablet or credential.
- `scripts/run-armed-once.sh`: provides the compatibility-named AppLoad worker.
  It refuses to load any fallback kernel module, validates and opens the
  restricted key-only local `18791` to remote loopback `18792` bridge tunnel,
  runs the configured trigger policy, owns root-only volatile
  trigger/readiness state under `/run`, and cleans up on exit. The SSH tunnel
  and selection worker are sibling processes: BusyBox `wait -n -p` identifies
  which ends first, a dead tunnel removes readiness and terminates the worker,
  and a finished worker terminates the tunnel while preserving its status.
- `remagic/appload-launch.sh` and `remagic/external.manifest.json`: define the
  single non-QTFB AppLoad tile and toggle a time-limited transient session
  without changing boot state. The launcher refuses to source its mode helper
  unless both resolve inside the exact root-owned AppLoad installation. Its
  special `--selection-button` action signals an active session or starts one
  and waits for listener readiness, avoiding the old start/trigger race. A
  ready marker is accepted only while the transient unit is active and
  `http://127.0.0.1:18791/health` succeeds; otherwise the stale unit is stopped
  once and restarted through the normal guarded path.
- `xovi-qmd/`: contains a disabled visual-canary source and compiled artifact,
  the reviewable firmware-specific functional two-button source and compiled
  artifact, and the immutable compatibility allowlist. The functional menu
  places the firmware's stock notebook-with-sparkles answer-here action and
  stock sparkles agent action immediately after Copy. Pending state is
  centralized and cleared on visibility loss, timeout, launch failure, and
  before shortcut-driven close. Offline QMLDiff compatibility/application
  against the extracted exact 3.28.0.164 resource tree must succeed before
  either device canary. The functional patch has no credential or direct
  OpenClaw access; the AppLoad launcher remains the only bridge to the session
  worker.
- `ops/install-smart-openclaw.sh` and `ops/device-install-smart-openclaw.sh`:
  assemble the local AppLoad bundle, preflight `/home` capacity, stream only
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
  bounded health sampling, and exact-stock rollback.
- `README.md`: leads with the supported two-button stock-text/WhatsApp OpenClaw/AppLoad workflow, reports local versus installed state explicitly, and clearly separates it from the upstream experimental pen-stroke and raw injected-button paths.
- `ops/openclaw-gateway-watchdog.sh`: keeps the private gateway available without restarting it during its plugin-heavy startup. It honors a 90-second startup grace and, after a genuine unhealthy state, waits for readiness after restart instead of assuming the port opens in ten seconds.

## Main functions

- `main` in `src/main.rs`: loads environment/configuration, handles diagnostics, and enters the Smart Remarkable orchestration loop.
- `create_engine` in `src/main.rs`: selects the provider transport; `openclaw` uses the OpenAI-compatible wire format but final-text response handling and OpenClaw-specific environment variables.
- `OpenAI::new_openclaw` in `src/llm_engine/openai.rs`: creates the loopback bridge transport using `OPENCLAW_BRIDGE_BASE_URL`/`OPENCLAW_BRIDGE_TOKEN`; the tablet does not receive Gateway, session, channel, account, or recipient authority.
- `parseResponseEnvelope` and `renderResponseEnvelope` in `bridge/src/response-envelope.mjs`: turn the one canonical structured final into a validated literal transcription, answer-only tablet result, and one delivery-bounded WhatsApp message.
- `SelectionService.submit` in `bridge/src/selection-service.mjs`: durably
  reserves the idempotency key, captures the current transcript for recovery
  and authority, binds trusted reMarkable origin/session state, sends the
  canonical WhatsApp-routed turn with the fixed routing contract but without a
  caller-supplied transcript ID, waits for ordered acknowledgement/final
  receipts, accepts current history only for the captured session, verifies a
  live candidate against its request anchor, reconciles exact active/reset
  transcript output, and commits the mode-specific safe response.
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
- `createOriginBindingHandlers` and `createRemarkableOriginHooks` in
  `bridge/openclaw-plugin/remarkable-upload.mjs`: store the server-generated
  per-run authority plus captured transcript identity, add reMarkable-specific
  document guidance only when the hook reports that exact transcript, and
  authorize the upload tool only at the exact
  run/transcript/agent/session-key boundary.
- `createRemarkableUploadTool` in
  `bridge/openclaw-plugin/remarkable-upload.mjs`: validates and privately
  snapshots a workspace PDF or EPUB, invokes the pinned reMarkable Cloud CLI
  without a shell or unrelated credentials, validates its receipt, and uses a
  durable fail-closed artifact journal to avoid duplicate uploads.
- `OpenAI::request_builder` in `src/llm_engine/openai.rs`: attaches only the strict request ID and response-mode headers in bridge mode and leaves direct provider requests unchanged.
- `trigger_task` in `src/coordinator.rs`: waits for a trigger, uses `try_admit` to atomically admit at most one request, and emits either a manual `UserSelection` or a source-aware `UserTouch` event. Its channel has capacity one and contacts begun while busy are discarded rather than queued.
- `should_collect_selection_taps` in `src/coordinator.rs`: permits four-corner collection only for real physical touch triggers; native LLM/Draw trigger files reuse the active stock selection.
- `processing_task` in `src/coordinator.rs`: captures/crops the screenshot, requests stock-close feedback only after a successful explicit-button crop, suppresses repeated pen submission of the still-active crop, selects a prompt, calls the model, executes the returned drawing tool, and clears engine/image/tool scratch state on completion.
- `prepare_selection_png_b64` in `src/util.rs`: converts a selected PNG to clean grayscale and enlarges its longest edge to 768 pixels when smaller; it returns an error for malformed input and never writes the image to disk.
- `Keyboard::dismiss_captured_selection` in `src/keyboard.rs`: emits the private modifier chord consumed only by the pending firmware-pinned QML button; the QML handler calls stock `selectionRoot.close()` without a clipboard, delete, movement, or touch action.
- `Touch::wait_for_trigger` in `src/touch.rs`: returns after a physical gesture or trigger file and records which source fired.
- `Touch::wait_for_pen_lasso_trigger` in `src/touch.rs`: reads the Paper Pro pen stream non-exclusively, rejects tap-sized contacts and gestures begun while busy, and applies either immediate-release or held-endpoint policy before emitting `PenLasso`.
- `PenGestureTracker` in `src/touch.rs`: reduces typed pen events into a bounded path extent and quick/held release using the configured dwell and jitter radius. It classifies only on lift; xochitl's detected marquee remains the final lasso check.
- `ProcessingOutcome` in `src/coordinator.rs`: distinguishes a completed request from a no-marquee pen candidate or duplicate still-active selection, allowing the worker to remain armed without making another model call.
- `take_button_trigger` in `src/touch.rs`: atomically consumes an LLM/Draw trigger file before the next hardware-event wait, preventing busy touch streams from starving one-shot activation.
- `Screenshot::take_screenshot` in `src/screenshot.rs`: resolves the live stock-UI framebuffer independently of `card0` allocation order, reads it, and normalizes it.
- `Screenshot::parse_framebuffer_candidates` in `src/screenshot.rs`: collapses adjacent `card0` mappings into allocation groups, pairs each group end with its contiguous readable span, and includes sufficiently large detached anonymous mappings.
- `Screenshot::calculate_frame_pointer_from` in `src/screenshot.rs`: follows the Paper Pro frame-length chain with hop and arithmetic bounds and rejects invalid or nonadvancing headers.
- `Screenshot::probe_framebuffer_range` in `src/screenshot.rs`: requires the entire expected frame range to be readable before a candidate is accepted.
- `setup_uinput` in `src/util.rs`: reuses `/dev/uinput` when present and therefore skips bundled module loading on firmware 3.28.
