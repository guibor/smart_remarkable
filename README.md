# Smart Remarkable

A Vision-LLM agent for the reMarkable tablet. It watches what you write, and
when you trigger it, sends a screenshot to an LLM and draws (or types) the
response back onto the screen.

This project is a fork of [awwaiid/ghostwriter](https://github.com/awwaiid/ghostwriter), extended with Select Mode.

## Paper Pro 3.28 / OpenClaw workflow

This branch keeps the stock notebook UI running and prints each response as
ordinary editable reMarkable text. It provides one **Smart Remarkable**
AppLoad tile and exactly three configurable modes:

| Mode | What submits | Lifetime |
|---|---|---|
| `once` | Complete a native lasso and lift the pen. | Exits after the first valid selection; default limit 10 minutes. |
| `session-hold` | Complete a native lasso, pause at the closing point with the pen still touching, then lift after the hold. | Handles multiple requests; default limit 60 minutes. This is the default and the safest button-free session mode. |
| `session-auto` | Every completed native lasso submits when the pen lifts. | Handles multiple requests; default limit 60 minutes. Opt in carefully because an ordinary selection edit can also be sent. |

The AppLoad tile toggles the configured worker on and off. To start a session,
open **My files → left sidebar → AppLoad**, tap **Smart Remarkable**, return
to the notebook, and use the interaction for the configured mode. Tap the
same AppLoad tile again to stop early; otherwise PID 1 stops the worker at its
time limit or whenever stock `xochitl` stops.

### Exact `session-hold` gesture

The hold happens *before* pen-up, at the point where the lasso loop closes:

1. Select reMarkable's native lasso tool.
2. Put the pen down, draw a loop around the handwriting, and return to the
   starting point without lifting.
3. With the loop closed, keep the tip touching the screen and keep the
   endpoint nearly still for at least 800 ms. The default tolerance is 12
   normalized screen pixels; moving farther resets the hold timer.
4. Lift the pen only after that pause. Smart then waits for the stock
   selection marquee, submits only the selected crop, and types the response
   below it.

Lifting immediately still creates an ordinary reMarkable selection but does
not submit it in `session-hold`. A pen tap or a too-small path is ignored. A
contact that began while another answer was processing is also ignored
rather than queued; draw a fresh lasso after the answer finishes.

### Native answer-here and agent buttons

The preferred explicit interaction, once the firmware-specific two-button
patch has passed its device canary, is:

1. Use the native lasso normally and lift the pen.
2. Immediately after the stock **Copy** action, choose:
   - The **sparkling notebook** to send the selection to canonical OpenClaw,
     receive the working acknowledgement and final in WhatsApp, and insert
     that exact final as editable stock text below the selection.
   - The **sparkles** to send the same canonical OpenClaw turn and receive the
     same WhatsApp acknowledgement/final sequence, with no tablet text, pen,
     or touch output.
3. The chosen button highlights at once and shared pending state ignores
   repeated taps. The v2 QML records the live `ink`, `image`, or `mixed` kind,
   fixed-point selection rectangle, stable `normal`/`rot180` orientation, and
   capture time. AppLoad strictly parses that descriptor, starts the local
   worker when necessary, adds a fresh kernel-random nonce, and publishes a
   root-only busy marker before the trigger. Local capture readiness does not
   wait for the SSH tunnel or bridge.
4. Smart asks QML to re-read the same selection immediately before capture.
   Only an exact match temporarily hides the stock tint, border, and menu via
   the stock `controlsAreVisible` flag and returns a nonce-bound prepare
   acknowledgement. Smart then captures only the descriptor rectangle with
   the descriptor orientation. Handwriting keeps the established whitening
   and enlargement; image and mixed selections preserve RGB and tonal detail.
5. After the prepared crop exists only in memory, Smart asks QML to revalidate
   once more, calls reMarkable's own selection-close path, and requires the
   matching close acknowledgement before any remote submission. A pre-close
   capture or validation failure restores the stock controls and leaves the
   selection recoverable. This does not copy, delete, move, or change the
   selected content. No pen hold or four-finger gesture is involved.
6. The private tunnel starts in parallel and publishes separate remote
   readiness. OpenClaw/WhatsApp work continues after the local marquee closes,
   while the busy generation rejects later taps instead of queueing them. For
   answer-here, Smart retains the complete normalized page captured while the
   exact selection was still prepared, then requires the first post-close frame
   to match those original bytes. A missing or changed original-page binding
   preserves the canonical OpenClaw/WhatsApp result but suppresses tablet
   insertion. The same fail-closed result applies unless Smart can verify the
   stock Text tool, close and verify its palette, observe only the pinned
   toolbar plus a narrow caret delta, confirm no current or new physical
   contact, and emit the complete supported answer within the bounded keyboard
   budget. Legacy and pen-lasso routes cannot prove this exact binding and
   therefore do not type locally in this candidate.

During app-first rollout only, the currently installed QMD hash
`2b9188af0c3fd726743e36ee1a3c86244cf6327ad22eeef1aa7a291a7add059d`
still calls `--selection-button=write_back` or
`--selection-button=whatsapp_only`. The launcher accepts those exact old
shapes as a separately tagged, random `legacy-v1` generation so the installed
buttons do not break before the v2 QMD is reviewed and promoted. That path
still uses historical marquee detection and remote-accepted close; it is a
transition contract, not evidence that the v2 descriptor/acknowledgement path
is installed or physically accepted.

Both buttons are explicit triggers in all three modes. In `once`, the worker
exits after the request; in either session mode it rearms for another one.

### Configuration

The non-secret settings live separately from the OpenClaw credential in
root-owned, mode-600
`/home/root/.config/smart-remarkable/settings.conf`. The file is parsed as
data, never evaluated as shell code:

```ini
mode=session-hold
hold_ms=800
hold_radius_px=12
min_extent_px=24
once_timeout_seconds=600
session_timeout_seconds=3600
```

Valid modes are only `once`, `session-hold`, and `session-auto`. Unknown
keys, malformed numbers, and out-of-range values fail closed instead of
starting a worker.

AppLoad is injected into the stock sidebar only while Xovi is active. On this
deployment it is deliberately not enabled at boot: if **AppLoad** is absent
after a restart, triple-press the power button with no more than two seconds
between presses, wait for the stock UI to return, then open the left sidebar
again. A single power press remains the ordinary sleep/wake action.

The deployment targets the canonical `agent:main:main` session through a
loopback-only server bridge. That bridge—not the tablet—owns the full Gateway
credential and the direct WhatsApp route. The tablet stores only an unrelated
narrow bridge bearer and a dedicated forwarding-only SSH key in root-owned
mode-600 files. History and memory stay in the canonical OpenClaw server
session; the client creates no separate tablet transcript and retains no page
screenshots.

Each tablet turn is also bound to trusted server-side reMarkable provenance
before it enters the canonical WhatsApp-routed session. If the handwritten
request asks OpenClaw to create or send a document, OpenClaw can create a PDF
or EPUB in its workspace and upload the validated artifact to the ordinary
reMarkable cloud library. It reports what it read and what it did in WhatsApp.
That delivery tool is execution-gated to the bound tablet run; typing similar
words in a normal WhatsApp turn does not authorize it.

For trusted `image` and `mixed` Capture selections, the candidate server hook
resolves intent in this order: an explicit current user instruction; a
specific still-active user instruction in canonical conversation; durable
memory/preferences; then the captured content and immediate context. Captured
or quoted text and assistant suggestions are context, not authority. If the
intent remains ambiguous, OpenClaw should provide an in-depth explanation,
background, and context for the selection—not a market scan, recommendations,
or a generic clarification—and ambiguity never authorizes an external side
effect.

The deployed reviewed OpenClaw workspace plugin is version `0.2.2`; the local
unpromoted candidate is version `0.3.0`. OpenClaw closes ordinary plugin API
methods after registration, so late origin bind and clear calls use a
registered synchronous agent-event adapter: only a random operation ID crosses
the plugin-owned control stream, while host callback methods perform
run-context get/set/clear and exact read-back. Origin bind and clear require
`operator.admin`; any missing, delayed, mismatched, or failed receipt is
unavailable rather than weakening provenance.

The AppLoad tile starts a transient, non-boot
`smart-remarkable-session.service` bound to `xochitl` and mutually exclusive
with T.M.R. It uses local tunnel port `18791`, while T.M.R. uses `18790`.
Volatile readiness and trigger state is root-only under
`/run/smart-remarkable`; it is removed when the worker stops. The optional
unauthenticated web server, full request/response logging, output files, old
provider API keys, and bundled kernel modules are not used.

The raw `xovi-ext/llmbutton` extension described below is deliberately not
used on firmware 3.28. It resolves private Qt ABI from native code and has a
real `xochitl` crash history. The installed 3.28.0.164 integration is instead
a small, firmware-hashed QMLDiff patch that adds the firmware's stock
sparkling-notebook and sparkles resources after **Copy** and delegates to
AppLoad. It contains no
credentials, networking, model call, Draw action, kernel code, or boot action.

### Implementation and deployment status

The 3.28.0.164 update is intentionally a reinstall, not an attempt to make
Xovi survive firmware updates. The tablet is still on the separately pinned
legacy-v1 functional QMD
`2b9188af0c3fd726743e36ee1a3c86244cf6327ad22eeef1aa7a291a7add059d`,
deployed worker
`0bce9522c47aa2becc2f07171ed59ade012061ff33bd5cdbc11ec1c94eefde50`,
and deployed plugin `0.2.2`. ReMagic's 30-second stock-rollback canary passed;
inert transaction `20260730T184327Z-34344` and functional transaction
`20260730T184443Z-34618` restored that exact installed generation. All eight
QMDs and AppLoad loaded; the recorded final `xochitl` PID was `9449` with zero
restarts, root was read-only, and takeover/canary helpers were inactive. The
repeatable procedure is in the
[Paper Pro Beta update recipe](https://github.com/guibor/remarkable-beta-os/blob/beta/pro/3.28.0.164/UPDATE-RECIPE.md).

The new v2 generation is complete locally but has not been installed on the
tablet or promoted to the server. Its exact functional source QMD is
`130353dbba7fd31b764f0835b610d59d9c25c7f1cc2b2c52e9285379f23ec1b8`,
compiled functional QMD is
`28a253e1d16d4aa5e2852afa40699d3bc13b3fb2ab1e9cdc0a953deec9953ef6`,
and aarch64 worker is
`c73586e65fe6acc5333b95c5934a9f5298ec5126de1069504ed09182c05e08a5`
(build ID `63c2a311d60699e22a22ee54e90094cce2e587f8`, maximum GLIBC
`2.28`, no RPATH/RUNPATH). The exact eight-QMD stack passes compatibility and
composes into 22 resources; 88 applicable Rust tests, 145 Node tests, and all
six device-free shell suites pass. This proves the local candidate and artifact
contract, not device behavior. Fresh exact-firmware preflight, inert canary,
human visual confirmation, functional watchdog/rollback, and physical
ink/image/mixed acceptance through both icons remain mandatory.

OpenClaw's candidate canonical final remains a strict
literal-transcription/answer envelope: WhatsApp receives one atomic `I read:`
quote followed by the answer, while the sparkling notebook returns only the
answer for guarded stock-text insertion and the sparkles action returns no
assistant text to the tablet.

In the earlier 3.28.0.163 deployment, server source transaction
`20260725T230143Z` and tablet transaction
`20260725T230352Z` both retain rollback preimages. The new worker passed a
start/health/stop tunnel smoke test without creating a model request. A
harmless live `Send`-mode canary was transcribed exactly as
`Bridge smoke test / Please reply READY`, answered `READY`, and received native
WhatsApp receipts for both acknowledgement and final. After human confirmation
of the disabled layout, guarded transaction
`20260725T211315Z-12106` promoted the exact functional two-button QMD
`761b7fd4f86ceed9625a541c1a8e7c2c101abc835b56e22c8f8e1a5f919f8ac7`.
Stock `xochitl` was healthy on that committed PID with zero automatic
restarts, the root filesystem remained read-only, and all
assistant/deployment units were inactive. A disposable-page answer-here and
agent acceptance test remains required
to verify real handwriting and notebook insertion through the physical UI.
The current allowlist requires the exact reviewed Better TOC, Better TOC
Collapse, Gestik, Ghostbuster, Pen Layer Memory, Quick Settings Timer, and TOC
From Selection QMDs and rejects every additional, missing, changed, symlinked,
wrongly owned, or wrongly moded QML artifact. No root remount, boot unit,
firmware write, kernel module, raw Qt-ABI extension, or stock `xochitl`
replacement is permitted.

The deployment intentionally adds no tablet boot service. After a tablet restart,
activate Xovi with the installed triple-power toggle before expecting the
selection-menu buttons. Once the functional phase is confirmed, lasso ink,
lift the pen, and tap the sparkling notebook or sparkles immediately after
**Copy**.

<img src="docs/select-mode-demo.gif" width="300">

The upstream project also has a **Select Mode**: lasso a region of handwriting, get an LLM
answer drawn into a box you choose. Because the answer is real pen strokes,
you can afterwards move and resize it with reMarkable's own selection tool.

**Experimental upstream LLM button.** When you lasso text with reMarkable's own selection
tool, an **LLM** button now shows up right beside the usual cut/copy/paste
menu — tap it to kick off Select Mode on that selection, no corner tap or
gesture required. It's added by a small extension
(`xovi-ext/llmbutton`) that hooks into xochitl's UI. It is not part of the
supported Paper Pro 3.28 deployment above.

<img src="docs/llm-button.jpeg" width="300">

**Experimental upstream Draw button.** A second button, **Draw**, sits right beside the LLM
button (same extension). Lasso a region and tap it instead of LLM: if the
selection is mostly handwritten/typed text, it sketches a small pencil-scratch
doodle illustrating what you wrote, drawn below the selection; if the
selection is already a drawing or sketch, it erases the original and redraws
an improved, more detailed version of it in the same spot. See
[SELECT_MODE.md](SELECT_MODE.md) for details.

**New: image-generation drawing (`--image-model`).** By default the Draw
button's artwork is SVG written by the chat LLM, which tops out at schematic
line art. Pass `--image-model` (default `gemini-2.5-flash-image`, Google's
"nano banana") and the sketch is instead rendered by a real image-generation
model — the chat LLM only classifies the selection and writes the image
prompt — then skeleton-traced into pen strokes. Sketch enhancement becomes
true image-to-image: your lassoed drawing is attached to the request, and
the original strokes are removed via xochitl's own selection-delete before
the refined version draws in their place. Needs `GEMINI_API_KEY` or
`GOOGLE_API_KEY`.

<img src="docs/image-draw-demo.gif" width="300">

## Contents

- [Features](#features)
- [Usage](#usage)
- [Install](#install)
- [LLM API Keys](#llm-api-keys)
- [Architecture](#architecture)
- [License](#license)
- [Credits](#credits)

## Features

- **Watch-and-draw loop.** A background task waits for a touch trigger (tap
  a screen corner, a four-finger tap, or a physical "LLM" button press — see
  below), screenshots the current page straight out of xochitl's
  framebuffer, sends it to a vision-capable LLM, and writes the answer back
  onto the screen — either typed via a virtual keyboard (`draw_text`) or
  hand-drawn as pen strokes from an LLM-generated SVG (`draw_svg`).

- **Select Mode** (`--select-mode`). Tap the trigger corner, then tap two
  opposite corners around a piece of handwriting to select it, then two more
  corners to choose where the answer should be drawn. The cropped selection
  is sent to the LLM, and the answer comes back as real ink scaled/centered
  into your placement box — genuine pen strokes you can move and resize
  afterward with reMarkable's native selection tool. See `SELECT_MODE.md`
  for the full walkthrough.

- **Experimental upstream LLM button (`xovi-ext/llmbutton`).** A XOVI native extension
  (`llmbutton.so`) that hooks into the running `xochitl` process at the Qt
  scene-graph level and injects an "LLM" button next to the stock
  cut/copy/paste selection menu. Tapping it writes a trigger file
  (`/tmp/llm_button_trigger`) that kicks off Select Mode on the current
  selection — no corner tap needed. This legacy path is not installed or
  consumed by the guarded Paper Pro AppLoad workflow.

- **Experimental upstream Draw button** (same extension). A second injected button beside LLM.
  Tapping it after lassoing a region writes `/tmp/draw_button_trigger` and
  routes to `prompts/draw.json`'s `draw_sketch` tool instead of an LLM
  answer: if the selection is mostly text, the model draws an illustrative
  doodle below it; if the selection is already a drawing, the app erases
  the original ink and redraws an improved version in the same spot. See
  [SELECT_MODE.md](SELECT_MODE.md) for the full mechanics.

- **Image-generation drawing** (`--image-model`, `--image-api-key`).
  Reroutes the Draw button through an image-generation model (default
  `gemini-2.5-flash-image`, "nano banana"): the chat LLM classifies the
  selection and writes a detailed image prompt (`prompts/draw_image.json`),
  `src/image_gen.rs` calls the Gemini image API — attaching the upscaled,
  background-cleaned crop of your sketch in enhancement mode — and the
  returned line art is thresholded, thinned to a 1-px skeleton, and traced
  as pen strokes (`Pen::draw_bitmap_centerline`). For the in-place redraw,
  the original strokes are deleted exactly via xochitl's own selection menu
  (the app locates and taps its trash button; dense hardware-eraser sweeps
  are the fallback), and only after generation succeeded — a failed API
  call never destroys your sketch.

- **Rotation-aware input.** Each screenshot detects whether xochitl's UI is
  rendered 180° rotated (device held upside down), normalizes the image to
  the user's orientation for the LLM and marquee detection, and mirrors all
  synthetic pen/touch coordinates back at the injection boundary — so taps,
  erasing, and drawing land correctly either way you hold the tablet.

- **Web config UI** (`--web-server`, `--web-port`). A `warp`-based HTTP
  server (default port `8080`) serving a small static UI for viewing and
  live-editing the running config, applying changes immediately (in-memory,
  hot-reloaded via a watch channel, with in-flight LLM calls cancelled) and
  persisting them to `~/.smart_remarkable.toml`. Also exposes
  `POST /api/simulation/trigger` to fire a trigger manually without touching
  the device.

- **Image segmentation** (`--apply-segmentation`). Runs contour-based region
  detection (`imageproc`) over the screenshot before calling the LLM,
  appending a text description of detected ink regions to the prompt for
  better spatial grounding.

- **Anthropic-only extras: thinking and web search.** `--thinking` enables
  extended thinking (`--thinking-tokens`, default `5000`, sets the budget);
  `--web-search` gives Claude a server-side web-search tool (max 5 uses per
  call). Both are no-ops on OpenAI/Google engines.

- **Layered, persistable config.** `--save-config` writes the fully-resolved
  config (defaults < `~/.smart_remarkable.toml` < `SMART_REMARKABLE_*` env
  vars < CLI args) to `~/.smart_remarkable.toml` and exits, so you can bake
  in your preferred flags instead of retyping them every launch.

- **Simulation / offline testing.** `--input-png` swaps a live screenshot
  for a static image; `--test-mode <rm2|rmpp>` plus
  `--test-touch-events-file`, `--test-screenshot-dir`,
  `--test-auto-trigger-delay`, and `--test-interaction-log` let the entire
  touch→screenshot→LLM→draw pipeline run headlessly on a desktop, no
  hardware required. `--no-draw`, `--no-submit`, `--no-loop`, and
  `--no-trigger` combine for fully offline, single-shot runs (used by
  `run_eval.sh`'s evaluation harness).

## Usage

**Paper Pro AppLoad/OpenClaw mode** uses the single-tile and three-mode
workflow documented above. It does not use a provider API key on the tablet.
Set the desired mode in
`/home/root/.config/smart-remarkable/settings.conf`, tap the tile once to
start, and tap it again to stop. With the native buttons, lasso, lift, and tap
the stock **notebook-with-sparkles** icon for WhatsApp plus notebook text or
the stock **sparkles** icon for WhatsApp/agent handling only. Without the
buttons, use the exact hold-before-lift gesture in `session-hold`; `once` and
`session-auto` submit on an ordinary lasso pen-up.

The following commands describe the generic upstream/direct-provider
interface and are not the supported OpenClaw launch path.

**Normal mode**, from an SSH session on the device:

```bash
ANTHROPIC_API_KEY=sk-... ./smart_remarkable
```

1. Write something on the page.
2. Tap the trigger corner (default upper-right; change with
   `--trigger-corner`).
3. The tool screenshots the page, sends it to the LLM, and types or draws
   the answer back onto the screen.

**Select Mode**:

```bash
ANTHROPIC_API_KEY=sk-... ./smart_remarkable --select-mode
```

1. Tap the trigger corner to arm.
2. Tap two opposite corners around the handwritten question (a minimum
   40px box is enforced, so imprecise taps are fine).
3. Tap two opposite corners of where the answer should be drawn.
4. The cropped selection is sent to the LLM; the answer is scaled and drawn
   as pen strokes into the placement box. Move/resize it afterward with
   xochitl's native selection tool.

There's no on-screen guidance between taps — the sequence is always
trigger → 2 selection taps → 2 placement taps. Run with `--log-level debug`
over SSH while you're learning the gesture.

**Experimental upstream LLM button / Draw button**: with the raw
`xovi-ext/llmbutton` installed, lassoing text with xochitl's own selection
tool shows **LLM** and **Draw** buttons beside cut/copy/paste. That native
extension is not the safe Paper Pro integration. The guarded 3.28.0.163
candidate in `xovi-qmd/` adds the stock notebook-with-sparkles and sparkles
actions. The current v2 source launches a bounded descriptor containing mode,
kind, orientation, geometry, and capture time, then uses AppLoad again for the
same-snapshot prepare and close acknowledgements; it never talks to the Rust
process directly. Historical `--selection-button=...` actions remain only for
the pinned installed legacy-QMD transition described above.

**Key CLI flags**

| Flag | Default | Purpose |
|---|---|---|
| `--engine` | auto-guessed from `--model` | Force `openai` / `anthropic` / `google` |
| `-m, --model` | `claude-sonnet-4-6` | Model name |
| `--engine-base-url` | provider default | Override API base URL |
| `--engine-api-key` | from env var | API key |
| `--prompt` | `general.json` | Prompt template (auto-switches to `selection.json` in select mode) |
| `--select-mode` | off | Enable Select Mode |
| `--image-model` | off (`gemini-2.5-flash-image` if passed bare) | Render Draw-button sketches with an image-generation model |
| `--image-api-key` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | API key for the image model |
| `--trigger-corner` | `UR` | `UR`/`UL`/`LR`/`LL`, `four-finger`, `pen-release`, or `pen-hold` |
| `--pen-hold-ms` | `800` | Dwell required at the closed-lasso endpoint in `pen-hold` mode; 400–3000 ms |
| `--pen-hold-radius-px` | `12` | Maximum normalized endpoint movement before the dwell timer resets; 4–48 px |
| `--pen-min-extent-px` | `24` | Minimum normalized maximum path extent eligible for lasso submission; 8–128 px |
| `--apply-segmentation` | off | Add CV-derived spatial hints to the prompt |
| `--web-search` / `--thinking` / `--thinking-tokens` | off / off / `5000` | Anthropic-only extras |
| `--web-server` / `--web-port` | off / `8080` | Live config UI/API |
| `--save-config` | off | Persist resolved config and exit |
| `--log-level` | `info` | `debug`, `trace`, etc. |
| `--input-png`, `--test-mode`, `--test-touch-events-file`, `--test-screenshot-dir`, `--test-auto-trigger-delay` | — | Offline simulation / testing |
| `--no-submit`, `--no-draw`, `--no-loop`, `--no-trigger` | off | Skip pieces of the pipeline for testing |
| `--debug-tap`, `--debug-drag`, `--debug-lasso`, `--debug-type`, `--debug-svg`, `--debug-erase` | — | One-shot device-I/O helpers, exit after running |

**Example commands**

```bash
# Run with Claude, corner trigger on upper-left, verbose logging
ANTHROPIC_API_KEY=sk-... ./smart_remarkable --trigger-corner UL --log-level debug

# Select Mode with a specific Gemini model and the web config UI enabled
GOOGLE_API_KEY=... ./smart_remarkable --select-mode -m gemini-2.5-pro --web-server

# Offline test against a saved screenshot, no drawing, single pass
./smart_remarkable --input-png ./test.png --no-draw --no-loop --no-trigger --no-submit

# Experimental upstream four-finger/Draw path; not the supported Paper Pro
# AppLoad workflow described above
OPENAI_API_KEY=... GEMINI_API_KEY=... ./smart_remarkable --select-mode \
  --trigger-corner four-finger -m gpt-5.4 --image-model
```

## Install

**ReMagic-compatible AppLoad installation for the supported OpenClaw path**

After building the aarch64 binary, the transactional installer packages the
local external app and places it under encrypted `/home`. It requires the
already-provisioned dedicated forwarding-only bridge key and live private
server bridge:

```bash
ops/install-smart-openclaw.sh remarkable-rmpp-new
```

The installer verifies hashes, file modes, stock-UI health, `/dev/uinput`,
and a read-only root filesystem before and after an atomic directory swap.
It also builds a sorted `STAGED-FILES.sha256` over every other regular file in
the bundle, including files sourced from an untracked worktree. The manifest's
own SHA-256 and the exact device-installer SHA-256 travel out of band and are
embedded with the manifest contents in the root-only recovery record
`/home/root/.smart-remarkable-recovery/install-<deployment-id>.provenance`.
That record is synced as `phase=prepared` before either application rename
and atomically becomes `phase=installed` only after the new app and manifest
have been reverified, leaving a useful map even if power is lost mid-swap.
Both installer halves also require the archive's exact path-only member list
before extraction. This makes the archive contents auditable without treating
`git diff` as the source of truth.
It does not rerun the ReMagic/Xovi installer, enable a service at boot, or
install `llmbutton.so`. Automatic uinput kernel-module loading is disabled
unless a developer explicitly opts in with
`SMART_REMARKABLE_ALLOW_UINPUT_MODULE_LOAD=1`; the supported 3.28 launchers
require the firmware-provided `/dev/uinput` and fail otherwise.

The local provenance regression is device-free:

```bash
bash tests/staged-file-manifest-test.sh
bash tests/smart-openclaw-recovery-metadata-test.sh
```

**Toolchain**: Rust `1.92.0` (pinned in `.tool-versions`).

**Build locally**

```bash
cargo build --release
# or
./build.sh local
```

Binary: `target/release/smart_remarkable`.

**Cross-compile with Docker (`cross`)**

```bash
cargo install cross --git https://github.com/cross-rs/cross
rustup target add armv7-unknown-linux-gnueabihf aarch64-unknown-linux-gnu

# reMarkable 2 (armv7)
cross build --release --target=armv7-unknown-linux-gnueabihf
# or: ./build.sh

# Paper Pro (aarch64)
cross build --release --target=aarch64-unknown-linux-gnu
# or: ./build.sh rmpp
```

`build.sh` can also scp the result for you: pass a hostname as the first
argument (default `remarkable`); anything starting with `rmpp` builds/ships
aarch64 to `root@<host>`, anything else builds/ships armv7. E.g.
`./build.sh rmpp-mytablet` or `./build.sh 192.168.1.117`.

**Cross-compile without Docker (macOS, Paper Pro / aarch64 only)**

```bash
brew tap messense/macos-cross-toolchains && brew install aarch64-unknown-linux-gnu
rustup target add aarch64-unknown-linux-gnu
CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-unknown-linux-gnu-gcc \
  cargo build --release --target aarch64-unknown-linux-gnu
```

There's no verified Docker-free path for the reMarkable 2 (armv7) target in
this repo — `.cargo/config.toml` has a commented-out template for a
messense-style `arm-remarkable-linux-gnueabi-gcc` toolchain, but it isn't
filled in or active.

**Deploy via scp**

```bash
scp target/armv7-unknown-linux-gnueabihf/release/smart_remarkable root@<device-ip>:
# or
scp target/aarch64-unknown-linux-gnu/release/smart_remarkable root@<device-ip>:
```

Find the device IP and root password under Settings → Help → About on the
tablet.

**Run on-device**

```bash
ssh root@<device-ip>
ANTHROPIC_API_KEY=sk-... ./smart_remarkable --select-mode
```

- **Developer Mode is required** (Settings → General → Software →
  Advanced). Enabling it factory-resets the device and voids the warranty.
- Run in the background with `nohup ./smart_remarkable &`.
- **Paper Pro uinput note**: the bundled uinput kernel module auto-loads and
  is prebuilt for OS versions 3.16–3.18 and 3.22 (`utils/rmpp/uinput-3.16.ko`,
  `-3.17.ko`, `-3.18.ko`, `-3.22.ko`). Other OS versions may need a rebuilt
  module — see `utils/rmpp/`.

## LLM API Keys

Set whichever provider's key you plan to use as an environment variable, or
drop them in a local `.env` file (loaded via `dotenv`):

```bash
export OPENAI_API_KEY=your-key-here
export ANTHROPIC_API_KEY=your-key-here
export GOOGLE_API_KEY=your-key-here
export GEMINI_API_KEY=your-key-here   # image generation (--image-model); GOOGLE_API_KEY also works
```

Note: image generation is not in the Gemini free tier — the key's Google AI
Studio project needs billing enabled (`gemini-2.5-flash-image` is ~$0.04 per
image).

- `--engine` picks the backend explicitly (`openai`, `anthropic`,
  `google`). If omitted, it's guessed from the `--model` name's prefix
  (`gpt*` → openai, `claude*` → anthropic, `gemini*` → google); if it can't
  guess, it errors and asks you to pass `--engine`.
- `--engine-api-key` / `--engine-base-url` override the corresponding
  provider env var (`OPENAI_API_KEY`/`OPENAI_BASE_URL`,
  `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`,
  `GOOGLE_API_KEY`/`GOOGLE_BASE_URL`). If neither the CLI flag nor the env
  var is set for the API key, the process will panic — there's no fallback.
  Base URLs do have hardcoded fallbacks (`api.openai.com`,
  `api.anthropic.com`, `generativelanguage.googleapis.com`).
- **Default model**: `claude-sonnet-4-6`, which auto-resolves to the
  `anthropic` engine when `--engine` isn't specified.

## Architecture

**Data flow**: admitted trigger → selected framebuffer crop → OpenClaw/LLM →
draw/type → cleanup and optional rearm.

1. **Trigger** (`touch.rs`, `coordinator::trigger_task`) — waits on
   `/dev/input/eventN` for a corner release, four-finger gesture, eligible
   lasso pen-up, or held-lasso pen-up. It also atomically consumes root-only
   `/run/smart-remarkable/llm_button_trigger` and
   `/run/smart-remarkable/draw_button_trigger`. Which source fired is tracked
   in `touch::TriggerSource`; an atomic admission gate and channel capacity
   of one prevent overlapping or surprise queued requests. Native selection
   triggers reuse xochitl's active marquee; manual Select Mode can still
   collect its two selection and two placement corners.
2. **Capture** (`screenshot.rs`) — reads `xochitl`'s framebuffer directly
   out of `/proc/<pid>/mem`, decodes/rotates/color-corrects it into a
   normalized 768×1024 PNG; can detect the native selection marquee via
   connected-component analysis.
3. **Coordinate** (`coordinator.rs`) — an async pipeline of `tokio` tasks
   (`trigger_task` → `processing_task` → `progress_task`) joined by
   `mpsc`/`watch` channels. `processing_task` optionally crops to the
   selection rect, optionally runs `segmenter.rs`, loads the JSON prompt
   template, and hands the base64 image + prompt to the LLM engine.
   It suppresses repeated pen submission of the same still-active selection,
   clears request image/model/tool scratch state after every path, and rearms
   only after cleanup. The supported OpenClaw wrapper disables the
   `progress_task` text animation.
4. **LLM call** (`src/llm_engine/`) — a shared `LLMEngine` trait
   abstracts over `openai.rs`, `anthropic.rs`, `google.rs`. Each builds a
   provider-specific tool-forcing request and invokes the callback for
   whichever tool the model calls: `draw_text`, `draw_svg`, `draw_answer`
   (structured line-based layout for Select Mode), or `draw_sketch` (Draw
   button — reports `selection_is_drawing` to pick doodle-below-selection
   vs. erase-and-redraw-in-place).
5. **Draw** (`pen.rs`, `keyboard.rs`) — `pen.rs` parses SVG via
   `resvg`/`usvg` (text-to-path) and `svg2polylines` (tracing), converting
   it into virtual pen strokes injected as raw `evdev` events; `skeleton.rs`
   offers an alternative centerline-tracing render path via Zhang-Suen
   thinning. For in-place redraws, `Pen::erase_rect` first sweeps
   `BTN_TOOL_RUBBER` (real eraser-tip hardware signal) passes across the
   box — xochitl ignores normal pen strokes as erasing regardless of the
   selected toolbar tool. `keyboard.rs` drives a `uinput` virtual keyboard
   to type text and the progress-dot animation.

**Key modules**

| Module | Responsibility |
|---|---|
| `main.rs` | CLI entry point, config/engine wiring, tool registration, restart-on-config-change loop, `--debug-*` one-shot helpers |
| `coordinator.rs` | Async task graph: trigger detection, no-selection re-arming, progress reporting, screenshot→LLM→tool pipeline |
| `touch.rs` | Raw touch/evdev reading, corner/four-finger/pen-release/pen-hold trigger detection, `/run` button signaling, coordinate mapping, gesture helpers |
| `screenshot.rs` | Framebuffer capture, decode, selection-marquee detection, cropping |
| `pen.rs` | Virtual pen (`evdev`/uinput): SVG/bitmap rendering strategies |
| `keyboard.rs` | Virtual keyboard (`evdev`/uinput): text typing, progress-dot animation |
| `device.rs` | `DeviceModel` detection (RM2 / Paper Pro) and per-device constants |
| `segmenter.rs` | Contour-based region detection for spatial grounding |
| `skeleton.rs` | Zhang-Suen thinning / centerline tracing |
| `util.rs` | SVG↔bitmap rasterization, fit-to-rect logic, uinput setup |
| `llm_engine/` | `LLMEngine` trait + `openai.rs`/`anthropic.rs`/`google.rs` |
| `image_gen.rs` | Gemini image-generation client for `--image-model` (nano banana) |
| `config.rs` | Layered config via `figment`/`toml`, hot-reload watch channel |
| `cancellation.rs` | Cooperative cancellation tokens |
| `status.rs` | Shared status snapshot for the web UI |
| `web_server.rs` + `src/web/` | Optional `warp` HTTP server + static config UI |
| `simulation/` | Desktop stand-ins for touch/screenshot hardware, interaction logging |
| `src/bin/experiment.rs` | Secondary binary for ad-hoc experimentation |
| `embedded_assets.rs` | Bundles `prompts/*.json` into the compiled binary via `rust-embed` |

**Stack**: Rust + `tokio` async task graph; `clap` for CLI; `reqwest`/`ureq`
for LLM HTTP calls; `resvg`/`usvg`/`svg2polylines` for SVG-to-stroke
rendering; `evdev`/`uinput` for virtual touch/pen/keyboard devices;
`figment`/`toml` for layered config; `warp` for the optional web UI;
`cross`-rs (Docker) or the messense toolchain for cross-compilation to
armv7/aarch64; a `prompts/*.json` system (`general.json`, `selection.json`,
plus one `tool_*.json` schema per registered tool) that drives LLM
tool-calling across all three provider backends.

The upstream **LLM/Draw button** extension (`xovi-ext/llmbutton`) is a
separate C shared object that resolves private Qt6 symbols with `dlsym` and
walks the live QtQuick scene graph. It is retained only as upstream source
and is not compatible with the guarded Paper Pro path.

The Paper Pro candidate instead uses firmware-specific QMLDiff artifacts in
`xovi-qmd/`. The functional patch inserts two
`ArkControls.ContextualMenu.Button` objects into the exact
`SceneSelectionHandler.qml` resource and dynamically asks AppLoad to launch
a strict v2 selection descriptor. AppLoad owns worker startup, adds the random
nonce, publishes the root-only busy/trigger generation, and relays exact
prepare/close acknowledgements. The listener advertises local capture
readiness independently from the runner's remote bridge-ready marker. QML has
no credential, network, or model access. The v2 source rehashes to the pinned
compiled candidate, and that candidate composes successfully with the seven
exact co-resident QMDs. The old installed compiled QMD still uses
transition-only `--selection-button=...` calls; the reviewed v2 candidate must
still pass inert and functional device canaries plus physical acceptance before
it replaces that artifact. A separate disabled-button patch remains the first
visual canary, and activation still requires fresh live hashes plus a bounded
rollback transaction.

## License

MIT — see [LICENSE](LICENSE). The release binary also embeds a GPL-2.0
kernel module; see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## Credits

Forked from [awwaiid/ghostwriter](https://github.com/awwaiid/ghostwriter).

References this project has drawn from:
* [Awesome reMarkable](https://github.com/reHackable/awesome-reMarkable)
* Screen capture adapted from [reSnap](https://github.com/cloudsftp/reSnap)
* Screen-drawing technique inspired by [rmkit lamp](https://github.com/rmkit-dev/rmkit/blob/master/src/lamp/main.cpy)
* SVG-to-PNG via [resvg](https://github.com/RazrFalcon/resvg)
* Virtual keyboard input via [rM-input-devices](https://github.com/pl-semiotics/rM-input-devices)
