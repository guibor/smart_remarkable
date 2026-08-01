# Smart Remarkable OpenClaw bridge

This is a loopback-only protocol adapter between Smart Remarkable's
OpenAI-shaped HTTP request and OpenClaw's native Gateway RPC. It is intended to
run on the same server, as the same Unix user, as the OpenClaw Gateway.

It does not run on or modify the reMarkable. The tablet reaches it through the
existing SSH local forward:

```text
tablet 127.0.0.1:18791
        -> SSH direct-tcpip
server 127.0.0.1:18792
        -> OpenClaw Gateway ws://127.0.0.1:18789
```

## Two-button behavior

- The stock notebook-with-sparkles icon sends
  `x-smart-remarkable-response-mode: write_back`. OpenClaw runs the request in
  `agent:main:main`, sends an immediate working acknowledgement and one final
  WhatsApp message containing a faithful account of the selection followed by
  the answer. The bridge returns only the answer for insertion in the notebook.
- The stock sparkles icon sends
  `x-smart-remarkable-response-mode: whatsapp_only`. It uses the same OpenClaw
  session, acknowledgement, tools, memory, and WhatsApp delivery, but the
  tablet deliberately does not insert the returned text. Its HTTP response
  contains only a fixed delivery receipt; the assistant answer is never echoed
  to the tablet in this mode.

For both modes, the tablet closes the stock selection as soon as it has
validated the firmware-supplied descriptor and captured the exact crop into
memory. That local handoff does not wait for the tunnel, bridge, model, tools,
or WhatsApp, so the notebook is usable while the one admitted canonical turn
continues. The bridge still withholds HTTP 200 headers until native `chat.send`
has admitted the run, and its JSON body follows only after the matching
protocol-valid live final or strict canonical-history reconciliation.

The two actions use stock firmware resources instead of custom glyphs or the
ambiguous labels `LLM` and `Send`. A pending mode is cleared before AppLoad
closes, on visibility loss, on timeout, and on launch failure, so one failed
attempt cannot silently consume the next tap.

## Data flow

1. The tablet posts one prompt, the selected crop, the current-page image, and
   document/page metadata to `POST /v1/chat/completions` with a narrow Bearer
   token, a response-mode header, a strict
   `x-smart-remarkable-selection-kind` value of `ink`, `image`, or `mixed`,
   `x-smart-remarkable-context-version: selection-page-v1`, and a unique
   request ID in the exact `smart-remarkable-` namespace. The body must contain
   exactly one non-empty text part followed by PNG `image_url` parts tagged
   `x_smart_remarkable_role: selection` and `current_page` in that order. Each
   PNG is limited to 6 MiB and their combined decoded size to 8 MiB. The body
   context has exactly `version`, `document_display_name`, `page_id`,
   zero-based `page_index`, matching one-based `page_number`,
   `page_image_scope: current_page_view`, and
   `page_image_completeness: full_page|viewport_only`. The visible display name
   must already be NFC, contain no C0/C1 controls, and fit in 1024 UTF-8 bytes.
2. The bridge validates the fixed request shape, then requires the exact plugin
   capability receipt for the current authenticated Gateway connection
   generation. Only after that side-effect-free probe succeeds does it compute
   a content fingerprint and atomically reserve the request ID, fingerprint,
   response mode, and selection kind in its persistent request journal. The
   fingerprint binds the prompt, selection kind, both PNGs, the NFC-normalized
   bounded display name, page identity/index/number, page-image scope and
   completeness, and all semantic protocol versions. Neither image, the
   display name, nor the prompt is persisted in the journal. The request ID is
   both the bridge coalescing key and OpenClaw's `chat.send` idempotency key.
3. Before the HTTP listener and `/health` can open, the bridge calls the
   plugin's side-effect-free `smart_remarkable.capabilities` method and
   requires the exact plugin ID, version 0.4.0, origin-v4 protocol, ordered
   `selection-page-v1` input-context versions, ordered
   `selection`/`current_page` attachment roles, and ordered
   `ink`/`image`/`mixed` capability receipt. An old, missing, or partially
   promoted plugin therefore keeps the bridge unready instead of letting the
   tablet close a locally captured selection before discovering server skew.
   A disconnect or new authenticated hello invalidates the old proof; both
   `/health` and the next admission re-probe that new generation. Capability
   RPCs and every request-specific RPC are checked before and after against the
   admitted generation, so a reconnect race fails closed.
4. The bridge preflights canonical history to capture the transcript ID for
   recovery and authority binding. It then calls
   `smart_remarkable.bind_origin` with origin protocol v4, the request ID,
   response mode, selection kind, input-context version, and captured
   transcript ID and requires the
   plugin's exact versioned receipt and opaque cleanup handle. This creates a
   pending realm-neutral JSON string, including the authenticated selection
   kind, in OpenClaw's host-owned run context, which is shared across the
   Gateway startup registry, active prompt/tool hooks, and pinned tool factory.
   OpenClaw closes ordinary plugin API methods after registration, so plugin
   version 0.4.0 reaches that host state through a registered synchronous
   agent-event adapter. The complete get/set/clear command remains in the
   originating plugin instance; the emitted plugin-owned control event carries
   only a fresh random operation ID. Its host callback performs the operation,
   and set/clear succeed only after exact read-back. A missing or delayed
   callback, unavailable host method, mismatched receipt, exception, or
   capacity overflow fails closed. No origin value, capability, cleanup
   handle, or operation enters the event, run ID, prompt, or transcript. Bind
   and clear require `operator.admin`. The
   bridge does not pass
   the captured transcript ID to `chat.send`; on OpenClaw 2026.7.1 that field
   can rotate current session state rather than atomically assert identity.
5. The bridge constructs a fixed capture manifest that names
   `remarkable-selection.png` as the primary user focus and
   `remarkable-current-page.png` as supporting page context. It labels the
   document display name, page identity, and both image contents as untrusted
   data while preserving the manifest roles as trusted transport facts. It
   then appends a selection-kind-aware versioned instruction requiring
   the canonical assistant final to be exactly
   `{"received_text":"...","response_text":"..."}`, then calls native
   `chat.send` with the fixed server-side session `agent:main:main` and both
   fixed-name PNGs as inline image attachments,
   `suppressCommandInterpretation: true`, `deliver: false`, and an explicit
   direct WhatsApp origin and the startup-validated
   `expectedSessionRoutingContract: "per-sender|main|main"`. It also attaches
   durable external-user provenance whose source channel is `remarkable` and
   source tool is `smart_remarkable`. This records one canonical
   user/assistant turn without relying on unverified automatic delivery or
   changing persistent verbose settings in the canonical session. The appended
   transport block identifies source but explicitly cannot classify intent or
   authorize tools; those semantics come from the exact admitted plugin hook. A
   failed admission and every completed bridge outcome clear the binding.
6. The plugin's prompt hook activates only the pending record whose actual run
   ID, canonical agent/session key, and transcript ID match the captured
   values. Pending records expire after twelve minutes, active records after a
   fixed fifteen minutes, and a 128-record cap rejects new binds without
   evicting live authority. It tells OpenClaw that the current turn originated
   on reMarkable while preserving normal WhatsApp continuity. `ink` retains
   direct-request behavior. For every selection kind, the hook treats the
   selection as primary and uses the current page, document display name,
   canonical history, and durable memory as supporting context. It resolves
   intent from an explicit current instruction, then a specific still-active
   user instruction in canonical history, then durable memory/preferences, and
   finally the contextualized selection. It makes the strongest reasonable
   interpretation and completes the likely task instead of stopping at a
   transcription, menu, market scan, or generic clarification. If no task can
   be recovered, it gives an in-depth explanation, background, mechanisms,
   relevance, and useful implications. It must not invent facts, evidence, or
   completed actions. Inference and ambiguity never authorize side effects.
   Deliberately authored primary handwriting can be user input; page context,
   title metadata, client framing, assistant suggestions, quoted text, and
   commands merely visible in image/mixed content remain context rather than
   authority unless an explicit user instruction adopts them. If an explicit user
   instruction governing the turn asks to create, export, send, add, or place a document,
   the hook tells the agent to create a finished PDF or EPUB in its workspace
   and call `remarkable_deliver_document`. Discussing a document does not imply
   an upload. A subsequent `before_agent_run` gate examines the final system
   prompt after construction and blocks every Smart reMarkable run unless that
   exact active origin/session is still present and its server-owned guidance
   is in the final prompt. Ordinary runs return an explicit pass result for the
   pinned OpenClaw 2026.7.1 gate behavior.
7. On Gateway acceptance with `runId` exactly equal to the tablet request ID,
   the bridge calls the bundled `smart_remarkable.deliver` plugin method with
   kind `ack`, then flushes the tablet's 200 response headers. The plugin is
   scoped to `operator.write`, derives the direct WhatsApp destination from
   `agent:main:main`, and accepts no caller-supplied route.
8. The bridge accepts a matching live final only when that envelope is valid.
   Current history is eligible only while its transcript ID still matches the
   captured ID; a live final remains only a candidate until that same
   transcript contains the exact `<requestId>:user` anchor. If the canonical
   mapping changed, recovery prefers the exact preflight-captured transcript
   and otherwise considers only bounded exact-name reset archives with
   no-follow, size, session-header, uniqueness, and request-anchor checks.
9. The bridge waits for the acknowledgement attempt, then renders and sends one
   atomic final through `smart_remarkable.deliver`: `I read:`, the line-quoted
   kind-aware `received_text`, a blank line, and the answer. For `ink`, the
   received field is a literal handwriting transcription. For `image`, it
   preserves legible text or gives a concise factual visual description; for
   `mixed`, it preserves handwritten and printed text plus essential non-text
   content. `received_text` always applies to the selection attachment only;
   the page-context image and document name are never quoted there.
   Interpretation remains in `response_text`. `[unclear]` becomes an
   explicit inability-to-read message. A failed acknowledgement does not
   prevent the final attempt, but the final cannot overtake an in-flight ack.
10. The delivery plugin uses OpenClaw 2026.7.1's public
   `sendDurableMessageBatch` helper and loaded native WhatsApp adapter.
   `mirror` and `session` are deliberately omitted, so these status/final sends
   are not appended to the canonical transcript a second time. Only a
   successful final plugin RPC with exact `status: "sent"` is reported as
   `openclaw_delivery.final.status: "sent"`. Success requires the native result
   to contain the exact derived run ID, channel `whatsapp`, and a matching
   non-empty platform receipt/message ID. A rejected or incomplete result is
   reported as `failed`; a final chat event alone is never described as
   successful delivery. The acknowledgement is held to the same checks.
11. When the agent calls `remarkable_deliver_document`, a second plugin hook
    requires the exact active request, captured transcript ID, canonical main
    agent, and canonical main session before injecting a server-only
    capability. Tool execution rechecks that session identity. The tool admits
    only a workspace-contained regular PDF or EPUB, snapshots it privately,
    invokes the pinned `remarkable-sync` CLI without a shell, and accepts only
    a strict cloud ID/hash receipt. Its durable journal prevents an identical
    confirmed upload from being repeated and fails closed after an ambiguous
    outcome.
12. Internal Gateway/provider error text is logged only server-side. Tablet
   responses use fixed public run, acknowledgement, and final-delivery
   messages.

Only IDs matching
`smart-remarkable-[A-Za-z0-9][A-Za-z0-9._:-]{0,110}` are admitted by the HTTP
boundary, provenance validators, request journal, origin plugin, and delivery
plugin. Concurrent retries with the same ID, mode, selection kind, context
version, and content
share one Gateway turn, one acknowledgement, and one final send. Reuse of an ID for
different content, context, mode, or selection kind is rejected
with HTTP 409. Replay labeling is per caller:
the caller that started the work receives
`x_smart_remarkable.replayed: false`; concurrent or delayed duplicate callers
receive `true`. The tablet suppresses notebook writeback for a replay so an
HTTP retry cannot insert the same answer twice.

The bridge request journal survives process restarts. A completed entry returns
its cached safe response, marked as a replay, without calling `chat.send` or
either delivery RPC again. A reserved, corrupt, or ambiguous entry fails
closed and never resubmits the request. Records contain the request ID, mode,
selection kind, exact context version, content fingerprint, and final safe
response only; they never persist either PNG, the raw document-display-name
request field, prompt, image base64, Gateway token, or WhatsApp credentials.
A bounded safe response may naturally mention the title. Safe responses include the admitted
`context_version` alongside mode and selection kind.
Entry directories are atomically reserved and records are committed with
write-fsync-rename-fsync. Record reads refuse symlinks and records larger than
128 KiB.

Origin v4, input context `selection-page-v1`, response envelope v3, and plugin
0.4.0 are a deliberate hard protocol boundary. Promotion
must quiesce new tablet requests, install the plugin and bridge as one guarded
server transaction, restart the Gateway so the new plugin is registered, and
start the bridge only after its capability probe succeeds. The record schema
also advances to v3 so context semantics are bound to every cached response.
Existing schema-v1 and schema-v2 reservations and responses remain on disk as
fail-closed barriers: they are never replayed or resubmitted under v3.
Because request IDs are unique per tablet attempt, normal new requests use new
v3 entries; an operator must not delete old records merely to make a retry
appear absent.

The journal has a fixed hard capacity (20,000 entries by default, configurable
up to 100,000) implemented with atomically claimed slot files. It never evicts
or automatically reuses an old request ID because that could weaken restart
idempotency. Once full, new IDs receive HTTP 503 and require explicit operator
maintenance. A filesystem failure can conservatively leak a slot; that reduces
available capacity but can never permit more than the configured maximum or
cause duplicate work.

The delivery plugin separately keeps
a persistent, plugin-owned receipt journal under OpenClaw's state directory.
A completed receipt is replayed without resending; a reservation left by an
interrupted or uncertain send is never automatically retried because its
platform outcome cannot be proven. This fail-closed rule can omit a message
after a pre-send crash, but it avoids silently duplicating a WhatsApp message
after an ambiguous post-send crash. The journal uses atomic directory
reservation plus write-fsync-rename commits. Directory and record reads use
no-follow handles, owner/type/identity checks, private modes, a one-link/64 KiB
record policy, stable descriptor reads, and fatal UTF-8 validation before
parsing a cached receipt. It does not call OpenClaw's trusted-plugin-only keyed
state API.
`sendDurableMessageBatch` also creates its own random-ID OpenClaw queue entry.
After a process crash that entry may still be pending or recovering while the
plugin reservation blocks a second batch. Queue recovery may eventually
complete the original attempt, but the plugin reports `UNAVAILABLE` until a
matching receipt is already journaled; it does not claim that the message was
automatically delivered or enqueue a duplicate.

The tablet requires both
`openclaw_delivery.acknowledgement.status: "sent"` and
`openclaw_delivery.final.status: "sent"` before it accepts completion or
writes an answer back into the notebook. The bridge still attempts the final
send after an acknowledgement failure so the user can receive the answer on
WhatsApp, but the tablet fails closed when either receipt is absent.

If a restarted bridge receives a completed `chat.send` `status: "ok"` replay,
it accepts it only with the exact request ID, then calls `chat.history` with
`maxChars: 500000` and the maximum 1000-message recent tail. It requires exactly
one user anchor whose idempotency key is `<requestId>:user`, ignores unrelated
assistant IDs, and accepts only a protocol-valid assistant record before the
next user turn. Duplicate anchors, target-interval truncation, a cross-user
boundary, or missing attributable output fail closed. Older history may exist
when the exact anchor is already in the returned tail. `status: "in_flight"` is
treated as accepted only with the same exact ID and uses the same bounded
live-event/history reconciliation.

If the canonical session mapping changes after admission, recovery is limited
to the exact transcript ID captured before the send. The reader validates that
ID as a filename component and first tries its active JSONL. If OpenClaw reset
it, the reader considers at most 128 exact
`.jsonl.reset.<safe-ISO-timestamp>` names, opens each with `O_NOFOLLOW`, bounds
the file at 64 MiB and each line at 8 MiB, validates the first session record,
and requires one unique exact request anchor. It never examines another
session's transcript. The captured ID is a recovery locator and authority
constraint only; it is never used to repin or mutate the current OpenClaw
session.

## Runtime prerequisites

- Node must satisfy OpenClaw 2026.7.1's exact engine constraint:
  `>=22.22.3 <23`, `>=24.15.0 <25`, or `>=25.9.0`.
- Run `npm ci --omit=dev` in this directory. The dependency is pinned to
  `openclaw@2026.7.1`; the production import is the official
  `openclaw/plugin-sdk/gateway-runtime` export.
- Run the bridge process as the same Unix user as
  `openclaw-gateway.service`. The sample system unit explicitly drops to
  `User=mdf`; that user's home must contain the canonical OpenClaw
  configuration and main-agent session store.
- Install and enable `openclaw-plugin/` as a native workspace plugin before
  starting the bridge. The reviewed manifest/package version is `0.4.0`; its
  manifest activates on Gateway startup, and the
  Gateway must expose `smart_remarkable.deliver`,
  `smart_remarkable.capabilities`,
  `smart_remarkable.bind_origin`, and `smart_remarkable.clear_origin`, plus the
  `remarkable_deliver_document` agent tool.
- In live OpenClaw configuration, explicitly grant both reviewed hook
  permissions to this non-bundled plugin:

  ```json
  {
    "plugins": {
      "entries": {
        "smart-remarkable-delivery": {
          "hooks": {
            "allowPromptInjection": true,
            "allowConversationAccess": true
          }
        }
      }
    }
  }
  ```

  The plugin validates its own ID and both exact booleans before registering
  any Gateway method, hook, or tool. Its manifest cannot grant these live host
  permissions to itself; missing or false flags therefore stop plugin startup.
- Document delivery uses the existing reMarkable Cloud client at
  `/home/mdf/code/remarkable-sync/.venv/bin/python` and its private config at
  `/home/mdf/.config/remarkable-sync/config.json`. The config must be a
  non-symlinked regular file owned by the Gateway user and mode 0600 or
  stricter. The plugin passes its path only through
  `REMARKABLE_SYNC_CONFIG`; it does not copy the credential into OpenClaw
  prompts, tool arguments, or logs.
- The OpenClaw Gateway must listen on `ws://127.0.0.1:18789`, and its token
  authentication must be enabled.
- OpenClaw's resolved session routing must remain exactly
  `per-sender|main|main`. The bridge validates this at startup and also passes
  it as `expectedSessionRoutingContract` on each native send, so a scope,
  main-key, or default-agent change fails closed instead of silently
  recanonicalizing the main alias.
- The SSH key used by the tablet belongs to a dedicated password-locked Unix
  account. The example policy in
  `ssh/sshd_config.smart-remarkable-tunnel.example` allows only client-local
  TCP forwarding to literal `127.0.0.1:18792` and denies reverse TCP,
  StreamLocal, shell/exec/subsystem, PTY, agent/X11, tunnel, and user-rc
  access. The bridge itself never binds a LAN address.
- The bridge request journal must be in a dedicated absolute directory whose
  leaf name is `request-journal-v1`. The sample service gives it a private
  `StateDirectory` while leaving the rest of the user's home read-only.

By default no full Gateway token or WhatsApp destination is duplicated:

- `~/.openclaw/openclaw.json` supplies `gateway.auth.token`.
- `~/.openclaw/agents/main/sessions/sessions.json` supplies
  `["agent:main:main"].origin`.
- That origin must have `provider: "whatsapp"`, direct `chatType`, and non-empty
  `to` and `accountId` values.
- WhatsApp destination environment overrides are rejected, so a service
  configuration cannot silently diverge from the canonical main conversation.
- `~/.config/smart-remarkable-openclaw-bridge/tablet.token` supplies the
  unrelated tablet-facing Bearer token. It must contain 43-128 base64url
  characters and be mode 0600 or stricter.

Environment overrides are listed in `.env.example`. In particular, the bridge
refuses a non-loopback HTTP listener, a non-loopback Gateway URL, or a
non-canonical WhatsApp route even if one is configured.

The default request-journal location for an unsandboxed manual run is
`$OPENCLAW_HOME/smart-remarkable-bridge/request-journal-v1`. The sample
production service explicitly sets it to
`%S/smart-remarkable-openclaw-bridge/request-journal-v1`, backed by
`StateDirectory=smart-remarkable-openclaw-bridge` at mode 0700. Do not add a
broad writable-home exception to the service sandbox.

## System service assumptions

The sample is a systemd **system** unit because systemd 249 does not enforce
`ProtectHome=` or `ProtectSystem=` for user-manager services. PID 1 creates the
private state directory and the service then runs unprivileged as
`User=mdf`, with the rest of `/home` read-only and the system filesystem
protected. The bridge files remain under
`/home/mdf/.local/share/smart-remarkable-openclaw-bridge`; the full Gateway
credential and canonical session files are read from the same user's home.
Only unit installation and lifecycle control require root.

The Gateway remains an independent systemd **user** service. A system unit
cannot order itself against a different user's service manager, so the bridge
depends only on network readiness. If the loopback Gateway is not ready, the
bridge exits before opening HTTP and `Restart=on-failure` retries it.

Install and start commands are intentionally not automated here:

```bash
npm ci --omit=dev
sudo install -m 0644 \
  systemd/smart-remarkable-openclaw-bridge.service.example \
  /etc/systemd/system/smart-remarkable-openclaw-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now smart-remarkable-openclaw-bridge.service
curl --fail http://127.0.0.1:18792/health
```

The health endpoint is deliberately simple and carries no credentials. It is
only reachable through loopback or the constrained tablet SSH tunnel. The
listener is opened only after the request journal has been created, ownership
checked, and proven writable, so `/health` cannot be green while durable
request reservation is unavailable. Missing manual-run directory ancestors are
created one at a time with a parent-directory fsync after every creation; crash
durability therefore does not depend on `StateDirectory=` having pre-created
the parent. Every health request also requires capability readiness for the
current authenticated Gateway generation. A disconnect, reconnect awaiting a
probe, probe failure, or capability mismatch returns
`503 {"status":"unavailable"}`.

## OpenClaw 2026.7.1 acceptance compatibility

`GatewayClient.request(..., { expectFinal: true, onAccepted })` invokes
`onAccepted` for an interim status named `accepted`, but the native
`chat.send` handler in OpenClaw 2026.7.1 names its post-admission response
`started`. The bridge prefers `onAccepted` and also treats that exact native
`started` response as the same acceptance boundary. After acceptance, a later
request-callback failure cannot discard the already admitted turn; the bridge
continues bounded canonical-history reconciliation for up to ten minutes. It
never flushes success headers merely because the socket connected or the HTTP
request parsed, and missing or mismatched acceptance run IDs never flush
success headers.

## Verification

```bash
npm test
node --test openclaw-plugin/test/*.test.mjs
```

The 148 bridge/plugin tests use a fake Gateway client and temporary filesystem
journals. They verify pre-acceptance header
withholding, both modes, all three strict selection kinds, kind-bound
fingerprints and origin receipts, the exact request-ID namespace, strict
selection/page role ordering, image bounds, page-metadata normalization,
context-version capability gating, fixed
routing, one turn/acknowledgement/final send per request ID, conflicting duplicates,
acknowledgement and final delivery
failure, ack-before-final ordering, exact transcription-plus-answer delivery,
answer-only writeback, strict envelope parsing, completed and in-flight replay
behavior, exact acceptance IDs, history misses and truncation, empty live-final
recovery, history-only `started` completion, cross-user attribution refusal,
fixed public errors, WhatsApp-only response redaction, the OpenClaw 2026.7.1
`started` compatibility path, persistent restart replay, fail-closed incomplete
reservations, per-caller replay labeling, fixed capacity, symlink/corruption
rejection, active-host capacity retention and expiry cleanup, trusted
origin/session binding and clearing, the synchronous agent-event host
run-context adapter, exact set/clear read-back, missing synchronous receipt
failure, wrong-plugin event rejection, bounded reentrant control,
routing-contract drift,
durable provenance, active and real reset-archive transcript recovery,
replacement-session/live-final rejection, production service wiring, and
pre-health journal preparation. They also exercise current-generation
capability invalidation/re-probing, a reconnect crossing an in-flight RPC,
dynamic health failure, admission refusal before journal reservation, explicit
hook-policy configuration, proactive context-aware prompt policy,
selection-only `received_text`, the final-prompt admission gate, and
schema-v1/schema-v2 reserved/completed migration barriers that are neither
replayed nor freed.

The plugin tests use fake sends plus both a fake journal and the real atomic
file journal in a temporary directory. They verify ordinary workspace-plugin
registration never touches OpenClaw's restricted keyed state API, the exact
`operator.write` delivery scope and `operator.admin` origin bind/clear scopes,
strict bounded params, fixed canonical route
derivation, direct-adapter receipt checks, absent `mirror`/`session` fields,
in-flight coalescing, durable receipt replay, and fail-closed ambiguous restart
behavior, including a surviving reservation while an independently keyed
OpenClaw queue entry may still recover. They also cover prompt-hook scoping,
direct-request ink guidance, capture-intent precedence and safe ambiguity
defaults, run-capability enforcement, workspace containment, link and format
rejection, private snapshots, strict CLI invocation and receipt parsing, upload
idempotency, ambiguous-outcome refusal, and no-follow bounded durable receipt
reads that reject symlinks, hard links, unsafe modes, oversized files, invalid
UTF-8, and forged envelopes. Neither suite makes network, server, tablet, or
reMarkable Cloud changes.
