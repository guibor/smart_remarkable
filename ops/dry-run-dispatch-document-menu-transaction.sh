#!/bin/bash
# Entirely local qualification and transaction simulation for the exact
# Ferrari 3.28.0.169 Dispatch notebook/PDF menu shortcut. No command in this
# file contacts a tablet or any network service.
set -Eeuo pipefail
export LC_ALL=en_US.UTF-8
umask 077

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST=$REPO/tests/dispatch-document-menu-test.sh
INSTALLER=$REPO/ops/device-install-dispatch-document-menu-candidate.sh
ROLLBACK=$REPO/ops/rollback-dispatch-document-menu-candidate.sh
DEPLOY=$REPO/ops/deploy-dispatch-document-menu-candidate.sh
BASELINE=$REPO/xovi-qmd/dispatch-document-menu-3.28.0.169.baseline.sha256
FUNCTIONAL=$REPO/xovi-qmd/dispatch-document-menu-3.28.0.169.qmd
INERT=$REPO/xovi-qmd/dispatch-document-menu-inert-3.28.0.169.qmd
PANEL=$REPO/qml/DispatchLauncher.qml
LATENCY=$REPO/xovi-qmd/dispatch-appload-partial-repaint-3.28.0.169.qmd
QMD_BACKUP=${QMD_BACKUP:-/Users/mdf/code/appload-rmstream-beta/.cache/notebook-ui-repair-20260918T205836Z/safety-backup.tgz}
DATES_QMD=${DATES_QMD:-/Users/mdf/code/notebook-date-index/.cache/dates-navigation-20260919T111620Z/notebook-date-index.qmd}
RMSTREAM_QMD=${RMSTREAM_QMD:-/Users/mdf/code/appload-rmstream-beta/.cache/notebook-ui-repair-20260918T205836Z/rmstream-shortcut.qmd}
DISPATCH_BINARY=${DISPATCH_BINARY:-/Users/mdf/code/personal/remarkable-dispatch-app/dist/remarkable-dispatch/remarkable-dispatch}

EXPECTED_BASELINE_SHA256=0f19ada5bd92364e61a2abeefae79a14171fbebc0f498813123fe3e60d7eed9d
EXPECTED_FUNCTIONAL_SHA256=883f275b59736e92cf55e0d49c39a649ed3ea66f2bb7500a88d54659f655aece
EXPECTED_INERT_SHA256=5a685b3142a339b370436c8f6563344d4b4684ddbab3f288f812ab6087a32fc1
EXPECTED_PANEL_SHA256=bf05247511a245fdc84fae41e03a8a2b749ad1d3ef622470a59da76646e8b0f7
EXPECTED_LATENCY_SHA256=1eb2037f28c9891fbdc4a97d1e2916b8e923fe04004ae1ced03b5de73f59a60e
EXPECTED_DISPATCH_BINARY_SHA256=f9896596941caa77ae9a1ba88da8e1ca09cc4f08f0f52560b800b54efe8875cc
EXPECTED_QMD_BACKUP_SHA256=dab755a5fe8885715caa706b6d40192e9e2217244c9f51a66d61086e63f9673f
EXPECTED_DATES_QMD_SHA256=2d4681414ac00b534b2f21d179365601ce9e876c7cfbf6c6c8d25a2f8738e580
EXPECTED_RMSTREAM_QMD_SHA256=3c3aad847219a7c8cc9a8dd0ca77dca0b9205974715d8081f42150c260655a96

hash_file() { shasum -a 256 "$1" | awk '{ print $1 }'; }
require_exact_file() {
    local path=$1 expected=$2 label=$3
    [ -f "$path" ] && [ ! -L "$path" ] || {
        echo "$label is missing, not regular, or symlinked: $path" >&2
        exit 1
    }
    [ "$(hash_file "$path")" = "$expected" ] || {
        echo "$label hash mismatch" >&2
        exit 1
    }
}

require_exact_file "$BASELINE" "$EXPECTED_BASELINE_SHA256" 'eleven-input baseline'
require_exact_file "$FUNCTIONAL" "$EXPECTED_FUNCTIONAL_SHA256" 'functional QMD'
require_exact_file "$INERT" "$EXPECTED_INERT_SHA256" 'inert QMD'
require_exact_file "$PANEL" "$EXPECTED_PANEL_SHA256" 'launcher panel'
require_exact_file "$LATENCY" "$EXPECTED_LATENCY_SHA256" 'accepted latency QMD'
require_exact_file "$DISPATCH_BINARY" "$EXPECTED_DISPATCH_BINARY_SHA256" 'final eraser-capable Dispatch executable'
require_exact_file "$QMD_BACKUP" "$EXPECTED_QMD_BACKUP_SHA256" 'current QMD backup'
require_exact_file "$DATES_QMD" "$EXPECTED_DATES_QMD_SHA256" 'current Dates QMD'
require_exact_file "$RMSTREAM_QMD" "$EXPECTED_RMSTREAM_QMD_SHA256" 'current RMStream QMD'
bash -n "$INSTALLER" "$ROLLBACK" "$DEPLOY" "$TEST" "$REPO/ops/build-dispatch-document-menu-candidate.sh"

# Static safety policy for the future device transaction.
grep -Fq -- '--on-active=180' "$INSTALLER"
grep -Fq 'trap rollback_on_exit EXIT' "$INSTALLER"
grep -Fq "trap 'exit 129' HUP" "$INSTALLER"
grep -Fq "trap 'exit 130' INT" "$INSTALLER"
grep -Fq "trap 'exit 143' TERM" "$INSTALLER"
grep -Fq "EXPECTED_DISPATCH_BINARY_SHA256=$EXPECTED_DISPATCH_BINARY_SHA256" "$INSTALLER"
for transaction_script in "$INSTALLER" "$ROLLBACK"; do
    grep -Fq "EXPECTED_LATENCY_QMD_SHA256=$EXPECTED_LATENCY_SHA256" "$transaction_script"
    grep -Fq "EXPECTED_FUNCTIONAL_SHA256=$EXPECTED_FUNCTIONAL_SHA256" "$transaction_script"
    grep -Fq "EXPECTED_INERT_SHA256=$EXPECTED_INERT_SHA256" "$transaction_script"
    grep -Fq '*.qmd|*.qrr|*.rcc)' "$transaction_script"
done
grep -Fq 'verify_service_tree' "$INSTALLER"
grep -Fq 'verify_systemd_capabilities' "$INSTALLER"
grep -Fq 'stock_surface_is_exact' "$ROLLBACK"
grep -Fq 'systemctl kill --kill-whom=all --signal=KILL "$TRANSACTION_UNIT"' "$ROLLBACK"
grep -Fq '/bin/bash "$STOCK"' "$ROLLBACK"
grep -Fq 'grep -Fvx "$TIMER_UNIT"' "$INSTALLER"
grep -Fq 'grep -Fvx "$SERVICE_UNIT"' "$INSTALLER"
grep -Fq 'cp "$STAGE/baseline.sha256" "$RECOVERY/baseline.sha256"' "$INSTALLER"
grep -Fq 'chmod 0600 "$RECOVERY/baseline.sha256"' "$INSTALLER"
grep -Fq 'cp "$STAGE/panel.qml" "$RECOVERY/panel.ready"' "$INSTALLER"
grep -Fq 'mv "$RECOVERY/panel.ready" "$PANEL"' "$INSTALLER"
grep -Fq 'candidate_qmd_count=12' "$TEST"
if grep -En '(^|[^[:alnum:]_])(ssh|scp|curl|wget|nc|socat)([^[:alnum:]_]|$)' "$INSTALLER" "$ROLLBACK"; then
    echo 'device transaction unexpectedly contains a network client' >&2
    exit 1
fi
dryrun_line=$(grep -n 'dry-run-dispatch-document-menu-transaction.sh' "$DEPLOY" | head -n 1 | cut -d: -f1)
network_line=$(grep -n 'ssh-keyscan' "$DEPLOY" | head -n 1 | cut -d: -f1)
[ "$dryrun_line" -lt "$network_line" ]

# Full exact-resource build, composition permutations, wrong-version rejection,
# and QML runtime harness.
"$TEST"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/dispatch-document-menu-dry-run.XXXXXX")
cleanup() {
    local status=$?
    trap - EXIT
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$WORK/runtime" "$WORK/panel" "$WORK/stage" "$WORK/altered-stage"

# Reconstruct the exact eleven-input qdir and simulate every reviewed mutation
# and rollback transition. This explicitly proves the existing latency QMD is
# byte-identical throughout.
tar -xzf "$QMD_BACKUP" -C "$WORK/runtime" xovi/exthome/qt-resource-rebuilder
QDIR=$WORK/runtime/xovi/exthome/qt-resource-rebuilder
cp "$DATES_QMD" "$QDIR/notebook-date-index.qmd"
cp "$RMSTREAM_QMD" "$QDIR/rmstream-shortcut.qmd"
cp "$LATENCY" "$QDIR/dispatch-appload-partial-repaint-3.28.0.169.qmd"
(cd "$QDIR" && shasum -a 256 -c "$BASELINE") >/dev/null
baseline_names=$(awk '{ print $2 }' "$BASELINE" | sort)
current_names=$(find "$QDIR" -maxdepth 1 -type f \( -name '*.qmd' -o -name '*.qrr' -o -name '*.rcc' \) -exec basename {} \; | sort)
[ "$current_names" = "$baseline_names" ]
[ "$(printf '%s\n' "$current_names" | sed '/^$/d' | wc -l | tr -d ' ')" -eq 11 ]
LATENCY_BEFORE=$(hash_file "$QDIR/dispatch-appload-partial-repaint-3.28.0.169.qmd")

# Baseline -> inert: the disabled row and panel are additive, producing 12.
mkdir "$WORK/panel/remarkable-dispatch-shortcut"
cp "$PANEL" "$WORK/panel/remarkable-dispatch-shortcut/DispatchLauncher.qml"
cp "$INERT" "$QDIR/dispatch-document-menu-3.28.0.169.qmd"
[ "$(find "$QDIR" -maxdepth 1 -type f \( -name '*.qmd' -o -name '*.qrr' -o -name '*.rcc' \) | wc -l | tr -d ' ')" -eq 12 ]
require_exact_file "$QDIR/dispatch-document-menu-3.28.0.169.qmd" "$EXPECTED_INERT_SHA256" 'simulated inert install'
require_exact_file "$QDIR/dispatch-appload-partial-repaint-3.28.0.169.qmd" "$LATENCY_BEFORE" 'latency QMD after inert install'

# Inert -> functional -> rollback to the exact inert bytes; panel is untouched.
cp "$QDIR/dispatch-document-menu-3.28.0.169.qmd" "$WORK/prior-inert.qmd"
cp "$WORK/panel/remarkable-dispatch-shortcut/DispatchLauncher.qml" "$WORK/prior-panel.qml"
cp "$FUNCTIONAL" "$QDIR/dispatch-document-menu-3.28.0.169.qmd"
require_exact_file "$QDIR/dispatch-document-menu-3.28.0.169.qmd" "$EXPECTED_FUNCTIONAL_SHA256" 'simulated functional promotion'
require_exact_file "$QDIR/dispatch-appload-partial-repaint-3.28.0.169.qmd" "$LATENCY_BEFORE" 'latency QMD after functional promotion'
cp "$WORK/prior-inert.qmd" "$QDIR/dispatch-document-menu-3.28.0.169.qmd"
cmp "$WORK/prior-panel.qml" "$WORK/panel/remarkable-dispatch-shortcut/DispatchLauncher.qml"
require_exact_file "$QDIR/dispatch-document-menu-3.28.0.169.qmd" "$EXPECTED_INERT_SHA256" 'functional rollback to inert'

# Inert rollback returns to the exact eleven-input baseline. Also exercise the
# safe interruption state where the installer created only an empty panel dir.
rm "$QDIR/dispatch-document-menu-3.28.0.169.qmd"
rm "$WORK/panel/remarkable-dispatch-shortcut/DispatchLauncher.qml"
rmdir "$WORK/panel/remarkable-dispatch-shortcut"
mkdir "$WORK/panel/remarkable-dispatch-shortcut"
rmdir "$WORK/panel/remarkable-dispatch-shortcut"
(cd "$QDIR" && shasum -a 256 -c "$BASELINE") >/dev/null
current_names=$(find "$QDIR" -maxdepth 1 -type f \( -name '*.qmd' -o -name '*.qrr' -o -name '*.rcc' \) -exec basename {} \; | sort)
[ "$current_names" = "$baseline_names" ]
require_exact_file "$QDIR/dispatch-appload-partial-repaint-3.28.0.169.qmd" "$LATENCY_BEFORE" 'latency QMD after complete rollback'

# Build the exact six-file stage manifest used by the Mac controller and prove
# that one changed candidate byte fails its receipt.
cp "$BASELINE" "$WORK/stage/baseline.sha256"
cp "$INSTALLER" "$WORK/stage/device-install.sh"
cp "$FUNCTIONAL" "$WORK/stage/functional.qmd"
cp "$INERT" "$WORK/stage/inert.qmd"
cp "$PANEL" "$WORK/stage/panel.qml"
cp "$ROLLBACK" "$WORK/stage/rollback.sh"
(cd "$WORK/stage" && shasum -a 256 baseline.sha256 device-install.sh functional.qmd inert.qmd panel.qml rollback.sh >SHA256SUMS)
(cd "$WORK/stage" && shasum -a 256 -c SHA256SUMS) >/dev/null
cp -R "$WORK/stage/." "$WORK/altered-stage/"
printf '\000' >>"$WORK/altered-stage/functional.qmd"
if (cd "$WORK/altered-stage" && shasum -a 256 -c SHA256SUMS) >/dev/null 2>&1; then
    echo 'altered stage unexpectedly passed its receipt' >&2
    exit 1
fi
STAGE_MANIFEST_SHA256=$(hash_file "$WORK/stage/SHA256SUMS")

printf 'dry_run=passed\n'
printf 'firmware=3.28.0.169\n'
printf 'transition=11-to-12-inert-to-functional-to-11\n'
printf 'latency_qmd_sha256=%s\n' "$LATENCY_BEFORE"
printf 'dispatch_binary_sha256=%s\n' "$EXPECTED_DISPATCH_BINARY_SHA256"
printf 'reviewed_stage_manifest_example_sha256=%s\n' "$STAGE_MANIFEST_SHA256"
printf 'device_contact=none\n'
