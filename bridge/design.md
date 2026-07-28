# Bridge design

## Modules

- `src/main.mjs` is the process entry point. It loads validated configuration,
  imports the official Gateway client, connects, prepares the persistent
  request journal, then opens the HTTP listener and performs orderly shutdown.
- `src/service-runtime.mjs` wires the production `SelectionService` to the
  persistent request journal and eagerly prepares that journal before an HTTP
  health endpoint can become available.
- `src/config.mjs` owns the trust boundary for credentials, routing, and
  loopback addresses, plus the dedicated request-journal path and hard capacity.
  It can derive canonical Gateway and WhatsApp values from OpenClaw's files
  while keeping the narrow tablet token separate.
- `src/gateway-connection.mjs` adapts `GatewayClient` into the small
  `request/subscribe/close` interface used by the application.
- `src/http-server.mjs` implements the loopback OpenAI-shaped endpoint. It
  validates authentication and input before calling the service, and flushes
  successful headers only through the service's acceptance callback.
- `src/validation.mjs` validates the narrow Bearer token, strict mode and
  request-ID headers, and the one-prompt/one-PNG body. It also creates the
  duplicate-content fingerprint, including the versions of the server-owned
  response and trusted-origin protocols so a protocol change cannot replay an
  older result.
- `src/selection-service.mjs` owns idempotency, Gateway request construction,
  trusted run-origin binding, acceptance, deterministic acknowledgement,
  strict final parsing, canonical history reconciliation, captured-transcript
  fallback, and response assembly.
- `src/source-provenance.mjs` defines the versioned Smart reMarkable origin
  identity, exact bind/clear Gateway method names, durable
  `systemInputProvenance`, and the bridge-side binding receipt validator.
- `src/transcript-recovery.mjs` reads only the preflight-captured OpenClaw
  transcript. It validates the session id as a filename component, prefers the
  active JSONL, and otherwise considers at most 128 exact
  `.jsonl.reset.<safe-ISO-timestamp>` archives. Every candidate is a
  no-follow regular file no larger than 64 MiB whose first record identifies
  the captured session. It returns only a unique exact request-anchored
  interval and rejects ambiguous archives.
- `src/response-envelope.mjs` defines the versioned
  `received_text`/`response_text` contract. It strictly parses the one
  canonical assistant final, bounds and normalizes both fields, and renders
  one atomic WhatsApp message that quotes the literal transcription before
  the answer.
- `src/request-journal.mjs` atomically reserves request identities before
  Gateway work and persists only a bounded safe terminal response. It provides
  restart replay without persisting the selected PNG or prompt and fails closed
  on incomplete, corrupt, oversized, or symlinked state.
- `src/openai-response.mjs` creates stable OpenAI-compatible success and
  post-acceptance error bodies with explicit WhatsApp delivery metadata.
- `src/errors.mjs` separates safe public HTTP errors from internal failures.
- `openclaw-plugin/index.mjs` registers the narrow
  `smart_remarkable.deliver`, `smart_remarkable.bind_origin`, and
  `smart_remarkable.clear_origin` Gateway methods, the document tool, and its
  prompt/tool hooks. WhatsApp delivery derives the canonical direct route from
  `agent:main:main`, sends through OpenClaw's durable native adapter with
  transcript mirroring omitted, and journals platform receipts for
  restart-safe replay.
- `openclaw-plugin/remarkable-upload.mjs` owns run-scoped origin capabilities,
  reMarkable-only prompt guidance and execution gating, workspace artifact
  validation/snapshotting, receipt-journaled `rm_sync.cli upload`, and strict
  reMarkable Cloud receipt parsing.
- `openclaw-plugin/file-receipt-journal.mjs` provides the ordinary workspace
  plugin's persistent idempotency backend. It uses hash-named atomic directory
  reservations and write-fsync-rename receipt commits under OpenClaw's state
  directory, without the trusted-plugin-only keyed state API. Directory and
  record reads use no-follow handles, owner/type/identity checks, private
  permissions, single-link records, a 64 KiB bound, stable descriptor reads,
  and fatal UTF-8 validation before parsing cached success.
- `openclaw-plugin/openclaw.plugin.json` and
  `openclaw-plugin/package.json` are the pinned OpenClaw 2026.7.1 workspace
  plugin manifest and entrypoint metadata.
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
hello before returning. It exposes RPC requests and a subscription fan-out
without exposing the underlying full token to HTTP code.

### `createHttpServer({ service, bridgeToken, logger })`

Creates the loopback HTTP handler for `/health` and
`POST /v1/chat/completions`. For a chat request, it authenticates and validates
all input before submission. Its acceptance callback writes and flushes status
200 only after the service verifies the exact request/run ID; the handler ends
the body after the service resolves. Post-acceptance fallback errors are fixed
public strings and never contain internal exception text.

### `createBridgeSelectionService({ gateway, config, logger })`

Creates the production request journal from validated configuration, awaits its
`prepare()` operation, and only then constructs `SelectionService`. Since
`main.mjs` calls this before `server.listen`, an unowned, unsafe, corrupt, or
unwritable journal prevents both request handling and a misleading green
`/health` response.

### `createRequestJournal({ rootDirectory, maxEntries })`

Creates the persistent fail-closed idempotency store. A dedicated ownership
marker prevents accidental adoption or permission changes of a pre-existing
non-empty directory. Each request ID maps to a SHA-256-named directory created
atomically across processes, and each fixed capacity slot is claimed with
exclusive creation. The hard cap defaults to 20,000 and cannot exceed 100,000;
there is no automatic retention or eviction.

`reserve()` binds the request ID to its content fingerprint and mode before any
Gateway call. An identical completed record returns a cloned response with
`x_smart_remarkable.replayed: true`; a conflicting, incomplete, corrupt,
oversized, or symlinked root, entry, or record fails closed. `complete()` uses a mode-0600
temporary file, file fsync, atomic rename, and directory fsync. Records are
limited to 128 KiB and contain no PNG, prompt, image base64, credentials, or
provider payloads. A failed cleanup can leak a capacity slot, which safely
reduces capacity without weakening the hard limit or idempotency.
Journal preparation creates missing directory ancestors one at a time and
fsyncs each parent immediately, so both the systemd path and the deeper manual
default retain the reservation hierarchy across a power loss.

### `SelectionService.submit({ requestId, mode, selection, onAccepted })`

Coalesces matching retries and rejects conflicting ID reuse. The first caller
durably reserves request ID, fingerprint, and response mode before starting
exactly one native `chat.send` with command interpretation disabled. Before
that send it captures the current canonical transcript id and calls
`smart_remarkable.bind_origin` with the request ID, mode, and captured session
ID. It requires the plugin's exact bound receipt, adds durable
external-user/reMarkable input provenance, supplies the startup-validated
`expectedSessionRoutingContract`, and keeps WhatsApp as the originating reply
route. A
completed durable record returns its cached safe response without new Gateway
or delivery work; an incomplete reservation after restart is never
resubmitted.

The captured session id is never supplied as `chat.send.sessionId`. In
OpenClaw 2026.7.1 that field can rotate a newer current session to the
caller-supplied id rather than atomically asserting transcript identity. If a
pre-acceptance send fails after binding, the bridge calls the narrow clear
method. Terminal OpenClaw lifecycle otherwise clears the run context.

Once accepted, the service starts exactly one
`smart_remarkable.deliver` acknowledgement and notifies every waiting HTTP
response. The canonical prompt ends with the versioned response-envelope
instruction. A live Gateway final is usable only when its run ID and session
match and its text passes the strict envelope parser. Empty or partial live
events do not become user-visible output.

In parallel, the service reconciles the durable canonical history. It requests
the recent tail, bounded to 1000 messages and `maxChars: 500000`, locates
exactly one user record whose direct or nested idempotency key is
`<requestId>:user`, and scans forward only until the next user record. It
accepts the first assistant record in that interval that passes the strict
envelope parser; assistant record IDs are deliberately irrelevant. Duplicate
anchors, crossing another user, target-interval truncation, malformed finals,
or missing attribution fail closed. Older history may exist when the exact
anchor is already present. Current history is eligible only while its
`sessionId` still equals the captured ID, and a live final is merely a
candidate until the exact captured-session request anchor is verified. This
polling path remains active after a
post-acceptance request-callback failure, so a queued or tool-using run is not
lost merely because the ephemeral live final was missing.
If canonical history has remapped and no longer contains the anchor, the
service prefers `<captured-session-id>.jsonl` beside the trusted sessions file.
If OpenClaw has reset that transcript, it considers only bounded exact-prefix
`.jsonl.reset.<safe-ISO-timestamp>` candidates. Each is opened with
`O_NOFOLLOW`, limited to 64 MiB and 8 MiB per line, and required to begin with
the exact captured session header. Exactly one archive may contain the request
anchor; multiple anchored or otherwise ambiguous matching archives fail
closed. It never examines a transcript belonging to another session.

It reports either delivery as sent only when the plugin returns exact
`status: "sent"`, the expected run ID, WhatsApp channel, and a non-empty
provider message ID. The final delivery text is rendered server-side as
`I read:` plus a line-quoted literal transcription, a blank line, and the
answer. Exact `[unclear]` becomes an explicit inability-to-read message rather
than a guessed transcription. It then commits a stable OpenAI-shaped response
before returning it. `write_back` contains only `response_text`;
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

### `createOriginBindingHandlers({ api, logger })`

Registers the narrow `smart_remarkable.bind_origin` and
`smart_remarkable.clear_origin` Gateway methods at `operator.write` scope.
Binding accepts only an exact request ID, response mode, and preflight-captured
session ID, then stores server-generated capability state in OpenClaw's
run-context namespace before `chat.send` can admit the run. Its receipt must
echo all three values. An identical bind is idempotent; malformed, conflicting,
or foreign namespace state fails closed. Clearing accepts only the matching
request ID and is used for pre-admission failures. Normal terminal run events
let OpenClaw remove the context.

### `createRemarkableOriginHooks({ api, logger })`

Creates the prompt and tool-call hooks that consume the trusted run context.
For a bound run whose hook context has the exact captured session ID,
`before_prompt_build` identifies the current turn as coming from reMarkable
while preserving the canonical WhatsApp conversation. It tells the agent to
create a PDF or EPUB and call `remarkable_deliver_document` only when the user
actually asks to create, export, send, add, or place a document on the tablet.
Merely discussing a document never implies an upload.

`before_tool_call` is the execution boundary. It permits the upload tool only
for the exact bound run, captured session ID, canonical `main` agent, and
`agent:main:main` session, then injects the server-owned request ID and
capability. Tool execution rechecks that session identity and capability. User
prompt text, transcript content, model output, and caller-supplied tool
arguments cannot authorize an upload.

### `createRemarkableUploadTool({ runtime, logger, store, execFile })`

Registers `remarkable_deliver_document` only in the canonical main session. It
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

### `validateOpenAiBody(body)`

Accepts only one multimodal user message containing non-empty text and exactly
one bounded PNG data URL. It returns the prompt, attachment base64, byte size,
and SHA-256 fingerprint consumed by `SelectionService`. The fingerprint binds
both the current response-envelope version and the trusted-origin protocol
version, so a completed result created under an older authority contract cannot
be replayed after a protocol change.

### `parseResponseEnvelope(source)` and `renderResponseEnvelope(envelope)`

`parseResponseEnvelope` accepts exactly one JSON object with exactly two unique
string keys: `received_text` and `response_text`. It rejects code fences,
unknown or duplicate decoded keys, empty fields, disallowed controls,
oversized transcriptions, and a final rendered message above the delivery
limit. CRLF becomes LF and Unicode is normalized to NFC.

`renderResponseEnvelope` applies the same validation to object input and
creates the single WhatsApp final. Every transcription line is quoted under
`I read:`; `[unclear]` is rendered as an explicit inability to confidently
read the selection.
