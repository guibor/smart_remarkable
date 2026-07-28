#!/bin/sh
set -eu
umask 077
ulimit -c 0

[ "$#" -eq 0 ] || {
    echo "run-selected-once does not accept caller-supplied arguments" >&2
    exit 2
}

HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
EXPECTED_APP=/home/root/xovi/exthome/appload/smart-remarkable
RUNTIME_ENV_PARSER="$HERE/scripts/openclaw-runtime-env.sh"
if [ "$HERE" != "$EXPECTED_APP" ] ||
    [ ! -d "$HERE" ] ||
    [ -L "$HERE" ] ||
    [ "$(stat -c %u:%g:%a "$HERE")" != "0:0:755" ] ||
    [ ! -f "$RUNTIME_ENV_PARSER" ] ||
    [ -L "$RUNTIME_ENV_PARSER" ] ||
    [ "$(stat -c %u:%g:%a "$RUNTIME_ENV_PARSER")" != "0:0:755" ]; then
    echo "Smart Remarkable application or helper path is not the exact root-owned installation" >&2
    exit 1
fi
if [ ! -f "$HERE/.env" ] ||
    [ -L "$HERE/.env" ] ||
    [ "$(stat -c %u:%g:%a "$HERE/.env")" != "0:0:600" ]; then
    echo "Smart Remarkable environment is not the exact root-only file" >&2
    exit 1
fi
# shellcheck disable=SC1091
. "$RUNTIME_ENV_PARSER"
smart_load_openclaw_runtime_env "$HERE/.env"
STATE_DIR=/run/smart-remarkable
TRIGGER="$STATE_DIR/llm_button_trigger"
SEND_TRIGGER="$STATE_DIR/send_button_trigger"
OPENCLAW_HOST=35.223.143.111
OPENCLAW_USER=smart-remarkable-tunnel
OPENCLAW_IDENTITY=$OPENCLAW_SSH_IDENTITY
OPENCLAW_PORT=$OPENCLAW_LOCAL_PORT
TUNNEL_PID=
TRIGGER_PID=
SSH_HOME="$STATE_DIR/ssh-home"
APP_HOME="$STATE_DIR/app-home"
EXPECTED_OPENCLAW_IDENTITY=/home/root/.ssh/id_dropbear_smart_remarkable_bridge
EXPECTED_OPENCLAW_HOST=35.223.143.111
EXPECTED_OPENCLAW_USER=smart-remarkable-tunnel

smart_process_running() {
    for exe in /proc/[0-9]*/exe; do
        [ -L "$exe" ] || continue
        target=$(readlink "$exe" 2>/dev/null) || continue
        [ "${target##*/}" = "smart_remarkable" ] && return 0
    done
    return 1
}

cleanup() {
    if [ -n "$TRIGGER_PID" ]; then
        kill "$TRIGGER_PID" 2>/dev/null || true
        wait "$TRIGGER_PID" 2>/dev/null || true
    fi
    if [ -n "$TUNNEL_PID" ]; then
        kill "$TUNNEL_PID" 2>/dev/null || true
        wait "$TUNNEL_PID" 2>/dev/null || true
    fi
    rm -f "$TRIGGER"
    rm -f \
        "$STATE_DIR/ready" \
        "$STATE_DIR/busy" \
        "$SEND_TRIGGER" \
        "$STATE_DIR/draw_button_trigger"
    rm -rf "$SSH_HOME" "$APP_HOME"
    rmdir "$STATE_DIR" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

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
if ! systemctl is-active --quiet xochitl.service; then
    echo "Stock xochitl is not active" >&2
    exit 1
fi
if systemctl is-active --quiet riddle-takeover.service; then
    echo "T.M.R. is active; refusing a concurrent Smart Remarkable request" >&2
    exit 1
fi
if systemctl is-active --quiet smart-remarkable-session.service || smart_process_running; then
    echo "Smart Remarkable is already active" >&2
    exit 1
fi

if [ -L "$STATE_DIR" ]; then
    echo "Refusing symlink runtime state directory" >&2
    exit 1
fi
mkdir -p "$STATE_DIR"
chown root:root "$STATE_DIR"
chmod 0700 "$STATE_DIR"
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
    -o ServerAliveInterval=30 \
    -o StrictHostKeyChecking=yes \
    -L "127.0.0.1:${OPENCLAW_PORT}:127.0.0.1:${OPENCLAW_REMOTE_PORT}" \
    "${OPENCLAW_USER}@${OPENCLAW_HOST}" &
TUNNEL_PID=$!

i=0
while ! /usr/bin/env -i \
    PATH=/usr/sbin:/usr/bin:/sbin:/bin \
    wget -q -T 2 -O /dev/null \
    "http://127.0.0.1:${OPENCLAW_PORT}/health" 2>/dev/null; do
    i=$((i + 1))
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null || [ "$i" -ge 15 ]; then
        echo "Unable to establish the private OpenClaw tunnel" >&2
        exit 1
    fi
    sleep 1
done
if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "OpenClaw tunnel exited during its health check" >&2
    exit 1
fi

rm -f "$TRIGGER"
rm -f "$SEND_TRIGGER"
(
    i=0
    while [ ! -f "$STATE_DIR/ready" ]; do
        i=$((i + 1))
        [ "$i" -lt 25 ] || exit 1
        sleep 1
    done
    : > "$TRIGGER"
) &
TRIGGER_PID=$!

cd "$HERE"
/usr/bin/env -i \
    HOME="$APP_HOME" \
    PATH=/usr/sbin:/usr/bin:/sbin:/bin \
    RUST_LOG="$RUST_LOG" \
    OPENCLAW_BRIDGE_TOKEN="$OPENCLAW_BRIDGE_TOKEN" \
    ./smart_remarkable \
    --select-mode \
    --engine openclaw \
    --engine-base-url "http://127.0.0.1:${OPENCLAW_PORT}" \
    --model "$SMART_REMARKABLE_MODEL" \
    --prompt selection_openclaw.json \
    --no-loop \
    --no-draw-progress
