#!/bin/bash
# Install one exact-firmware QMLDiff canary through a two-phase, guarded
# transaction. No boot unit, root remount, kernel module, or native UI injector
# is created by this controller.
set -Eeuo pipefail
umask 077

usage() {
    cat >&2 <<'USAGE'
Usage:
  ops/install-llm-button-canary.sh inert [--host SSH_HOST]
  ops/install-llm-button-canary.sh functional \
      --confirm-inert-visible=INERT_TRANSACTION_ID [--host SSH_HOST]
  ops/install-llm-button-canary.sh refresh-inert \
      --confirm-functional-working=FUNCTIONAL_TRANSACTION_ID [--host SSH_HOST]
  ops/install-llm-button-canary.sh refresh-functional \
      --confirm-refresh-inert-visible=REFRESH_INERT_TRANSACTION_ID [--host SSH_HOST]

The inert phase inserts disabled stock notebook-with-sparkles and sparkles
buttons. Inspect both on the tablet, then pass the exact transaction ID printed
by that run when promoting to functional.
The two refresh phases first replace an accepted functional button with a new
disabled visual canary, then promote only that exact confirmed canary.
USAGE
}

if [ "${1:-}" = -h ] || [ "${1:-}" = --help ]; then
    usage
    exit 0
fi

PHASE=${1:-}
[ "$#" -eq 0 ] || shift
HOST=remarkable-rmpp-new
CONFIRMED_INERT_ID=
CONFIRMED_FUNCTIONAL_ID=
CONFIRMED_REFRESH_INERT_ID=

while [ "$#" -gt 0 ]; do
    case "$1" in
        --host)
            [ "$#" -ge 2 ] || { usage; exit 2; }
            HOST=$2
            shift 2
            ;;
        --confirm-inert-visible=*)
            CONFIRMED_INERT_ID=${1#*=}
            shift
            ;;
        --confirm-functional-working=*)
            CONFIRMED_FUNCTIONAL_ID=${1#*=}
            shift
            ;;
        --confirm-refresh-inert-visible=*)
            CONFIRMED_REFRESH_INERT_ID=${1#*=}
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage
            exit 2
            ;;
    esac
done

valid_id() {
    [[ "$1" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]]
}

case "$PHASE" in
    inert)
        [ -z "$CONFIRMED_INERT_ID" ] &&
            [ -z "$CONFIRMED_FUNCTIONAL_ID" ] &&
            [ -z "$CONFIRMED_REFRESH_INERT_ID" ] || {
            echo "An inert run cannot confirm an earlier transaction" >&2
            exit 2
        }
        CONFIRMATION=none
        ;;
    functional)
        [ -z "$CONFIRMED_FUNCTIONAL_ID" ] &&
            [ -z "$CONFIRMED_REFRESH_INERT_ID" ] || {
            echo "Functional promotion accepts only an inert confirmation" >&2
            exit 2
        }
        valid_id "$CONFIRMED_INERT_ID" || {
            echo "Functional promotion requires --confirm-inert-visible=INERT_TRANSACTION_ID" >&2
            exit 2
        }
        CONFIRMATION=$CONFIRMED_INERT_ID
        ;;
    refresh-inert)
        [ -z "$CONFIRMED_INERT_ID" ] &&
            [ -z "$CONFIRMED_REFRESH_INERT_ID" ] || {
            echo "Refresh-inert accepts only a functional confirmation" >&2
            exit 2
        }
        valid_id "$CONFIRMED_FUNCTIONAL_ID" || {
            echo "Refresh-inert requires --confirm-functional-working=FUNCTIONAL_TRANSACTION_ID" >&2
            exit 2
        }
        CONFIRMATION=$CONFIRMED_FUNCTIONAL_ID
        ;;
    refresh-functional)
        [ -z "$CONFIRMED_INERT_ID" ] &&
            [ -z "$CONFIRMED_FUNCTIONAL_ID" ] || {
            echo "Refresh-functional accepts only a refresh-inert confirmation" >&2
            exit 2
        }
        valid_id "$CONFIRMED_REFRESH_INERT_ID" || {
            echo "Refresh-functional requires --confirm-refresh-inert-visible=REFRESH_INERT_TRANSACTION_ID" >&2
            exit 2
        }
        CONFIRMATION=$CONFIRMED_REFRESH_INERT_ID
        ;;
    *)
        usage
        exit 2
        ;;
esac

case "$HOST" in
    ""|-*|*[!A-Za-z0-9_.@-]*)
        echo "Unsafe SSH host or alias: $HOST" >&2
        exit 2
        ;;
esac

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ALLOWLIST="$REPO/xovi-qmd/compatibility-3.28.0.164.env"
CONTRACT_HELPER="$REPO/ops/artifact-compatibility-contract.sh"
DEVICE_SCRIPT="$REPO/ops/device-install-llm-button-canary.sh"
QMLDIFF_BIN=${QMLDIFF_BIN:-}
QMLFORMAT_BIN=${QMLFORMAT_BIN:-$(command -v qmlformat 2>/dev/null || true)}
QML_REFERENCE_ROOT=${QML_REFERENCE_ROOT:-/private/tmp/rmpp-3280164-resource-extract/resources}
XOCHITL_REFERENCE=${XOCHITL_REFERENCE:-/private/tmp/xochitl-ferrari-3.28.0.164}
READELF=${READELF:-/opt/homebrew/bin/aarch64-linux-gnu-readelf}
ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/smart-remarkable-llm-canary.XXXXXX")
STAGE="$WORK/stage"
ARCHIVE="$WORK/llm-button-canary.tar"
LIVE_HASHTAB="$WORK/live-hashtab"
QML_APPLY_OUTPUT="$WORK/qml-apply-output"
REMOTE_ARCHIVE="/home/root/.smart-remarkable-llm-canary-$ID.tar"
REMOTE_SCRIPT="/home/root/.smart-remarkable-llm-canary-$ID.sh"
STATE_DIR=/run/smart-remarkable-llm-button
GLOBAL_LOCK="$STATE_DIR/deployment.lock"
TXN_UNIT="smart-remarkable-llm-canary-$ID.service"
WATCHDOG_UNIT="smart-remarkable-llm-watchdog-$ID.service"
REMOTE_CLEANUP=0

cleanup() {
    rc=$?
    trap - EXIT
    if [ "$REMOTE_CLEANUP" -ne 0 ]; then
        # Terminate only this transaction. Never stop an armed guardian from a
        # local error, Ctrl-C, or SSH disconnect.
        ssh -o BatchMode=yes "$HOST" "
            if test -f '$GLOBAL_LOCK/owner' &&
                test \"\$(cat '$GLOBAL_LOCK/owner' 2>/dev/null)\" = '$ID'; then
                systemctl kill --kill-who=main --signal=TERM '$TXN_UNIT' \
                    >/dev/null 2>&1 || true
                if ! test -f '$STATE_DIR/$ID.watchdog-ready'; then
                    systemctl stop '$WATCHDOG_UNIT' >/dev/null 2>&1 || true
                    rm -f '$REMOTE_ARCHIVE' '$REMOTE_SCRIPT'
                    rm -f '$GLOBAL_LOCK/owner'
                    rmdir '$GLOBAL_LOCK' >/dev/null 2>&1 || true
                fi
            elif ! systemctl is-active --quiet '$WATCHDOG_UNIT' &&
                ! systemctl is-active --quiet '$TXN_UNIT'; then
                rm -f '$REMOTE_ARCHIVE' '$REMOTE_SCRIPT'
            fi
        " >/dev/null 2>&1 || true
    fi
    rm -rf "$WORK"
    exit "$rc"
}
trap cleanup EXIT

test -f "$ALLOWLIST"
test ! -L "$ALLOWLIST"
test -f "$CONTRACT_HELPER"
test ! -L "$CONTRACT_HELPER"
test -f "$DEVICE_SCRIPT"
test ! -L "$DEVICE_SCRIPT"

# Parse the compatibility file as inert data through the shared strict parser.
# shellcheck disable=SC1090
. "$CONTRACT_HELPER"
smart_contract_load "$ALLOWLIST"

[[ "$DEVICE_SERIAL" =~ ^[0-9A-F]{16}$ ]]
[[ "$FIRMWARE_VERSION" =~ ^[0-9]+(\.[0-9]+){3}$ ]]
[[ "$FIRMWARE_BUILD" =~ ^[0-9]{14}$ ]]
[[ "$XOCHITL_BUILD_ID" =~ ^[0-9a-f]{40}$ ]]
[[ "$SCENE_SELECTION_HANDLER_RESOURCE_HASH" =~ ^[0-9]+$ ]]
[[ "$DEVICE_SCENE_VIEW_RESOURCE_HASH" =~ ^[0-9]+$ ]]
[[ "$SELECTION_CONTEXTUAL_MENU_RESOURCE_HASH" =~ ^[0-9]+$ ]]
if [ "$PHASE" = inert ]; then
    SOURCE_QMD="$REPO/xovi-qmd/llm-button-inert-3.28.0.164.source.qmd"
    BUTTON_QMD="$REPO/xovi-qmd/llm-button-inert-3.28.0.164.qmd"
    EXPECTED_SOURCE_SHA=$INERT_SOURCE_QMD_SHA256
    EXPECTED_BUTTON_SHA=$INERT_BUTTON_QMD_SHA256
else
    smart_contract_require_complete || {
        echo "QMD transition requires finalized app and QMD contract hashes" >&2
        exit 1
    }
    if [ "$PHASE" = refresh-inert ]; then
        SOURCE_QMD="$REPO/xovi-qmd/llm-button-inert-3.28.0.164.source.qmd"
        BUTTON_QMD="$REPO/xovi-qmd/llm-button-inert-3.28.0.164.qmd"
        EXPECTED_SOURCE_SHA=$INERT_SOURCE_QMD_SHA256
        EXPECTED_BUTTON_SHA=$INERT_BUTTON_QMD_SHA256
    else
        SOURCE_QMD="$REPO/xovi-qmd/llm-button-3.28.0.164.source.qmd"
        BUTTON_QMD="$REPO/xovi-qmd/llm-button-3.28.0.164.qmd"
        EXPECTED_SOURCE_SHA=$SOURCE_QMD_SHA256
        EXPECTED_BUTTON_SHA=$BUTTON_QMD_SHA256
    fi
fi

test -f "$SOURCE_QMD"
test ! -L "$SOURCE_QMD"
test -f "$BUTTON_QMD"
test ! -L "$BUTTON_QMD"
test "$(shasum -a 256 "$SOURCE_QMD" | awk '{print $1}')" = "$EXPECTED_SOURCE_SHA"
test "$(shasum -a 256 "$BUTTON_QMD" | awk '{print $1}')" = "$EXPECTED_BUTTON_SHA"

SCENE_SELECTION_HANDLER_REL=qml/common/SceneSelectionHandler.qml
DEVICE_SCENE_VIEW_REL=qml/device/view/documentview/DeviceSceneView.qml

require_stock_qml_references() {
    local relative_path reference_path
    if [ ! -d "$QML_REFERENCE_ROOT" ] || [ -L "$QML_REFERENCE_ROOT" ]; then
        echo "QML reference root is not a regular directory: $QML_REFERENCE_ROOT" >&2
        exit 1
    fi
    for relative_path in \
        "$SCENE_SELECTION_HANDLER_REL" \
        "$DEVICE_SCENE_VIEW_REL"
    do
        reference_path="$QML_REFERENCE_ROOT/$relative_path"
        if [ ! -f "$reference_path" ] || [ -L "$reference_path" ]; then
            echo "Missing regular stock QML reference: $reference_path" >&2
            exit 1
        fi
    done
}

require_applied_qml_outputs() {
    local relative_path output_path
    for relative_path in \
        "$SCENE_SELECTION_HANDLER_REL" \
        "$DEVICE_SCENE_VIEW_REL"
    do
        output_path="$QML_APPLY_OUTPUT/$relative_path"
        if [ ! -f "$output_path" ] || [ -L "$output_path" ] || [ ! -s "$output_path" ]; then
            echo "QMD did not produce a regular nonempty QML resource: $output_path" >&2
            exit 1
        fi
        if ! "$QMLFORMAT_BIN" --ignore-settings "$output_path" >/dev/null; then
            echo "QMD produced QML that qmlformat cannot parse: $output_path" >&2
            exit 1
        fi
    done
}

# The tablet has no readelf. Verify build ID on a local byte-for-byte reference,
# then require the same complete SHA-256 again on-device immediately pre-mutation.
test -f "$XOCHITL_REFERENCE"
test ! -L "$XOCHITL_REFERENCE"
test -x "$READELF"
test "$(shasum -a 256 "$XOCHITL_REFERENCE" | awk '{print $1}')" = "$XOCHITL_SHA256"
REFERENCE_BUILD_ID=$(
    "$READELF" -n "$XOCHITL_REFERENCE" |
        awk '/Build ID:/ && !found { value=$3; found=1 } END { if (!found) exit 1; print value }'
)
test "$REFERENCE_BUILD_ID" = "$XOCHITL_BUILD_ID"

if [ -z "$QMLDIFF_BIN" ]; then
    for candidate in \
        "$(command -v qmldiff 2>/dev/null || true)" \
        /private/tmp/rm-xovi-extensions-audit-20260723/qt-resource-rebuilder/qmldiff/target/release/qmldiff
    do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
            QMLDIFF_BIN=$candidate
            break
        fi
    done
fi
[ -n "$QMLDIFF_BIN" ] && [ -x "$QMLDIFF_BIN" ] || {
    echo "A local qmldiff binary is required; set QMLDIFF_BIN" >&2
    exit 1
}
[ -n "$QMLFORMAT_BIN" ] && [ -x "$QMLFORMAT_BIN" ] || {
    echo "A local qmlformat binary is required; set QMLFORMAT_BIN" >&2
    exit 1
}

# Fail locally before the first device connection if the exact extracted stock
# resources needed for a real parser/application check are unavailable.
require_stock_qml_references

# Preliminary read-only gate. The device transaction repeats the complete
# fingerprint immediately before it writes ARMED or the QMD.
ssh -o BatchMode=yes "$HOST" "
    set -eu
    test \"\$(cat /sys/devices/soc0/serial_number | tr -d '[:space:]')\" = '$DEVICE_SERIAL'
    test \"\$(awk -F= '\$1 == \"IMG_VERSION\" { gsub(/^\"|\"$/, \"\", \$2); print \$2 }' /etc/os-release)\" = '$FIRMWARE_VERSION'
    test \"\$(tr -d '[:space:]' </etc/version)\" = '$FIRMWARE_BUILD'
    systemctl is-active --quiet xochitl.service
    for unit in \
        riddle-takeover.service \
        smart-remarkable-once.service \
        smart-remarkable-session.service
    do
        if systemctl is-active --quiet \"\$unit\"; then
            echo \"Refusing canary while \$unit is active\" >&2
            exit 1
        fi
    done
    test \"\$(sha256sum /usr/bin/xochitl | cut -d' ' -f1)\" = '$XOCHITL_SHA256'
    test \"\$(sha256sum /home/root/xovi/exthome/qt-resource-rebuilder/hashtab | cut -d' ' -f1)\" = '$HASHTAB_SHA256'
    test \"\$(findmnt -n -o OPTIONS / | tr ',' '\n' | grep -c '^ro$')\" -eq 1
"

scp -O -q \
    "$HOST:/home/root/xovi/exthome/qt-resource-rebuilder/hashtab" \
    "$LIVE_HASHTAB"
test "$(shasum -a 256 "$LIVE_HASHTAB" | awk '{print $1}')" = "$HASHTAB_SHA256"
COMPATIBILITY_RESULT=$(
    "$QMLDIFF_BIN" check-compatibility "$LIVE_HASHTAB" "$BUTTON_QMD"
)
test "$COMPATIBILITY_RESULT" = 'No compatibility errors found.'

# check-compatibility validates resource identities but does not parse and
# apply the patch. Exercise the exact compiled QMD against both extracted stock
# resources, using the SHA-pinned live hashtab, before any remote write.
mkdir -m 0700 "$QML_APPLY_OUTPUT"
"$QMLDIFF_BIN" apply-diffs \
    --hashtab "$LIVE_HASHTAB" \
    "$QML_REFERENCE_ROOT" "$QML_APPLY_OUTPUT" "$BUTTON_QMD"
require_applied_qml_outputs

DUMP=$("$QMLDIFF_BIN" dump-hashtab "$LIVE_HASHTAB")
printf '%s\n' "$DUMP" |
    grep -Fx "/qml/common/SceneSelectionHandler.qml = $SCENE_SELECTION_HANDLER_RESOURCE_HASH" \
        >/dev/null
printf '%s\n' "$DUMP" |
    grep -Fx "/qml/device/view/documentview/DeviceSceneView.qml = $DEVICE_SCENE_VIEW_RESOURCE_HASH" \
        >/dev/null
printf '%s\n' "$DUMP" |
    grep -Fx "/qml/common/SelectionContextualMenu.qml = $SELECTION_CONTEXTUAL_MENU_RESOURCE_HASH" \
        >/dev/null
unset COMPATIBILITY_RESULT DUMP

mkdir -m 0700 "$STAGE"
install -m 0755 "$CONTRACT_HELPER" "$STAGE/artifact-compatibility-contract.sh"
install -m 0600 "$ALLOWLIST" "$STAGE/compatibility.env"
install -m 0644 "$BUTTON_QMD" "$STAGE/button.qmd"
COPYFILE_DISABLE=1 tar -C "$STAGE" -cf "$ARCHIVE" \
    artifact-compatibility-contract.sh compatibility.env button.qmd
test "$(tar -tf "$ARCHIVE")" = \
    "$(printf 'artifact-compatibility-contract.sh\ncompatibility.env\nbutton.qmd')"
ARCHIVE_SHA=$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')
SCRIPT_SHA=$(shasum -a 256 "$DEVICE_SCRIPT" | awk '{print $1}')

REMOTE_CLEANUP=1
scp -O -q "$ARCHIVE" "$HOST:$REMOTE_ARCHIVE"
scp -O -q "$DEVICE_SCRIPT" "$HOST:$REMOTE_SCRIPT"

# Acquire one device-wide deployment lock before either per-ID transient unit
# starts. A competing controller cannot stop these uniquely named units.
ssh -o BatchMode=yes "$HOST" "
    set -eu
    test \"\$(sha256sum '$REMOTE_ARCHIVE' | cut -d' ' -f1)\" = '$ARCHIVE_SHA'
    test \"\$(sha256sum '$REMOTE_SCRIPT' | cut -d' ' -f1)\" = '$SCRIPT_SHA'
    chown root:root '$REMOTE_ARCHIVE' '$REMOTE_SCRIPT'
    chmod 0600 '$REMOTE_ARCHIVE'
    chmod 0700 '$REMOTE_SCRIPT'
    if test -e '$STATE_DIR' || test -L '$STATE_DIR'; then
        test -d '$STATE_DIR'
        test ! -L '$STATE_DIR'
        test \"\$(stat -c %u:%g:%a '$STATE_DIR')\" = 0:0:700
    else
        mkdir -p '$STATE_DIR'
        chown root:root '$STATE_DIR'
        chmod 0700 '$STATE_DIR'
    fi
    mkdir '$GLOBAL_LOCK'
    chown root:root '$GLOBAL_LOCK'
    chmod 0700 '$GLOBAL_LOCK'
    printf '%s\n' '$ID' >'$GLOBAL_LOCK/owner'
    chown root:root '$GLOBAL_LOCK/owner'
    chmod 0600 '$GLOBAL_LOCK/owner'
    rm -f \
        '$STATE_DIR/$ID.status' \
        '$STATE_DIR/$ID.armed' \
        '$STATE_DIR/$ID.healthy' \
        '$STATE_DIR/$ID.ack' \
        '$STATE_DIR/$ID.commit' \
        '$STATE_DIR/$ID.validated' \
        '$STATE_DIR/$ID.rollback-done' \
        '$STATE_DIR/$ID.watchdog-ready'
    systemctl reset-failed '$TXN_UNIT' '$WATCHDOG_UNIT' >/dev/null 2>&1 || true
    systemd-run --no-block --collect \
        --unit='$WATCHDOG_UNIT' \
        --property='RuntimeMaxSec=400' \
        --property='TimeoutStopSec=70' \
        --property='LimitCORE=0' \
        --property='Restart=on-failure' \
        --property='RestartSec=2' \
        --property='StartLimitIntervalSec=300' \
        --property='StartLimitBurst=3' \
        /bin/bash '$REMOTE_SCRIPT' watchdog \
        '$PHASE' '$ID' '$EXPECTED_BUTTON_SHA' '$DEVICE_SERIAL' \
        '$STOCK_SCRIPT_SHA256' '$XOVI_XOCHITL_SERVICE_CONF_SHA256' '$XOCHITL_SHA256' \
        '$XOCHITL_UNIT_SHA256' '$XOCHITL_STOCK_OVERRIDE_SHA256'
    attempt=0
    while test \"\$attempt\" -lt 20; do
        test -f '$STATE_DIR/$ID.watchdog-ready' && break
        watchdog_state=\$(systemctl show -p ActiveState --value '$WATCHDOG_UNIT')
        case \"\$watchdog_state\" in active|activating) ;; *) exit 1 ;; esac
        attempt=\$((attempt + 1))
        sleep 1
    done
    test -f '$STATE_DIR/$ID.watchdog-ready'
    grep -Fqx 'ID=$ID' '$STATE_DIR/$ID.watchdog-ready'
    grep -Fqx 'QMD_SHA256=$EXPECTED_BUTTON_SHA' '$STATE_DIR/$ID.watchdog-ready'
    systemd-run --no-block --collect \
        --unit='$TXN_UNIT' \
        --property='RuntimeMaxSec=180' \
        --property='TimeoutStopSec=60' \
        --property='LimitCORE=0' \
        --property='Requires=$WATCHDOG_UNIT' \
        --property='BindsTo=$WATCHDOG_UNIT' \
        --property='After=$WATCHDOG_UNIT' \
        --property='Conflicts=riddle-takeover.service smart-remarkable-once.service smart-remarkable-session.service' \
        /bin/bash '$REMOTE_SCRIPT' install \
        '$PHASE' '$ID' '$ARCHIVE_SHA' '$CONFIRMATION'
"

read_remote_state() {
    ssh -o BatchMode=yes "$HOST" "
        if test -f '$STATE_DIR/$ID.commit'; then
            cat '$STATE_DIR/$ID.commit'
        elif test -f '$STATE_DIR/$ID.rollback-done'; then
            cat '$STATE_DIR/$ID.rollback-done'
        elif test -f '$STATE_DIR/$ID.status'; then
            cat '$STATE_DIR/$ID.status'
        elif test -f '$STATE_DIR/$ID.healthy'; then
            cat '$STATE_DIR/$ID.healthy'
        fi
    " || true
}

STATE=
attempt=0
while [ "$attempt" -lt 100 ]; do
    STATE=$(read_remote_state)
    case "$STATE" in
        healthy:*|failure:*|rollback:*|success:*) break ;;
    esac
    attempt=$((attempt + 1))
    sleep 2
done

if [[ "$STATE" =~ ^healthy:$PHASE:([1-9][0-9]*)$ ]]; then
    NEW_PID=${BASH_REMATCH[1]}
else
    echo "Canary did not reach the controller-checkpoint: ${STATE:-no state}" >&2
    exit 1
fi

# The remote acknowledgement action performs the controller-side five-second
# PID/root/QMD postcheck and writes ACK only if every invariant remains true.
ssh -o BatchMode=yes "$HOST" \
    "/bin/bash '$REMOTE_SCRIPT' acknowledge '$PHASE' '$ID' '$EXPECTED_BUTTON_SHA' '$NEW_PID'"

STATE=
attempt=0
while [ "$attempt" -lt 40 ]; do
    STATE=$(read_remote_state)
    case "$STATE" in
        success:*|failure:*|rollback:*) break ;;
    esac
    attempt=$((attempt + 1))
    sleep 1
done

if [[ "$STATE" =~ ^success:$PHASE:([1-9][0-9]*)$ ]] &&
    [ "${BASH_REMATCH[1]}" = "$NEW_PID" ]; then
    :
else
    echo "Canary was not committed: ${STATE:-no state}" >&2
    exit 1
fi

ssh -o BatchMode=yes "$HOST" "
    set -eu
    test \"\$(cat '$STATE_DIR/$ID.commit')\" = '$STATE'
    test \"\$(systemctl show -p MainPID --value xochitl.service)\" = '$NEW_PID'
    systemctl is-active --quiet xochitl.service
    test -f /home/root/xovi/exthome/qt-resource-rebuilder/smart-remarkable-llm.qmd
    test ! -L /home/root/xovi/exthome/qt-resource-rebuilder/smart-remarkable-llm.qmd
    test \"\$(stat -c %u:%g:%a /home/root/xovi/exthome/qt-resource-rebuilder/smart-remarkable-llm.qmd)\" = 0:0:644
    test \"\$(sha256sum /home/root/xovi/exthome/qt-resource-rebuilder/smart-remarkable-llm.qmd | cut -d' ' -f1)\" = '$EXPECTED_BUTTON_SHA'
    test \"\$(findmnt -n -o OPTIONS / | tr ',' '\n' | grep -c '^ro$')\" -eq 1
    attempt=0
    while systemctl is-active --quiet '$WATCHDOG_UNIT' &&
        test \"\$attempt\" -lt 15; do
        attempt=\$((attempt + 1))
        sleep 1
    done
    if systemctl is-active --quiet '$WATCHDOG_UNIT'; then
        echo 'Canary watchdog did not stop within the bound' >&2
        exit 1
    fi
    test -f '$STATE_DIR/$ID.validated'
    test ! -L '$STATE_DIR/$ID.validated'
    test \"\$(stat -c %u:%g:%a '$STATE_DIR/$ID.validated')\" = 0:0:600
    test \"\$(cat '$STATE_DIR/$ID.validated')\" = 'validated:$PHASE:$NEW_PID'
    test ! -e '$STATE_DIR/$ID.status'
    test ! -L '$STATE_DIR/$ID.status'
    test ! -e '$STATE_DIR/$ID.rollback-done'
    test ! -L '$STATE_DIR/$ID.rollback-done'
    test \"\$(cat '$STATE_DIR/$ID.commit')\" = '$STATE'
    test \"\$(systemctl show -p MainPID --value xochitl.service)\" = '$NEW_PID'
    systemctl is-active --quiet xochitl.service
    test \"\$(sha256sum /home/root/xovi/exthome/qt-resource-rebuilder/smart-remarkable-llm.qmd | cut -d' ' -f1)\" = '$EXPECTED_BUTTON_SHA'
    test \"\$(findmnt -n -o OPTIONS / | tr ',' '\n' | grep -c '^ro$')\" -eq 1
    systemctl stop '$TXN_UNIT' >/dev/null 2>&1 || true
    systemctl reset-failed '$TXN_UNIT' '$WATCHDOG_UNIT' >/dev/null 2>&1 || true
    rm -f '$REMOTE_ARCHIVE' '$REMOTE_SCRIPT'
    if test -f '$GLOBAL_LOCK/owner' &&
        test \"\$(cat '$GLOBAL_LOCK/owner')\" = '$ID'; then
        rm -f '$GLOBAL_LOCK/owner'
        rmdir '$GLOBAL_LOCK' >/dev/null 2>&1 || true
    fi
"
REMOTE_CLEANUP=0

printf '%s LLM-button canary committed on %s; transaction_id=%s xochitl_pid=%s qmd_sha256=%s\n' \
    "$PHASE" "$HOST" "$ID" "$NEW_PID" "$EXPECTED_BUTTON_SHA"
