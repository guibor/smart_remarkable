# Bridge design

## Modules

- `src/main.mjs` is the process entry point. It loads validated configuration,
  imports the official Gateway client, connects, prepares the persistent
  request journal, then opens the HTTP listener and performs orderly shutdown.
- `src/service-runtime.mjs` wires the production `SelectionService` to the
  persistent request journal, eagerly prepares that journal, and requires the
  exact side-effect-free plugin capability receipt for the current
  authenticated Gateway generation before HTTP health or admission can be
  ready.
- `src/config.mjs` owns the trust boundary for credentials, routing, and
  loopback addresses, plus the dedicated request-journal path and hard capacity.
  It can derive canonical Gateway and WhatsApp values from OpenClaw's files
  while keeping the narrow tablet token separate.
- `src/gateway-connection.mjs` adapts `GatewayClient` into the small interface
  used by the application. Each authenticated hello creates a monotonically
  increasing connection generation; close/connect errors invalidate it, and
  generation-pinned RPCs check the generation both before and after the
  underlying request.
- `src/http-server.mjs` implements the loopback OpenAI-shaped endpoint. It
  validates authentication and input before calling the service, returns
  health only after current-generation capability readiness, and flushes
  successful headers only through the service's acceptance callback.
- `src/validation.mjs` validates the narrow Bearer token, strict mode,
  exact `smart-remarkable-` request-ID namespace, and
  `ink`/`image`/`mixed` selection-kind and `selection-page-v1` context headers.
  The exact body is one prompt followed by role-tagged selection and
  current-page PNGs plus strict document/page metadata. It also creates the
  duplicate-content fingerprint over the prompt, kind, both PNGs, every
  metadata field, and the server-owned protocol versions.
- `src/selection-service.mjs` owns idempotency, Gateway request construction,
  the server-built capture manifest and fixed-name attachments, trusted
  run-origin binding, acceptance, deterministic acknowledgement, strict final
  parsing, canonical history reconciliation, captured-transcript fallback, and
  binding-scoped response-PDF delivery, final WhatsApp status, and response
  assembly.
- `src/source-provenance.mjs` defines the versioned Smart reMarkable origin
  identity, exact capability/bind/clear/response-PDF Gateway method names, the
  pinned plugin/origin/context/PDF-policy versions, ordered attachment roles and selection kinds,
  durable
  `systemInputProvenance`, a transport block that records but cannot create the
  authenticated button-and-binding PDF authority, and
  the bridge-side capability and binding receipt validators.
- `src/transcript-recovery.mjs` reads only the preflight-captured OpenClaw
  transcript. It validates the session id as a filename component, prefers the
  active JSONL, and otherwise considers at most 128 exact
  `.jsonl.reset.<safe-ISO-timestamp>` archives. Every candidate is a
  no-follow regular file no larger than 64 MiB whose first record identifies
  the captured session. It returns only a unique exact request-anchored
  interval, reports no visible anchor when one eligible header-matching
  transcript yields none, and rejects ambiguous archives. That tolerant
  no-anchor result is not successor-session negative proof.
- The same module's `proveCapturedResetTranscriptUnanchored` is the stricter
  negative-proof path for a post-admission automatic canonical-session
  successor. It refuses an active transcript, requires exactly one finalized
  reset candidate, uses the same pre-read no-follow descriptor stat to enforce
  the regular-file/64 MiB limit and set the read bound, requires matching final
  identity and size, decodes UTF-8 fatally, parses every bounded JSONL line,
  enforces the line limit before accepting only narrow ASCII JSON-whitespace
  blank lines, validates exactly one matching session header, rechecks the
  candidate set and reopened-path identity, and succeeds only with zero exact
  request anchors.
- `src/response-envelope.mjs` defines the versioned
  `received_text`/`response_text` contract and builds kind-aware instructions
  without changing that exact two-field shape. Version v3 restricts
  `received_text` to the primary selection only. It strictly parses the one
  canonical assistant final, bounds and normalizes both fields, and renders
  one atomic WhatsApp message that quotes the literal selection account before
  the answer. It rejects whitespace-only fields and excess line complexity,
  and reserves 512 bytes below the native delivery limit for the fixed
  reMarkable Cloud PDF status.
- `src/request-journal.mjs` atomically reserves request identities before
  Gateway work and persists only a bounded safe terminal response. It provides
  restart replay without persisting either PNG, the raw document-display-name
  request field, or prompt and fails closed on incomplete, corrupt, oversized,
  or symlinked state. A bounded cached safe response may naturally mention the
  title. Schema v4 additionally requires the exact uploaded/failed response-PDF
  metadata; schemas v1-v3 remain incomplete replay barriers.
- `src/openai-response.mjs` creates stable OpenAI-compatible success and
  post-acceptance error bodies with explicit WhatsApp delivery and bounded safe
  response-PDF outcome metadata.
- `src/errors.mjs` separates safe public HTTP errors from internal failures.
- `openclaw-plugin/index.mjs` registers the narrow
  `smart_remarkable.deliver`, side-effect-free
  `smart_remarkable.capabilities`, `smart_remarkable.bind_origin`, and
  `smart_remarkable.clear_origin` Gateway methods, the admin-scoped
  `smart_remarkable.deliver_response_pdf` method, the document tool, and its
  prompt/tool hooks. WhatsApp delivery derives the canonical direct route from
  `agent:main:main`, sends through OpenClaw's durable native adapter with
  transcript mirroring omitted, and journals platform receipts for
  restart-safe replay. Registration first requires the live host configuration
  to identify this exact plugin and grant both `allowPromptInjection` and
  `allowConversationAccess`; the workspace manifest cannot self-grant those
  permissions.
- `openclaw-plugin/remarkable-upload.mjs` owns run-scoped origin capabilities,
  proactive context-aware reMarkable prompt guidance and execution gating,
  response-PDF RPC authorization/idempotency, workspace artifact
  validation/snapshotting, receipt-journaled `rm_sync.cli upload`, and strict
  reMarkable Cloud receipt parsing. The automatic response path rechecks the
  exact active binding before and after rendering and reuses a completed safe
  receipt without rendering or uploading again.
- `openclaw-plugin/response-pdf.mjs` validates and snapshots only the strict
  transcription and response strings, invokes the sibling Python renderer
  behind fixed `/usr/bin/prlimit` resource limits, verifies its exact
  Pango/Cairo dependency receipt and structured result, validates the private
  bounded PDF, and returns an idempotent cleanup handle.
- `openclaw-plugin/response-pdf-renderer.py` creates the fixed one-column A4
  PDF directly with Pango/Cairo. It gives user content only to
  `Pango.Layout.set_text`, never to markup, Markdown, HTML, TeX, or a shell;
  uses full-paragraph Unicode bidi with fixed DejaVu/FreeSans faces; disables
  uncontrolled fallback; rejects unknown glyphs; and bounds pages and output.
- `openclaw-plugin/run-context-control.mjs` is the late-call adapter for
  OpenClaw's host-owned run context. It registers one plugin-owned agent-event
  subscription while the plugin API is open, retains complete commands only
  in the originating plugin instance, and emits only random operation IDs.
  The synchronous callback uses host `getRunContext`, `setRunContext`, and
  `clearRunContext`; exact receipts and read-back make every failure
  fail-closed.
- `openclaw-plugin/file-receipt-journal.mjs` provides the ordinary workspace
  plugin's persistent idempotency backend. It uses hash-named atomic directory
  reservations and write-fsync-rename receipt commits under OpenClaw's state
  directory, without the trusted-plugin-only keyed state API. Directory and
  record reads use no-follow handles, owner/type/identity checks, private
  permissions, single-link records, a 64 KiB bound, stable descriptor reads,
  and fatal UTF-8 validation before parsing cached success.
- `openclaw-plugin/openclaw.plugin.json` and
  `openclaw-plugin/package.json` are the pinned OpenClaw 2026.7.1 workspace
  plugin manifest and entrypoint metadata at candidate plugin version 0.5.0.
- `systemd/smart-remarkable-openclaw-bridge.service.example` is a system unit
  that drops to `User=mdf`. Using PID 1, rather than the systemd 249 user
  manager, makes `ProtectHome=read-only`, `ProtectSystem=strict`, and the
  single private writable `StateDirectory` effective. It intentionally does
  not declare ordering against OpenClaw's separate user-manager unit; bounded
  restart-on-failure handles a Gateway that is not ready yet.

## Main functions

### `loadConfig(env)`

Loads the tablet token, Gateway token, canonical main-session WhatsApp route,
loopback addresses, timeouts, request-journal configuration, and OpenClaw's
current session-routing contract. It rejects
broad listeners, non-loopback Gateway URLs, weak tablet tokens, unsafe
token-file permissions, a non-direct/non-WhatsApp main origin, a relative or
non-dedicated journal path, a journal capacity above 100,000, or any routing
contract other than the intended `per-sender|main|main`. WhatsApp destination
overrides are rejected; the route can come only from `agent:main:main` in the
canonical session store.
The default canonical-run deadline is ten minutes so queued tool and media
turns are not cut off at the former three-minute tablet/bridge boundary.

### `createGatewayConnection({ GatewayClient, config, logger })`

Starts the official OpenClaw Gateway client and waits for its authenticated
hello before returning. Every authenticated hello advances a connection
generation, and disconnects invalidate it. `requestForGeneration()` refuses a
stale/disconnected generation before RPC and rechecks it after RPC, closing the
race in which a result arrives after reconnect. The adapter also exposes
event/connection subscriptions without exposing the full token to HTTP code.

### `createCapabilityReadiness({ gateway, timeoutMs })`

Owns the side-effect-free `smart_remarkable.capabilities` proof for one
authenticated Gateway generation. `ensureReady()` coalesces concurrent probes,
requires plugin 0.5.0, origin-v5, the exact response-PDF method, policy, and
cloud destination, ordered `selection-page-v1` input contexts,
ordered `selection`/`current_page` roles, and the exact ordered selection kinds.
It caches success only while that generation remains current. A connection
notification clears the proof; `assertGeneration()` prevents an admitted job
from crossing onto a new connection, and `close()` removes the connection
subscription.

### `createHttpServer({ service, bridgeToken, logger })`

Creates the loopback HTTP handler for `/health` and
`POST /v1/chat/completions`. For a chat request, it authenticates and validates
all input before submission. `/health` awaits capability readiness for the
current authenticated Gateway generation and returns a credential-free 503
when disconnected, unprobed, or mismatched. Its acceptance callback writes and
flushes status 200 only after the service verifies the exact request/run ID;
the handler ends the body after the service resolves. Post-acceptance fallback
errors are fixed public strings and never contain internal exception text.

### `createBridgeSelectionService({ gateway, config, logger })`

Creates the production request journal from validated configuration, awaits its
`prepare()` operation, then calls `smart_remarkable.capabilities` and validates
the exact plugin ID, version 0.5.0, origin-v5 protocol, response-PDF contract, ordered input-context
versions, ordered attachment roles, and ordered selection kinds before
constructing `SelectionService`. The proof is cached only for the
same authenticated Gateway generation; disconnect/reconnect invalidates it,
and concurrent probes for one generation coalesce. Since `main.mjs` calls this
before `server.listen`, an unowned journal or old, missing, or partially
promoted plugin prevents both request handling and a misleading green
`/health` response.

### `createRequestJournal({ rootDirectory, maxEntries })`

Creates the persistent fail-closed idempotency store. A dedicated ownership
marker prevents accidental adoption or permission changes of a pre-existing
non-empty directory. Each request ID maps to a SHA-256-named directory created
atomically across processes, and each fixed capacity slot is claimed with
exclusive creation. The hard cap defaults to 20,000 and cannot exceed 100,000;
there is no automatic retention or eviction.

`reserve()` requires the exact `smart-remarkable-` request-ID namespace and
binds the request ID to its content fingerprint, mode, selection kind, and
exact `selection-page-v1` context version before any request-specific Gateway
call. An identical completed record returns
a cloned response with
`x_smart_remarkable.replayed: true`; a conflicting, incomplete, corrupt,
oversized, or symlinked root, entry, or record fails closed. `complete()` uses a mode-0600
temporary file, file fsync, atomic rename, and directory fsync. Records are
limited to 128 KiB and contain no PNG, prompt, document display name, image
base64, credentials, or provider payloads. The fingerprint is the only durable
representation of the full selection/page context. A failed cleanup can leak a
capacity slot, which safely reduces capacity without weakening the hard limit
or idempotency.
Journal preparation creates missing directory ancestors one at a time and
fsyncs each parent immediately, so both the systemd path and the deeper manual
default retain the reservation hierarchy across a power loss.
Record schema v4 requires the admitted `context_version` and exact safe
response-PDF outcome in every cached response. Legacy schema-v1, schema-v2,
and schema-v3 entries in the same owned journal are
intentionally reported as incomplete barriers rather than replayed or
resubmitted with weaker identity. They retain their capacity slot and map to
HTTP 409. The origin-v5/plugin-0.5 bridge
and plugin must be promoted with requests quiesced; the current-generation
capability probe is the final readiness gate after the Gateway reload.

### `SelectionService.submit({ requestId, mode, selectionKind, contextVersion, selection, onAccepted })`

Coalesces matching retries and rejects conflicting ID reuse. The first caller
proves the exact plugin capability contract for the current authenticated
Gateway generation, then durably reserves request ID, fingerprint, response
mode, selection kind, and context version before starting exactly one native
`chat.send` with command interpretation disabled. Every request-specific
Gateway RPC remains pinned to that admitted generation. Before the send it
captures the current canonical transcript id and
calls `smart_remarkable.bind_origin` with origin protocol v5, the request ID,
mode, selection kind, `selection-page-v1`, and captured session ID. It requires
the plugin's exact bound receipt, adds durable
external-user/reMarkable input provenance, supplies the startup-validated
`expectedSessionRoutingContract`, and keeps WhatsApp as the originating reply
route. A completed durable record returns its cached safe response without new
Gateway or delivery work; an incomplete reservation after restart is never
resubmitted.

The captured session id is never supplied as `chat.send.sessionId`. In
OpenClaw 2026.7.1 that field can rotate a newer current session to the
caller-supplied id rather than atomically asserting transcript identity. If a
pre-acceptance send fails after binding, the bridge calls the narrow clear
method. The bind method writes a realm-neutral JSON string into OpenClaw's
host-owned run context so separate startup, active-hook, and pinned-tool plugin
registries share the same authority. Ordinary plugin API methods close after
registration, so plugin version 0.5.0 performs each late bind-side get, set, or
clear through the registered synchronous agent-event adapter. Only a random
operation ID enters the plugin-owned stream; the command and scalar remain in
the originating instance's bounded private map. The host callback performs the
operation for the event run ID, and a missing or asynchronous receipt,
mismatch, unavailable host method, failed exact read-back, or exception is
`UNAVAILABLE`. The bridge pins OpenClaw 2026.7.1 because same-stack event
delivery is part of this adapter's reviewed contract; an upgrade requires a
fresh lifecycle audit. A bind is pending for at most twelve
minutes; the exact prompt-hook run/transcript activates it once for a fixed
fifteen-minute deadline. The bind-side registry holds at most 128 local
reservations and rejects new ones rather than evicting them. Before each bind,
it reconciles every tracked slot against the shared host scalar: a live active
record retains its slot beyond the pending deadline, while an expired,
missing, or malformed record is cleared from host state before capacity is
released. The bridge also clears host and local state after every successful
or failed outcome using the exact opaque binding handle, while expiry bounds
authority left by a crashed bridge.

Before `chat.send`, the service constructs a fixed JSON capture manifest. It
labels `remarkable-selection.png` as the primary user focus and
`remarkable-current-page.png` as supporting page context, includes the
validated display name and page metadata, and marks every document-supplied
value and both images untrusted. The attachment names, order, and roles are
server-controlled. Both PNGs remain in memory and are forwarded as fixed-name
Gateway attachments.

Once accepted, the service starts exactly one
`smart_remarkable.deliver` acknowledgement and notifies every waiting HTTP
response. The canonical prompt ends with response-envelope v3, which applies
`received_text` only to the selection attachment. A live Gateway final is
usable only when its run ID and session match and its text passes the strict
envelope parser. Empty or partial live events do not become user-visible
output.

In parallel, the service reconciles the durable canonical history. It requests
the recent tail, bounded to 1000 messages and `maxChars: 500000`, locates
exactly one user record whose direct or nested idempotency key is
`<requestId>:user`, and scans forward only until the next user record. It
accepts the first assistant record in that interval that passes the strict
envelope parser; assistant record IDs are deliberately irrelevant. Duplicate
anchors, crossing another user, target-interval truncation, malformed finals,
or missing attribution fail closed. Older history may exist when the exact
anchor is already present. Current history is immediately eligible while its
`sessionId` still equals the captured ID, and a live final is merely a
candidate until the exact eligible-history request anchor is verified. This
polling path remains active after a
post-acceptance request-callback failure, so a queued or tool-using run is not
lost merely because the ephemeral live final was missing.
If canonical history has remapped, the service first prefers
`<captured-session-id>.jsonl` beside the trusted sessions file.
If OpenClaw has reset that transcript, it considers only bounded exact-prefix
`.jsonl.reset.<safe-ISO-timestamp>` candidates. Each is opened with
`O_NOFOLLOW`, limited to 64 MiB and 8 MiB per line, and required to begin with
the exact captured session header. Exactly one archive may contain the request
anchor; multiple anchored or otherwise ambiguous matching archives fail
closed. If the safely verified captured transcript contains the request, it
retains precedence even while pending. Once canonical history names a
successor, an unscoped live event cannot complete that captured request; only
its durable transcript interval can. If it is verified and unanchored, and
only if that negative proof came from the one finalized reset archive under
the stricter stable reader, the newly canonical bounded Gateway history may
prove a post-admission automatic canonical-session successor with exactly one
matching request anchor, exact persisted
`external_user`/`remarkable`/`smart_remarkable` provenance, and the normal
strict assistant interval. A missing, active, changed, malformed, oversized,
invalid-UTF-8, mismatched, or ambiguous captured transcript leaves successor
history ineligible. A live final alone cannot cross this boundary. The bridge
never opens another session's transcript file.

After the strict envelope is recovered, the service calls the admin-scoped
`smart_remarkable.deliver_response_pdf` method with exactly the request ID,
opaque active binding handle, `received_text`, and `response_text`. The method
renders and uploads only while that same origin authority remains active. The
acknowledgement and PDF attempt run together; the final WhatsApp send waits for
the terminal PDF receipt so its fixed status is truthful. A failed or malformed
PDF receipt becomes additive fixed failure metadata and does not erase a valid
answer. The origin is cleared only after PDF and final delivery are terminal.

It reports either delivery as sent only when the plugin returns exact
`status: "sent"`, the expected run ID, WhatsApp channel, and a non-empty
provider message ID. The final delivery text is rendered server-side as
`I read:` plus the line-quoted kind-aware `received_text`, a blank line, the
answer, and the confirmed/fixed-failure PDF status. Exact `[unclear]` becomes an explicit inability-to-read message
rather than a guessed account. It then commits a stable OpenAI-shaped response
including the admitted selection kind, context version, and safe
`remarkable_document` outcome before returning it.
`write_back`
contains only `response_text`;
`whatsapp_only` contains only a fixed receipt and cannot expose either field to
the tablet. The original caller receives
`replayed: false`; concurrent, delayed, and post-restart duplicate callers
receive a cloned response with `replayed: true`, allowing the tablet to suppress
duplicate notebook insertion. Pre-acceptance errors remain HTTP errors;
failures after flushed acceptance use fixed public strings in the 200 JSON
body. If the terminal response cannot be durably committed, the service never
claims normal tablet completion.

### `createDeliveryHandler({ runtime, logger, store, sendBatch })`

Builds the server-side handler for `smart_remarkable.deliver`. It accepts only
the exact bounded `{ requestId, kind, text }` shape, where `kind` is `ack` or
`final`; caller-supplied channel, destination, account, session, or credential
fields are rejected. The handler reads the latest `agent:main:main` session
entry through the public plugin runtime and requires an unthreaded direct
WhatsApp origin with bounded `to` and `accountId`.

Identical in-process calls share one promise. Before platform I/O, the handler
atomically reserves `<requestId>:<kind>` in its plugin-owned file journal under
OpenClaw's resolved state directory. The reservation is an atomic directory
creation; records are committed with write-fsync-rename-fsync. An incomplete or
corrupt entry fails closed. This custom workspace plugin deliberately does not
call OpenClaw 2026.7.1's keyed state API, which is limited to bundled and
officially trusted plugins.

The handler calls `sendDurableMessageBatch` with the loaded WhatsApp adapter,
required durability, and `operator.write` scope. It intentionally supplies
neither `mirror` nor `session`, so no outbound delivery mirror is written to
the canonical transcript. Success requires a `sent` result whose WhatsApp
message IDs match the durable batch's primary platform receipt. That receipt
is then journaled for replay without resending.

A surviving reservation or any send whose platform outcome cannot be proven is
treated as ambiguous and is never resent automatically. This favors
at-most-once visible delivery: a crash before the native send may omit the
message, while a crash after native acceptance will not create a duplicate on
plugin retry. The durable helper owns a separate random-ID queue entry, so
OpenClaw queue recovery may still be pending and may complete the original
attempt while the plugin reservation blocks a second batch. In that state the
plugin returns `UNAVAILABLE`; it neither claims automatic delivery nor starts
another send. Exact crash-once delivery would require provider-level
idempotency or unknown-send reconciliation that the loaded WhatsApp adapter
does not expose through this OpenClaw 2026.7.1 surface.

The bridge response records acknowledgement and final delivery independently
and still attempts the final after an acknowledgement failure. The tablet
client nevertheless requires both statuses to be `sent`; otherwise it refuses
completion and notebook writeback. This preserves the explicit WhatsApp
progress contract without hiding either receipt failure.

### `requireRemarkableHookPolicy(api)`

Runs before plugin registration and requires the exact plugin ID plus explicit
live `allowPromptInjection: true` and `allowConversationAccess: true` host
policy. Failure throws before any Gateway method, hook, or tool is registered,
so a permissive manifest assumption or partially updated OpenClaw config cannot
leave a weakened plugin surface active.

### `createOriginAdmissionRegistry(options)`

Creates the bind handler's bounded local reservation index. It commits
immutable pending records synchronously, makes exact repeats idempotent
without extending their deadline or rotating secrets, rejects conflicting
reuse, and enforces a hard capacity bound. Its reconciliation pass compares
each tracked reservation with the authoritative scalar host run-context
record, retains live pending or active authority, and clears expired or
malformed host state before releasing the corresponding slot.

### `createRunContextControl({ api })`

Registers the plugin-owned control subscription during `register`, before the
ordinary plugin API closes. A late get, set, or clear places a bounded command
in a private map, emits an event containing only a fresh random operation ID,
and requires the matching subscription to complete synchronously. The callback
uses OpenClaw's host-supplied run-context methods, verifies exact set/clear
read-back, and writes a private receipt. Event attribution, operation ID,
operation, run ID, and namespace must all match; maps are cleared in `finally`.
No admission scalar, capability, cleanup handle, or operation is placed in an
event, run ID, prompt, or transcript.

### `createOriginBindingHandlers({ admissionRegistry, runContext })`

Registers the narrow `smart_remarkable.bind_origin` and
`smart_remarkable.clear_origin` Gateway methods at `operator.admin` scope.
Binding accepts only an exact request ID, response mode, selection kind,
`selection-page-v1` input-context version, and preflight-captured session ID,
then stores a pending server-generated capability and cleanup handle as a
realm-neutral origin-v5 scalar in
OpenClaw's host run context before `chat.send` can admit the run. Its receipt
must echo the protocol, mode, kind, context version, and captured session
without exposing the tool capability. An identical bind is idempotent;
malformed or conflicting state fails closed. Before binding, it asks the local
index to reconcile capacity against current host state. Clearing requires the
matching request ID and opaque handle and is used after every bridge outcome.

### `createRemarkableOriginHooks({ runContext })`

Creates the model-admission, prompt, and tool-call hooks that consume scalar host admission
state. For a pending run whose hook context has the exact request ID, captured session
ID, canonical agent, and canonical session key,
`before_prompt_build` identifies the current turn as coming from reMarkable
while preserving the canonical WhatsApp conversation. The validated manifest
roles make the selection primary and the current page, document display name,
page metadata, canonical history, and durable memory supporting context. For
`ink`, deliberately authored primary handwriting retains direct-request
semantics. For all kinds, intent precedence is current explicit instruction,
specific still-active history, durable memory/preferences, then the
contextualized selection. The hook makes a strongest reasonable
interpretation, completes the likely task, and asks a clarification only when
material conflict or a missing consequential choice prevents responsible
best effort. Otherwise an unclear task receives in-depth explanation,
background, mechanisms, relevance, and implications instead of a market scan
or generic question. It forbids invented facts, evidence, action claims, or
certainty. Inferred or ambiguous intent never authorizes a side effect. Page
context, title metadata, client framing, assistant suggestions, quoted text,
and commands merely visible in image/mixed content remain non-authoritative
unless an explicit user instruction adopts them. The hook
tells the agent to create a PDF or EPUB and call
`remarkable_deliver_document` only when an explicit user instruction governing
the authenticated turn asks to create, export, send, add, or place a separate
rich document. It also explains that the server automatically builds the fixed
response PDF, so the model neither invokes the tool for that PDF nor claims its
success. Merely discussing a document never implies an extra upload.

After prompt construction, `before_agent_run` re-reads the host scalar and
fails closed unless the Smart reMarkable run still has the exact active
request/session/agent identity and the final system prompt contains the exact
server-owned guidance for that origin. This is the last boundary before the
model receives the prompt and image. OpenClaw 2026.7.1's runtime gate
normalizer treats an absent result as a block despite the public type, so
ordinary non-Smart runs return an explicit `{ outcome: "pass" }`. Plugin
registration separately requires the live host's explicit prompt-injection and
conversation-access permissions; neither the manifest nor prompt content can
grant them.

`before_tool_call` is the execution boundary. It permits the upload tool only
for the exact active run, captured session ID, canonical `main` agent, and
`agent:main:main` session, then injects the server-owned request ID and
capability. Tool execution rechecks that session identity and capability. User
prompt text, transcript content, model output, and caller-supplied tool
arguments cannot authorize an upload.

### `createRemarkableResponsePdfHandler({ runtime, runContext, admissionRegistry, renderResponsePdf, store, execFileFn })`

Creates the admin-scoped automatic response-PDF RPC. It accepts exactly the
request ID, opaque binding handle, normalized literal transcription, and
answer; enforces the response-envelope byte/control/line-complexity bounds;
and requires a live active origin admission. The prompt hook copies the exact
activated admission into the plugin process before the model runs. OpenClaw's
callback-scoped run context may then disappear normally when that run ends;
the handler permits that absence only while the same opaque handle, captured
session, capability, fixed active deadline, and in-process admission remain
exact. Any still-present host record must match the authority fields, and the
bridge's explicit clear removes the admission after completion. One fingerprint binds those values,
the origin capability/session, and the fixed policy. Identical in-flight calls
share one promise, at most one distinct operation may run at a time,
conflicting or excess work fails before rendering, and an exact completed durable
receipt returns before rendering. After a new render it rechecks the unchanged
admission, uploads through the common no-shell receipt path, returns only the
strict cloud receipt, and always invokes the renderer cleanup handle.

### `renderResponsePdf(input, dependencies)`

Snapshots validated scalar inputs before its first await and creates a private
render transaction below OpenClaw state. It verifies the exact Pango/Cairo
helper dependency receipt, then runs fixed `/usr/bin/prlimit` and
`/usr/bin/python3 -I -B` arguments with a minimal private environment, fixed
metadata, bounded memory/CPU/file/process resources, output, and timeout. The
helper receives strict JSON and renders its strings only with Pango plain-text
layouts. It accepts only a
private single-link bounded `%PDF-`/`%%EOF` file whose identity remains stable,
then returns its deterministic request-derived name, hash, path, and idempotent
cleanup callback.

### `createRemarkableUploadTool({ api, context, runContext, store, execFileFn })`

Registers `remarkable_deliver_document` only in the canonical main session. It
uses the injected late-call run-context adapter, rather than the closed
ordinary plugin facade, for the final capability/session recheck. It
accepts a workspace-relative PDF or EPUB and optional safe display name. The
tool resolves the file through OpenClaw's root-contained file API, rejects
traversal, links, non-regular or multiply linked files, excessive size, invalid
format signatures, and unsafe names, then makes a private mode-0600 snapshot.
It rechecks source identity, size, and modification time before invoking the
pinned `remarkable-sync` Python module with `execFile`, no shell, a minimal
environment, bounded output, an abort signal, and a fixed timeout.

The upload result is accepted only when it is the exact JSON shape containing a
valid reMarkable document ID and cloud hash. A plugin-owned durable receipt
journal coalesces identical attempts and replays proven success without
uploading twice. An incomplete or ambiguous upload remains fail-closed under
that artifact key because the CLI and cloud API expose no idempotency token or
safe unknown-outcome reconciliation.

### `validateOpenAiBody(body, selectionKind, headerContextVersion)`

Accepts only one multimodal user message with exact content order: one
non-empty text item, a PNG tagged `selection`, then a PNG tagged
`current_page`. Each decoded PNG is limited to 6 MiB and their sum to 8 MiB.
The namespaced context object must contain exactly `selection-page-v1`, an
NFC/control-clean display name no larger than 1024 UTF-8 bytes, a bounded page
ID, consistent zero/one-based page numbers, scope `current_page_view`, and
completeness `full_page` or `viewport_only`. The body and header versions must
match. It returns both image payloads, normalized metadata, kind, and a SHA-256
fingerprint over every field plus response-envelope and origin versions, so a
completed result created under different content, page context, semantics, or
authority cannot be replayed.

### `buildResponseEnvelopeProtocolInstruction(selectionKind)`,
`parseResponseEnvelope(source)`, and `renderResponseEnvelope(envelope)`

The instruction builder keeps the exact two-field envelope but defines
`received_text` per authenticated kind: literal handwriting for `ink`,
verbatim visible text or a concise factual image description for `image`, and
verbatim handwritten/printed text plus essential non-text content for `mixed`.
Interpretation and answers belong only in `response_text`.
`received_text` is always restricted to `remarkable-selection.png`; page
context and document metadata never enter the quoted receipt.

`parseResponseEnvelope` accepts exactly one JSON object with exactly two unique
string keys: `received_text` and `response_text`. It rejects code fences,
unknown or duplicate decoded keys, empty fields, ill-formed Unicode, disallowed controls,
oversized transcriptions, and a final rendered message above the delivery
limit. CRLF becomes LF and Unicode is normalized to NFC.

`renderResponseEnvelope` applies the same validation to object input and
creates the single WhatsApp final. Every transcription line is quoted under
`I read:`; `[unclear]` is rendered as an explicit inability to confidently
read the selection.
