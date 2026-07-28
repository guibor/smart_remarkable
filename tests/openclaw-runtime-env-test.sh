#!/bin/sh
set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$REPO/scripts/openclaw-runtime-env.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/smart-openclaw-env-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
VALID="$WORK/valid.env"

write_valid() {
    {
        printf '%s\n' \
            'OPENCLAW_BRIDGE_TOKEN=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' \
            'OPENCLAW_SSH_IDENTITY=/home/root/.ssh/id_dropbear_smart_remarkable_bridge' \
            'OPENCLAW_LOCAL_PORT=18791' \
            'OPENCLAW_REMOTE_PORT=18792' \
            'SMART_REMARKABLE_MODEL=openclaw/main' \
            'RUST_LOG=info'
    } >"$VALID"
}

expect_rejected() {
    if smart_load_openclaw_runtime_env "$1" >/dev/null 2>&1; then
        echo "invalid runtime environment unexpectedly passed: $1" >&2
        exit 1
    fi
}

write_valid
smart_load_openclaw_runtime_env "$VALID"
test "$OPENCLAW_BRIDGE_TOKEN" = \
    AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
test "$OPENCLAW_SSH_IDENTITY" = \
    /home/root/.ssh/id_dropbear_smart_remarkable_bridge
test "$OPENCLAW_LOCAL_PORT" = 18791
test "$OPENCLAW_REMOTE_PORT" = 18792
test "$SMART_REMARKABLE_MODEL" = openclaw/main
test "$RUST_LOG" = info

cp "$VALID" "$WORK/duplicate.env"
sed -i.bak \
    's/^RUST_LOG=.*/OPENCLAW_LOCAL_PORT=18791/' \
    "$WORK/duplicate.env"
expect_rejected "$WORK/duplicate.env"

cp "$VALID" "$WORK/unknown.env"
sed -i.bak 's/^RUST_LOG=.*/OPENCLAW_GATEWAY_TOKEN=forbidden/' \
    "$WORK/unknown.env"
expect_rejected "$WORK/unknown.env"

cp "$VALID" "$WORK/model.env"
sed -i.bak 's#openclaw/main#openai/gpt-5#' "$WORK/model.env"
expect_rejected "$WORK/model.env"

MARKER="$WORK/evaluated"
export MARKER
cp "$VALID" "$WORK/not-shell.env"
sed -i.bak \
    's#^OPENCLAW_BRIDGE_TOKEN=.*#OPENCLAW_BRIDGE_TOKEN=$(touch "$MARKER")#' \
    "$WORK/not-shell.env"
expect_rejected "$WORK/not-shell.env"
test ! -e "$MARKER"

cp "$VALID" "$WORK/extra.env"
printf '%s\n' 'RUST_BACKTRACE=full' >>"$WORK/extra.env"
expect_rejected "$WORK/extra.env"
