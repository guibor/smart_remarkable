#!/bin/bash
# Entirely local qualification of the Ferrari 3.28.0.169 Dispatch/AppLoad
# repaint candidate. This script has no SSH or device operation.
set -Eeuo pipefail
export LC_ALL=en_US.UTF-8

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APPLOAD_SO=${APPLOAD_SO:-/Users/mdf/code/remarkable-device-backups/0A247209DABC7917/20260730T170508Z-3.28.0.164-pre-xovi/core/appload.so}
APPLOAD_QMD=${APPLOAD_QMD:-/Users/mdf/code/remarkable-device-backups/0A247209DABC7917/20260730T170508Z-3.28.0.164-pre-xovi/core/installed-appload-9a6d55d.qmd}
STOCK_XOCHITL=${STOCK_XOCHITL:-/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.28.0.169/xochitl}
STOCK_QREX_CONFIG=${STOCK_QREX_CONFIG:-/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.28.0.169/qrex.toml}
HASHTAB=${HASHTAB:-/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.28.0.169/hashtab}
QMD_BACKUP=${QMD_BACKUP:-/Users/mdf/code/appload-rmstream-beta/.cache/notebook-ui-repair-20260918T205836Z/safety-backup.tgz}
DATES_QMD=${DATES_QMD:-/Users/mdf/code/appload-rmstream-beta/.cache/notebook-ui-repair-20260918T205836Z/notebook-date-index.qmd}
RMSTREAM_QMD=${RMSTREAM_QMD:-/Users/mdf/code/appload-rmstream-beta/.cache/notebook-ui-repair-20260918T205836Z/rmstream-shortcut.qmd}
RUNTIME_BACKUP=${RUNTIME_BACKUP:-/Users/mdf/code/remarkable-beta-os/.cache/device-backups/20260814T231159Z-33044-pro-3.28.0.169-preimages/home-runtime.tar.gz}
KNOWN_REMAGIC_LOG=${KNOWN_REMAGIC_LOG:-/Users/mdf/code/appload-rmstream-beta/.cache/notebook-ui-repair-20260918T205836Z/xochitl.log}
DISPATCH_BINARY=${DISPATCH_BINARY:-/Users/mdf/code/remarkable-device-backups/0A247209DABC7917/20260919T100629Z-dispatch-e6e2233/remarkable-dispatch.installed-e6e2233}
DISPATCH_MANIFEST=${DISPATCH_MANIFEST:-/Users/mdf/code/personal/remarkable-dispatch-app/packaging/external.manifest.json}
QREX_BIN=${QREX_BIN:-/Users/mdf/code/remarkable-beta-os/.cache/tools/qrex/target/release/qrex}
QMLDIFF_BIN=${QMLDIFF_BIN:-/Users/mdf/code/remarkable-beta-os/.cache/tools/rm-xovi-extensions/qt-resource-rebuilder/qmldiff/target/release/qmldiff}
QMLFORMAT_BIN=${QMLFORMAT_BIN:-$(command -v qmlformat 2>/dev/null || true)}

CANDIDATE=$REPO/xovi-qmd/dispatch-appload-partial-repaint-3.28.0.169.qmd
BASELINE=$REPO/xovi-qmd/dispatch-appload-partial-repaint-3.28.0.169.baseline.sha256
INSTALLER=$REPO/ops/device-install-dispatch-appload-latency-candidate.sh
ROLLBACK=$REPO/ops/rollback-dispatch-appload-latency-candidate.sh
BUILD=$REPO/ops/build-dispatch-appload-latency-candidate.sh

EXPECTED_APPLOAD_SHA256=9a6d55d21852976e7c6cf34b1d09e5ca6e428547aa8c03d53d91b1bb9ff87b9a
EXPECTED_APPLOAD_QMD_SHA256=274632b775df4005e06252fee0697a350d98224bdde9009da1616dfa0249a3f5
EXPECTED_XOCHITL_SHA256=43a9d5d0acc5b998264c16586e11b848f3b83d2d63b5fd322b09c0977d94d3d4
EXPECTED_QREX_CONFIG_SHA256=3840fe788951d3c98d75b0cd0d93e72d9663af6be24391f7b1106ee79add73d9
EXPECTED_HASHTAB_SHA256=ecb0cfbd6828c374e48139064436a12f2c04778a90192b9dd85887edbdbe256a
EXPECTED_QMD_BACKUP_SHA256=dab755a5fe8885715caa706b6d40192e9e2217244c9f51a66d61086e63f9673f
EXPECTED_DATES_QMD_SHA256=f6cba3190f3f690c2729539f0ecc3b629dd0d18366dc22fc5a89174df73731e0
EXPECTED_RMSTREAM_QMD_SHA256=3c3aad847219a7c8cc9a8dd0ca77dca0b9205974715d8081f42150c260655a96
EXPECTED_RUNTIME_BACKUP_SHA256=3b2c16b7429b256eb053de9e122fb846b739414937fb6e41db4ca6b97c1ca23d
EXPECTED_KNOWN_REMAGIC_LOG_SHA256=3f7ba16347543bd9080f8ab8c1281aa9bf998572f1605a3d022ceb61f871140f
EXPECTED_REMAGIC_SHA256=fb785d0f6a4efe3f58137b95fd979307cafa0d8d52e3e1d263d0f0df77ac81a7
EXPECTED_XOVI_START_SHA256=bf15dfd641deea3e4487b9182957938a3dc824c340383c9243b7f118bfe829dc
EXPECTED_DISPATCH_BINARY_SHA256=d700b7c8c3df4d5750d0844169a0d50324f9d7fd2a8ac4f8667a40efa26ceab4
EXPECTED_DISPATCH_MANIFEST_SHA256=4c0b0adba890becb4aa85678c3dc345a9d8909f65a5b9734b809b4746341a32c
EXPECTED_QREX_SHA256=8837ddf2d56e0596dfb1a8a75c5b43f3fff1045be10068d1de248d6418801c38
EXPECTED_QMLDIFF_SHA256=566debdf4c9e48ced5c86b03c2091cef7c12e66451d34d8b747d6c6d67d28e43
EXPECTED_BASELINE_SHA256=d09c244e58bf4097e273c4175aa29fbe4bfacae5e42d58a9f73f25f737d4fd04
EXPECTED_CANDIDATE_SHA256=1eb2037f28c9891fbdc4a97d1e2916b8e923fe04004ae1ced03b5de73f59a60e
EXPECTED_STOCK_TREE_SHA256=8cae0cb192f9cf084a3ec8603aa52d3eb620bc3ddf45afbbb1b92883269f6f75
EXPECTED_APPLOAD_TREE_SHA256=ce22bfeed299fee86db2ba08d88be60d8c472d648314cc843aa3478dfa839878
EXPECTED_PATCHED_WINDOW_SHA256=af8d378b319e6ad3633ae729425f5c4dbd3d385100835a7e23f90e8f7f9eafa7

hash_file() {
    shasum -a 256 "$1" | awk '{ print $1 }'
}

require_exact_file() {
    path=$1
    expected=$2
    label=$3
    [ -f "$path" ] && [ ! -L "$path" ] || {
        echo "$label is missing, not regular, or symlinked: $path" >&2
        exit 1
    }
    actual=$(hash_file "$path")
    [ "$actual" = "$expected" ] || {
        echo "$label hash mismatch: expected $expected, got $actual" >&2
        exit 1
    }
}

tree_hash() {
    root=$1
    (cd "$root" && find . -type f -print0 | LC_ALL=C sort -z |
        xargs -0 shasum -a 256 | shasum -a 256 | awk '{ print $1 }')
}

require_safe_path() {
    path=$1
    case "$path" in
        /*) ;;
        *) echo "input path is not absolute: $path" >&2; exit 2 ;;
    esac
    case "$path" in
        *'"'*|*'\'*|*$'\n'*|*$'\r'*)
            echo "input path contains unsupported characters: $path" >&2
            exit 2
            ;;
    esac
}

for path in "$APPLOAD_SO" "$APPLOAD_QMD" "$STOCK_XOCHITL" "$STOCK_QREX_CONFIG" \
    "$HASHTAB" "$QMD_BACKUP" "$DATES_QMD" "$RMSTREAM_QMD" "$RUNTIME_BACKUP" \
    "$KNOWN_REMAGIC_LOG" "$DISPATCH_BINARY" "$DISPATCH_MANIFEST"; do
    require_safe_path "$path"
done

require_exact_file "$APPLOAD_SO" "$EXPECTED_APPLOAD_SHA256" "AppLoad preimage"
require_exact_file "$APPLOAD_QMD" "$EXPECTED_APPLOAD_QMD_SHA256" "embedded AppLoad QMD"
require_exact_file "$STOCK_XOCHITL" "$EXPECTED_XOCHITL_SHA256" "stock xochitl"
require_exact_file "$STOCK_QREX_CONFIG" "$EXPECTED_QREX_CONFIG_SHA256" "stock qrex config"
require_exact_file "$HASHTAB" "$EXPECTED_HASHTAB_SHA256" "firmware hashtable"
require_exact_file "$QMD_BACKUP" "$EXPECTED_QMD_BACKUP_SHA256" "ten-QMD backup"
require_exact_file "$DATES_QMD" "$EXPECTED_DATES_QMD_SHA256" "current Dates QMD"
require_exact_file "$RMSTREAM_QMD" "$EXPECTED_RMSTREAM_QMD_SHA256" "current RMStream QMD"
require_exact_file "$RUNTIME_BACKUP" "$EXPECTED_RUNTIME_BACKUP_SHA256" "runtime backup"
require_exact_file "$KNOWN_REMAGIC_LOG" "$EXPECTED_KNOWN_REMAGIC_LOG_SHA256" "known ReMagic log"
require_exact_file "$DISPATCH_BINARY" "$EXPECTED_DISPATCH_BINARY_SHA256" "current Dispatch binary"
require_exact_file "$DISPATCH_MANIFEST" "$EXPECTED_DISPATCH_MANIFEST_SHA256" "Dispatch manifest"
require_exact_file "$QREX_BIN" "$EXPECTED_QREX_SHA256" "qrex"
require_exact_file "$QMLDIFF_BIN" "$EXPECTED_QMLDIFF_SHA256" "qmldiff"
require_exact_file "$BASELINE" "$EXPECTED_BASELINE_SHA256" "baseline manifest"
require_exact_file "$CANDIDATE" "$EXPECTED_CANDIDATE_SHA256" "candidate"
[ -x "$QMLFORMAT_BIN" ] || { echo "qmlformat is required" >&2; exit 1; }
bash -n "$BUILD" "$INSTALLER" "$ROLLBACK"

grep -Fqx '  "name": "Dispatch",' "$DISPATCH_MANIFEST"
grep -Fqx '  "qtfb": true,' "$DISPATCH_MANIFEST"
grep -Fqx '  "aspectRatio": "original",' "$DISPATCH_MANIFEST"
grep -Fqx '  "disablesWindowedMode": true' "$DISPATCH_MANIFEST"
grep -Fq 'systemd-run' "$INSTALLER"
grep -Fq -- '--on-active=180' "$INSTALLER"
grep -Fq 'trap rollback_on_exit EXIT' "$INSTALLER"
grep -Fq "trap 'exit 129' HUP" "$INSTALLER"
grep -Fq "trap 'exit 130' INT" "$INSTALLER"
grep -Fq "trap 'exit 143' TERM" "$INSTALLER"
grep -Fq 'unexpected target preserved; stock mode requested' "$ROLLBACK"
grep -Fq 'systemctl kill --kill-whom=all --signal=KILL "$TRANSACTION_UNIT"' "$ROLLBACK"
grep -Fq '/bin/bash "$STOCK"' "$ROLLBACK"
grep -Fq "EXPECTED_DISPATCH_BINARY_SHA256=$EXPECTED_DISPATCH_BINARY_SHA256" "$INSTALLER"
grep -Fq "EXPECTED_START_SHA256=$EXPECTED_XOVI_START_SHA256" "$INSTALLER"
grep -Fq 'EXPECTED_SERVICE_CONF_SHA256=6036f7776f8775529f94056fafe066ff373f5aa6bca39633bfd4dabfc1552ffd' "$INSTALLER"
grep -Fq 'EXPECTED_STOCK_UNIT_SHA256=23f537cf59d527bfbf4823f372385d613e1ade0961c98831c935a372018f9566' "$INSTALLER"
grep -Fq 'EXPECTED_STOCK_OVERRIDE_SHA256=a9432caffacb29d6fcb35136dcc3cb43d8737eb6c2efcb35ea335725f42082d1' "$INSTALLER"
grep -Fq 'verify_service_tree' "$INSTALLER"
grep -Fq 'no_other_mutation_active' "$INSTALLER"
grep -Fq -- '--kill-whom=WHOM' "$INSTALLER"
grep -Fq -- '--signal=SIGNAL' "$INSTALLER"
grep -Fq 'stock_surface_is_exact' "$ROLLBACK"
grep -Fq "EXPECTED_DISPATCH_MANIFEST_SHA256=$EXPECTED_DISPATCH_MANIFEST_SHA256" "$INSTALLER"
grep -Fq "exact_owned_file \"\$DISPATCH_MANIFEST\" \"\$EXPECTED_DISPATCH_MANIFEST_SHA256\" 501:20:644" "$INSTALLER"
grep -Fq "exact_owned_file \"\$DISPATCH_BINARY\" \"\$EXPECTED_DISPATCH_BINARY_SHA256\" 0:0:755" "$INSTALLER"
grep -Fq "grep -Ec '\\[qmldiff\\]: Loading file [^ ]+\\.qmd$'" "$INSTALLER"
grep -Fq "grep -Fq '[qmldiff]: Failed to load file'" "$INSTALLER"
if grep -En '(^|[^[:alnum:]_])(ssh|scp|curl|wget)([^[:alnum:]_]|$)' "$INSTALLER" "$ROLLBACK"; then
    echo "device transaction unexpectedly contains a network client" >&2
    exit 1
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/dispatch-appload-transaction.XXXXXX")
cleanup() {
    status=$?
    trap - EXIT
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$WORK/stock" "$WORK/appload" "$WORK/runtime" "$WORK/stage" "$WORK/mock-qdir"

# The exact ReMagic wrapper has no QMD-count allowlist: it starts Xovi, samples
# one stable xochitl PID, and captures the bounded journal. The pinned QRR log
# proves that the exact extension emits one deterministic Loading-file marker
# per QMD plus the affected AppLoad window marker used by the live postcheck.
tar -xzf "$RUNTIME_BACKUP" -C "$WORK/runtime" xovi/remagic-live-test-safe.sh xovi/start
require_exact_file "$WORK/runtime/xovi/remagic-live-test-safe.sh" "$EXPECTED_REMAGIC_SHA256" "extracted ReMagic wrapper"
require_exact_file "$WORK/runtime/xovi/start" "$EXPECTED_XOVI_START_SHA256" "extracted Xovi start script"
grep -Fq '/home/root/xovi/start' "$WORK/runtime/xovi/remagic-live-test-safe.sh"
grep -Fq 'journalctl -u xochitl --since "@$started" --no-pager > /tmp/remagic-live-test.log' "$WORK/runtime/xovi/remagic-live-test-safe.sh"
if grep -Ei '(qmd|qt-resource-rebuilder).*(count|wc -l|allowlist)' \
    "$WORK/runtime/xovi/remagic-live-test-safe.sh" "$WORK/runtime/xovi/start"; then
    echo "pinned ReMagic/start unexpectedly contains a QMD-count restriction" >&2
    exit 1
fi

verify_qmd_log() {
    log=$1
    expected_count=$2
    expected_candidate=$3
    [ "$(grep -Ec '\[qmldiff\]: Loading file [^ ]+\.qmd$' "$log")" = "$expected_count" ] || return 1
    while read -r _ qmd_name; do
        [ "$(grep -Fc "[qmldiff]: Loading file $qmd_name" "$log")" = 1 ] || return 1
    done <"$BASELINE"
    candidate_marker='[qmldiff]: Loading file dispatch-appload-partial-repaint-3.28.0.169.qmd'
    [ "$(grep -Fc "$candidate_marker" "$log")" = "$expected_candidate" ] || return 1
    grep -Fq '[qmldiff]: Processing file /appload/qml/window.qml...' "$log" || return 1
    ! grep -Fq '[qmldiff]: Failed to load file' "$log" || return 1
}
verify_qmd_log "$KNOWN_REMAGIC_LOG" 10 0
cp "$KNOWN_REMAGIC_LOG" "$WORK/synthetic-eleven-qmd.log"
printf '%s\n' '[qmldiff]: Loading file dispatch-appload-partial-repaint-3.28.0.169.qmd' >>"$WORK/synthetic-eleven-qmd.log"
verify_qmd_log "$WORK/synthetic-eleven-qmd.log" 11 1

# Rebuild the reviewed QMD from the exact AppLoad preimage; output remains in
# the temporary directory and must equal the checked-in candidate byte-for-byte.
"$BUILD" "$APPLOAD_SO" "$WORK/rebuilt.qmd" >/dev/null
cmp "$WORK/rebuilt.qmd" "$CANDIDATE"

# Extract stock resources from the exact xochitl rather than trusting an old
# cache directory. Only the output and binary path lines may differ.
sed \
    -e "s|^binary_path = .*|binary_path = \"$STOCK_XOCHITL\"|" \
    -e "s|^output_path = .*|output_path = \"$WORK/stock\"|" \
    "$STOCK_QREX_CONFIG" >"$WORK/stock-qrex.toml"
"$QREX_BIN" --extract --skip-dirs "$WORK/stock-qrex.toml" >/dev/null
[ "$(find "$WORK/stock" -type f | wc -l | tr -d ' ')" = 1349 ]
[ "$(tree_hash "$WORK/stock")" = "$EXPECTED_STOCK_TREE_SHA256" ]

cat >"$WORK/appload-qrex.toml" <<EOF
binary_path = "$APPLOAD_SO"
output_path = "$WORK/appload"
base_address = 0

[[resources]]
version = 3
addresses = { tree = 0x329d0, names = 0x32740, data = 0x32c90 }
EOF
"$QREX_BIN" --extract --skip-dirs "$WORK/appload-qrex.toml" >/dev/null
[ "$(find "$WORK/appload" -type f | wc -l | tr -d ' ')" = 21 ]
[ "$(tree_hash "$WORK/appload")" = "$EXPECTED_APPLOAD_TREE_SHA256" ]
cp -R "$WORK/appload/." "$WORK/stock/"

# Recover the most recent known exact ten-QMD state and refuse inventory drift.
tar -xzf "$QMD_BACKUP" -C "$WORK/runtime" xovi/exthome/qt-resource-rebuilder
RUNTIME_QDIR=$WORK/runtime/xovi/exthome/qt-resource-rebuilder
# The safety tar is the pre-transaction base. The two files next to it are the
# independently hashed, committed post-transaction Dates/RMStream artifacts.
cp "$DATES_QMD" "$RUNTIME_QDIR/notebook-date-index.qmd"
cp "$RMSTREAM_QMD" "$RUNTIME_QDIR/rmstream-shortcut.qmd"
(cd "$RUNTIME_QDIR" && shasum -a 256 -c "$BASELINE") >/dev/null
actual_names=$(find "$RUNTIME_QDIR" -maxdepth 1 -type f -name '*.qmd' -exec basename {} \; | sort)
expected_names=$(awk '{ print $2 }' "$BASELINE" | sort)
[ "$actual_names" = "$expected_names" ]

qmds=()
while read -r _ name; do
    qmds+=("$RUNTIME_QDIR/$name")
done <"$BASELINE"
"$QMLDIFF_BIN" check-compatibility "$HASHTAB" "$APPLOAD_QMD" "${qmds[@]}" "$CANDIDATE" >/dev/null

# Compose both relative AppLoad/candidate orders. Identical outputs prove this
# narrow replacement does not depend on an accidental extension load order.
"$QMLDIFF_BIN" apply-diffs --hashtab "$HASHTAB" \
    "$WORK/stock" "$WORK/composed-after" \
    "$APPLOAD_QMD" "${qmds[@]}" "$CANDIDATE" -c >"$WORK/apply-after.log"
"$QMLDIFF_BIN" apply-diffs --hashtab "$HASHTAB" \
    "$WORK/stock" "$WORK/composed-before" \
    "$CANDIDATE" "$APPLOAD_QMD" "${qmds[@]}" -c >"$WORK/apply-before.log"
diff -qr "$WORK/composed-after" "$WORK/composed-before" >/dev/null
[ "$(find "$WORK/composed-after" -type f | wc -l | tr -d ' ')" = 29 ]
[ "$(find "$WORK/composed-after" -type f -name '*.qml' | wc -l | tr -d ' ')" = 29 ]
while IFS= read -r -d '' qml; do
    "$QMLFORMAT_BIN" --ignore-settings "$qml" >/dev/null
done < <(find "$WORK/composed-after" -type f -name '*.qml' -print0)

PATCHED=$WORK/composed-after/appload/qml/window.qml
require_exact_file "$PATCHED" "$EXPECTED_PATCHED_WINDOW_SHA256" "composed AppLoad window"
[ "$(grep -c 'allowScaling:' "$PATCHED")" -eq 1 ]
grep -F 'root.fullscreen' "$PATCHED" >/dev/null
grep -F 'root.disablesWindowedMode' "$PATCHED" >/dev/null
grep -F 'root.appName === "Dispatch"' "$PATCHED" >/dev/null
grep -F 'root.scaledContentWidth === root.globalWidth' "$PATCHED" >/dev/null
grep -F 'root.scaledContentHeight === root.globalHeight' "$PATCHED" >/dev/null
grep -F 'qtfbKey !== -1' "$PATCHED" >/dev/null

# Exercise the exact file transaction in a temporary qdir: baseline, atomic
# candidate move, candidate state, exact rollback removal, baseline restored.
cp "$RUNTIME_QDIR"/*.qmd "$WORK/mock-qdir/"
(cd "$WORK/mock-qdir" && shasum -a 256 -c "$BASELINE") >/dev/null
cp "$CANDIDATE" "$WORK/mock-qdir/.candidate.ready"
chmod 0644 "$WORK/mock-qdir/.candidate.ready"
[ "$(hash_file "$WORK/mock-qdir/.candidate.ready")" = "$EXPECTED_CANDIDATE_SHA256" ]
mv "$WORK/mock-qdir/.candidate.ready" "$WORK/mock-qdir/${CANDIDATE##*/}"
[ "$(find "$WORK/mock-qdir" -maxdepth 1 -type f -name '*.qmd' | wc -l | tr -d ' ')" = 11 ]
require_exact_file "$WORK/mock-qdir/${CANDIDATE##*/}" "$EXPECTED_CANDIDATE_SHA256" "mock installed candidate"
mv "$WORK/mock-qdir/${CANDIDATE##*/}" "$WORK/mock-qdir/removed-candidate.qmd"
(cd "$WORK/mock-qdir" && shasum -a 256 -c "$BASELINE") >/dev/null

# Build the exact reviewed transfer manifest and prove one-byte input drift is
# rejected by the pinned candidate hash before a device transaction could run.
cp "$BASELINE" "$WORK/stage/baseline.sha256"
cp "$CANDIDATE" "$WORK/stage/candidate.qmd"
cp "$INSTALLER" "$WORK/stage/device-install.sh"
cp "$ROLLBACK" "$WORK/stage/rollback.sh"
chmod 0700 "$WORK/stage/device-install.sh" "$WORK/stage/rollback.sh"
(cd "$WORK/stage" && shasum -a 256 baseline.sha256 candidate.qmd device-install.sh rollback.sh >SHA256SUMS)
(cd "$WORK/stage" && shasum -a 256 -c SHA256SUMS) >/dev/null
reviewed_manifest=$(hash_file "$WORK/stage/SHA256SUMS")
cp "$WORK/stage/candidate.qmd" "$WORK/tampered.qmd"
printf '\n' >>"$WORK/tampered.qmd"
[ "$(hash_file "$WORK/tampered.qmd")" != "$EXPECTED_CANDIDATE_SHA256" ]

printf 'dry_run=passed\n'
printf 'firmware=3.28.0.169\n'
printf 'candidate_sha256=%s\n' "$EXPECTED_CANDIDATE_SHA256"
printf 'baseline_sha256=%s\n' "$EXPECTED_BASELINE_SHA256"
printf 'patched_window_sha256=%s\n' "$EXPECTED_PATCHED_WINDOW_SHA256"
printf 'stage_manifest_sha256=%s\n' "$reviewed_manifest"
printf 'watchdog=systemd-timer-180s-plus-remagic-wrapper-signal-exit\n'
printf 'device_contact=none\n'
