#!/bin/sh
set -eu

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$REPO/scripts/mode-settings.sh"

assert_mode() {
    SMART_REMARKABLE_SETTINGS_FILE="$REPO/tests/fixtures/mode-$1.conf"
    export SMART_REMARKABLE_SETTINGS_FILE
    smart_load_mode_settings
    test "$SMART_MODE" = "$1"
    test "$SMART_TRIGGER_CORNER" = "$2"
    test "$SMART_NO_LOOP" = "$3"
    test "$SMART_RUNTIME_MAX_SECONDS" = "$4"
}

assert_mode once pen-release 1 600
assert_mode session-hold pen-hold 0 3300
assert_mode session-auto pen-release 0 3600

SMART_REMARKABLE_SETTINGS_FILE="$REPO/tests/fixtures/mode-invalid.conf"
export SMART_REMARKABLE_SETTINGS_FILE
if smart_load_mode_settings >/dev/null 2>&1; then
    echo "invalid mode unexpectedly passed validation" >&2
    exit 1
fi
