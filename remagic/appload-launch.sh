#!/bin/sh
# AppLoad entry point. Toggle one configured, time-limited Smart Remarkable
# worker, or deliver an explicit native selection-button request.
# The worker is owned by PID 1, never enabled at boot, and is stopped whenever
# stock xochitl stops (including when T.M.R. takes over).
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
EXPECTED_APP=/home/root/xovi/exthome/appload/smart-remarkable
MODE_SETTINGS="$HERE/scripts/mode-settings.sh"
SELECTION_PROTOCOL="$HERE/scripts/selection-protocol.sh"
if [ "$HERE" != "$EXPECTED_APP" ] ||
    [ ! -d "$HERE" ] ||
    [ -L "$HERE" ] ||
    [ "$(stat -c %u:%g:%a "$HERE")" != "0:0:755" ]; then
    echo "Smart Remarkable launcher is not the exact root-owned installation" >&2
    exit 1
fi
for helper in "$MODE_SETTINGS" "$SELECTION_PROTOCOL"; do
    if [ ! -f "$helper" ] ||
        [ -L "$helper" ] ||
        [ "$(stat -c %u:%g:%a "$helper")" != "0:0:755" ]; then
        echo "Smart Remarkable launcher helper is not exact and root-owned" >&2
        exit 1
    fi
done
UNIT=smart-remarkable-session.service
STATE_DIR=/run/smart-remarkable
WRITE_BACK_TRIGGER="$STATE_DIR/llm_button_trigger"
WHATSAPP_ONLY_TRIGGER="$STATE_DIR/send_button_trigger"
BUSY_FILE="$STATE_DIR/busy"
PREPARE_ACK_FILE="$STATE_DIR/selection_prepare_ack"
CLOSE_ACK_FILE="$STATE_DIR/selection_close_ack"
ADMISSION_LOCK="$STATE_DIR/selection-admission.lock"
. "$MODE_SETTINGS"
. "$SELECTION_PROTOCOL"
smart_load_mode_settings

[ "$#" -le 1 ] || {
    echo "Unsupported Smart Remarkable launcher arguments" >&2
    exit 2
}
case "${1:-}" in
    '') ACTION=toggle ;;
    --selection-button-descriptor=*)
        smart_parse_selection_request \
            "${1#--selection-button-descriptor=}" || {
                echo "Invalid Smart Remarkable selection descriptor" >&2
                exit 2
            }
        RESPONSE_MODE=$SMART_SELECTION_MODE
        REQUEST_SNAPSHOT=$SMART_SELECTION_SNAPSHOT
        REQUEST_CAPTURED_MS=$SMART_SELECTION_CAPTURED_MS
        REQUEST_PROTOCOL=v2
        ACTION=selection-button
        ;;
    # App-first staging compatibility for the currently installed 2b9188 QMD.
    # These routes receive a random, fresh launcher generation and remain
    # distinct from the strict v2 geometry/acknowledgement protocol.
    --selection-button)
        RESPONSE_MODE=write_back
        REQUEST_PROTOCOL=legacy-v1
        ACTION=selection-button
        ;;
    --selection-button=write_back)
        RESPONSE_MODE=write_back
        REQUEST_PROTOCOL=legacy-v1
        ACTION=selection-button
        ;;
    --selection-button=whatsapp_only)
        RESPONSE_MODE=whatsapp_only
        REQUEST_PROTOCOL=legacy-v1
        ACTION=selection-button
        ;;
    --selection-prepare-ack=*)
        smart_parse_selection_snapshot \
            "${1#--selection-prepare-ack=}" || {
                echo "Invalid Smart Remarkable selection prepare acknowledgement" >&2
                exit 2
            }
        ACK_SNAPSHOT=$SMART_SELECTION_SNAPSHOT
        ACTION=selection-prepare-ack
        ;;
    --selection-close-ack=*)
        smart_parse_selection_snapshot \
            "${1#--selection-close-ack=}" || {
                echo "Invalid Smart Remarkable selection close acknowledgement" >&2
                exit 2
            }
        ACK_SNAPSHOT=$SMART_SELECTION_SNAPSHOT
        ACTION=selection-close-ack
        ;;
    *)
        echo "Unsupported Smart Remarkable launcher argument" >&2
        exit 2
        ;;
esac

runtime_dir_is_secure() {
    [ -d "$STATE_DIR" ] &&
        [ ! -L "$STATE_DIR" ] &&
        [ "$(stat -c %u:%g:%a "$STATE_DIR")" = "0:0:700" ]
}

acquire_selection_lock() {
    runtime_dir_is_secure || return 1
    [ ! -L "$ADMISSION_LOCK" ] || return 1
    saved_umask=$(umask)
    umask 077
    if ! mkdir "$ADMISSION_LOCK" 2>/dev/null; then
        umask "$saved_umask"
        return 1
    fi
    umask "$saved_umask"
    chmod 0700 "$ADMISSION_LOCK" || {
        rmdir "$ADMISSION_LOCK" 2>/dev/null || true
        return 1
    }
    chown 0:0 "$ADMISSION_LOCK" || {
        rmdir "$ADMISSION_LOCK" 2>/dev/null || true
        return 1
    }
    [ "$(stat -c %u:%g:%a "$ADMISSION_LOCK")" = "0:0:700" ] || {
        rmdir "$ADMISSION_LOCK" 2>/dev/null || true
        return 1
    }
}

release_selection_lock() {
    rmdir "$ADMISSION_LOCK" 2>/dev/null || true
}

publish_root_marker() {
    marker_payload=$1
    marker_target=$2
    marker_name=$3
    [ ! -e "$marker_target" ] && [ ! -L "$marker_target" ] || return 1
    marker_tmp="$STATE_DIR/.${marker_name}.$$"
    [ ! -e "$marker_tmp" ] && [ ! -L "$marker_tmp" ] || return 1

    saved_umask=$(umask)
    umask 077
    if ! printf '%s\n' "$marker_payload" > "$marker_tmp"; then
        umask "$saved_umask"
        return 1
    fi
    umask "$saved_umask"
    chmod 0600 "$marker_tmp" || {
        rm -f "$marker_tmp"
        return 1
    }
    chown 0:0 "$marker_tmp" || {
        rm -f "$marker_tmp"
        return 1
    }
    if [ "$(stat -c %u:%g:%a "$marker_tmp")" != "0:0:600" ]; then
        rm -f "$marker_tmp"
        return 1
    fi
    if ! ln "$marker_tmp" "$marker_target"; then
        rm -f "$marker_tmp"
        return 1
    fi
    rm -f "$marker_tmp"
}

read_active_selection() {
    [ -f "$BUSY_FILE" ] || return 1
    [ ! -L "$BUSY_FILE" ] || return 1
    [ "$(stat -c %u:%g:%a "$BUSY_FILE")" = "0:0:600" ] || return 1
    [ "$(stat -c %h "$BUSY_FILE")" -ge 1 ] || return 1
    [ "$(stat -c %h "$BUSY_FILE")" -le 2 ] || return 1
    IFS= read -r active_descriptor < "$BUSY_FILE" || return 1
    smart_parse_active_selection_descriptor "$active_descriptor"
}

deliver_selection_button_locked() {
    for path in \
        "$WRITE_BACK_TRIGGER" \
        "$WHATSAPP_ONLY_TRIGGER" \
        "$BUSY_FILE" \
        "$PREPARE_ACK_FILE" \
        "$CLOSE_ACK_FILE"
    do
        [ ! -L "$path" ] || return 1
        [ ! -e "$path" ] || return 1
    done

    case "$RESPONSE_MODE" in
        write_back) target=$WRITE_BACK_TRIGGER ;;
        whatsapp_only) target=$WHATSAPP_ONLY_TRIGGER ;;
        *) return 1 ;;
    esac

    smart_generate_selection_nonce || return 1
    case "$REQUEST_PROTOCOL" in
        v2)
            selection_descriptor="v2,$SMART_SELECTION_NONCE,${REQUEST_SNAPSHOT#v2,},$REQUEST_CAPTURED_MS"
            ;;
        legacy-v1)
            smart_capture_epoch_ms || return 1
            selection_descriptor="legacy-v1,$SMART_SELECTION_NONCE,$SMART_SELECTION_CAPTURED_MS"
            ;;
        *) return 1 ;;
    esac

    # The nonce-bearing busy file is published first and remains present until
    # Rust has completed or failed this exact request. New taps therefore fail
    # even after the trigger marker itself has been consumed.
    publish_root_marker "$selection_descriptor" "$BUSY_FILE" selection-busy || return 1
    if ! publish_root_marker "$selection_descriptor" "$target" selection-trigger; then
        rm -f "$BUSY_FILE"
        return 1
    fi
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
    if ! runtime_dir_is_secure; then
        echo "Smart Remarkable runtime directory is not root-only" >&2
        return 1
    fi
    if ! acquire_selection_lock; then
        echo "A Smart Remarkable button request is already pending" >&2
        return 1
    fi
    if deliver_selection_button_locked; then
        selection_status=0
    else
        selection_status=$?
    fi
    release_selection_lock
    if [ "$selection_status" -ne 0 ]; then
        echo "A Smart Remarkable button request is already pending or invalid" >&2
        return "$selection_status"
    fi
}

deliver_selection_ack_locked() {
    read_active_selection || return 1
    [ "$ACK_SNAPSHOT" = "$SMART_SELECTION_SNAPSHOT" ] || return 1
    case "$ACTION" in
        selection-prepare-ack) ack_target=$PREPARE_ACK_FILE ;;
        selection-close-ack) ack_target=$CLOSE_ACK_FILE ;;
        *) return 1 ;;
    esac
    publish_root_marker "$SMART_SELECTION_ACK" "$ack_target" selection-ack
}

deliver_selection_ack() {
    if ! systemctl is-active --quiet "$UNIT" ||
        [ ! -f "$STATE_DIR/ready" ] ||
        ! runtime_dir_is_secure; then
        echo "Smart Remarkable is not locally ready for a selection acknowledgement" >&2
        return 1
    fi
    if ! acquire_selection_lock; then
        echo "Smart Remarkable selection acknowledgement is busy" >&2
        return 1
    fi
    if deliver_selection_ack_locked; then
        ack_status=0
    else
        ack_status=$?
    fi
    release_selection_lock
    if [ "$ack_status" -ne 0 ]; then
        echo "Selection acknowledgement does not match the active request" >&2
        return "$ack_status"
    fi
}

smart_process_running() {
    for exe in /proc/[0-9]*/exe; do
        [ -L "$exe" ] || continue
        target=$(readlink "$exe" 2>/dev/null) || continue
        [ "${target##*/}" = "smart_remarkable" ] && return 0
    done
    return 1
}

clear_stale_local_ready_before_start() {
    if [ ! -e "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ]; then
        return 0
    fi
    runtime_dir_is_secure || return 1
    rm -f "$STATE_DIR/ready"
    [ ! -e "$STATE_DIR/ready" ] && [ ! -L "$STATE_DIR/ready" ]
}

case "$ACTION" in
    selection-prepare-ack|selection-close-ack)
        deliver_selection_ack
        exit 0
        ;;
esac

if systemctl is-active --quiet "$UNIT"; then
    if [ "$ACTION" = selection-button ]; then
        if [ -f "$STATE_DIR/ready" ]; then
            deliver_selection_button
            exit 0
        fi
        # Only local listener readiness gates capture. A stale local marker is
        # repaired through the ordinary guarded start path; remote tunnel
        # readiness is owned separately by the runner and Rust worker.
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

# A killed prior transient can leave an empty local-ready marker. Remove it
# before PID 1 starts the replacement so the following wait can observe only
# readiness recreated by the new worker.
clear_stale_local_ready_before_start
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
