# Design

Smart Remarkable is a user-space assistant that leaves reMarkable's stock `xochitl` process running. It reads the current framebuffer from `xochitl`, sends a normalized screenshot to a selected vision model, and returns the result through virtual pen, touch, or keyboard devices backed by the kernel's existing `/dev/uinput` support.

## Runtime flow

The supported Paper Pro 3.28 workflow is deliberately one-shot:

1. The user lassos handwriting with the stock selection tool.
2. `scripts/run-selected-once.sh` starts Smart Remarkable and writes `/tmp/llm_button_trigger` after startup.
3. The touch loop consumes the trigger file before waiting for another hardware event, then the trigger task identifies the source as `LlmButton` and skips manual rectangle collection.
4. Screenshot processing detects the active native selection marquee and computes a placement box below it.
5. The selected crop is sent to OpenAI, and the answer is rendered as simulated pen strokes.
6. `--no-loop` makes the process exit after the response.

There is no Xovi injection, boot service, display takeover, or custom kernel module in this deployment.

## Validated deployment

The patched aarch64 binary and `scripts/run-selected-once.sh` are installed under `/home/root/smart_remarkable`. A live Paper Pro 3.28 test detected the stock lasso marquee, cropped only the selected handwriting, called OpenAI once, rendered the answer below the selection as pen strokes, and exited. The stock UI stayed active with zero restarts and the system partition remained read-only.

## Modules

- `src/main.rs`: parses CLI/configuration, creates the provider and device objects, registers drawing tools, and coordinates the application lifecycle.
- `src/coordinator.rs`: runs the trigger, screenshot, model, progress, and tool-execution pipeline. It distinguishes manual touch selection from native button-file selection.
- `src/touch.rs`: reads real touch events, detects corner/four-finger gestures, consumes button trigger files, and emits simulated touch input when a tool needs it.
- `src/screenshot.rs`: locates `xochitl`'s framebuffer mapping, reads it without modifying process memory, normalizes it to 768x1024, and detects native selection marquees.
- `src/pen.rs` and `src/keyboard.rs`: create temporary uinput devices and translate model output into pen strokes or keyboard events.
- `src/llm_engine/`: implements OpenAI, Anthropic, and Google providers behind the common `LLMEngine` interface.
- `src/config.rs` and `prompts/`: merge runtime configuration and define provider/tool instructions.
- `scripts/run-selected-once.sh`: provides the constrained Paper Pro launcher used for this deployment.

## Main functions

- `main` in `src/main.rs`: loads environment/configuration, handles diagnostics, and enters the Smart Remarkable orchestration loop.
- `trigger_task` in `src/coordinator.rs`: waits for a trigger and emits either a manual `UserSelection` or a source-aware `UserTouch` event.
- `should_collect_selection_taps` in `src/coordinator.rs`: permits four-corner collection only for real physical touch triggers; native LLM/Draw trigger files reuse the active stock selection.
- `processing_task` in `src/coordinator.rs`: captures/crops the screenshot, selects a prompt, calls the model, and executes the returned drawing tool.
- `Touch::wait_for_trigger` in `src/touch.rs`: returns after a physical gesture or trigger file and records which source fired.
- `take_button_trigger` in `src/touch.rs`: atomically consumes an LLM/Draw trigger file before the next hardware-event wait, preventing busy touch streams from starving one-shot activation.
- `Screenshot::take_screenshot` in `src/screenshot.rs`: reads and normalizes the live stock-UI framebuffer.
- `setup_uinput` in `src/util.rs`: reuses `/dev/uinput` when present and therefore skips bundled module loading on firmware 3.28.
