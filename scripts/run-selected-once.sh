#!/bin/sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TRIGGER=/tmp/llm_button_trigger

rm -f "$TRIGGER"
(
    sleep "${SMART_REMARKABLE_TRIGGER_DELAY:-2}"
    : > "$TRIGGER"
) &

cd "$HERE"
exec ./smart_remarkable \
    --select-mode \
    --engine openai \
    --model "${SMART_REMARKABLE_MODEL:-gpt-4o-mini}" \
    --no-loop \
    --no-draw-progress \
    "$@"
