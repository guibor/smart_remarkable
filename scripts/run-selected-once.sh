#!/bin/sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TRIGGER=/tmp/llm_button_trigger
OPENCLAW_HOST=${OPENCLAW_SSH_HOST:-35.223.143.111}
OPENCLAW_USER=${OPENCLAW_SSH_USER:-mdf}
OPENCLAW_IDENTITY=${OPENCLAW_SSH_IDENTITY:-/home/root/.ssh/id_ed25519_openclaw}
OPENCLAW_PORT=${OPENCLAW_LOCAL_PORT:-18790}
TUNNEL_PID=
TRIGGER_PID=

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
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -r "$OPENCLAW_IDENTITY" ]; then
    echo "OpenClaw tunnel identity not found: $OPENCLAW_IDENTITY" >&2
    exit 1
fi

ssh \
    -N \
    -q \
    -i "$OPENCLAW_IDENTITY" \
    -o BatchMode=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o StrictHostKeyChecking=yes \
    -L "127.0.0.1:${OPENCLAW_PORT}:127.0.0.1:18789" \
    "${OPENCLAW_USER}@${OPENCLAW_HOST}" &
TUNNEL_PID=$!

i=0
while ! wget -q -T 2 -O /dev/null "http://127.0.0.1:${OPENCLAW_PORT}/health" 2>/dev/null; do
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
(
    sleep "${SMART_REMARKABLE_TRIGGER_DELAY:-2}"
    : > "$TRIGGER"
) &
TRIGGER_PID=$!

cd "$HERE"
./smart_remarkable \
    --select-mode \
    --engine openclaw \
    --engine-base-url "http://127.0.0.1:${OPENCLAW_PORT}" \
    --model "${SMART_REMARKABLE_MODEL:-openclaw/default}" \
    --prompt selection_openclaw.json \
    --no-loop \
    --no-draw-progress \
    "$@"
