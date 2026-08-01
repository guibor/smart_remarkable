#!/bin/sh
# Run one configured, time-bounded Smart Remarkable mode inside the transient
# AppLoad systemd unit.
set -eu
umask 077
ulimit -c 0

[ "$#" -eq 0 ] || {
    echo "run-armed-once does not accept caller-supplied arguments" >&2
    exit 2
}

HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
EXPECTED_APP=/home/root/xovi/exthome/appload/smart-remarkable
MODE_SETTINGS="$HERE/scripts/mode-settings.sh"
RUNTIME_ENV_PARSER="$HERE/scripts/openclaw-runtime-env.sh"
if [ "$HERE" != "$EXPECTED_APP" ] ||
    [ ! -d "$HERE" ] ||
    [ -L "$HERE" ] ||
    [ "$(stat -c %u:%g:%a "$HERE")" != "0:0:755" ]; then
    echo "Smart Remarkable is not running from the exact root-owned application directory" >&2
    exit 1
fi
for helper in "$MODE_SETTINGS" "$RUNTIME_ENV_PARSER"; do
    if [ ! -f "$helper" ] ||
        [ -L "$helper" ] ||
        [ "$(stat -c %u:%g:%a "$helper")" != "0:0:755" ]; then
        echo "Smart Remarkable helper is not an exact root-owned executable file" >&2
        exit 1
    fi
done
. "$MODE_SETTINGS"
smart_load_mode_settings
if [ ! -f "$HERE/.env" ] ||
    [ -L "$HERE/.env" ] ||
    [ "$(stat -c %u:%g:%a "$HERE/.env")" != "0:0:600" ]; then
    echo "Smart Remarkable environment is not the exact root-only file" >&2
    exit 1
fi
# shellcheck disable=SC1091
. "$RUNTIME_ENV_PARSER"
smart_load_openclaw_runtime_env "$HERE/.env"
OPENCLAW_HOST=35.223.143.111
OPENCLAW_USER=smart-remarkable-tunnel
OPENCLAW_IDENTITY=$OPENCLAW_SSH_IDENTITY
OPENCLAW_PORT=$OPENCLAW_LOCAL_PORT
TUNNEL_PID=
WORKER_PID=
STATE_DIR=/run/smart-remarkable
SSH_HOME="$STATE_DIR/ssh-home"
APP_HOME="$STATE_DIR/app-home"
EXPECTED_OPENCLAW_IDENTITY=/home/root/.ssh/id_dropbear_smart_remarkable_bridge
EXPECTED_OPENCLAW_HOST=35.223.143.111
EXPECTED_OPENCLAW_USER=smart-remarkable-tunnel

cleanup() {
    if [ -n "$WORKER_PID" ]; then
        kill "$WORKER_PID" 2>/dev/null || true
        wait "$WORKER_PID" 2>/dev/null || true
    fi
    if [ -n "$TUNNEL_PID" ]; then
        kill "$TUNNEL_PID" 2>/dev/null || true
        wait "$TUNNEL_PID" 2>/dev/null || true
    fi
    rm -f \
        "$STATE_DIR/ready" \
        "$STATE_DIR/bridge-ready" \
        "$STATE_DIR/bridge-failed" \
        "$STATE_DIR/busy" \
        "$STATE_DIR/selection_prepare_ack" \
        "$STATE_DIR/selection_close_ack" \
        "$STATE_DIR/llm_button_trigger" \
        "$STATE_DIR/send_button_trigger" \
        "$STATE_DIR/draw_button_trigger"
    rmdir "$STATE_DIR/selection-admission.lock" 2>/dev/null || true
    rm -rf "$SSH_HOME" "$APP_HOME"
    rmdir "$STATE_DIR" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

publish_bridge_marker() {
    marker_name=$1
    marker_tmp="$STATE_DIR/.${marker_name}.$$"
    marker_target="$STATE_DIR/$marker_name"
    [ ! -e "$marker_tmp" ] && [ ! -L "$marker_tmp" ] || return 1
    : > "$marker_tmp"
    chmod 0600 "$marker_tmp"
    chown root:root "$marker_tmp"
    [ "$(stat -c %u:%g:%a "$marker_tmp")" = "0:0:600" ] || {
        rm -f "$marker_tmp"
        return 1
    }
    mv -f "$marker_tmp" "$marker_target"
}

if [ "$OPENCLAW_IDENTITY" != "$EXPECTED_OPENCLAW_IDENTITY" ] ||
    [ ! -f "$OPENCLAW_IDENTITY" ] ||
    [ -L "$OPENCLAW_IDENTITY" ] ||
    [ "$(stat -c %u:%g:%a "$OPENCLAW_IDENTITY")" != "0:0:600" ]; then
    echo "OpenClaw tunnel identity is not the exact dedicated root-only key" >&2
    exit 1
fi
if [ "$OPENCLAW_HOST" != "$EXPECTED_OPENCLAW_HOST" ] ||
    [ "$OPENCLAW_USER" != "$EXPECTED_OPENCLAW_USER" ] ||
    [ "$OPENCLAW_PORT" != 18791 ] ||
    [ "$OPENCLAW_REMOTE_PORT" != 18792 ]; then
    echo "OpenClaw tunnel route does not match the pinned bridge route" >&2
    exit 1
fi
case "$OPENCLAW_PORT:$OPENCLAW_REMOTE_PORT" in
    *[!0-9:]*|:*|*:) echo "Invalid OpenClaw bridge port" >&2; exit 2 ;;
esac
[ "$OPENCLAW_PORT" -ge 1 ] && [ "$OPENCLAW_PORT" -le 65535 ]
[ "$OPENCLAW_REMOTE_PORT" -ge 1 ] && [ "$OPENCLAW_REMOTE_PORT" -le 65535 ]
if [ ! -c /dev/uinput ]; then
    echo "Firmware-compatible /dev/uinput is unavailable; refusing to load a bundled module" >&2
    exit 1
fi

if [ -L "$STATE_DIR" ]; then
    echo "Refusing symlink runtime state directory" >&2
    exit 1
fi
mkdir -p "$STATE_DIR"
chown root:root "$STATE_DIR"
chmod 0700 "$STATE_DIR"
# A SIGKILL or power loss can bypass the normal exit trap. Clear only our
# volatile markers before the relatively slow tunnel setup, so AppLoad can
# never mistake a stale ready file for this worker being able to receive the
# first native-button request.
rm -f \
    "$STATE_DIR/ready" \
    "$STATE_DIR/bridge-ready" \
    "$STATE_DIR/bridge-failed" \
    "$STATE_DIR/busy" \
    "$STATE_DIR/selection_prepare_ack" \
    "$STATE_DIR/selection_close_ack" \
    "$STATE_DIR/llm_button_trigger" \
    "$STATE_DIR/send_button_trigger" \
    "$STATE_DIR/draw_button_trigger"
rmdir "$STATE_DIR/selection-admission.lock" 2>/dev/null || true
test -f /home/root/.ssh/known_hosts
test ! -L /home/root/.ssh/known_hosts
test "$(stat -c %u:%g:%a /home/root/.ssh/known_hosts)" = "0:0:600"
rm -rf "$SSH_HOME"
test ! -e "$SSH_HOME"
test ! -L "$SSH_HOME"
mkdir -m 0700 -p "$SSH_HOME/.ssh"
cp /home/root/.ssh/known_hosts "$SSH_HOME/.ssh/known_hosts"
chown -R root:root "$SSH_HOME"
chmod 0600 "$SSH_HOME/.ssh/known_hosts"
rm -rf "$APP_HOME"
test ! -e "$APP_HOME"
test ! -L "$APP_HOME"
mkdir -m 0700 -p "$APP_HOME"
chown root:root "$APP_HOME"
unset SSH_AUTH_SOCK DROPBEAR_PASSWORD DBCLIENT_PASSWORD

# Local capture readiness does not depend on the private tunnel. Start the
# listener first; it publishes /run/smart-remarkable/ready as soon as it can
# accept a nonce-bound selection. Rust waits for bridge-ready only after the
# exact crop has been captured and the stock selection has closed.
cd "$HERE"
# This split is safe: MODE_ARGS contains only fixed literals selected above.
MODE_ARGS=
if [ "$SMART_NO_LOOP" -eq 1 ]; then
    MODE_ARGS=--no-loop
fi
# shellcheck disable=SC2086
/usr/bin/env -i \
    HOME="$APP_HOME" \
    PATH=/usr/sbin:/usr/bin:/sbin:/bin \
    RUST_LOG="$RUST_LOG" \
    OPENCLAW_BRIDGE_TOKEN="$OPENCLAW_BRIDGE_TOKEN" \
    ./smart_remarkable \
    --select-mode \
    --trigger-corner "$SMART_TRIGGER_CORNER" \
    --pen-hold-ms "$SMART_HOLD_MS" \
    --pen-hold-radius-px "$SMART_HOLD_RADIUS_PX" \
    --pen-min-extent-px "$SMART_MIN_EXTENT_PX" \
    --engine openclaw \
    --engine-base-url "http://127.0.0.1:${OPENCLAW_PORT}" \
    --model "$SMART_REMARKABLE_MODEL" \
    --prompt selection_openclaw.json \
    --no-draw-progress \
    $MODE_ARGS &
WORKER_PID=$!

# A disappearing network must not discard an already captured selection.
# Keep the worker (and its crop) only in RAM while repeatedly recreating the
# forwarding-only tunnel. The worker's own bounded bridge wait and the
# transient unit's RuntimeMaxSec remain the outer limits.
while kill -0 "$WORKER_PID" 2>/dev/null; do
    rm -f "$STATE_DIR/bridge-ready" "$STATE_DIR/bridge-failed"
    /usr/bin/env -i \
        HOME="$SSH_HOME" \
        PATH=/usr/sbin:/usr/bin:/sbin:/bin \
        /usr/bin/ssh \
        -N \
        -q \
        -i "$OPENCLAW_IDENTITY" \
        -o BatchMode=yes \
        -o PasswordAuthentication=no \
        -o DisableTrivialAuth=yes \
        -o ForwardAgent=no \
        -o ExitOnForwardFailure=yes \
        -K 30 \
        -o StrictHostKeyChecking=yes \
        -L "127.0.0.1:${OPENCLAW_PORT}:127.0.0.1:${OPENCLAW_REMOTE_PORT}" \
        "${OPENCLAW_USER}@${OPENCLAW_HOST}" &
    TUNNEL_PID=$!

    tunnel_healthy=0
    i=0
    while [ "$i" -lt 5 ]; do
        if ! kill -0 "$WORKER_PID" 2>/dev/null ||
            ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
            break
        fi
        if /usr/bin/env -i \
            PATH=/usr/sbin:/usr/bin:/sbin:/bin \
            wget -q -T 2 -O /dev/null \
            "http://127.0.0.1:${OPENCLAW_PORT}/health" 2>/dev/null; then
            tunnel_healthy=1
            break
        fi
        i=$((i + 1))
        sleep 1
    done

    if ! kill -0 "$WORKER_PID" 2>/dev/null; then
        if wait "$WORKER_PID"; then
            WORKER_STATUS=0
        else
            WORKER_STATUS=$?
        fi
        WORKER_PID=
        kill "$TUNNEL_PID" 2>/dev/null || true
        wait "$TUNNEL_PID" 2>/dev/null || true
        TUNNEL_PID=
        exit "$WORKER_STATUS"
    fi

    if [ "$tunnel_healthy" -ne 1 ] ||
        ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
        kill "$TUNNEL_PID" 2>/dev/null || true
        wait "$TUNNEL_PID" 2>/dev/null || true
        TUNNEL_PID=
        echo "Private OpenClaw tunnel unavailable; retrying without discarding the captured request" >&2
        sleep 2
        continue
    fi

    publish_bridge_marker bridge-ready

    # BusyBox ash on the supported firmware provides wait -n -p. Remote
    # readiness disappears before any reconnect; only worker exit terminates
    # the bounded session.
    EXITED_PID=
    if wait -n -p EXITED_PID "$TUNNEL_PID" "$WORKER_PID"; then
        EXITED_STATUS=0
    else
        EXITED_STATUS=$?
    fi
    rm -f "$STATE_DIR/bridge-ready"

    if [ "$EXITED_PID" = "$WORKER_PID" ]; then
        WORKER_PID=
        kill "$TUNNEL_PID" 2>/dev/null || true
        wait "$TUNNEL_PID" 2>/dev/null || true
        TUNNEL_PID=
        exit "$EXITED_STATUS"
    fi

    TUNNEL_PID=
    echo "Private OpenClaw tunnel disconnected; reconnecting with the worker retained in memory" >&2
    sleep 2
done

if wait "$WORKER_PID"; then
    WORKER_STATUS=0
else
    WORKER_STATUS=$?
fi
WORKER_PID=
exit "$WORKER_STATUS"
