#!/bin/bash
set -Eeuo pipefail

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEVICE_INSTALLER="$REPO/ops/device-install-smart-openclaw.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/smart-remarkable-recovery-test.XXXXXX")

cleanup() {
    status=$?
    trap - EXIT
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT

awk '
    /^write_recovery_metadata\(\) \{/ { capture=1 }
    capture { print }
    capture && /^}$/ { exit }
' "$DEVICE_INSTALLER" >"$WORK/write-recovery-metadata.sh"
# shellcheck disable=SC1090
. "$WORK/write-recovery-metadata.sh"

APP="$WORK/app"
STAGE="$WORK/stage"
BACKUP="$WORK/rollback"
RECOVERY_METADATA="$WORK/install-test.provenance"
RECOVERY_METADATA_TMP="$WORK/.install-test.provenance.tmp"
mkdir "$APP" "$STAGE"
printf 'old app\n' >"$APP/old-app.txt"
printf 'new app\n' >"$STAGE/new-app.txt"
new_app_sha=$(sha256sum "$STAGE/new-app.txt" | cut -d' ' -f1)
printf '%s  %s\n' "$new_app_sha" 'fixture/source.txt' >"$STAGE/SOURCE-INPUTS.sha256"
source_inputs_sha=$(sha256sum "$STAGE/SOURCE-INPUTS.sha256" | cut -d' ' -f1)
printf '%s  %s\n' \
    "$new_app_sha" './new-app.txt' \
    "$source_inputs_sha" './SOURCE-INPUTS.sha256' |
    LC_ALL=C sort >"$STAGE/STAGED-FILES.sha256"

ID=20260725T120000Z
EXPECTED_ARCHIVE_SHA=$(printf 'a%.0s' {1..64})
EXPECTED_BINARY_SHA=$new_app_sha
EXPECTED_STAGED_MANIFEST_SHA=$(sha256sum "$STAGE/STAGED-FILES.sha256" | cut -d' ' -f1)
EXPECTED_DEVICE_INSTALLER_SHA=$(sha256sum "$DEVICE_INSTALLER" | cut -d' ' -f1)
EXPECTED_CONTRACT_SHA=$(printf 'c%.0s' {1..64})
EXPECTED_DEVICE_SERIAL=0A247209DABC7917
EXPECTED_FIRMWARE_VERSION=3.28.0.164
EXPECTED_FIRMWARE_BUILD=20260702125656
EXPECTED_XOCHITL_SHA256=$(printf 'b%.0s' {1..64})
HAD_APP=1
CREATED_SETTINGS=0
CREATED_RECOVERY_METADATA=0
ACTIVE_QMD_STATE=legacy-functional
ACTIVE_QMD_SHA=$(printf 'd%.0s' {1..64})
PREVIOUS_APP_STAGED_MANIFEST_SHA=$(printf 'e%.0s' {1..64})
PREVIOUS_APP_CONTRACT_SHA=unavailable
SYNC_CALLS=0

chown() {
    :
}
stat() {
    if [ "$1" = -c ] && [ "$2" = %u:%g:%a ]; then
        printf '0:0:%s\n' "$(gstat -c %a "$3")"
        return
    fi
    gstat "$@"
}
sync() {
    SYNC_CALLS=$((SYNC_CALLS + 1))
}

# The durable prepared record must exist before either rename. If power is lost
# at any following checkpoint, it identifies both trees and the candidate.
write_recovery_metadata prepared "$STAGE"
test "$SYNC_CALLS" -eq 1
test "$(gstat -c %a "$RECOVERY_METADATA")" = 600
test "$(grep -Fxc 'phase=prepared' "$RECOVERY_METADATA")" -eq 1
test "$(grep -Fxc "stage_path=$STAGE" "$RECOVERY_METADATA")" -eq 1
test "$(grep -Fxc "backup_path=$BACKUP" "$RECOVERY_METADATA")" -eq 1
test "$(grep -Fxc 'had_previous_app=1' "$RECOVERY_METADATA")" -eq 1
test "$(grep -Fxc "artifact_contract_sha256=$EXPECTED_CONTRACT_SHA" "$RECOVERY_METADATA")" -eq 1
test "$(grep -Fxc 'active_qmd_state=legacy-functional' "$RECOVERY_METADATA")" -eq 1
test "$(grep -Fxc "active_qmd_sha256=$ACTIVE_QMD_SHA" "$RECOVERY_METADATA")" -eq 1
test "$(grep -Fxc 'rollback_order=qmd-before-app' "$RECOVERY_METADATA")" -eq 1
prepared_record_sha=$(sha256sum "$RECOVERY_METADATA" | cut -d' ' -f1)

# Simulated power loss after old_moved: the prepared record still identifies
# the preserved old tree and the verified candidate tree.
mv "$APP" "$BACKUP"
test ! -e "$APP"
test -f "$BACKUP/old-app.txt"
test -f "$STAGE/new-app.txt"
test "$(sha256sum "$RECOVERY_METADATA" | cut -d' ' -f1)" = "$prepared_record_sha"

# Simulated power loss after new_active: the same prepared record remains
# available until the installed phase has been atomically written and synced.
mv "$STAGE" "$APP"
test -f "$APP/new-app.txt"
test -f "$BACKUP/old-app.txt"
test "$(grep -Fxc 'phase=prepared' "$RECOVERY_METADATA")" -eq 1

write_recovery_metadata installed "$APP"
test "$SYNC_CALLS" -eq 2
test "$(grep -Fxc 'phase=installed' "$RECOVERY_METADATA")" -eq 1
test "$(grep -Fxc 'phase=prepared' "$RECOVERY_METADATA")" -eq 0
test "$(grep -Fxc "staged_manifest_sha256=$EXPECTED_STAGED_MANIFEST_SHA" "$RECOVERY_METADATA")" -eq 1
embedded_manifest=$(
    sed -n '/^staged_files_begin$/,/^staged_files_end$/p' "$RECOVERY_METADATA" |
        sed '1d;$d'
)
test "$embedded_manifest" = "$(cat "$APP/STAGED-FILES.sha256")"
if grep -E 'OPENCLAW_BRIDGE_TOKEN|OPENAI_API_KEY|sk-[A-Za-z0-9]' "$RECOVERY_METADATA"; then
    echo "Recovery metadata contains a credential-like field" >&2
    exit 1
fi

echo "smart-openclaw recovery metadata power-loss tests passed"
