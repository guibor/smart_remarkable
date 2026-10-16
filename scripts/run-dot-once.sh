#!/bin/sh
# Existing AppLoad one-flight/session owner, independent HTTPS Dot transport.
# No SSH tunnel, provider keys, durable outbox, module load, or boot changes.
set -eu
umask 077
ulimit -c 0
[ "$#" -eq 0 ] || exit 2
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "$HERE" = /home/root/xovi/exthome/appload/smart-remarkable ] || exit 1
[ -d "$HERE" ] && [ ! -L "$HERE" ] && [ "$(stat -c %u:%g:%a "$HERE")" = 0:0:755 ] || exit 1
for member in smart_remarkable scripts/dot-runtime-env.sh; do
    [ -f "$HERE/$member" ] && [ ! -L "$HERE/$member" ] &&
        [ "$(stat -c %u:%g:%a "$HERE/$member")" = 0:0:755 ] || exit 1
done
[ -f "$HERE/.dot.env" ] && [ ! -L "$HERE/.dot.env" ] &&
    [ "$(stat -c %u:%g:%a "$HERE/.dot.env")" = 0:0:600 ] || exit 1
. "$HERE/scripts/dot-runtime-env.sh"
smart_load_dot_runtime_env "$HERE/.dot.env" || { echo 'Invalid private Dot configuration' >&2; exit 2; }
[ -c /dev/uinput ] || { echo 'Built-in input support unavailable; no module will be loaded' >&2; exit 1; }
grep -Fxq 'IMG_VERSION="3.29.0.153"' /etc/os-release || exit 1
[ "$(tr -d '\r\n' </sys/devices/soc0/machine)" = 'reMarkable Ferrari' ] || exit 1
STATE=/run/smart-remarkable
[ ! -L "$STATE" ] || exit 1
mkdir -p "$STATE"
chown root:root "$STATE"
chmod 0700 "$STATE"
WORKER=
cleanup() {
    if [ -n "$WORKER" ]; then kill "$WORKER" 2>/dev/null || true; wait "$WORKER" 2>/dev/null || true; fi
    for name in ready busy bridge-ready bridge-failed selection_prepare_ack selection_close_ack selection_write_ack selection_write_final_ack write-challenge llm_button_trigger send_button_trigger draw_button_trigger; do
        rm -f "$STATE/$name"
    done
    rmdir "$STATE/selection-admission.lock" 2>/dev/null || true
    rm -rf "$STATE/app-home"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cleanup
mkdir -m 0700 "$STATE/app-home"
cd "$HERE"
# No DOT_GUARDED_INK_QUALIFIED flag: injection remains gated until firmware
# input/owner qualification. Queued/answered Dot/PDF delivery is independent.
/usr/bin/env -i HOME="$STATE/app-home" PATH=/usr/sbin:/usr/bin:/sbin:/bin \
    RUST_LOG=info DOT_BASE_URL="$DOT_BASE_URL" DOT_TABLET_KEY="$DOT_TABLET_KEY" \
    ./smart_remarkable --engine dot --model dot --select-mode \
    --trigger-corner buttons-only --prompt selection.json --no-draw-progress &
WORKER=$!
result=0
wait "$WORKER" || result=$?
WORKER=
exit "$result"
