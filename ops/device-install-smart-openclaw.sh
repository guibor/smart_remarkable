#!/bin/bash
# Runs as root on the reMarkable inside a transient installation unit.
# All writes stay below /home; the stock UI remains active throughout.
set -Eeuo pipefail

ID=${1:?deployment id required}
EXPECTED_ARCHIVE_SHA=${2:?archive sha256 required}
EXPECTED_BINARY_SHA=${3:?binary sha256 required}
EXPECTED_BRIDGE_TOKEN_SHA=${4:?bridge token sha256 required}
EXPECTED_STAGED_MANIFEST_SHA=${5:?staged manifest sha256 required}
EXPECTED_DEVICE_INSTALLER_SHA=${6:?device installer sha256 required}
if [[ ! "$ID" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
    echo "Invalid deployment id" >&2
    exit 2
fi
for expected_sha in \
    "$EXPECTED_ARCHIVE_SHA" \
    "$EXPECTED_BINARY_SHA" \
    "$EXPECTED_BRIDGE_TOKEN_SHA" \
    "$EXPECTED_STAGED_MANIFEST_SHA" \
    "$EXPECTED_DEVICE_INSTALLER_SHA"
do
    case "$expected_sha" in
        *[!0-9a-f]*|"") echo "Invalid expected SHA-256" >&2; exit 2 ;;
    esac
    if [ "${#expected_sha}" -ne 64 ]; then
        echo "Invalid expected SHA-256 length" >&2
        exit 2
    fi
done

APP_ROOT=/home/root/xovi/exthome/appload
APP="$APP_ROOT/smart-remarkable"
RECOVERY_ROOT=/home/root/.smart-remarkable-recovery
STAGE="$RECOVERY_ROOT/stage-$ID"
BACKUP="$RECOVERY_ROOT/rollback-$ID"
FAILED="$RECOVERY_ROOT/failed-$ID"
RECOVERY_METADATA="$RECOVERY_ROOT/install-$ID.provenance"
RECOVERY_METADATA_TMP="$RECOVERY_ROOT/.install-$ID.provenance.tmp"
ACTUAL_FILE_LIST="$RECOVERY_ROOT/.actual-files-$ID"
MANIFEST_FILE_LIST="$RECOVERY_ROOT/.manifest-files-$ID"
ARCHIVE="/home/root/.smart-remarkable.bundle-$ID.tar"
BRIDGE_TOKEN_FILE="/home/root/.smart-remarkable.bridge-token-$ID"
BRIDGE_TUNNEL_KEY=/home/root/.ssh/id_dropbear_smart_remarkable_bridge
SETTINGS_DIR=/home/root/.config/smart-remarkable
SETTINGS="$SETTINGS_DIR/settings.conf"
SWAP_STARTED=0
HAD_APP=0
CREATED_SETTINGS=0
CREATED_RECOVERY_METADATA=0
EXPECTED_DEVICE_SERIAL=0A247209DABC7917
EXPECTED_FIRMWARE_VERSION=3.28.0.163
EXPECTED_FIRMWARE_BUILD=20260702125656
EXPECTED_XOCHITL_SHA256=49f60572e830f6c4f20d800a56d644cdf53cd65a8e240b2b27106cce55040f89

read_device_serial() {
    for path in /sys/devices/soc0/serial_number /proc/device-tree/serial-number; do
        if [ -r "$path" ]; then
            tr -d '\000\r\n' <"$path"
            return
        fi
    done
    return 1
}

smart_process_running() {
    for exe in /proc/[0-9]*/exe; do
        [ -L "$exe" ] || continue
        target=$(readlink "$exe" 2>/dev/null) || continue
        [ "${target##*/}" = "smart_remarkable" ] && return 0
    done
    return 1
}

write_recovery_metadata() {
    phase=$1
    payload_root=$2
    case "$phase" in
        prepared|installed) ;;
        *) return 2 ;;
    esac
    test -d "$payload_root"
    test ! -L "$payload_root"
    test -f "$payload_root/STAGED-FILES.sha256"
    test ! -L "$payload_root/STAGED-FILES.sha256"
    test "$(sha256sum "$payload_root/STAGED-FILES.sha256" | cut -d' ' -f1)" = "$EXPECTED_STAGED_MANIFEST_SHA"
    test -f "$payload_root/SOURCE-INPUTS.sha256"
    test ! -L "$payload_root/SOURCE-INPUTS.sha256"
    source_inputs_sha=$(sha256sum "$payload_root/SOURCE-INPUTS.sha256" | cut -d' ' -f1)

    {
        printf 'format=smart-remarkable-install-provenance-v1\n'
        printf 'phase=%s\n' "$phase"
        printf 'deployment_id=%s\n' "$ID"
        printf 'device_serial=%s\n' "$EXPECTED_DEVICE_SERIAL"
        printf 'firmware_version=%s\n' "$EXPECTED_FIRMWARE_VERSION"
        printf 'firmware_build=%s\n' "$EXPECTED_FIRMWARE_BUILD"
        printf 'xochitl_sha256=%s\n' "$EXPECTED_XOCHITL_SHA256"
        printf 'app_path=%s\n' "$APP"
        printf 'stage_path=%s\n' "$STAGE"
        printf 'backup_path=%s\n' "$BACKUP"
        printf 'had_previous_app=%s\n' "$HAD_APP"
        printf 'settings_created=%s\n' "$CREATED_SETTINGS"
        printf 'archive_sha256=%s\n' "$EXPECTED_ARCHIVE_SHA"
        printf 'binary_sha256=%s\n' "$EXPECTED_BINARY_SHA"
        printf 'source_inputs_sha256=%s\n' "$source_inputs_sha"
        printf 'staged_manifest_sha256=%s\n' "$EXPECTED_STAGED_MANIFEST_SHA"
        printf 'device_installer_sha256=%s\n' "$EXPECTED_DEVICE_INSTALLER_SHA"
        printf 'source_inputs_begin\n'
        cat "$payload_root/SOURCE-INPUTS.sha256"
        printf 'source_inputs_end\n'
        printf 'staged_files_begin\n'
        cat "$payload_root/STAGED-FILES.sha256"
        printf 'staged_files_end\n'
    } >"$RECOVERY_METADATA_TMP"
    chown root:root "$RECOVERY_METADATA_TMP"
    chmod 0600 "$RECOVERY_METADATA_TMP"
    CREATED_RECOVERY_METADATA=1
    mv "$RECOVERY_METADATA_TMP" "$RECOVERY_METADATA"
    sync
    test "$(stat -c %u:%g:%a "$RECOVERY_METADATA")" = "0:0:600"
    test "$(grep -Fxc "phase=$phase" "$RECOVERY_METADATA")" -eq 1
    test "$(grep -Fxc "staged_manifest_sha256=$EXPECTED_STAGED_MANIFEST_SHA" "$RECOVERY_METADATA")" -eq 1
    test "$(grep -Fxc "device_installer_sha256=$EXPECTED_DEVICE_INSTALLER_SHA" "$RECOVERY_METADATA")" -eq 1
}

restore_previous() {
    set +e
    if [ "$SWAP_STARTED" -ne 0 ] && [ -d "$APP" ]; then
        mv "$APP" "$FAILED"
    fi
    if [ "$HAD_APP" -ne 0 ] && [ -d "$BACKUP" ]; then
        mv "$BACKUP" "$APP"
    fi
    if [ "$CREATED_SETTINGS" -ne 0 ]; then
        rm -f "$SETTINGS"
        rmdir "$SETTINGS_DIR" 2>/dev/null || true
    fi
    if [ "$CREATED_RECOVERY_METADATA" -ne 0 ]; then
        rm -f "$RECOVERY_METADATA"
    fi
    rm -f \
        "$RECOVERY_METADATA_TMP" \
        "$ACTUAL_FILE_LIST" \
        "$MANIFEST_FILE_LIST"
    rm -f "$BRIDGE_TOKEN_FILE"
}

fail_and_restore() {
    status=$1
    trap - ERR HUP INT TERM
    restore_previous
    rm -rf "$STAGE" "$FAILED"
    exit "$status"
}

trap 'fail_and_restore $?' ERR
trap 'fail_and_restore 129' HUP
trap 'fail_and_restore 130' INT
trap 'fail_and_restore 143' TERM

for dir_mode in \
    /home:0:0:755 \
    /home/root:0:0:700 \
    /home/root/xovi:0:0:755 \
    /home/root/xovi/exthome:0:0:755 \
    /home/root/xovi/exthome/appload:0:0:755 \
    /home/root/.config:0:0:755 \
    /home/root/.config/smart-remarkable:0:0:700
do
    dir=${dir_mode%%:*}
    expected=${dir_mode#*:}
    test -d "$dir"
    test ! -L "$dir"
    test "$(stat -c %u:%g:%a "$dir")" = "$expected"
done
if [ -e "$RECOVERY_ROOT" ] || [ -L "$RECOVERY_ROOT" ]; then
    test -d "$RECOVERY_ROOT"
    test ! -L "$RECOVERY_ROOT"
    test "$(stat -c %u:%g:%a "$RECOVERY_ROOT")" = "0:0:700"
fi
for transaction_path in "$STAGE" "$BACKUP" "$FAILED"; do
    test ! -e "$transaction_path"
    test ! -L "$transaction_path"
done
for transaction_file in \
    "$RECOVERY_METADATA" \
    "$RECOVERY_METADATA_TMP" \
    "$ACTUAL_FILE_LIST" \
    "$MANIFEST_FILE_LIST"
do
    test ! -e "$transaction_file"
    test ! -L "$transaction_file"
done
if [ -e "$APP" ] || [ -L "$APP" ]; then
    test -d "$APP"
    test ! -L "$APP"
    test "$(stat -c %u:%g:%a "$APP")" = "0:0:755"
    HAD_APP=1
fi

test "$(read_device_serial)" = "$EXPECTED_DEVICE_SERIAL"
test "$(sed -n 's/^IMG_VERSION=//p' /etc/os-release | tr -d '"\r\n')" = "$EXPECTED_FIRMWARE_VERSION"
test "$(tr -d '\r\n' </etc/version)" = "$EXPECTED_FIRMWARE_BUILD"
test "$(sha256sum /usr/bin/xochitl | cut -d' ' -f1)" = "$EXPECTED_XOCHITL_SHA256"
systemctl is-active --quiet xochitl.service
for unit in \
    riddle-takeover.service \
    smart-remarkable-once.service \
    smart-remarkable-session.service
do
    if systemctl is-active --quiet "$unit"; then
        echo "Refusing installation while $unit is active" >&2
        fail_and_restore 1
    fi
done
if smart_process_running; then
    echo "Refusing installation while smart_remarkable is running" >&2
    fail_and_restore 1
fi
test -c /dev/uinput
test -f "$BRIDGE_TUNNEL_KEY"
test ! -L "$BRIDGE_TUNNEL_KEY"
test "$(stat -c %u:%g:%a "$BRIDGE_TUNNEL_KEY")" = "0:0:600"
test "$(findmnt -n -o OPTIONS / | tr ',' '\n' | grep -c '^ro$')" -eq 1
test "$(sha256sum "$0" | cut -d' ' -f1)" = "$EXPECTED_DEVICE_INSTALLER_SHA"
test "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" = "$EXPECTED_ARCHIVE_SHA"
EXPECTED_ARCHIVE_MEMBERS=$(printf '%s\n' \
    './INSTALL-PROVENANCE.txt' \
    './SOURCE-INPUTS.sha256' \
    './STAGED-FILES.sha256' \
    './appload-launch.sh' \
    './external.manifest.json' \
    './icon.png' \
    './scripts/mode-settings.sh' \
    './scripts/openclaw-runtime-env.sh' \
    './scripts/run-armed-once.sh' \
    './scripts/run-selected-once.sh' \
    './selection_openclaw.json' \
    './selection_openclaw_whatsapp.json' \
    './smart_remarkable')
test "$(tar -tf "$ARCHIVE")" = "$EXPECTED_ARCHIVE_MEMBERS"
test -f "$BRIDGE_TOKEN_FILE"
test ! -L "$BRIDGE_TOKEN_FILE"
test "$(stat -c %u:%g:%a "$BRIDGE_TOKEN_FILE")" = "0:0:600"
test "$(sha256sum "$BRIDGE_TOKEN_FILE" | cut -d' ' -f1)" = "$EXPECTED_BRIDGE_TOKEN_SHA"

mkdir -p "$RECOVERY_ROOT"
chown root:root "$RECOVERY_ROOT"
chmod 0700 "$RECOVERY_ROOT"
test "$(stat -c %u:%g:%a "$RECOVERY_ROOT")" = "0:0:700"
mkdir -m 0700 "$STAGE"
tar -xf "$ARCHIVE" -C "$STAGE"

for required in \
    smart_remarkable \
    selection_openclaw.json \
    selection_openclaw_whatsapp.json \
    external.manifest.json \
    icon.png \
    appload-launch.sh \
    scripts/run-armed-once.sh \
    scripts/run-selected-once.sh \
    scripts/mode-settings.sh \
    scripts/openclaw-runtime-env.sh \
    INSTALL-PROVENANCE.txt \
    SOURCE-INPUTS.sha256 \
    STAGED-FILES.sha256
do
    test -f "$STAGE/$required"
    test ! -L "$STAGE/$required"
done
test "$(sha256sum "$STAGE/STAGED-FILES.sha256" | cut -d' ' -f1)" = "$EXPECTED_STAGED_MANIFEST_SHA"
if [ -n "$(find "$STAGE" -type l -print)" ]; then
    echo "Staged bundle contains a symlink" >&2
    fail_and_restore 1
fi
if [ -n "$(find "$STAGE" ! -type d ! -type f -print)" ]; then
    echo "Staged bundle contains a non-regular entry" >&2
    fail_and_restore 1
fi
(
    cd "$STAGE"
    find . -type f ! -path './STAGED-FILES.sha256' -print | LC_ALL=C sort
) >"$ACTUAL_FILE_LIST"
: >"$MANIFEST_FILE_LIST"
while IFS= read -r manifest_line; do
    digest=${manifest_line%%  *}
    relative_path=${manifest_line#"$digest  "}
    if [ "$manifest_line" != "$digest  $relative_path" ]; then
        echo "Malformed staged manifest line" >&2
        fail_and_restore 1
    fi
    case "$digest" in
        *[!0-9a-f]*|"") fail_and_restore 1 ;;
    esac
    test "${#digest}" -eq 64
    case "$relative_path" in
        ./*) ;;
        *) fail_and_restore 1 ;;
    esac
    case "/${relative_path#./}/" in
        *"//"*|*"/./"*|*"/../"*) fail_and_restore 1 ;;
    esac
    case "$relative_path" in
        './STAGED-FILES.sha256'|*\\*|*$'\n'*|*$'\r'*)
            fail_and_restore 1
            ;;
    esac
    printf '%s\n' "$relative_path" >>"$MANIFEST_FILE_LIST"
done <"$STAGE/STAGED-FILES.sha256"
test -s "$MANIFEST_FILE_LIST"
cmp -s "$ACTUAL_FILE_LIST" "$MANIFEST_FILE_LIST"
(
    cd "$STAGE"
    sha256sum -c STAGED-FILES.sha256 >/dev/null
)
rm -f "$ACTUAL_FILE_LIST" "$MANIFEST_FILE_LIST"
test "$(sha256sum "$STAGE/smart_remarkable" | cut -d' ' -f1)" = "$EXPECTED_BINARY_SHA"

chown -R root:root "$STAGE"
find "$STAGE" -type d -exec chmod 0755 {} \;
find "$STAGE" -type f -exec chmod 0644 {} \;
chmod 0755 \
    "$STAGE/smart_remarkable" \
    "$STAGE/appload-launch.sh" \
    "$STAGE/scripts/run-armed-once.sh" \
    "$STAGE/scripts/run-selected-once.sh" \
    "$STAGE/scripts/mode-settings.sh" \
    "$STAGE/scripts/openclaw-runtime-env.sh"

BRIDGE_TOKEN=$(cat "$BRIDGE_TOKEN_FILE")
case "$BRIDGE_TOKEN" in
    ""|*[!A-Za-z0-9_-]*) fail_and_restore 2 ;;
esac
test "${#BRIDGE_TOKEN}" -ge 43
test "${#BRIDGE_TOKEN}" -le 128
test "$(wc -l <"$BRIDGE_TOKEN_FILE")" -eq 1
umask 077
{
    printf 'OPENCLAW_BRIDGE_TOKEN=%s\n' "$BRIDGE_TOKEN"
    printf '%s\n' \
        'OPENCLAW_SSH_IDENTITY=/home/root/.ssh/id_dropbear_smart_remarkable_bridge' \
        'OPENCLAW_LOCAL_PORT=18791' \
        'OPENCLAW_REMOTE_PORT=18792' \
        'SMART_REMARKABLE_MODEL=openclaw/main' \
        'RUST_LOG=info'
} >"$STAGE/.env"
unset BRIDGE_TOKEN
chown root:root "$STAGE/.env"
chmod 0600 "$STAGE/.env"

test "$(stat -c %u:%g:%a "$STAGE/.env")" = "0:0:600"
test "$(grep -c '^OPENCLAW_BRIDGE_TOKEN=.' "$STAGE/.env")" -eq 1
test "$(grep -Fxc 'OPENCLAW_LOCAL_PORT=18791' "$STAGE/.env")" -eq 1
test "$(grep -Fxc 'OPENCLAW_REMOTE_PORT=18792' "$STAGE/.env")" -eq 1
test "$(grep -Fxc 'SMART_REMARKABLE_MODEL=openclaw/main' "$STAGE/.env")" -eq 1
for forbidden in \
    OPENCLAW_GATEWAY_TOKEN \
    OPENCLAW_SESSION_KEY \
    OPENCLAW_MESSAGE_CHANNEL \
    OPENAI_API_KEY \
    OPENAI_BASE_URL
do
    if grep -q "^$forbidden=" "$STAGE/.env"; then
        echo "Forbidden credential or route in staged environment: $forbidden" >&2
        fail_and_restore 1
    fi
done

if [ -e "$SETTINGS" ]; then
    test -f "$SETTINGS"
    test ! -L "$SETTINGS"
    test "$(stat -c %u:%g:%a "$SETTINGS")" = "0:0:600"
else
    test ! -L /home/root/.config
    test ! -L "$SETTINGS_DIR"
    mkdir -p "$SETTINGS_DIR"
    chown root:root "$SETTINGS_DIR"
    chmod 0700 "$SETTINGS_DIR"
    {
        printf '%s\n' \
            '# Smart Remarkable interaction settings (no credentials).' \
            'mode=session-hold' \
            'hold_ms=800' \
            'hold_radius_px=12' \
            'min_extent_px=24' \
            'once_timeout_seconds=600' \
            'session_timeout_seconds=3600'
    } >"$SETTINGS"
    chown root:root "$SETTINGS"
    chmod 0600 "$SETTINGS"
    CREATED_SETTINGS=1
fi
SMART_REMARKABLE_SETTINGS_FILE="$SETTINGS"
export SMART_REMARKABLE_SETTINGS_FILE
# shellcheck disable=SC1091
. "$STAGE/scripts/mode-settings.sh"
smart_load_mode_settings
case "$SMART_MODE" in
    once|session-hold|session-auto) ;;
    *) fail_and_restore 2 ;;
esac

# This exercises the dynamic loader and clap parser only. It does not open
# the framebuffer or an input device because clap exits for --version.
test "$("$STAGE/smart_remarkable" --version)" = "smart_remarkable 0.4.0"
write_recovery_metadata prepared "$STAGE"

if [ "$HAD_APP" -ne 0 ]; then
    test ! -e "$BACKUP"
    mv "$APP" "$BACKUP"
fi
SWAP_STARTED=1
mv "$STAGE" "$APP"
sync

test "$(sha256sum "$APP/smart_remarkable" | cut -d' ' -f1)" = "$EXPECTED_BINARY_SHA"
test "$(sha256sum "$APP/STAGED-FILES.sha256" | cut -d' ' -f1)" = "$EXPECTED_STAGED_MANIFEST_SHA"
(
    cd "$APP"
    sha256sum -c STAGED-FILES.sha256 >/dev/null
)
test "$(stat -c %u:%g:%a "$APP/smart_remarkable")" = "0:0:755"
test "$(stat -c %u:%g:%a "$APP/.env")" = "0:0:600"
test "$(stat -c %u:%g:%a "$SETTINGS")" = "0:0:600"
systemctl is-active --quiet xochitl.service
if smart_process_running; then
    echo "Post-install smart_remarkable process unexpectedly active" >&2
    fail_and_restore 1
fi
test "$(findmnt -n -o OPTIONS / | tr ',' '\n' | grep -c '^ro$')" -eq 1

write_recovery_metadata installed "$APP"

SWAP_STARTED=0
CREATED_SETTINGS=0
rm -f "$ARCHIVE" "$BRIDGE_TOKEN_FILE"
trap - ERR HUP INT TERM
echo "Smart Remarkable installation complete"
