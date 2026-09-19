#!/bin/bash
set -Eeuo pipefail
export LC_ALL=en_US.UTF-8

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APLOAD_SO=${1:-}
OUTPUT=${2:-$REPO/xovi-qmd/dispatch-appload-partial-repaint-3.28.0.169.qmd}
SOURCE=$REPO/xovi-qmd/dispatch-appload-partial-repaint-3.28.0.169.source.qmd
QREX_BIN=${QREX_BIN:-/Users/mdf/code/remarkable-beta-os/.cache/tools/qrex/target/release/qrex}
QMLDIFF_BIN=${QMLDIFF_BIN:-/Users/mdf/code/remarkable-beta-os/.cache/tools/rm-xovi-extensions/qt-resource-rebuilder/qmldiff/target/release/qmldiff}
QMLFORMAT_BIN=${QMLFORMAT_BIN:-$(command -v qmlformat 2>/dev/null || true)}
HASHTAB=${HASHTAB:-/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.28.0.169/hashtab}

EXPECTED_APPLOAD_SHA256=9a6d55d21852976e7c6cf34b1d09e5ca6e428547aa8c03d53d91b1bb9ff87b9a
EXPECTED_WINDOW_SHA256=848b234015d2d8671648b6b661e57cdd3b51d80c537c38cb053e503cf3a95c30
EXPECTED_HASHTAB_SHA256=ecb0cfbd6828c374e48139064436a12f2c04778a90192b9dd85887edbdbe256a
EXPECTED_SOURCE_SHA256=424b1ca4859e38de5dc07e5e33a7c18a532a61fb821edbe9a3cbce3985e12e6e
EXPECTED_CANDIDATE_SHA256=1eb2037f28c9891fbdc4a97d1e2916b8e923fe04004ae1ced03b5de73f59a60e

usage() {
    cat >&2 <<'EOF'
usage: build-dispatch-appload-latency-candidate.sh /absolute/path/to/appload.so [output.qmd]

The AppLoad input must be the exact installed Ferrari preimage. The script
extracts its embedded window.qml, hashes the source diff only against the
reviewed 3.28.0.169 hashtable, applies the candidate offline, parses the result,
and writes the candidate only after every pinned hash matches.
EOF
    exit 2
}

hash_file() {
    shasum -a 256 "$1" | awk '{print $1}'
}

require_exact_file() {
    file=$1
    expected=$2
    label=$3
    [ -f "$file" ] && [ ! -L "$file" ] || {
        echo "$label is missing, not regular, or symlinked: $file" >&2
        exit 1
    }
    actual=$(hash_file "$file")
    [ "$actual" = "$expected" ] || {
        echo "$label hash mismatch: expected $expected, got $actual" >&2
        exit 1
    }
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
case "$APLOAD_SO" in
    /*) ;;
    *) usage ;;
esac
case "$APLOAD_SO" in
    *'"'*|*'\\'*|*$'\n'*|*$'\r'*)
        echo "AppLoad path contains characters unsupported by the pinned qrex config" >&2
        exit 1
        ;;
esac

require_exact_file "$APLOAD_SO" "$EXPECTED_APPLOAD_SHA256" "AppLoad binary"
require_exact_file "$HASHTAB" "$EXPECTED_HASHTAB_SHA256" "3.28.0.169 hashtable"
require_exact_file "$SOURCE" "$EXPECTED_SOURCE_SHA256" "candidate source"
[ -x "$QREX_BIN" ] && [ ! -L "$QREX_BIN" ] || {
    echo "Pinned qrex executable is unavailable: $QREX_BIN" >&2
    exit 1
}
[ -x "$QMLDIFF_BIN" ] && [ ! -L "$QMLDIFF_BIN" ] || {
    echo "Pinned qmldiff executable is unavailable: $QMLDIFF_BIN" >&2
    exit 1
}
[ -n "$QMLFORMAT_BIN" ] && [ -x "$QMLFORMAT_BIN" ] || {
    echo "qmlformat is required for the offline parse gate" >&2
    exit 1
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/dispatch-appload-latency.XXXXXX")
cleanup() {
    status=$?
    trap - EXIT
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT HUP INT TERM

cat >"$WORK/qrex.toml" <<EOF
binary_path = "$APLOAD_SO"
output_path = "$WORK/resources"
base_address = 0

[[resources]]
version = 3
addresses = { tree = 0x329d0, names = 0x32740, data = 0x32c90 }
EOF

mkdir -p "$WORK/resources" "$WORK/applied"
"$QREX_BIN" --extract --skip-dirs "$WORK/qrex.toml" >/dev/null
WINDOW=$WORK/resources/appload/qml/window.qml
require_exact_file "$WINDOW" "$EXPECTED_WINDOW_SHA256" "embedded AppLoad window.qml"

cp "$SOURCE" "$WORK/candidate.qmd"
"$QMLDIFF_BIN" hash-diffs "$HASHTAB" "$WORK/candidate.qmd"
require_exact_file "$WORK/candidate.qmd" "$EXPECTED_CANDIDATE_SHA256" "compiled candidate"
"$QMLDIFF_BIN" check-compatibility "$HASHTAB" "$WORK/candidate.qmd"
"$QMLDIFF_BIN" apply-diffs \
    --hashtab "$HASHTAB" \
    "$WORK/resources" "$WORK/applied" "$WORK/candidate.qmd" -c \
    >"$WORK/apply.log"

PATCHED=$WORK/applied/appload/qml/window.qml
[ -f "$PATCHED" ] && [ ! -L "$PATCHED" ] || {
    echo "qmldiff did not emit the patched AppLoad window" >&2
    exit 1
}
test "$(grep -c 'allowScaling: !(root.fullscreen' "$PATCHED")" -eq 1
grep -F 'root.disablesWindowedMode' "$PATCHED" >/dev/null
grep -F 'root.appName === "Dispatch"' "$PATCHED" >/dev/null
grep -F 'root.scaledContentWidth === root.globalWidth' "$PATCHED" >/dev/null
grep -F 'root.scaledContentHeight === root.globalHeight' "$PATCHED" >/dev/null
grep -F 'qtfbKey !== -1' "$PATCHED" >/dev/null
"$QMLFORMAT_BIN" --ignore-settings "$PATCHED" >/dev/null

mkdir -p "$(dirname -- "$OUTPUT")"
cp "$WORK/candidate.qmd" "$WORK/output.qmd"
chmod 0644 "$WORK/output.qmd"
mv "$WORK/output.qmd" "$OUTPUT"
require_exact_file "$OUTPUT" "$EXPECTED_CANDIDATE_SHA256" "written candidate"

printf 'candidate=%s\n' "$OUTPUT"
printf 'candidate_sha256=%s\n' "$EXPECTED_CANDIDATE_SHA256"
printf 'source_sha256=%s\n' "$EXPECTED_SOURCE_SHA256"
printf 'appload_sha256=%s\n' "$EXPECTED_APPLOAD_SHA256"
printf 'window_sha256=%s\n' "$EXPECTED_WINDOW_SHA256"
printf 'hashtab_sha256=%s\n' "$EXPECTED_HASHTAB_SHA256"
printf 'offline_apply=passed\n'
