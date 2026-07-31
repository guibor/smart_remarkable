#!/bin/sh
set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
QML="$REPO/xovi-qmd/llm-button-3.28.0.164.source.qmd"
LEGACY_INVOCATION="$REPO/tests/fixtures/legacy-installed-button-invocation.txt"
INERT="$REPO/xovi-qmd/llm-button-inert-3.28.0.164.source.qmd"
LAUNCHER="$REPO/remagic/appload-launch.sh"
RUNNER="$REPO/scripts/run-armed-once.sh"
PROTOCOL="$REPO/scripts/selection-protocol.sh"
TOUCH="$REPO/src/touch.rs"
COORDINATOR="$REPO/src/coordinator.rs"
MAIN="$REPO/src/main.rs"

write_back_line=$(grep -n 'iconSource: "qrc:/ark/icons/notebook_sparkles"' "$QML" | cut -d: -f1)
agent_line=$(grep -n 'iconSource: "qrc:/icons/sparkles.svg"' "$QML" | cut -d: -f1)
test -n "$write_back_line"
test -n "$agent_line"
test "$write_back_line" -lt "$agent_line"
test "$(grep -c 'iconSource: "qrc:/ark/icons/notebook_sparkles"' "$INERT")" -eq 1
test "$(grep -c 'iconSource: "qrc:/icons/sparkles.svg"' "$INERT")" -eq 1

# Both buttons share one pending state and one launcher implementation.
test "$(grep -c 'property string pendingMode: ""' "$QML")" -eq 1
test "$(grep -c 'property string pendingSnapshot: ""' "$QML")" -eq 1
test "$(grep -c 'property bool pendingPrepared: false' "$QML")" -eq 1
test "$(grep -c 'function clearPendingMode()' "$QML")" -eq 1
test "$(grep -c 'function requestMode(mode)' "$QML")" -eq 1
test "$(grep -c 'function captureSnapshot()' "$QML")" -eq 1
! grep -F 'function captureDescriptor(mode)' "$QML" >/dev/null
test "$(grep -c 'sequence: "Ctrl+Alt+Shift+7"' "$QML")" -eq 1
test "$(grep -c 'sequence: "Ctrl+Alt+Shift+8"' "$QML")" -eq 1
test "$(grep -c 'sequence: "Ctrl+Alt+Shift+9"' "$QML")" -eq 1
test "$(grep -c 'AppLoadLibrary {' "$QML")" -eq 1
grep -F 'return launchExternal("external::smart-remarkable", -1, [argument], ({}))' \
    "$QML" >/dev/null
grep -F 'if (pid > 0) {' "$QML" >/dev/null
! grep -F 'AppLoadLauncher' "$QML" >/dev/null
test "$(grep -c 'property: "controlsAreVisible"' "$QML")" -eq 1
test "$(grep -c 'restoreMode: Binding.RestoreBindingOrValue' "$QML")" -eq 1
! grep -E 'target: selection[[:space:]]*$' "$QML" >/dev/null
grep -F 'selectionRoot.controlsAreVisible !== false' "$QML" >/dev/null
grep -F 'selectionRoot.close()' "$QML" >/dev/null
test "$(grep -c 'id: smartRemarkablePendingReset' "$QML")" -eq 1
grep -F 'interval: 45000' "$QML" >/dev/null
grep -F 'smartRemarkablePendingReset.restart()' "$QML" >/dev/null
test "$(grep -c 'Qt.callLater(function() {' "$QML")" -eq 3
grep -F '// Let the stock selected state paint before AppLoad' "$QML" >/dev/null
grep -F 'pendingMode !== mode ||' "$QML" >/dev/null
grep -F 'pendingSnapshot !== snapshot ||' "$QML" >/dev/null
grep -F 'onTriggered: smartRemarkableLlmButton.clearPendingMode()' "$QML" >/dev/null
grep -F 'onClicked: requestMode("write_back")' "$QML" >/dev/null
grep -F 'onClicked: smartRemarkableLlmButton.requestMode(' "$QML" >/dev/null
grep -F '"whatsapp_only")' "$QML" >/dev/null
grep -F '"--selection-button-descriptor=" +' "$QML" >/dev/null
grep -F 'descriptor)) {' "$QML" >/dev/null
grep -F '"--selection-prepare-ack=" + snapshot' "$QML" >/dev/null
grep -F '"--selection-close-ack=" + snapshot' "$QML" >/dev/null
test "$(grep -c 'selection.mapToItem' "$QML")" -eq 4
test "$(grep -c 'selectionRoot.mapToGlobal' "$QML")" -eq 3
# Axis dominance alone would admit a modest shear. Pin the sub-pixel
# off-diagonal rejection and uniform finite scale checks used before QML labels
# a view normal or rot180.
grep -F 'var offAxisTolerance = 0.5' "$QML" >/dev/null
grep -F 'var xScale = Math.abs(xDx) / selectionRoot.width' "$QML" >/dev/null
grep -F 'var yScale = Math.abs(yDy) / selectionRoot.height' "$QML" >/dev/null
grep -F '!isFinite(xScale) || !isFinite(yScale)' "$QML" >/dev/null
grep -F 'Math.abs(xDy) > offAxisTolerance' "$QML" >/dev/null
grep -F 'Math.abs(yDx) > offAxisTolerance' "$QML" >/dev/null
grep -F 'Math.abs(xScale - yScale) >' "$QML" >/dev/null
! grep -F 'Math.abs(xDx) <= Math.abs(xDy)' "$QML" >/dev/null
test "$(grep -c 'controller.selectionContainsStroke' "$QML")" -eq 1
test "$(grep -c 'controller.selectionContainsImage' "$QML")" -eq 1
test "$(grep -c 'Math.floor(Date.now())' "$QML")" -eq 1
grep -F 'return "v2," + kind + "," + orientation + "," +' "$QML" >/dev/null

# The guarded visual canary exposes both positions but has no action.
test "$(grep -c 'enabled: false' "$INERT")" -eq 2
! grep -F 'AppLoadLauncher' "$INERT" >/dev/null
! grep -F 'pendingMode' "$INERT" >/dev/null

# AppLoad accepts only a versioned selection descriptor, maps its mode to a
# distinct volatile marker, and atomically publishes root-only payload bytes.
grep -F -- '--selection-button-descriptor=*)' "$LAUNCHER" >/dev/null
grep -F 'smart_parse_selection_request' "$LAUNCHER" >/dev/null
# The installed 2b9188 QMD still calls these spellings. The app-first update
# must accept them as a separately tagged random legacy generation until the
# v2 QMD is independently composed and promoted.
grep -F -- '--selection-button=write_back)' "$LAUNCHER" >/dev/null
grep -F -- '--selection-button=whatsapp_only)' "$LAUNCHER" >/dev/null
test "$(sed -n 's/^installed_qmd_sha256=//p' "$LEGACY_INVOCATION")" = \
    '2b9188af0c3fd726743e36ee1a3c86244cf6327ad22eeef1aa7a291a7add059d'
grep -Fx -- '--selection-button=write_back' "$LEGACY_INVOCATION" >/dev/null
grep -Fx -- '--selection-button=whatsapp_only' "$LEGACY_INVOCATION" >/dev/null
grep -F 'selection_descriptor="legacy-v1,$SMART_SELECTION_NONCE,$SMART_SELECTION_CAPTURED_MS"' \
    "$LAUNCHER" >/dev/null
grep -F 'WRITE_BACK_TRIGGER="$STATE_DIR/llm_button_trigger"' "$LAUNCHER" >/dev/null
grep -F 'WHATSAPP_ONLY_TRIGGER="$STATE_DIR/send_button_trigger"' "$LAUNCHER" >/dev/null
grep -F 'BUSY_FILE="$STATE_DIR/busy"' "$LAUNCHER" >/dev/null
grep -F 'clear_stale_local_ready_before_start()' "$LAUNCHER" >/dev/null
clear_ready_line=$(grep -n '^clear_stale_local_ready_before_start$' "$LAUNCHER" | cut -d: -f1)
systemd_run_line=$(grep -n '^systemd-run \\$' "$LAUNCHER" | cut -d: -f1)
test -n "$clear_ready_line"
test -n "$systemd_run_line"
test "$clear_ready_line" -lt "$systemd_run_line"
grep -F 'PREPARE_ACK_FILE="$STATE_DIR/selection_prepare_ack"' "$LAUNCHER" >/dev/null
grep -F 'CLOSE_ACK_FILE="$STATE_DIR/selection_close_ack"' "$LAUNCHER" >/dev/null
grep -F 'smart_generate_selection_nonce' "$LAUNCHER" >/dev/null
grep -F 'publish_root_marker "$selection_descriptor" "$BUSY_FILE"' "$LAUNCHER" >/dev/null
grep -F 'publish_root_marker "$SMART_SELECTION_ACK" "$ack_target"' "$LAUNCHER" >/dev/null
grep -F 'chmod 0600 "$marker_tmp"' "$LAUNCHER" >/dev/null
grep -F 'chown 0:0 "$marker_tmp"' "$LAUNCHER" >/dev/null
grep -F 'ln "$marker_tmp" "$marker_target"' "$LAUNCHER" >/dev/null
! grep -F 'bridge_is_healthy' "$LAUNCHER" >/dev/null
! grep -F '127.0.0.1:18791/health' "$LAUNCHER" >/dev/null
! grep -F '$STATE_DIR/bridge-ready' "$LAUNCHER" >/dev/null
! grep -F '$STATE_DIR/bridge-failed' "$LAUNCHER" >/dev/null
! grep -F 'wget' "$LAUNCHER" >/dev/null
grep -F 'if [ -f "$STATE_DIR/ready" ]; then' "$LAUNCHER" >/dev/null
grep -F 'systemctl stop "$UNIT"' "$LAUNCHER" >/dev/null
grep -F 'wait -n -p EXITED_PID "$TUNNEL_PID" "$WORKER_PID"' "$RUNNER" >/dev/null
grep -F 'if [ "$EXITED_PID" = "$TUNNEL_PID" ]; then' "$RUNNER" >/dev/null
grep -F 'publish_bridge_marker bridge-ready' "$RUNNER" >/dev/null
grep -F 'publish_bridge_marker bridge-failed' "$RUNNER" >/dev/null
worker_line=$(grep -n '    ./smart_remarkable' "$RUNNER" | head -1 | cut -d: -f1)
tunnel_line=$(grep -n '    /usr/bin/ssh' "$RUNNER" | head -1 | cut -d: -f1)
health_line=$(grep -n '    wget -q -T 2 -O /dev/null' "$RUNNER" | head -1 | cut -d: -f1)
test -n "$worker_line"
test -n "$tunnel_line"
test -n "$health_line"
test "$worker_line" -lt "$tunnel_line"
test "$tunnel_line" -lt "$health_line"
grep -F 'std::fs::write(RUNTIME_READY_FILE, [])?' "$TOUCH" >/dev/null

# Deterministic structural latency coverage: prepare acknowledgement, forced-
# orientation capture, and close acknowledgement all precede the first remote
# readiness wait. Together with the launcher/runner assertions above, the
# visible selection handoff cannot be gated on tunnel startup or health.
prepare_line=$(grep -n 'wait_for_selection_acknowledgement(descriptor, SelectionAckPhase::Prepared' \
    "$COORDINATOR" | head -1 | cut -d: -f1)
capture_line=$(grep -n 'screenshot.take_screenshot_with_orientation(descriptor.orientation)' \
    "$COORDINATOR" | head -1 | cut -d: -f1)
close_line=$(grep -n 'wait_for_selection_acknowledgement(descriptor, SelectionAckPhase::Closed' \
    "$COORDINATOR" | head -1 | cut -d: -f1)
remote_line=$(grep -n 'wait_for_bridge_ready(&cancellation).await?' \
    "$COORDINATOR" | head -1 | cut -d: -f1)
test -n "$prepare_line"
test -n "$capture_line"
test -n "$close_line"
test -n "$remote_line"
test "$prepare_line" -lt "$capture_line"
test "$capture_line" -lt "$close_line"
test "$close_line" -lt "$remote_line"

# Delayed write-back opens its hardware observer after Smart's own physical-
# evdev placement injection, then queries current kernel contact state before
# the verification screenshot or first key. A deliberately narrow caret mask
# binds placement to the requested point.
monitor_line=$(grep -n 'let mut input_monitor = WriteBackInputMonitor::start()?' \
    "$MAIN" | head -1 | cut -d: -f1)
text_tool_line=$(grep -n 'touch.select_text_tool_with_orientation' \
    "$MAIN" | head -1 | cut -d: -f1)
placement_line=$(grep -n 'touch.tap(tap_point).await?' \
    "$MAIN" | head -1 | cut -d: -f1)
test -n "$monitor_line"
test -n "$text_tool_line"
test -n "$placement_line"
test "$text_tool_line" -lt "$placement_line"
test "$placement_line" -lt "$monitor_line"
grep -F 'let cursor_left = (tap_x - 4).max(left);' "$MAIN" >/dev/null
grep -F 'let cursor_right = (tap_x + 12).min(right);' "$MAIN" >/dev/null
grep -F 'device.get_key_state()?' "$TOUCH" >/dev/null
grep -F 'Self::read_multitouch_tracking_ids(device, slot_count)?' "$TOUCH" >/dev/null
grep -F 'libc::ioctl(device.as_raw_fd(), request, query.as_mut_ptr())' "$TOUCH" >/dev/null
grep -F 'keyboard.key_cmd_body_guarded(|| input_monitor.interaction_detected())?' "$MAIN" >/dev/null
grep -F 'WriteBackGuardState::Unrestricted | WriteBackGuardState::Required =>' "$MAIN" >/dev/null
grep -F 'prepared_write_back_baseline = match screenshot.normalized_view()' "$COORDINATOR" >/dev/null
grep -F 'self.ensure_palette_closed_with_orientation(orientation).await' "$TOUCH" >/dev/null

# Stale marker cleanup may happen early, but ready is published only after
# fallible engine/tool setup and immediately before the listener owns its RAII
# guard.
clear_state_line=$(grep -n 'clear_stale_trigger_state();' "$MAIN" | head -1 | cut -d: -f1)
register_tools_line=$(grep -n '^    register_tools(' "$MAIN" | head -1 | cut -d: -f1)
publish_ready_line=$(grep -n 'publish_trigger_readiness()?' "$MAIN" | head -1 | cut -d: -f1)
spawn_listener_line=$(grep -n 'let mut trigger_handle = {' "$MAIN" | head -1 | cut -d: -f1)
test "$clear_state_line" -lt "$register_tools_line"
test "$register_tools_line" -lt "$publish_ready_line"
test "$publish_ready_line" -lt "$spawn_listener_line"
grep -F 'OPENCLAW_BRIDGE_TOKEN' "$REPO/src/llm_engine/openai.rs" >/dev/null
grep -F 'OPENCLAW_BRIDGE_BASE_URL' "$REPO/src/llm_engine/openai.rs" >/dev/null
! grep -F 'OPENCLAW_GATEWAY_TOKEN' "$REPO/src/llm_engine/openai.rs" >/dev/null
grep -F '"x-smart-remarkable-selection-kind"' \
    "$REPO/src/llm_engine/openai.rs" >/dev/null

# Both client prompts are kind-neutral transport framing. Capture authority and
# intent come only from the authenticated server hook.
python3 -m json.tool \
    "$REPO/prompts/selection_openclaw.json" >/dev/null
python3 -m json.tool \
    "$REPO/prompts/selection_openclaw_whatsapp.json" >/dev/null
for prompt in \
    "$REPO/prompts/selection_openclaw.json" \
    "$REPO/prompts/selection_openclaw_whatsapp.json"
do
    grep -F 'client framing is transport context only' "$prompt" >/dev/null
    grep -F 'does not classify the crop' "$prompt" >/dev/null
    ! grep -F 'Treat the handwriting as the user'\''s request' "$prompt" >/dev/null
    ! grep -F 'ordinary message from this user' "$prompt" >/dev/null
done

# Every shell entry point is syntactically valid.
python3 -m json.tool "$REPO/remagic/external.manifest.json" >/dev/null
sh -n "$LAUNCHER"
sh -n "$RUNNER"
sh -n "$PROTOCOL"
sh -n "$REPO/scripts/run-selected-once.sh"

# Pure protocol parsing and kernel nonce generation are executable off-device.
# The acknowledgement snapshot deliberately omits the nonce; the root-only
# launcher binds it to exactly one active nonce-bearing busy descriptor.
. "$PROTOCOL"
smart_selection_is_canonical_decimal 0
smart_selection_is_canonical_decimal 1
smart_selection_is_canonical_decimal 9
smart_selection_is_canonical_decimal 10
! smart_selection_is_canonical_decimal 01
! smart_selection_is_canonical_decimal 10a
! smart_selection_is_canonical_decimal 12_
smart_parse_selection_request \
    'v2,write_back,mixed,rot180,100000,200000,500000,600000,1800000000000'
test "$SMART_SELECTION_MODE" = write_back
test "$SMART_SELECTION_SNAPSHOT" = \
    'v2,mixed,rot180,100000,200000,500000,600000'
smart_parse_selection_request \
    'v2,write_back,ink,normal,1,2,9,10,1800000000000'
test "$SMART_SELECTION_SNAPSHOT" = \
    'v2,ink,normal,1,2,9,10'
! smart_parse_selection_request \
    'v2,write_back,mixed,sideways,100000,200000,500000,600000,1800000000000'
alphanumeric_coordinate_error=$(
    smart_parse_selection_request \
        'v2,write_back,mixed,normal,10a,200000,500000,600000,1800000000000' \
        2>&1
) && exit 1
test -z "$alphanumeric_coordinate_error"
! smart_parse_selection_snapshot \
    'v2,mixed,rot180,100000,200000,100000,600000'
huge_coordinate=99999999999999999999999999999999999999999999999999
if huge_coordinate_error=$(smart_parse_selection_request \
        "v2,write_back,mixed,normal,$huge_coordinate,200000,500000,600000,1800000000000" \
        2>&1); then
    exit 1
fi
# Reject before BusyBox integer conversion: malformed untrusted input must not
# emit an overflow/error diagnostic that depends on shell implementation.
test -z "$huge_coordinate_error"
smart_generate_selection_nonce
first_nonce=$SMART_SELECTION_NONCE
smart_generate_selection_nonce
second_nonce=$SMART_SELECTION_NONCE
test "${#first_nonce}" -eq 64
test "$first_nonce" != "$second_nonce"
smart_parse_active_selection_descriptor \
    "v2,$first_nonce,mixed,rot180,100000,200000,500000,600000,1800000000000"
test "$SMART_SELECTION_ACK" = \
    "v2,$first_nonce,mixed,rot180,100000,200000,500000,600000"
smart_capture_epoch_ms
case "$SMART_SELECTION_CAPTURED_MS" in
    *[!0-9]*|'') exit 1 ;;
esac
test "${#SMART_SELECTION_CAPTURED_MS}" -eq 13

printf '%s\n' "two-button client protocol checks passed"
