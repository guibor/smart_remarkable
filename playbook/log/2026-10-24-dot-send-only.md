# Pro notebook selection -> Dot (send-only)

User request: finish notebook lasso sending and install on Pro, explicitly keep
answer-writing disabled. Current firmware branch is retained; Move is untouched.

## Implementation

- Native lasso paper-plane sends ink/image/mixed selections through v3 snapshot,
  prepare/capture/close acknowledgements, same-frame page context and stable
  notebook/page identity. Full single-view portrait/180-degree viewport only.
- No Dot answer tool is registered. UI hides the writing action; launcher,
  coordinator and transport independently reject write-back.
- Exact framebuffer-spy row capture fixes the legacy 1632x2154 assumption:
  current Ferrari is 1620x2160 RGB32, stride6528. `/proc/PID/mem` is read-only.
- Existing Dot app pairing supplies private `.dot.env`. Existing OpenClaw `.env`
  and interaction settings remain byte-identical; the empty private working
  directory avoids dotenv loading the old provider environment.
- A volatile content-free receipt drives the shared passive Sent to Dot toast.
  Ambiguous failure says not confirmed, not sent. Automatic retries reuse the
  same immutable request ID/body. No pen/text writer or notebook-file mutation.

## Qualification

116 Rust library tests, strict config parser, two-button protocol, actual QMD
JS geometry/send-only tests, both current13QMD composition orders and three Qt
receipt cases pass. Qt confirms bounded toast geometry and input pass-through.
The Pro read-only capture probe produced a correctly aligned1620x2160 image.
Installed worker start/ready/stop passed without selection or input. An
authenticated invalid-envelope request returnedHTTP400 without creating a job.
All16preexisting settings and unrelated base QMDs match the earlier receipt.

## Exact artifacts and recovery

- Binary: `ce04b1d8a6fcc02bc53a49ed2ad42a876cd76dd9803ed71e968d7a61d658fe6d`.
- Smart QMD: `8420dfe198f15d82765eaf3370298f03f5d4da91bf277c824c135e71ba2051a1`.
- Final helper manifest: `fc5a939be4ec11adda8f49e17a340d672dcbe68037d31ce4adc7a8aa51f555cb`.
- App preimage: `9c02d5b91ecd59bb6cd1a916f24651460127a7042c84a451ce5b258e9d58c9ed`.
- Native transaction: `20261024T204500Z-2`.
- Native manifest: `db51675f72c8cdd245e6ec7749d22b1640248b79f4fe8e40295d186873123d3b`.
- Native preimage: `f7a19a98b9580870b7b7c767076dd513b87057c3777dbecead11746301cda027`.

Both archives were copied to the Mac and passed SHA256/gzip/tar checks. The
first prepared native stage204000was never activated; the204500stage includes
the corrected toast layout. Its older prepared backup is history, not current.
The195100owner recovered via its own stop/watchdog to base744092 before app
publication. Native DSOs and combined PDF/Restyle/WebPDF overlay are unchanged.
Final live runtime: UI749060, Dates5396, owner747555/watchdog748590, all active
with zero restarts. Thirteen runtimeQMDs and all three native maps verified;
notebook/PDF Dot, WebPDF and Companion host readiness passed, no matching QML
errors, rootRO. The final-owner read-only capture also passed. Physical
notebook lasso/actual Dot answer acceptance is separate from these machine checks.
