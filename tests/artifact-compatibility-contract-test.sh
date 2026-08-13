#!/bin/bash
set -Eeuo pipefail
export LC_ALL=C

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CONTRACT="$REPO/xovi-qmd/compatibility-3.28.0.166.env"
HELPER="$REPO/ops/artifact-compatibility-contract.sh"
APP_CONTROLLER="$REPO/ops/install-smart-openclaw.sh"
APP_INSTALLER="$REPO/ops/device-install-smart-openclaw.sh"
QMD_CONTROLLER="$REPO/ops/install-llm-button-canary.sh"
QMD_INSTALLER="$REPO/ops/device-install-llm-button-canary.sh"
LAUNCHER="$REPO/remagic/appload-launch.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/smart-artifact-contract-test.XXXXXX")

cleanup() {
    status=$?
    trap - EXIT
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT

# shellcheck disable=SC1090
. "$HELPER"
smart_contract_load "$CONTRACT"
test "$ARTIFACT_CONTRACT_VERSION" = smart-remarkable-artifacts-v2
test "$SELECTION_PROTOCOL_VERSION" = smart-selection-v3
test "$DEVICE_SCENE_VIEW_RESOURCE_HASH" = 11806562588218124596
test "$(smart_contract_classify_qmd_sha "$LEGACY_BUTTON_QMD_SHA256")" = \
    legacy-functional
test "$(smart_contract_classify_qmd_sha "$V2_MIGRATION_BUTTON_QMD_SHA256")" = \
    v2-migration-functional
test "$(smart_contract_classify_qmd_sha "$INERT_BUTTON_QMD_SHA256")" = new-inert
if smart_contract_require_complete; then
    for artifact_spec in \
        "$SOURCE_QMD_SHA256:$REPO/xovi-qmd/llm-button-3.28.0.166.source.qmd" \
        "$BUTTON_QMD_SHA256:$REPO/xovi-qmd/llm-button-3.28.0.166.qmd" \
        "$SMART_REMARKABLE_SHA256:$REPO/target/aarch64-unknown-linux-gnu/release/smart_remarkable" \
        "$APPLOAD_LAUNCHER_SHA256:$REPO/remagic/appload-launch.sh" \
        "$RUN_ARMED_ONCE_SHA256:$REPO/scripts/run-armed-once.sh" \
        "$SELECTION_PROTOCOL_SHA256:$REPO/scripts/selection-protocol.sh"
    do
        expected_sha=${artifact_spec%%:*}
        artifact_path=${artifact_spec#*:}
        test -f "$artifact_path"
        test ! -L "$artifact_path"
        test "$(shasum -a 256 "$artifact_path" | awk '{print $1}')" = "$expected_sha"
    done
else
    # During implementation, all final-generation fields stay unresolved as
    # one deliberate state. Partial finalization is protocol skew and fails.
    for unresolved_key in \
        SOURCE_QMD_SHA256 \
        BUTTON_QMD_SHA256 \
        SMART_REMARKABLE_SHA256 \
        APPLOAD_LAUNCHER_SHA256 \
        RUN_ARMED_ONCE_SHA256 \
        SELECTION_PROTOCOL_SHA256
    do
        eval "unresolved_value=\${$unresolved_key-}"
        test "$unresolved_value" = UNRESOLVED
    done
fi

complete_contract="$WORK/complete.env"
while IFS= read -r line || [ -n "$line" ]; do
    key=${line%%=*}
    case "$key" in
        SOURCE_QMD_SHA256) value=$(printf 'a%.0s' {1..64}) ;;
        BUTTON_QMD_SHA256) value=$(printf 'b%.0s' {1..64}) ;;
        SMART_REMARKABLE_SHA256) value=$(printf 'c%.0s' {1..64}) ;;
        APPLOAD_LAUNCHER_SHA256) value=$(printf 'd%.0s' {1..64}) ;;
        RUN_ARMED_ONCE_SHA256) value=$(printf 'e%.0s' {1..64}) ;;
        SELECTION_PROTOCOL_SHA256) value=$(printf 'f%.0s' {1..64}) ;;
        *) printf '%s\n' "$line"; continue ;;
    esac
    printf '%s=%s\n' "$key" "$value"
done <"$CONTRACT" >"$complete_contract"

smart_contract_load "$complete_contract"
smart_contract_require_complete
test "$(smart_contract_classify_qmd_sha absent)" = absent
test "$(smart_contract_classify_qmd_sha "$LEGACY_BUTTON_QMD_SHA256")" = \
    legacy-functional
test "$(smart_contract_classify_qmd_sha "$V2_MIGRATION_BUTTON_QMD_SHA256")" = \
    v2-migration-functional
test "$(smart_contract_classify_qmd_sha "$INERT_BUTTON_QMD_SHA256")" = new-inert
test "$(smart_contract_classify_qmd_sha "$BUTTON_QMD_SHA256")" = new-functional
if smart_contract_classify_qmd_sha "$(printf '9%.0s' {1..64})" >/dev/null 2>&1; then
    echo "Unknown QMD hash was admitted" >&2
    exit 1
fi

cp "$complete_contract" "$WORK/duplicate.env"
printf 'BUTTON_QMD_SHA256=%s\n' "$(printf '1%.0s' {1..64})" >>"$WORK/duplicate.env"
if smart_contract_load "$WORK/duplicate.env"; then
    echo "Duplicate contract key was accepted" >&2
    exit 1
fi
cp "$complete_contract" "$WORK/unknown.env"
printf 'UNREVIEWED_FIELD=value\n' >>"$WORK/unknown.env"
if smart_contract_load "$WORK/unknown.env"; then
    echo "Unknown contract key was accepted" >&2
    exit 1
fi
cp "$complete_contract" "$WORK/unsafe.env"
printf 'unsafe line\n' >>"$WORK/unsafe.env"
if smart_contract_load "$WORK/unsafe.env"; then
    echo "Malformed contract line was accepted" >&2
    exit 1
fi

# Exercise the device installer's authoritative path/type/owner/mode/hash QMD
# classifier without a tablet. BSD macOS stat is adapted to the Linux format
# that the device function uses.
awk '
    /^classify_smart_qmd\(\) \{/ { capture=1 }
    capture { print }
    capture && /^}$/ { exit }
' "$APP_INSTALLER" >"$WORK/classify-smart-qmd.sh"
# shellcheck disable=SC1090
. "$WORK/classify-smart-qmd.sh"
TEST_OWNER=0:0
GNU_STAT=$(command -v gstat || command -v stat)
stat() {
    if [ "$1" = -c ] && [ "$2" = %u:%g:%a ]; then
        printf '%s:%s\n' "$TEST_OWNER" "$("$GNU_STAT" -c %a "$3")"
        return
    fi
    "$GNU_STAT" "$@"
}
QMD_TARGET="$WORK/active.qmd"
legacy_fixture="$WORK/legacy.qmd"
v2_fixture="$WORK/v2.qmd"
inert_fixture="$WORK/inert.qmd"
functional_fixture="$WORK/functional.qmd"
printf 'legacy\n' >"$legacy_fixture"
printf 'v2\n' >"$v2_fixture"
printf 'inert\n' >"$inert_fixture"
printf 'functional\n' >"$functional_fixture"
LEGACY_BUTTON_QMD_SHA256=$(sha256sum "$legacy_fixture" | cut -d' ' -f1)
V2_MIGRATION_BUTTON_QMD_SHA256=$(sha256sum "$v2_fixture" | cut -d' ' -f1)
INERT_BUTTON_QMD_SHA256=$(sha256sum "$inert_fixture" | cut -d' ' -f1)
BUTTON_QMD_SHA256=$(sha256sum "$functional_fixture" | cut -d' ' -f1)
test "$(classify_smart_qmd)" = absent:absent
for classifier_spec in \
    "$legacy_fixture:legacy-functional:$LEGACY_BUTTON_QMD_SHA256" \
    "$v2_fixture:v2-migration-functional:$V2_MIGRATION_BUTTON_QMD_SHA256" \
    "$inert_fixture:new-inert:$INERT_BUTTON_QMD_SHA256" \
    "$functional_fixture:new-functional:$BUTTON_QMD_SHA256"
do
    fixture=${classifier_spec%%:*}
    classifier_tail=${classifier_spec#*:}
    cp "$fixture" "$QMD_TARGET"
    chmod 0644 "$QMD_TARGET"
    test "$(classify_smart_qmd)" = "$classifier_tail"
done
printf 'unknown\n' >"$QMD_TARGET"
chmod 0644 "$QMD_TARGET"
if classify_smart_qmd >/dev/null 2>&1; then
    echo "Unknown active QMD file was admitted" >&2
    exit 1
fi
cp "$legacy_fixture" "$QMD_TARGET"
chmod 0600 "$QMD_TARGET"
if classify_smart_qmd >/dev/null 2>&1; then
    echo "Wrong-mode active QMD file was admitted" >&2
    exit 1
fi
chmod 0644 "$QMD_TARGET"
TEST_OWNER=501:20
if classify_smart_qmd >/dev/null 2>&1; then
    echo "Wrong-owner active QMD file was admitted" >&2
    exit 1
fi
TEST_OWNER=0:0
rm -f "$QMD_TARGET"
ln -s "$legacy_fixture" "$QMD_TARGET"
if classify_smart_qmd >/dev/null 2>&1; then
    echo "Symlinked active QMD file was admitted" >&2
    exit 1
fi
rm -f "$QMD_TARGET"

# Build a root-mode-mocked AppLoad tree and prove that mutating any one of the
# four protocol-bound client artifacts independently closes admission.
APP_FIXTURE="$WORK/app"
mkdir -p "$APP_FIXTURE/scripts"
printf 'worker\n' >"$APP_FIXTURE/smart_remarkable"
printf 'launcher\n' >"$APP_FIXTURE/appload-launch.sh"
printf 'runner\n' >"$APP_FIXTURE/scripts/run-armed-once.sh"
printf 'protocol\n' >"$APP_FIXTURE/scripts/selection-protocol.sh"
cp "$complete_contract" "$APP_FIXTURE/compatibility.env"
chmod 0755 \
    "$APP_FIXTURE" \
    "$APP_FIXTURE/scripts" \
    "$APP_FIXTURE/smart_remarkable" \
    "$APP_FIXTURE/appload-launch.sh" \
    "$APP_FIXTURE/scripts/run-armed-once.sh" \
    "$APP_FIXTURE/scripts/selection-protocol.sh"
chmod 0644 "$APP_FIXTURE/compatibility.env"
SMART_REMARKABLE_SHA256=$(sha256sum "$APP_FIXTURE/smart_remarkable" | cut -d' ' -f1)
APPLOAD_LAUNCHER_SHA256=$(sha256sum "$APP_FIXTURE/appload-launch.sh" | cut -d' ' -f1)
RUN_ARMED_ONCE_SHA256=$(sha256sum "$APP_FIXTURE/scripts/run-armed-once.sh" | cut -d' ' -f1)
SELECTION_PROTOCOL_SHA256=$(sha256sum "$APP_FIXTURE/scripts/selection-protocol.sh" | cut -d' ' -f1)
SMART_ARTIFACT_CONTRACT_PATH="$APP_FIXTURE/compatibility.env"
/bin/bash "$REPO/ops/build-staged-sha256-manifest.sh" "$APP_FIXTURE"
chmod 0644 "$APP_FIXTURE/STAGED-FILES.sha256"
smart_contract_installed_client_is_exact "$APP_FIXTURE"
for client_relative_path in \
    smart_remarkable \
    appload-launch.sh \
    scripts/run-armed-once.sh \
    scripts/selection-protocol.sh
do
    cp "$APP_FIXTURE/$client_relative_path" "$WORK/client.original"
    printf 'mutation\n' >>"$APP_FIXTURE/$client_relative_path"
    /bin/bash "$REPO/ops/build-staged-sha256-manifest.sh" "$APP_FIXTURE"
    chmod 0644 "$APP_FIXTURE/STAGED-FILES.sha256"
    if smart_contract_installed_client_is_exact "$APP_FIXTURE"; then
        echo "Mutated client artifact was admitted: $client_relative_path" >&2
        exit 1
    fi
    cp "$WORK/client.original" "$APP_FIXTURE/$client_relative_path"
    chmod 0755 "$APP_FIXTURE/$client_relative_path"
    /bin/bash "$REPO/ops/build-staged-sha256-manifest.sh" "$APP_FIXTURE"
    chmod 0644 "$APP_FIXTURE/STAGED-FILES.sha256"
    smart_contract_installed_client_is_exact "$APP_FIXTURE"
done

bash -n \
    "$HELPER" \
    "$APP_CONTROLLER" \
    "$APP_INSTALLER" \
    "$QMD_CONTROLLER" \
    "$QMD_INSTALLER"

# The application controller must fail locally on unresolved values before it
# can read a server token or contact the tablet, and its bundle contains every
# contract-bound runtime artifact.
complete_line=$(grep -n 'smart_contract_require_complete' "$APP_CONTROLLER" | head -n 1 | cut -d: -f1)
network_line=$(grep -n '^TOKEN_SHA=' "$APP_CONTROLLER" | head -n 1 | cut -d: -f1)
test "$complete_line" -lt "$network_line"
for expected in \
    'scripts/selection-protocol.sh' \
    'ops/artifact-compatibility-contract.sh' \
    'xovi-qmd/compatibility-3.28.0.166.env' \
    '$STAGE/scripts/selection-protocol.sh'
do
    grep -F "$expected" "$APP_CONTROLLER" >/dev/null
done
grep -F 'test "$BINARY_SHA" = "$EXPECTED_SMART_REMARKABLE_SHA256"' \
    "$APP_CONTROLLER" >/dev/null
grep -F "'\$STAGED_MANIFEST_SHA' '\$DEVICE_INSTALLER_SHA' '\$CONTRACT_SHA'" \
    "$APP_CONTROLLER" >/dev/null

for expected in \
    './compatibility.env' \
    './scripts/artifact-compatibility-contract.sh' \
    './scripts/selection-protocol.sh' \
    'scripts/selection-protocol.sh'
do
    grep -F "$expected" "$APP_INSTALLER" >/dev/null
done
grep -F 'smart_contract_installed_client_is_exact "$STAGE"' "$APP_INSTALLER" >/dev/null
grep -F 'smart_contract_installed_client_is_exact "$APP"' "$APP_INSTALLER" >/dev/null
grep -F 'absent|legacy-functional|v2-migration-functional|new-inert' "$APP_INSTALLER" >/dev/null
grep -F 'new-functional)' "$APP_INSTALLER" >/dev/null
grep -F 'rollback_order=qmd-before-app' "$APP_INSTALLER" >/dev/null

# Both deployment directions share the same atomic lock. Functional authority
# is admitted only after the exact installed client has been rechecked, and the
# QMD controller archives the parser used for that decision.
test "$(grep -h '^GLOBAL_LOCK=.*deployment.lock\|^COMPATIBILITY_LOCK=.*deployment.lock' \
    "$APP_INSTALLER" "$QMD_INSTALLER" | wc -l | tr -d ' ')" -eq 2
grep -F 'artifact-compatibility-contract.sh compatibility.env button.qmd' \
    "$QMD_CONTROLLER" >/dev/null
grep -F 'smart_contract_require_complete' "$QMD_INSTALLER" >/dev/null
armed_line=$(grep -n 'mv "$armed_tmp" "$ARMED"' "$QMD_INSTALLER" | cut -d: -f1)
client_gate_line=$(grep -n 'smart_contract_installed_client_is_exact "$APP_ROOT"' \
    "$QMD_INSTALLER" | cut -d: -f1 | \
    awk -v armed="$armed_line" '$1 < armed { last=$1 } END { print last }')
test "$client_gate_line" -lt "$armed_line"
grep -F 'legacy-functional|v2-migration-functional|new-functional' "$QMD_INSTALLER" >/dev/null

# Both exact stock resources patched by the 0.8 QMD are contract-bound and
# checked from the live hashtab before the canary is admitted.
grep -F 'SCENE_SELECTION_HANDLER_RESOURCE_HASH' "$QMD_CONTROLLER" >/dev/null
grep -F 'DEVICE_SCENE_VIEW_RESOURCE_HASH' "$QMD_CONTROLLER" >/dev/null
grep -F 'DeviceSceneView.qml = $DEVICE_SCENE_VIEW_RESOURCE_HASH' \
    "$QMD_CONTROLLER" >/dev/null

# Compatibility-table membership alone does not prove that qmldiff can parse
# and apply a compiled QMD. Keep the real-application gate ahead of both the
# first device connection (for local reference validation) and every remote
# write, without requiring the firmware fixture in this device-free suite.
grep -F 'QML_REFERENCE_ROOT=${QML_REFERENCE_ROOT:-/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.28.0.166/resources}' \
    "$QMD_CONTROLLER" >/dev/null
for expected in \
    'QML_APPLY_OUTPUT="$WORK/qml-apply-output"' \
    'QMLFORMAT_BIN=${QMLFORMAT_BIN:-$(command -v qmlformat 2>/dev/null || true)}' \
    'qml/common/SceneSelectionHandler.qml' \
    'qml/device/view/documentview/DeviceSceneView.qml' \
    'if [ ! -f "$reference_path" ] || [ -L "$reference_path" ]; then' \
    '"$QMLDIFF_BIN" apply-diffs' \
    '--hashtab "$LIVE_HASHTAB"' \
    'if [ ! -f "$output_path" ] || [ -L "$output_path" ] || [ ! -s "$output_path" ]; then' \
    '"$QMLFORMAT_BIN" --ignore-settings "$output_path"'
do
    grep -F -- "$expected" "$QMD_CONTROLLER" >/dev/null
done
reference_gate_line=$(grep -n '^require_stock_qml_references$' "$QMD_CONTROLLER" | cut -d: -f1)
first_ssh_line=$(grep -n '^ssh -o BatchMode=yes ' "$QMD_CONTROLLER" | head -n 1 | cut -d: -f1)
apply_gate_line=$(grep -n '"$QMLDIFF_BIN" apply-diffs' "$QMD_CONTROLLER" | cut -d: -f1)
output_gate_line=$(grep -n '^require_applied_qml_outputs$' "$QMD_CONTROLLER" | cut -d: -f1)
qml_parse_line=$(grep -n '"$QMLFORMAT_BIN" --ignore-settings "$output_path"' "$QMD_CONTROLLER" | cut -d: -f1)
first_remote_write_line=$(grep -n '^REMOTE_CLEANUP=1$' "$QMD_CONTROLLER" | cut -d: -f1)
test "$reference_gate_line" -lt "$first_ssh_line"
test "$apply_gate_line" -lt "$first_remote_write_line"
test "$output_gate_line" -lt "$first_remote_write_line"
test "$qml_parse_line" -lt "$first_remote_write_line"

grep -F '"version": "0.8.0-openclaw"' \
    "$REPO/remagic/external.manifest.json" >/dev/null

# The reviewed migration adapter must continue accepting both exact legacy
# button spellings while the installed legacy QMD is active.
grep -F -- '--selection-button=write_back)' "$LAUNCHER" >/dev/null
grep -F -- '--selection-button=whatsapp_only)' "$LAUNCHER" >/dev/null
grep -F 'REQUEST_PROTOCOL=legacy-v1' "$LAUNCHER" >/dev/null

echo "artifact compatibility contract tests passed"
