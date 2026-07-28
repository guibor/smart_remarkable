#!/bin/sh
# AppLoad entry point. Toggle one configured, time-limited Smart Remarkable
# worker, or deliver an explicit native selection-button request.
# The worker is owned by PID 1, never enabled at boot, and is stopped whenever
# stock xochitl stops (including when T.M.R. takes over).
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
EXPECTED_APP=/home/root/xovi/exthome/appload/smart-remarkable
MODE_SETTINGS="$HERE/scripts/mode-settings.sh"
if [ "$HERE" != "$EXPECTED_APP" ] ||
    [ ! -d "$HERE" ] ||
    [ -L "$HERE" ] ||
    [ "$(stat -c %u:%g:%a "$HERE")" != "0:0:755" ] ||
    [ ! -f "$MODE_SETTINGS" ] ||
    [ -L "$MODE_SETTINGS" ] ||
    [ "$(stat -c %u:%g:%a "$MODE_SETTINGS")" != "0:0:755" ]; then
    echo "Smart Remarkable launcher is not the exact root-owned installation" >&2
    exit 1
fi
UNIT=smart-remarkable-session.service
STATE_DIR=/run/smart-remarkable
WRITE_BACK_TRIGGER="$STATE_DIR/llm_button_trigger"
WHATSAPP_ONLY_TRIGGER="$STATE_DIR/send_button_trigger"
. "$MODE_SETTINGS"
smart_load_mode_settings

[ "$#" -le 1 ] || {
    echo "Unsupported Smart Remarkable launcher arguments" >&2
    exit 2
}
case "${1:-}" in
    '') ACTION=toggle ;;
    # Keep the original spelling as a write-back compatibility alias so an
    # already-loaded one-button QMD cannot accidentally change semantics
    # during a guarded refresh.
    --selection-button)
        ACTION=selection-button
        RESPONSE_MODE=write_back
        ;;
    --selection-button=write_back)
        ACTION=selection-button
        RESPONSE_MODE=write_back
        ;;
    --selection-button=whatsapp_only)
        ACTION=selection-button
        RESPONSE_MODE=whatsapp_only
        ;;
    *)
        echo "Unsupported Smart Remarkable launcher argument" >&2
        exit 2
        ;;
esac

bridge_is_healthy() {
    /usr/bin/env -i \
        PATH=/usr/sbin:/usr/bin:/sbin:/bin \
        wget -q -T 2 -O /dev/null \
        "http://127.0.0.1:18791/health" 2>/dev/null
}

deliver_selection_button() {
    i=0
    while [ ! -f "$STATE_DIR/ready" ]; do
        i=$((i + 1))
        if [ "$i" -ge 25 ] || ! systemctl is-active --quiet "$UNIT"; then
            echo "Smart Remarkable did not become ready for the LLM button" >&2
            return 1
        fi
        sleep 1
    done
    if ! bridge_is_healthy; then
        echo "Smart Remarkable bridge is not healthy" >&2
        return 1
    fi
    for path in "$WRITE_BACK_TRIGGER" "$WHATSAPP_ONLY_TRIGGER"; do
        [ ! -L "$path" ] || {
            echo "Refusing symlink trigger path" >&2
            return 1
        }
    done
    # The worker admits one request and never treats button markers as a
    # backlog. Reject an unconsumed marker here as an additional launcher-side
    # guard against rapid or concurrent AppLoad calls.
    if [ -e "$WRITE_BACK_TRIGGER" ] || [ -e "$WHATSAPP_ONLY_TRIGGER" ]; then
        echo "A Smart Remarkable button request is already pending" >&2
        return 1
    fi
    case "$RESPONSE_MODE" in
        write_back) : > "$WRITE_BACK_TRIGGER" ;;
        whatsapp_only) : > "$WHATSAPP_ONLY_TRIGGER" ;;
        *)
            echo "Invalid Smart Remarkable response mode" >&2
            return 1
            ;;
    esac
}

smart_process_running() {
    for exe in /proc/[0-9]*/exe; do
        [ -L "$exe" ] || continue
        target=$(readlink "$exe" 2>/dev/null) || continue
        [ "${target##*/}" = "smart_remarkable" ] && return 0
    done
    return 1
}

if systemctl is-active --quiet "$UNIT"; then
    if [ "$ACTION" = selection-button ]; then
        if [ -f "$STATE_DIR/ready" ] && bridge_is_healthy; then
            deliver_selection_button
            exit 0
        fi
        # The transient unit is active but cannot currently reach its bridge.
        # Stop it once and continue through the ordinary guarded start path.
        # If that fresh start is also unhealthy, deliver_selection_button
        # fails closed instead of attempting another restart.
        systemctl stop "$UNIT"
    else
        systemctl stop "$UNIT"
        exit 0
    fi
fi

if systemctl is-active --quiet riddle-takeover.service; then
    echo "T.M.R. is active; Smart Remarkable was not armed" >&2
    exit 1
fi
if smart_process_running; then
    echo "Another Smart Remarkable process is active; the AppLoad worker was not started" >&2
    exit 1
fi
systemctl is-active --quiet xochitl.service
systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true

systemd-run \
    --unit="$UNIT" \
    --collect \
    --property="BindsTo=xochitl.service" \
    --property="After=xochitl.service" \
    --property="Conflicts=riddle-takeover.service" \
    --property="Before=riddle-takeover.service" \
    --property="RuntimeMaxSec=${SMART_RUNTIME_MAX_SECONDS}s" \
    --property="LimitCORE=0" \
    --property="KillMode=control-group" \
    --property="Restart=no" \
    --property="TimeoutStopSec=5s" \
    /bin/sh "$HERE/scripts/run-armed-once.sh"

if [ "$ACTION" = selection-button ]; then
    deliver_selection_button
fi
