#!/bin/sh
set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
QML="$REPO/xovi-qmd/llm-button-3.28.0.163.source.qmd"
INERT="$REPO/xovi-qmd/llm-button-inert-3.28.0.163.source.qmd"
LAUNCHER="$REPO/remagic/appload-launch.sh"
RUNNER="$REPO/scripts/run-armed-once.sh"

write_back_line=$(grep -n 'iconSource: "qrc:/ark/icons/notebook_sparkles"' "$QML" | cut -d: -f1)
agent_line=$(grep -n 'iconSource: "qrc:/icons/sparkles.svg"' "$QML" | cut -d: -f1)
test -n "$write_back_line"
test -n "$agent_line"
test "$write_back_line" -lt "$agent_line"
test "$(grep -c 'iconSource: "qrc:/ark/icons/notebook_sparkles"' "$INERT")" -eq 1
test "$(grep -c 'iconSource: "qrc:/icons/sparkles.svg"' "$INERT")" -eq 1

# Both buttons share one pending state and one launcher implementation.
test "$(grep -c 'property string pendingMode: ""' "$QML")" -eq 1
test "$(grep -c 'function clearPendingMode()' "$QML")" -eq 1
test "$(grep -c 'function requestMode(mode)' "$QML")" -eq 1
test "$(grep -c 'smartRemarkableLlmButton.clearPendingMode()' "$QML")" -eq 3
test "$(grep -c 'clearPendingMode()' "$QML")" -eq 5
test "$(grep -c 'sequence: "Ctrl+Alt+Shift+9"' "$QML")" -eq 1
test "$(grep -c 'AppLoadLauncher.launchApplication' "$QML")" -eq 1
test "$(grep -c 'id: smartRemarkablePendingReset' "$QML")" -eq 1
grep -F 'interval: 45000' "$QML" >/dev/null
grep -F 'smartRemarkablePendingReset.restart()' "$QML" >/dev/null
grep -F 'onTriggered: smartRemarkableLlmButton.clearPendingMode()' "$QML" >/dev/null
grep -F 'onClicked: requestMode("write_back")' "$QML" >/dev/null
grep -F 'onClicked: smartRemarkableLlmButton.requestMode(' "$QML" >/dev/null
grep -F '"whatsapp_only")' "$QML" >/dev/null
grep -F -- '"--selection-button=" + mode' "$QML" >/dev/null

# The guarded visual canary exposes both positions but has no action.
test "$(grep -c 'enabled: false' "$INERT")" -eq 2
! grep -F 'AppLoadLauncher' "$INERT" >/dev/null
! grep -F 'pendingMode' "$INERT" >/dev/null

# AppLoad maps exact mode arguments to distinct volatile markers while keeping
# the already-installed one-button spelling as write-back during rollout.
grep -F -- '--selection-button=write_back)' "$LAUNCHER" >/dev/null
grep -F -- '--selection-button=whatsapp_only)' "$LAUNCHER" >/dev/null
grep -F 'WRITE_BACK_TRIGGER="$STATE_DIR/llm_button_trigger"' "$LAUNCHER" >/dev/null
grep -F 'WHATSAPP_ONLY_TRIGGER="$STATE_DIR/send_button_trigger"' "$LAUNCHER" >/dev/null
grep -F '"http://127.0.0.1:18791/health"' "$LAUNCHER" >/dev/null
grep -F 'if [ -f "$STATE_DIR/ready" ] && bridge_is_healthy; then' "$LAUNCHER" >/dev/null
grep -F 'systemctl stop "$UNIT"' "$LAUNCHER" >/dev/null
grep -F 'wait -n -p EXITED_PID "$TUNNEL_PID" "$WORKER_PID"' "$RUNNER" >/dev/null
grep -F 'if [ "$EXITED_PID" = "$TUNNEL_PID" ]; then' "$RUNNER" >/dev/null
grep -F 'rm -f "$STATE_DIR/ready"' "$RUNNER" >/dev/null
grep -F 'OPENCLAW_BRIDGE_TOKEN' "$REPO/src/llm_engine/openai.rs" >/dev/null
grep -F 'OPENCLAW_BRIDGE_BASE_URL' "$REPO/src/llm_engine/openai.rs" >/dev/null
! grep -F 'OPENCLAW_GATEWAY_TOKEN' "$REPO/src/llm_engine/openai.rs" >/dev/null

# Send has its own ordinary-conversation prompt and every shell entry point is
# syntactically valid.
python3 -m json.tool \
    "$REPO/prompts/selection_openclaw_whatsapp.json" >/dev/null
python3 -m json.tool "$REPO/remagic/external.manifest.json" >/dev/null
sh -n "$LAUNCHER"
sh -n "$RUNNER"
sh -n "$REPO/scripts/run-selected-once.sh"

printf '%s\n' "two-button client protocol checks passed"
