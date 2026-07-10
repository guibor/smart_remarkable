# Design

Smart Remarkable is a user-space assistant that leaves reMarkable's stock `xochitl` process running. It reads the current framebuffer from `xochitl`, sends a normalized screenshot to the user's OpenClaw agent, and returns the result through virtual pen, touch, or keyboard devices backed by the kernel's existing `/dev/uinput` support.

## Runtime flow

The supported Paper Pro 3.28 workflow is deliberately one-shot:

1. The user lassos handwriting with the stock selection tool.
2. `scripts/run-selected-once.sh` starts Smart Remarkable and writes `/tmp/llm_button_trigger` after startup.
3. The touch loop consumes the trigger file before waiting for another hardware event, then the trigger task identifies the source as `LlmButton` and skips manual rectangle collection.
4. Screenshot processing detects the active native selection marquee and computes a placement box below it.
5. The launcher opens a forwarding-only SSH tunnel to the private OpenClaw Gateway and sends the selected crop to its OpenAI-compatible endpoint as an `openclaw/default` agent turn using `selection_openclaw.json`.
6. The OpenClaw transport accepts the agent's ordinary final text and invokes the local `draw_text` callback; it does not require OpenClaw to call a tablet-specific client tool.
7. `draw_text` selects reMarkable's stock text tool, taps the computed placement rectangle, applies body style, and types ordinary text through the virtual keyboard.
8. `--no-loop` makes the process exit after the response, and the launcher trap removes the trigger and terminates both its trigger helper and SSH tunnel.

There is no direct provider API call, publicly exposed OpenClaw operator endpoint, Xovi injection, boot service, display takeover, or custom kernel module in this deployment. The tunnel and Smart Remarkable process both exist only for one invocation.

## Validated deployment

The patched aarch64 binary, `selection_openclaw.json`, forwarding launcher, and mode-600 gateway credential are installed under `/home/root/smart_remarkable`. The direct provider credential is absent. A live Paper Pro 3.28 test detected the stock lasso marquee, cropped only the selected handwriting, routed it through the private tunnel to the dedicated `smart-remarkable-rmpp` OpenClaw session, received `10`, dispatched that final text to `draw_text`, and exited. The disposable page already contained an older native text object under the selection, so reMarkable appended the result to that editable object; the earlier clean-page test verified creation of a new stock text object. No simulated answer pen strokes ran. The tunnel, trigger, and Smart Remarkable process were removed; the stock UI stayed active with zero restarts and the system partition remained read-only.

The OpenClaw Gateway remains loopback-only. Its Chat Completions endpoint is enabled behind gateway authentication, the tablet key is restricted to forwarding that single port with no shell, and the deployed watchdog waits through the gateway's 90-second startup window. A no-draw tablet test of the exact tunnel and dedicated-session route returned `10` in eight seconds before the live UI test.

## Modules

- `src/main.rs`: parses CLI/configuration, creates the provider and device objects, registers drawing tools, and coordinates the application lifecycle.
- `src/coordinator.rs`: runs the trigger, screenshot, model, progress, and tool-execution pipeline. It distinguishes manual touch selection from native button-file selection.
- `src/touch.rs`: reads real touch events, detects corner/four-finger gestures, consumes button trigger files, and emits simulated touch input when a tool needs it.
- `src/screenshot.rs`: locates `xochitl`'s framebuffer mapping, reads it without modifying process memory, normalizes it to 768x1024, and detects native selection marquees.
- `src/pen.rs` and `src/keyboard.rs`: create temporary uinput devices and translate model output into pen strokes or keyboard events.
- `src/llm_engine/`: implements OpenClaw, OpenAI, Anthropic, and Google transports behind the common `LLMEngine` interface.
- `src/llm_engine/openai.rs`: provides both the direct OpenAI tool-call transport and an OpenClaw mode. OpenClaw mode authenticates with `OPENCLAW_GATEWAY_TOKEN`, routes requests to the dedicated `smart-remarkable-rmpp` session rather than OpenClaw's busy default conversation, enforces connect/turn timeouts, omits client-tool forcing, extracts final response text, and dispatches it to the registered `draw_text` callback.
- `src/config.rs` and `prompts/`: merge runtime configuration and define provider/tool instructions. `selection_openclaw.json` asks OpenClaw for concise plain text that is safe to type into a stock text box; `selection_print.json` remains the direct-provider print prompt.
- `scripts/run-selected-once.sh`: provides the constrained Paper Pro launcher. It starts and health-checks a restricted SSH port forward, triggers one native selection request, and cleans up both helper processes on every exit path.
- `ops/openclaw-gateway-watchdog.sh`: keeps the private gateway available without restarting it during its plugin-heavy startup. It honors a 90-second startup grace and, after a genuine unhealthy state, waits for readiness after restart instead of assuming the port opens in ten seconds.

## Main functions

- `main` in `src/main.rs`: loads environment/configuration, handles diagnostics, and enters the Smart Remarkable orchestration loop.
- `create_engine` in `src/main.rs`: selects the provider transport; `openclaw` uses the OpenAI-compatible wire format but final-text response handling and OpenClaw-specific environment variables.
- `OpenAI::new_openclaw` in `src/llm_engine/openai.rs`: creates the private-gateway transport using `OPENCLAW_BASE_URL`/`OPENCLAW_GATEWAY_TOKEN` and enables final-text dispatch.
- `trigger_task` in `src/coordinator.rs`: waits for a trigger and emits either a manual `UserSelection` or a source-aware `UserTouch` event.
- `should_collect_selection_taps` in `src/coordinator.rs`: permits four-corner collection only for real physical touch triggers; native LLM/Draw trigger files reuse the active stock selection.
- `processing_task` in `src/coordinator.rs`: captures/crops the screenshot, selects a prompt, calls the model, and executes the returned drawing tool.
- `Touch::wait_for_trigger` in `src/touch.rs`: returns after a physical gesture or trigger file and records which source fired.
- `take_button_trigger` in `src/touch.rs`: atomically consumes an LLM/Draw trigger file before the next hardware-event wait, preventing busy touch streams from starving one-shot activation.
- `Screenshot::take_screenshot` in `src/screenshot.rs`: reads and normalizes the live stock-UI framebuffer.
- `setup_uinput` in `src/util.rs`: reuses `/dev/uinput` when present and therefore skips bundled module loading on firmware 3.28.
