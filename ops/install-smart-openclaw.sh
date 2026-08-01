#!/bin/bash
# Build a local ReMagic/AppLoad bundle and install it transactionally under
# /home on the selected tablet. Only the bridge-scoped bearer is transferred;
# the full OpenClaw Gateway credential never leaves the server.
set -Eeuo pipefail
umask 077

HOST=${1:-remarkable-rmpp-new}
BRIDGE_HOST=${SMART_REMARKABLE_BRIDGE_HOST:-md-server}
BRIDGE_TOKEN_PATH=${SMART_REMARKABLE_BRIDGE_TOKEN_PATH:-/home/mdf/.config/smart-remarkable-openclaw-bridge/tablet.token}
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BINARY="$REPO/target/aarch64-unknown-linux-gnu/release/smart_remarkable"
LOCAL_INSTALLER="$REPO/ops/install-smart-openclaw.sh"
DEVICE_INSTALLER="$REPO/ops/device-install-smart-openclaw.sh"
MANIFEST_BUILDER="$REPO/ops/build-staged-sha256-manifest.sh"
CONTRACT="$REPO/xovi-qmd/compatibility-3.28.0.164.env"
CONTRACT_HELPER="$REPO/ops/artifact-compatibility-contract.sh"
ID=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/smart-remarkable-install.XXXXXX")
STAGE="$WORK/smart-remarkable"
ARCHIVE="$WORK/smart-remarkable.bundle.tar"
ARCHIVE_MEMBERS="$WORK/archive-members.txt"
REMOTE_ARCHIVE="/home/root/.smart-remarkable.bundle-$ID.tar"
REMOTE_SCRIPT="/home/root/.smart-remarkable.install-$ID.sh"
REMOTE_TOKEN="/home/root/.smart-remarkable.bridge-token-$ID"
REMOTE_CLEANUP=0

cleanup() {
    status=$?
    trap - EXIT
    if [ "$REMOTE_CLEANUP" -ne 0 ]; then
        ssh -o BatchMode=yes "$HOST" \
            "rm -f '$REMOTE_ARCHIVE' '$REMOTE_SCRIPT' '$REMOTE_TOKEN'" \
            >/dev/null 2>&1 || true
    fi
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT

test -f "$CONTRACT"
test ! -L "$CONTRACT"
test -f "$CONTRACT_HELPER"
test ! -L "$CONTRACT_HELPER"
# shellcheck disable=SC1090
. "$CONTRACT_HELPER"
smart_contract_load "$CONTRACT"
smart_contract_require_complete || {
    echo "Application installation requires finalized app and QMD contract hashes" >&2
    exit 1
}
EXPECTED_DEVICE_SERIAL=$DEVICE_SERIAL
EXPECTED_FIRMWARE_VERSION=$FIRMWARE_VERSION
EXPECTED_FIRMWARE_BUILD=$FIRMWARE_BUILD
EXPECTED_XOCHITL_SHA256=$XOCHITL_SHA256
EXPECTED_SMART_REMARKABLE_SHA256=$SMART_REMARKABLE_SHA256
CONTRACT_SHA=$(shasum -a 256 "$CONTRACT" | awk '{print $1}')

test -x "$BINARY"
BUNDLE_SOURCE_PATHS=(
    target/aarch64-unknown-linux-gnu/release/smart_remarkable
    prompts/selection_openclaw.json
    prompts/selection_openclaw_whatsapp.json
    remagic/external.manifest.json
    remagic/icon.png
    remagic/appload-launch.sh
    scripts/selection-protocol.sh
    scripts/run-armed-once.sh
    scripts/run-selected-once.sh
    scripts/mode-settings.sh
    scripts/openclaw-runtime-env.sh
    ops/install-smart-openclaw.sh
    ops/device-install-smart-openclaw.sh
    ops/build-staged-sha256-manifest.sh
    ops/artifact-compatibility-contract.sh
    xovi-qmd/compatibility-3.28.0.164.env
)
for source_relative_path in "${BUNDLE_SOURCE_PATHS[@]}"; do
    source_path="$REPO/$source_relative_path"
    test -f "$source_path"
    test ! -L "$source_path"
done
mkdir -p "$STAGE/scripts"
install -m 0755 "$BINARY" "$STAGE/smart_remarkable"
install -m 0644 "$REPO/prompts/selection_openclaw.json" "$STAGE/selection_openclaw.json"
install -m 0644 \
    "$REPO/prompts/selection_openclaw_whatsapp.json" \
    "$STAGE/selection_openclaw_whatsapp.json"
install -m 0644 "$REPO/remagic/external.manifest.json" "$STAGE/external.manifest.json"
install -m 0644 "$REPO/remagic/icon.png" "$STAGE/icon.png"
install -m 0755 "$REPO/remagic/appload-launch.sh" "$STAGE/appload-launch.sh"
install -m 0755 \
    "$REPO/ops/artifact-compatibility-contract.sh" \
    "$STAGE/scripts/artifact-compatibility-contract.sh"
install -m 0755 \
    "$REPO/scripts/selection-protocol.sh" \
    "$STAGE/scripts/selection-protocol.sh"
install -m 0755 "$REPO/scripts/run-armed-once.sh" "$STAGE/scripts/run-armed-once.sh"
install -m 0755 "$REPO/scripts/run-selected-once.sh" "$STAGE/scripts/run-selected-once.sh"
install -m 0755 "$REPO/scripts/mode-settings.sh" "$STAGE/scripts/mode-settings.sh"
install -m 0755 \
    "$REPO/scripts/openclaw-runtime-env.sh" \
    "$STAGE/scripts/openclaw-runtime-env.sh"
install -m 0644 "$CONTRACT" "$STAGE/compatibility.env"

BINARY_SHA=$(shasum -a 256 "$BINARY" | awk '{print $1}')
test "$BINARY_SHA" = "$EXPECTED_SMART_REMARKABLE_SHA256"
LOCAL_INSTALLER_SHA=$(shasum -a 256 "$LOCAL_INSTALLER" | awk '{print $1}')
DEVICE_INSTALLER_SHA=$(shasum -a 256 "$DEVICE_INSTALLER" | awk '{print $1}')
MANIFEST_BUILDER_SHA=$(shasum -a 256 "$MANIFEST_BUILDER" | awk '{print $1}')
GIT_HEAD=$(git -C "$REPO" rev-parse HEAD)
SOURCE_DIFF_SHA=$(git -C "$REPO" diff --binary HEAD -- | shasum -a 256 | awk '{print $1}')
for source_relative_path in "${BUNDLE_SOURCE_PATHS[@]}"; do
    source_digest=$(shasum -a 256 "$REPO/$source_relative_path" | awk '{print $1}')
    printf '%s  %s\n' "$source_digest" "$source_relative_path"
done | LC_ALL=C sort >"$STAGE/SOURCE-INPUTS.sha256"
SOURCE_INPUTS_SHA=$(shasum -a 256 "$STAGE/SOURCE-INPUTS.sha256" | awk '{print $1}')
{
    printf 'source=https://github.com/yangg1224/smart_remarkable\n'
    printf 'git_head=%s\n' "$GIT_HEAD"
    printf 'source_diff_sha256=%s\n' "$SOURCE_DIFF_SHA"
    printf 'binary_sha256=%s\n' "$BINARY_SHA"
    printf 'artifact_contract=compatibility.env\n'
    printf 'artifact_contract_sha256=%s\n' "$CONTRACT_SHA"
    printf 'local_installer_sha256=%s\n' "$LOCAL_INSTALLER_SHA"
    printf 'device_installer_sha256=%s\n' "$DEVICE_INSTALLER_SHA"
    printf 'manifest_builder_sha256=%s\n' "$MANIFEST_BUILDER_SHA"
    printf 'source_inputs=SOURCE-INPUTS.sha256\n'
    printf 'source_inputs_sha256=%s\n' "$SOURCE_INPUTS_SHA"
    printf 'staged_manifest=STAGED-FILES.sha256\n'
    printf 'staged_manifest_scope=all-other-bundled-regular-files\n'
    printf 'integration=local-remagic-appload-openclaw-main\n'
} >"$STAGE/INSTALL-PROVENANCE.txt"

/bin/bash "$MANIFEST_BUILDER" "$STAGE"
STAGED_MANIFEST_SHA=$(shasum -a 256 "$STAGE/STAGED-FILES.sha256" | awk '{print $1}')
(
    cd "$STAGE"
    shasum -a 256 --strict --status -c STAGED-FILES.sha256
)

sed -n 's/^[0-9a-f]\{64\}  //p' "$STAGE/STAGED-FILES.sha256" >"$ARCHIVE_MEMBERS"
printf './STAGED-FILES.sha256\n' >>"$ARCHIVE_MEMBERS"
LC_ALL=C sort -o "$ARCHIVE_MEMBERS" "$ARCHIVE_MEMBERS"
EXPECTED_ARCHIVE_MEMBERS=$(printf '%s\n' \
    './INSTALL-PROVENANCE.txt' \
    './SOURCE-INPUTS.sha256' \
    './STAGED-FILES.sha256' \
    './appload-launch.sh' \
    './compatibility.env' \
    './external.manifest.json' \
    './icon.png' \
    './scripts/artifact-compatibility-contract.sh' \
    './scripts/mode-settings.sh' \
    './scripts/openclaw-runtime-env.sh' \
    './scripts/run-armed-once.sh' \
    './scripts/run-selected-once.sh' \
    './scripts/selection-protocol.sh' \
    './selection_openclaw.json' \
    './selection_openclaw_whatsapp.json' \
    './smart_remarkable')
test "$(cat "$ARCHIVE_MEMBERS")" = "$EXPECTED_ARCHIVE_MEMBERS"
COPYFILE_DISABLE=1 tar -C "$STAGE" -cf "$ARCHIVE" -T "$ARCHIVE_MEMBERS"
test "$(tar -tf "$ARCHIVE")" = "$EXPECTED_ARCHIVE_MEMBERS"
ARCHIVE_SHA=$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')
ARCHIVE_BYTES=$(wc -c <"$ARCHIVE" | tr -d ' ')
REQUIRED_HOME_KIB=$(((ARCHIVE_BYTES * 3 + 64 * 1024 * 1024 + 1023) / 1024))
jq -e \
    '.id == "smart-remarkable" and .application == "appload-launch.sh" and .qtfb == false' \
    "$STAGE/external.manifest.json" >/dev/null

# Read only the narrow tablet bearer from the server. Validate and hash it on
# the server, then stream it directly into a private tablet staging file so it
# is never materialized on this computer or printed by this script.
case "$HOST" in
    ""|-*|*[!A-Za-z0-9_.@-]*)
        echo "Unsafe tablet SSH host or alias" >&2
        exit 2
        ;;
esac
case "$BRIDGE_HOST" in
    ""|-*|*[!A-Za-z0-9_.@-]*)
        echo "Unsafe bridge SSH host or alias" >&2
        exit 2
        ;;
esac
case "$BRIDGE_TOKEN_PATH" in
    /home/*)
        case "$BRIDGE_TOKEN_PATH" in
            *[!A-Za-z0-9_./-]*|*//*|*/./*|*/../*|*/.|*/..)
                echo "Unsafe bridge token path" >&2
                exit 2
                ;;
        esac
        ;;
    *) echo "Unsafe bridge token path" >&2; exit 2 ;;
esac
TOKEN_SHA=$(
    ssh -o BatchMode=yes "$BRIDGE_HOST" "
        set -eu
        canonical=\$(readlink -f '$BRIDGE_TOKEN_PATH')
        test \"\$canonical\" = '$BRIDGE_TOKEN_PATH'
        case \"\$canonical\" in /home/*) ;; *) exit 1 ;; esac
        test -f '$BRIDGE_TOKEN_PATH'
        test ! -L '$BRIDGE_TOKEN_PATH'
        test \"\$(stat -c %u:%a '$BRIDGE_TOKEN_PATH')\" = \"\$(id -u):600\"
        token=\$(cat '$BRIDGE_TOKEN_PATH')
        case \"\$token\" in
            ''|*[!A-Za-z0-9_-]*) exit 1 ;;
        esac
        test \"\${#token}\" -ge 43
        test \"\${#token}\" -le 128
        test \"\$(wc -l <'$BRIDGE_TOKEN_PATH')\" -eq 1
        sha256sum '$BRIDGE_TOKEN_PATH' | cut -d' ' -f1
    "
)
[[ "$TOKEN_SHA" =~ ^[0-9a-f]{64}$ ]]

ssh -o BatchMode=yes "$HOST" "
    set -eu
    read_device_serial() {
        for path in /sys/devices/soc0/serial_number /proc/device-tree/serial-number; do
            if [ -r \"\$path\" ]; then
                tr -d '\\000\\r\\n' <\"\$path\"
                return
            fi
        done
        return 1
    }
    smart_process_running() {
        for exe in /proc/[0-9]*/exe; do
            [ -L \"\$exe\" ] || continue
            target=\$(readlink \"\$exe\" 2>/dev/null) || continue
            [ \"\${target##*/}\" = smart_remarkable ] && return 0
        done
        return 1
    }
    test \"\$(read_device_serial)\" = '$EXPECTED_DEVICE_SERIAL'
    test \"\$(sed -n 's/^IMG_VERSION=//p' /etc/os-release | tr -d '\\\"\\r\\n')\" = '$EXPECTED_FIRMWARE_VERSION'
    test \"\$(tr -d '\\r\\n' </etc/version)\" = '$EXPECTED_FIRMWARE_BUILD'
    test \"\$(sha256sum /usr/bin/xochitl | cut -d' ' -f1)\" = '$EXPECTED_XOCHITL_SHA256'
    systemctl is-active --quiet xochitl.service
    for unit in \
        riddle-takeover.service \
        smart-remarkable-once.service \
        smart-remarkable-session.service
    do
        if systemctl is-active --quiet \"\$unit\"; then
            echo \"Refusing installation while \$unit is active\" >&2
            exit 1
        fi
    done
    if smart_process_running; then
        echo 'Refusing installation while smart_remarkable is running' >&2
        exit 1
    fi
    test -c /dev/uinput
    test -x /usr/bin/hexdump
    test -x /usr/bin/flock
    test -x /usr/bin/ssh
    ssh_version=\$(/usr/bin/ssh -V 2>&1)
    test \"\$ssh_version\" = 'Dropbear v2025.88'
    ssh_help=\$(/usr/bin/ssh -h 2>&1 || true)
    case \"\$ssh_help\" in
        *'-K <keepalive>'*) ;;
        *) echo 'Firmware lacks the bounded Dropbear keepalive option' >&2; exit 1 ;;
    esac
    ssh_option_help=\$(/usr/bin/ssh -o help 2>&1 || true)
    for required_ssh_option in \
        BatchMode \
        PasswordAuthentication \
        DisableTrivialAuth \
        ForwardAgent \
        ExitOnForwardFailure \
        StrictHostKeyChecking
    do
        printf '%s\n' \"\$ssh_option_help\" |
            grep -F \"\$required_ssh_option\" >/dev/null || {
                echo 'Firmware lacks a pinned Smart tunnel option' >&2
                exit 1
            }
    done
    unset ssh_version ssh_help ssh_option_help required_ssh_option
    flock_probe=/run/smart-remarkable-install-flock.\$\$
    rm -f \"\$flock_probe\"
    (umask 077; : >\"\$flock_probe\")
    chmod 0600 \"\$flock_probe\"
    chown root:root \"\$flock_probe\"
    exec 9<>\"\$flock_probe\"
    if ! /usr/bin/flock -n -x 9; then
        exec 9>&-
        rm -f \"\$flock_probe\"
        echo 'Firmware cannot lock the Smart launcher lifecycle fd' >&2
        exit 1
    fi
    /usr/bin/flock -u 9
    exec 9>&-
    rm -f \"\$flock_probe\"
    nonce_probe=\$(
        /usr/bin/hexdump -n 32 -v -e '1/1 \"%02x\"' /dev/urandom
    )
    case "\$nonce_probe" in
        ''|*[!0-9a-f]*)
            echo 'Firmware cannot produce a canonical Smart request nonce' >&2
            exit 1
            ;;
    esac
    test "\${#nonce_probe}" -eq 64
    unset nonce_probe
    test -f /home/root/.ssh/id_dropbear_smart_remarkable_bridge
    test ! -L /home/root/.ssh/id_dropbear_smart_remarkable_bridge
    test \"\$(stat -c %u:%g:%a /home/root/.ssh/id_dropbear_smart_remarkable_bridge)\" = 0:0:600
    for dir_mode in \
        /home:0:0:755 \
        /home/root:0:0:700 \
        /home/root/xovi:0:0:755 \
        /home/root/xovi/exthome:0:0:755 \
        /home/root/xovi/exthome/appload:0:0:755 \
        /home/root/.config:0:0:755 \
        /home/root/.config/smart-remarkable:0:0:700
    do
        dir=\${dir_mode%%:*}
        expected=\${dir_mode#*:}
        test -d \"\$dir\"
        test ! -L \"\$dir\"
        test \"\$(stat -c %u:%g:%a \"\$dir\")\" = \"\$expected\"
    done
    QMD=/home/root/xovi/exthome/qt-resource-rebuilder/smart-remarkable-llm.qmd
    if test -e \"\$QMD\" || test -L \"\$QMD\"; then
        test -f \"\$QMD\"
        test ! -L \"\$QMD\"
        test \"\$(stat -c %u:%g:%a \"\$QMD\")\" = 0:0:644
        qmd_sha=\$(sha256sum \"\$QMD\" | cut -d' ' -f1)
        case \"\$qmd_sha\" in
            '$LEGACY_BUTTON_QMD_SHA256'|'$V2_MIGRATION_BUTTON_QMD_SHA256'|'$INERT_BUTTON_QMD_SHA256'|'$BUTTON_QMD_SHA256') ;;
            *) echo 'Active Smart QMD is outside the application compatibility contract' >&2; exit 1 ;;
        esac
    fi
    test ! -e '$REMOTE_ARCHIVE'
    test ! -L '$REMOTE_ARCHIVE'
    test ! -e '$REMOTE_SCRIPT'
    test ! -L '$REMOTE_SCRIPT'
    test ! -e '$REMOTE_TOKEN'
    test ! -L '$REMOTE_TOKEN'
    test \"\$(findmnt -n -o OPTIONS / | tr ',' '\n' | grep -c '^ro$')\" -eq 1
    AVAILABLE_HOME_KIB=\$(df -Pk /home | awk 'NR == 2 { print \$4 }')
    test \"\$AVAILABLE_HOME_KIB\" -ge '$REQUIRED_HOME_KIB'
"

REMOTE_CLEANUP=1
scp -O -q "$ARCHIVE" "$HOST:$REMOTE_ARCHIVE"
scp -O -q "$DEVICE_INSTALLER" "$HOST:$REMOTE_SCRIPT"
ssh -o BatchMode=yes "$BRIDGE_HOST" "cat '$BRIDGE_TOKEN_PATH'" |
    ssh -o BatchMode=yes "$HOST" "
        set -eu
        umask 077
        test ! -e '$REMOTE_TOKEN'
        test ! -L '$REMOTE_TOKEN'
        cat >'$REMOTE_TOKEN'
        chown root:root '$REMOTE_TOKEN'
        chmod 0600 '$REMOTE_TOKEN'
        test \"\$(sha256sum '$REMOTE_TOKEN' | cut -d' ' -f1)\" = '$TOKEN_SHA'
    "

ssh -o BatchMode=yes "$HOST" "
    set -eu
    test -f '$REMOTE_SCRIPT'
    test ! -L '$REMOTE_SCRIPT'
    test \"\$(stat -c %u:%g '$REMOTE_SCRIPT')\" = '0:0'
    test \"\$(sha256sum '$REMOTE_SCRIPT' | cut -d' ' -f1)\" = '$DEVICE_INSTALLER_SHA'
    chmod 0700 '$REMOTE_SCRIPT'
    systemctl reset-failed smart-remarkable-install.service >/dev/null 2>&1 || true
    systemd-run --wait --collect \
        --unit=smart-remarkable-install.service \
        --property='Conflicts=riddle-takeover.service smart-remarkable-once.service smart-remarkable-session.service' \
        --property='Before=riddle-takeover.service smart-remarkable-once.service smart-remarkable-session.service' \
        /bin/bash '$REMOTE_SCRIPT' \
        '$ID' '$ARCHIVE_SHA' '$BINARY_SHA' '$TOKEN_SHA' \
        '$STAGED_MANIFEST_SHA' '$DEVICE_INSTALLER_SHA' '$CONTRACT_SHA'
    rm -f '$REMOTE_SCRIPT'
"
REMOTE_CLEANUP=0

ssh -o BatchMode=yes "$HOST" "
    set -eu
    APP=/home/root/xovi/exthome/appload/smart-remarkable
    smart_process_running() {
        for exe in /proc/[0-9]*/exe; do
            [ -L \"\$exe\" ] || continue
            target=\$(readlink \"\$exe\" 2>/dev/null) || continue
            [ \"\${target##*/}\" = smart_remarkable ] && return 0
        done
        return 1
    }
    test \"\$(sha256sum \"\$APP/smart_remarkable\" | cut -d' ' -f1)\" = '$BINARY_SHA'
    test \"\$(sha256sum \"\$APP/compatibility.env\" | cut -d' ' -f1)\" = '$CONTRACT_SHA'
    test \"\$(sha256sum \"\$APP/appload-launch.sh\" | cut -d' ' -f1)\" = '$APPLOAD_LAUNCHER_SHA256'
    test \"\$(sha256sum \"\$APP/scripts/run-armed-once.sh\" | cut -d' ' -f1)\" = '$RUN_ARMED_ONCE_SHA256'
    test \"\$(sha256sum \"\$APP/scripts/selection-protocol.sh\" | cut -d' ' -f1)\" = '$SELECTION_PROTOCOL_SHA256'
    test \"\$(sha256sum \"\$APP/STAGED-FILES.sha256\" | cut -d' ' -f1)\" = '$STAGED_MANIFEST_SHA'
    (cd \"\$APP\" && sha256sum -c STAGED-FILES.sha256 >/dev/null)
    test \"\$(stat -c %u:%g:%a \"\$APP/.env\")\" = '0:0:600'
    test \"\$(grep -c '^OPENCLAW_BRIDGE_TOKEN=.' \"\$APP/.env\")\" -eq 1
    test \"\$(grep -Fxc 'OPENCLAW_REMOTE_PORT=18792' \"\$APP/.env\")\" -eq 1
    for forbidden in \
        OPENCLAW_GATEWAY_TOKEN \
        OPENCLAW_SESSION_KEY \
        OPENCLAW_MESSAGE_CHANNEL
    do
        if grep -q \"^\$forbidden=\" \"\$APP/.env\"; then
            echo \"Forbidden credential or route in installed environment: \$forbidden\" >&2
            exit 1
        fi
    done
    systemctl is-active --quiet xochitl.service
    for unit in smart-remarkable-once.service smart-remarkable-session.service; do
        if systemctl is-active --quiet \"\$unit\"; then
            echo \"Post-install service unexpectedly active: \$unit\" >&2
            exit 1
        fi
    done
    if smart_process_running; then
        echo 'Post-install smart_remarkable process unexpectedly active' >&2
        exit 1
    fi
    RECOVERY_METADATA=/home/root/.smart-remarkable-recovery/install-$ID.provenance
    test -f \"\$RECOVERY_METADATA\"
    test ! -L \"\$RECOVERY_METADATA\"
    test \"\$(stat -c %u:%g:%a \"\$RECOVERY_METADATA\")\" = '0:0:600'
    test \"\$(grep -Fxc 'phase=installed' \"\$RECOVERY_METADATA\")\" -eq 1
    test \"\$(grep -Fxc 'deployment_id=$ID' \"\$RECOVERY_METADATA\")\" -eq 1
    test \"\$(grep -Fxc 'archive_sha256=$ARCHIVE_SHA' \"\$RECOVERY_METADATA\")\" -eq 1
    test \"\$(grep -Fxc 'binary_sha256=$BINARY_SHA' \"\$RECOVERY_METADATA\")\" -eq 1
    test \"\$(grep -Fxc 'source_inputs_sha256=$SOURCE_INPUTS_SHA' \"\$RECOVERY_METADATA\")\" -eq 1
    test \"\$(grep -Fxc 'staged_manifest_sha256=$STAGED_MANIFEST_SHA' \"\$RECOVERY_METADATA\")\" -eq 1
    test \"\$(grep -Fxc 'device_installer_sha256=$DEVICE_INSTALLER_SHA' \"\$RECOVERY_METADATA\")\" -eq 1
    test \"\$(grep -Fxc 'artifact_contract_sha256=$CONTRACT_SHA' \"\$RECOVERY_METADATA\")\" -eq 1
    test \"\$(grep -Fxc 'rollback_order=qmd-before-app' \"\$RECOVERY_METADATA\")\" -eq 1
    EMBEDDED_MANIFEST=\$(
        sed -n '/^staged_files_begin\$/,/^staged_files_end\$/p' \"\$RECOVERY_METADATA\" |
            sed '1d;\$d'
    )
    test \"\$EMBEDDED_MANIFEST\" = \"\$(cat \"\$APP/STAGED-FILES.sha256\")\"
    EMBEDDED_SOURCE_INPUTS=\$(
        sed -n '/^source_inputs_begin\$/,/^source_inputs_end\$/p' \"\$RECOVERY_METADATA\" |
            sed '1d;\$d'
    )
    test \"\$EMBEDDED_SOURCE_INPUTS\" = \"\$(cat \"\$APP/SOURCE-INPUTS.sha256\")\"
    test \"\$(findmnt -n -o OPTIONS / | tr ',' '\n' | grep -c '^ro$')\" -eq 1
"

printf 'Installed Smart Remarkable binary sha256=%s staged_manifest_sha256=%s\n' \
    "$BINARY_SHA" "$STAGED_MANIFEST_SHA"
