#!/bin/bash
# Complete device-free qualification for the Ferrari 3.28.0.169 Dispatch
# notebook/PDF shortcut. No command in this file contacts the tablet.
set -Eeuo pipefail
export LC_ALL=en_US.UTF-8

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APPLOAD_SO=${APPLOAD_SO:-/Users/mdf/code/remarkable-device-backups/0A247209DABC7917/20260730T170508Z-3.28.0.164-pre-xovi/core/appload.so}
APPLOAD_QMD=${APPLOAD_QMD:-/Users/mdf/code/remarkable-device-backups/0A247209DABC7917/20260730T170508Z-3.28.0.164-pre-xovi/core/installed-appload-9a6d55d.qmd}
STOCK_XOCHITL=${STOCK_XOCHITL:-/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.28.0.169/xochitl}
STOCK_QREX_CONFIG=${STOCK_QREX_CONFIG:-/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.28.0.169/qrex.toml}
HASHTAB=${HASHTAB:-/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.28.0.169/hashtab}
QMD_BACKUP=${QMD_BACKUP:-/Users/mdf/code/appload-rmstream-beta/.cache/notebook-ui-repair-20260918T205836Z/safety-backup.tgz}
DATES_QMD=${DATES_QMD:-/Users/mdf/code/notebook-date-index/.cache/dates-navigation-20260919T111620Z/notebook-date-index.qmd}
RMSTREAM_QMD=${RMSTREAM_QMD:-/Users/mdf/code/appload-rmstream-beta/.cache/notebook-ui-repair-20260918T205836Z/rmstream-shortcut.qmd}
QREX_BIN=${QREX_BIN:-/Users/mdf/code/remarkable-beta-os/.cache/tools/qrex/target/release/qrex}
QMLDIFF_BIN=${QMLDIFF_BIN:-/Users/mdf/code/remarkable-beta-os/.cache/tools/rm-xovi-extensions/qt-resource-rebuilder/qmldiff/target/release/qmldiff}
QMLFORMAT_BIN=${QMLFORMAT_BIN:-$(command -v qmlformat 2>/dev/null || true)}
QML_BIN=${QML_BIN:-$(command -v qml 2>/dev/null || true)}

BASELINE=$REPO/xovi-qmd/dispatch-document-menu-3.28.0.169.baseline.sha256
LATENCY_QMD=$REPO/xovi-qmd/dispatch-appload-partial-repaint-3.28.0.169.qmd
FUNCTIONAL=$REPO/xovi-qmd/dispatch-document-menu-3.28.0.169.qmd
INERT=$REPO/xovi-qmd/dispatch-document-menu-inert-3.28.0.169.qmd
PANEL=$REPO/qml/DispatchLauncher.qml
BUILD=$REPO/ops/build-dispatch-document-menu-candidate.sh

EXPECTED_APPLOAD_SHA256=9a6d55d21852976e7c6cf34b1d09e5ca6e428547aa8c03d53d91b1bb9ff87b9a
EXPECTED_APPLOAD_QMD_SHA256=274632b775df4005e06252fee0697a350d98224bdde9009da1616dfa0249a3f5
EXPECTED_APPLOAD_QML_SHA256=d90e6764f141bcf6bd9b1d30c77acf2170a06c1aa8f11fb52ba1e8b38a5ee1f2
EXPECTED_WINDOW_QML_SHA256=848b234015d2d8671648b6b661e57cdd3b51d80c537c38cb053e503cf3a95c30
EXPECTED_XOCHITL_SHA256=43a9d5d0acc5b998264c16586e11b848f3b83d2d63b5fd322b09c0977d94d3d4
EXPECTED_QREX_CONFIG_SHA256=3840fe788951d3c98d75b0cd0d93e72d9663af6be24391f7b1106ee79add73d9
EXPECTED_HASHTAB_SHA256=ecb0cfbd6828c374e48139064436a12f2c04778a90192b9dd85887edbdbe256a
EXPECTED_QMD_BACKUP_SHA256=dab755a5fe8885715caa706b6d40192e9e2217244c9f51a66d61086e63f9673f
EXPECTED_DATES_QMD_SHA256=2d4681414ac00b534b2f21d179365601ce9e876c7cfbf6c6c8d25a2f8738e580
EXPECTED_RMSTREAM_QMD_SHA256=3c3aad847219a7c8cc9a8dd0ca77dca0b9205974715d8081f42150c260655a96
EXPECTED_QREX_SHA256=8837ddf2d56e0596dfb1a8a75c5b43f3fff1045be10068d1de248d6418801c38
EXPECTED_QMLDIFF_SHA256=566debdf4c9e48ced5c86b03c2091cef7c12e66451d34d8b747d6c6d67d28e43
EXPECTED_BASELINE_SHA256=0f19ada5bd92364e61a2abeefae79a14171fbebc0f498813123fe3e60d7eed9d
EXPECTED_LATENCY_QMD_SHA256=1eb2037f28c9891fbdc4a97d1e2916b8e923fe04004ae1ced03b5de73f59a60e
EXPECTED_FUNCTIONAL_SHA256=883f275b59736e92cf55e0d49c39a649ed3ea66f2bb7500a88d54659f655aece
EXPECTED_INERT_SHA256=5a685b3142a339b370436c8f6563344d4b4684ddbab3f288f812ab6087a32fc1
EXPECTED_PANEL_SHA256=bf05247511a245fdc84fae41e03a8a2b749ad1d3ef622470a59da76646e8b0f7
EXPECTED_PATCHED_WINDOW_SHA256=af8d378b319e6ad3633ae729425f5c4dbd3d385100835a7e23f90e8f7f9eafa7

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

for triple in \
    "$APPLOAD_SO|$EXPECTED_APPLOAD_SHA256|AppLoad preimage" \
    "$APPLOAD_QMD|$EXPECTED_APPLOAD_QMD_SHA256|embedded AppLoad QMD" \
    "$STOCK_XOCHITL|$EXPECTED_XOCHITL_SHA256|stock xochitl" \
    "$STOCK_QREX_CONFIG|$EXPECTED_QREX_CONFIG_SHA256|stock qrex config" \
    "$HASHTAB|$EXPECTED_HASHTAB_SHA256|firmware hashtable" \
    "$QMD_BACKUP|$EXPECTED_QMD_BACKUP_SHA256|QMD backup" \
    "$DATES_QMD|$EXPECTED_DATES_QMD_SHA256|Dates QMD" \
    "$RMSTREAM_QMD|$EXPECTED_RMSTREAM_QMD_SHA256|RMStream QMD" \
    "$QREX_BIN|$EXPECTED_QREX_SHA256|qrex" \
    "$QMLDIFF_BIN|$EXPECTED_QMLDIFF_SHA256|qmldiff" \
    "$BASELINE|$EXPECTED_BASELINE_SHA256|eleven-QMD baseline" \
    "$LATENCY_QMD|$EXPECTED_LATENCY_QMD_SHA256|accepted latency QMD" \
    "$FUNCTIONAL|$EXPECTED_FUNCTIONAL_SHA256|functional shortcut QMD" \
    "$INERT|$EXPECTED_INERT_SHA256|inert shortcut QMD" \
    "$PANEL|$EXPECTED_PANEL_SHA256|Dispatch launcher panel"; do
    IFS='|' read -r path expected label <<<"$triple"
    require_exact_file "$path" "$expected" "$label"
done
[ -n "$QMLFORMAT_BIN" ] && [ -x "$QMLFORMAT_BIN" ] || { echo "qmlformat is required" >&2; exit 1; }
[ -n "$QML_BIN" ] && [ -x "$QML_BIN" ] || { echo "qml is required" >&2; exit 1; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/dispatch-document-menu-test.XXXXXX")
cleanup() {
    local status=$?
    trap - EXIT
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$WORK/stock" "$WORK/appload" "$WORK/runtime" "$WORK/rebuilt"

"$BUILD" "$WORK/rebuilt/functional.qmd" "$WORK/rebuilt/inert.qmd" >/dev/null
cmp "$WORK/rebuilt/functional.qmd" "$FUNCTIONAL"
cmp "$WORK/rebuilt/inert.qmd" "$INERT"

sed \
    -e "s|^binary_path = .*|binary_path = \"$STOCK_XOCHITL\"|" \
    -e "s|^output_path = .*|output_path = \"$WORK/stock\"|" \
    "$STOCK_QREX_CONFIG" >"$WORK/stock-qrex.toml"
"$QREX_BIN" --extract --skip-dirs "$WORK/stock-qrex.toml" >/dev/null

cat >"$WORK/appload-qrex.toml" <<EOF
binary_path = "$APPLOAD_SO"
output_path = "$WORK/appload"
base_address = 0

[[resources]]
version = 3
addresses = { tree = 0x329d0, names = 0x32740, data = 0x32c90 }
EOF
"$QREX_BIN" --extract --skip-dirs "$WORK/appload-qrex.toml" >/dev/null
require_exact_file "$WORK/appload/appload/qml/appload.qml" "$EXPECTED_APPLOAD_QML_SHA256" "embedded appload.qml"
require_exact_file "$WORK/appload/appload/qml/window.qml" "$EXPECTED_WINDOW_QML_SHA256" "embedded window.qml"
cp -R "$WORK/appload/." "$WORK/stock/"

tar -xzf "$QMD_BACKUP" -C "$WORK/runtime" xovi/exthome/qt-resource-rebuilder
RUNTIME_QDIR=$WORK/runtime/xovi/exthome/qt-resource-rebuilder
cp "$DATES_QMD" "$RUNTIME_QDIR/notebook-date-index.qmd"
cp "$RMSTREAM_QMD" "$RUNTIME_QDIR/rmstream-shortcut.qmd"
cp "$LATENCY_QMD" "$RUNTIME_QDIR/dispatch-appload-partial-repaint-3.28.0.169.qmd"
(cd "$RUNTIME_QDIR" && shasum -a 256 -c "$BASELINE") >/dev/null
actual_names=$(find "$RUNTIME_QDIR" -maxdepth 1 -type f -name '*.qmd' -exec basename {} \; | sort)
expected_names=$(awk '{ print $2 }' "$BASELINE" | sort)
[ "$actual_names" = "$expected_names" ]
[ "$(printf '%s\n' "$actual_names" | sed '/^$/d' | wc -l | tr -d ' ')" -eq 11 ]

mapfile_compat=()
while IFS= read -r qmd; do
    mapfile_compat+=("$qmd")
done < <(find "$RUNTIME_QDIR" -maxdepth 1 -type f -name '*.qmd' | LC_ALL=C sort)
"$QMLDIFF_BIN" check-compatibility "$HASHTAB" "$APPLOAD_QMD" "${mapfile_compat[@]}" "$FUNCTIONAL" "$INERT" >/dev/null

verify_composed_tree() {
    local tree=$1
    local expected_enabled=$2
    local menu=$tree/qt/qml/xofm/libs/toolbar/qml/SettingsMenu.qml
    local values=$tree/qml/common/Values.qml
    local main=$tree/qml/device/view/main/MainView.qml
    local window=$tree/appload/qml/window.qml

    while IFS= read -r -d '' qml; do
        "$QMLFORMAT_BIN" --ignore-settings "$qml" >/dev/null
    done < <(find "$tree" -type f -name '*.qml' -print0)

    [ "$(grep -c 'label: "Dispatch"' "$menu")" -eq 1 ]
    [ "$(grep -c 'label: "Dates"' "$menu")" -eq 1 ]
    [ "$(grep -c '"Start screen sharing"' "$menu")" -eq 1 ]
    grep -F 'visible: root.documentType==="note"||root.documentType==="pdf"' "$menu" >/dev/null
    grep -F 'shouldShow: root.documentType==="note"||root.documentType==="pdf"' "$menu" >/dev/null
    grep -F 'iconSource: "qrc:/ark/icons/send"' "$menu" >/dev/null
    if [ "$expected_enabled" = functional ]; then
        [ "$(grep -c 'signal dispatchOpenRequested()' "$values")" -eq 1 ]
        [ "$(grep -c 'DispatchLauncher.qml' "$main")" -eq 1 ]
        [ "$(grep -c 'Values.dispatchOpenRequested()' "$menu")" -eq 1 ]
        grep -F '!root.documentViewActive' "$main" >/dev/null
    else
        ! grep -F 'signal dispatchOpenRequested()' "$values" >/dev/null
        ! grep -F 'DispatchLauncher.qml' "$main" >/dev/null
        grep -F 'enabled: false' "$menu" >/dev/null
    fi
    grep -F 'requestTableOfContents(true)' "$tree/qml/device/view/documentview/DocumentView.qml" >/dev/null
    grep -F 'rmstreamShortcutLoader' "$main" >/dev/null
    grep -F 'windowParent' "$main" >/dev/null
    require_exact_file "$window" "$EXPECTED_PATCHED_WINDOW_SHA256" "preserved partial-repaint window"
    [ "$(grep -c 'allowScaling:' "$window")" -eq 1 ]
    grep -F 'root.appName === "Dispatch"' "$window" >/dev/null
    grep -F 'root.scaledContentWidth === root.globalWidth' "$window" >/dev/null
    grep -F 'root.scaledContentHeight === root.globalHeight' "$window" >/dev/null
}

# Exact filename-sorted qdir order with AppLoad's embedded QMD first.
cp "$FUNCTIONAL" "$RUNTIME_QDIR/dispatch-document-menu-3.28.0.169.qmd"
actual_qmds=()
while IFS= read -r qmd; do actual_qmds+=("$qmd"); done < <(find "$RUNTIME_QDIR" -maxdepth 1 -type f -name '*.qmd' | LC_ALL=C sort)
"$QMLDIFF_BIN" apply-diffs --hashtab "$HASHTAB" \
    "$WORK/stock" "$WORK/composed-actual" "$APPLOAD_QMD" "${actual_qmds[@]}" -c >/dev/null
verify_composed_tree "$WORK/composed-actual" functional

# Exercise every relative order of the three MainView/Values/SettingsMenu
# shortcut QMDs, with AppLoad's embedded QMD both before and after them.
fixed_qmds=()
for qmd in "${mapfile_compat[@]}"; do
    case "${qmd##*/}" in
        notebook-date-index.qmd|rmstream-shortcut.qmd) ;;
        *) fixed_qmds+=("$qmd") ;;
    esac
done
orders=(
    "dates rmstream dispatch"
    "dates dispatch rmstream"
    "rmstream dates dispatch"
    "rmstream dispatch dates"
    "dispatch dates rmstream"
    "dispatch rmstream dates"
)
for app_order in first last; do
    for order in "${orders[@]}"; do
        specials=()
        for name in $order; do
            case "$name" in
                dates) specials+=("$DATES_QMD") ;;
                rmstream) specials+=("$RMSTREAM_QMD") ;;
                dispatch) specials+=("$FUNCTIONAL") ;;
            esac
        done
        output="$WORK/permutation-$app_order-${order// /-}"
        if [ "$app_order" = first ]; then
            args=("$APPLOAD_QMD" "${fixed_qmds[@]}" "${specials[@]}")
        else
            args=("${fixed_qmds[@]}" "${specials[@]}" "$APPLOAD_QMD")
        fi
        "$QMLDIFF_BIN" apply-diffs --hashtab "$HASHTAB" "$WORK/stock" "$output" "${args[@]}" -c >/dev/null
        verify_composed_tree "$output" functional
    done
done

# Inert canary composes with the same exact stack but has no launch signal,
# controller loader, or enabled action.
rm "$RUNTIME_QDIR/dispatch-document-menu-3.28.0.169.qmd"
cp "$INERT" "$RUNTIME_QDIR/dispatch-document-menu-3.28.0.169.qmd"
inert_qmds=()
while IFS= read -r qmd; do inert_qmds+=("$qmd"); done < <(find "$RUNTIME_QDIR" -maxdepth 1 -type f -name '*.qmd' | LC_ALL=C sort)
"$QMLDIFF_BIN" apply-diffs --hashtab "$HASHTAB" \
    "$WORK/stock" "$WORK/composed-inert" "$APPLOAD_QMD" "${inert_qmds[@]}" -c >/dev/null
verify_composed_tree "$WORK/composed-inert" inert

"$QMLDIFF_BIN" apply-diffs --hashtab "$HASHTAB" --version 3.28.0.168 \
    "$WORK/stock" "$WORK/wrong-version" "$FUNCTIONAL" -c >/dev/null
[ "$(find "$WORK/wrong-version" -type f | wc -l | tr -d ' ')" -eq 0 ]

node "$REPO/tests/dispatch-document-menu-harness.mjs" "$WORK/harness"
QML_IMPORT_PATH="$WORK/harness/mocks" \
    QT_QUICK_CONTROLS_STYLE=Basic \
    QT_QPA_PLATFORM=offscreen \
    QT_QUICK_BACKEND=software \
    "$QML_BIN" --disable-context-sharing "$WORK/harness/dispatch-harness.qml" \
    >"$WORK/dispatch-harness.log" 2>&1
grep -Fq 'Dispatch document-menu runtime PASSED' "$WORK/dispatch-harness.log"
if grep -Eq 'ReferenceError|TypeError|Cannot assign|is not a type' "$WORK/dispatch-harness.log"; then
    cat "$WORK/dispatch-harness.log" >&2
    exit 1
fi

printf 'dispatch_document_menu_tests=passed\n'
printf 'firmware=3.28.0.169\n'
printf 'baseline_qmd_count=11\n'
printf 'candidate_qmd_count=12\n'
printf 'latency_qmd_sha256=%s\n' "$EXPECTED_LATENCY_QMD_SHA256"
printf 'functional_qmd_sha256=%s\n' "$EXPECTED_FUNCTIONAL_SHA256"
printf 'inert_qmd_sha256=%s\n' "$EXPECTED_INERT_SHA256"
printf 'panel_sha256=%s\n' "$EXPECTED_PANEL_SHA256"
printf 'device_contact=none\n'
