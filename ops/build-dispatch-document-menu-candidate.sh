#!/bin/bash
# Build the inert and functional Ferrari 3.28.0.169 Dispatch document-menu
# QMDs from source. This script is local-only and never contacts the tablet.
set -Eeuo pipefail
export LC_ALL=en_US.UTF-8

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HASHTAB=${HASHTAB:-/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.28.0.169/hashtab}
RESOURCES=${RESOURCES:-/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.28.0.169/resources}
QMLDIFF_BIN=${QMLDIFF_BIN:-/Users/mdf/code/remarkable-beta-os/.cache/tools/rm-xovi-extensions/qt-resource-rebuilder/qmldiff/target/release/qmldiff}
QMLFORMAT_BIN=${QMLFORMAT_BIN:-$(command -v qmlformat 2>/dev/null || true)}

FUNCTIONAL_SOURCE=$REPO/xovi-qmd/dispatch-document-menu-3.28.0.169.source.qmd
INERT_SOURCE=$REPO/xovi-qmd/dispatch-document-menu-inert-3.28.0.169.source.qmd
FUNCTIONAL_OUTPUT=${1:-$REPO/xovi-qmd/dispatch-document-menu-3.28.0.169.qmd}
INERT_OUTPUT=${2:-$REPO/xovi-qmd/dispatch-document-menu-inert-3.28.0.169.qmd}
PANEL=$REPO/qml/DispatchLauncher.qml
BASELINE=$REPO/xovi-qmd/dispatch-document-menu-3.28.0.169.baseline.sha256

EXPECTED_HASHTAB_SHA256=ecb0cfbd6828c374e48139064436a12f2c04778a90192b9dd85887edbdbe256a
EXPECTED_QMLDIFF_SHA256=566debdf4c9e48ced5c86b03c2091cef7c12e66451d34d8b747d6c6d67d28e43
EXPECTED_FUNCTIONAL_SOURCE_SHA256=561630343088049c58a35b4ae7143471dfcdcd703b267c87a2e1a86220d95819
EXPECTED_INERT_SOURCE_SHA256=8265c28ff41aa634915e3ce99691fea3b65b08366868f386731077a0197300ec
EXPECTED_FUNCTIONAL_SHA256=883f275b59736e92cf55e0d49c39a649ed3ea66f2bb7500a88d54659f655aece
EXPECTED_INERT_SHA256=5a685b3142a339b370436c8f6563344d4b4684ddbab3f288f812ab6087a32fc1
EXPECTED_PANEL_SHA256=bf05247511a245fdc84fae41e03a8a2b749ad1d3ef622470a59da76646e8b0f7
EXPECTED_BASELINE_SHA256=0f19ada5bd92364e61a2abeefae79a14171fbebc0f498813123fe3e60d7eed9d

hash_file() {
    shasum -a 256 "$1" | awk '{ print $1 }'
}

require_exact_file() {
    local path=$1
    local expected=$2
    local label=$3
    [ -f "$path" ] && [ ! -L "$path" ] || {
        echo "$label is missing, not regular, or symlinked: $path" >&2
        exit 1
    }
    local actual
    actual=$(hash_file "$path")
    [ "$actual" = "$expected" ] || {
        echo "$label hash mismatch: expected $expected, got $actual" >&2
        exit 1
    }
}

require_exact_file "$HASHTAB" "$EXPECTED_HASHTAB_SHA256" "3.28.0.169 hashtable"
require_exact_file "$QMLDIFF_BIN" "$EXPECTED_QMLDIFF_SHA256" "qmldiff"
require_exact_file "$FUNCTIONAL_SOURCE" "$EXPECTED_FUNCTIONAL_SOURCE_SHA256" "functional source"
require_exact_file "$INERT_SOURCE" "$EXPECTED_INERT_SOURCE_SHA256" "inert source"
require_exact_file "$PANEL" "$EXPECTED_PANEL_SHA256" "Dispatch launcher panel"
require_exact_file "$BASELINE" "$EXPECTED_BASELINE_SHA256" "eleven-QMD baseline"
[ -d "$RESOURCES" ] && [ ! -L "$RESOURCES" ] || {
    echo "exact firmware resources are unavailable: $RESOURCES" >&2
    exit 1
}
[ -n "$QMLFORMAT_BIN" ] && [ -x "$QMLFORMAT_BIN" ] || {
    echo "qmlformat is required for the parse gate" >&2
    exit 1
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/dispatch-document-menu-build.XXXXXX")
cleanup() {
    local status=$?
    trap - EXIT
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT HUP INT TERM

cp "$FUNCTIONAL_SOURCE" "$WORK/functional.qmd"
cp "$INERT_SOURCE" "$WORK/inert.qmd"
"$QMLDIFF_BIN" hash-diffs "$HASHTAB" "$WORK/functional.qmd"
"$QMLDIFF_BIN" hash-diffs "$HASHTAB" "$WORK/inert.qmd"
require_exact_file "$WORK/functional.qmd" "$EXPECTED_FUNCTIONAL_SHA256" "compiled functional QMD"
require_exact_file "$WORK/inert.qmd" "$EXPECTED_INERT_SHA256" "compiled inert QMD"
"$QMLDIFF_BIN" check-compatibility "$HASHTAB" "$WORK/functional.qmd"
"$QMLDIFF_BIN" check-compatibility "$HASHTAB" "$WORK/inert.qmd"

"$QMLDIFF_BIN" apply-diffs --hashtab "$HASHTAB" \
    "$RESOURCES" "$WORK/functional-tree" "$WORK/functional.qmd" -c >"$WORK/functional.log"
"$QMLDIFF_BIN" apply-diffs --hashtab "$HASHTAB" \
    "$RESOURCES" "$WORK/inert-tree" "$WORK/inert.qmd" -c >"$WORK/inert.log"

while IFS= read -r -d '' qml; do
    "$QMLFORMAT_BIN" --ignore-settings "$qml" >/dev/null
done < <(find "$WORK/functional-tree" "$WORK/inert-tree" -type f -name '*.qml' -print0)
"$QMLFORMAT_BIN" --ignore-settings "$PANEL" >/dev/null

FUNCTIONAL_MENU=$WORK/functional-tree/qt/qml/xofm/libs/toolbar/qml/SettingsMenu.qml
INERT_MENU=$WORK/inert-tree/qt/qml/xofm/libs/toolbar/qml/SettingsMenu.qml
FUNCTIONAL_VALUES=$WORK/functional-tree/qml/common/Values.qml
FUNCTIONAL_MAIN=$WORK/functional-tree/qml/device/view/main/MainView.qml

[ "$(grep -c 'label: "Dispatch"' "$FUNCTIONAL_MENU")" -eq 1 ]
[ "$(grep -c 'label: "Dispatch"' "$INERT_MENU")" -eq 1 ]
grep -F 'visible: root.documentType==="note"||root.documentType==="pdf"' "$FUNCTIONAL_MENU" >/dev/null
grep -F 'shouldShow: root.documentType==="note"||root.documentType==="pdf"' "$FUNCTIONAL_MENU" >/dev/null
grep -F 'iconSource: "qrc:/ark/icons/send"' "$FUNCTIONAL_MENU" >/dev/null
grep -F 'Values.dispatchOpenRequested()' "$FUNCTIONAL_MENU" >/dev/null
grep -F 'enabled: false' "$INERT_MENU" >/dev/null
! grep -F 'dispatchOpenRequested' "$INERT_MENU" >/dev/null
grep -F 'signal dispatchOpenRequested()' "$FUNCTIONAL_VALUES" >/dev/null
grep -F 'file:///home/root/.local/lib/remarkable-dispatch-shortcut/DispatchLauncher.qml' "$FUNCTIONAL_MAIN" >/dev/null
grep -F '{appRoot: root, appWindowsRoot: navigator}' "$FUNCTIONAL_MAIN" >/dev/null

mkdir -p "$(dirname -- "$FUNCTIONAL_OUTPUT")" "$(dirname -- "$INERT_OUTPUT")"
cp "$WORK/functional.qmd" "$WORK/functional.ready"
cp "$WORK/inert.qmd" "$WORK/inert.ready"
chmod 0644 "$WORK/functional.ready" "$WORK/inert.ready"
mv "$WORK/functional.ready" "$FUNCTIONAL_OUTPUT"
mv "$WORK/inert.ready" "$INERT_OUTPUT"
require_exact_file "$FUNCTIONAL_OUTPUT" "$EXPECTED_FUNCTIONAL_SHA256" "written functional QMD"
require_exact_file "$INERT_OUTPUT" "$EXPECTED_INERT_SHA256" "written inert QMD"

printf 'functional=%s\n' "$FUNCTIONAL_OUTPUT"
printf 'functional_sha256=%s\n' "$EXPECTED_FUNCTIONAL_SHA256"
printf 'inert=%s\n' "$INERT_OUTPUT"
printf 'inert_sha256=%s\n' "$EXPECTED_INERT_SHA256"
printf 'panel_sha256=%s\n' "$EXPECTED_PANEL_SHA256"
printf 'firmware=3.28.0.169\n'
printf 'offline_apply=passed\n'
