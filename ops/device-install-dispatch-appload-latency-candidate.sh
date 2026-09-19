#!/bin/bash
# Guarded device-side transaction for the Dispatch-only AppLoad repaint QMD.
# This file is an inert artifact until a reviewed stage is explicitly run on
# the exact Ferrari 3.28.0.169 target.
set -Eeuo pipefail
umask 077

ACTION=${1:-}
STAGE=${2:-}
REVIEWED_MANIFEST_SHA256=${3:-}
ID=${4:-}

case "$ACTION" in prepare|activate) ;;
    *) echo "usage: $0 prepare|activate STAGE REVIEWED_SHA256 ID" >&2; exit 2 ;;
esac
[[ "$ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || {
    echo "invalid transaction id" >&2
    exit 2
}
case "$REVIEWED_MANIFEST_SHA256" in
    *[!0-9a-f]*|"") echo "invalid reviewed manifest hash" >&2; exit 2 ;;
esac
[ "${#REVIEWED_MANIFEST_SHA256}" -eq 64 ] || exit 2
case "$STAGE" in
    /home/root/.codex-staging/dispatch-appload-latency-*) ;;
    *) echo "invalid stage path" >&2; exit 2 ;;
esac
[ -d "$STAGE" ] && [ ! -L "$STAGE" ] || exit 2
[ "$(readlink -f "$STAGE")" = "$STAGE" ] || exit 2

QDIR=/home/root/xovi/exthome/qt-resource-rebuilder
TARGET="$QDIR/dispatch-appload-partial-repaint-3.28.0.169.qmd"
XOVI_ROOT=/home/root/xovi
XOCHITL=/usr/bin/xochitl
XOVI="$XOVI_ROOT/xovi.so"
EXTENSIONS="$XOVI_ROOT/extensions.d"
QRR="$EXTENSIONS/qt-resource-rebuilder.so"
BROKER="$EXTENSIONS/xovi-message-broker.so"
APPLOAD="$EXTENSIONS/appload.so"
FRAMEBUFFER_SPY="$EXTENSIONS/framebuffer-spy.so"
HASHTAB="$QDIR/hashtab"
REMAGIC="$XOVI_ROOT/remagic-live-test-safe.sh"
START="$XOVI_ROOT/start"
STOCK="$XOVI_ROOT/stock"
SERVICE_ROOT="$XOVI_ROOT/services"
SERVICE_DIR="$SERVICE_ROOT/xochitl.service"
SERVICE_CONF="$SERVICE_DIR/qt-resource-rebuilder.conf"
SCRIPT_ROOT="$XOVI_ROOT/scripts"
STOCK_UNIT=/usr/lib/systemd/system/xochitl.service
STOCK_OVERRIDE=/usr/lib/systemd/system/xochitl.service.d/xochitl-service-override.conf
DISPATCH_ROOT="$XOVI_ROOT/exthome/appload/remarkable-dispatch"
DISPATCH_BINARY="$DISPATCH_ROOT/remarkable-dispatch"
DISPATCH_MANIFEST="$DISPATCH_ROOT/external.manifest.json"
RECOVERY_PARENT=/home/root/.smart-remarkable-recovery
RECOVERY_BASE="$RECOVERY_PARENT/dispatch-appload-latency"
RECOVERY="$RECOVERY_BASE/$ID"
LOCK=/run/dispatch-appload-latency.lock
TIMER_UNIT="dispatch-appload-latency-rollback-$ID.timer"
SERVICE_UNIT="dispatch-appload-latency-rollback-$ID.service"
TRANSACTION_UNIT="dispatch-appload-latency-install-$ID.service"
REMAGIC_TIMER=remagic-live-safety.timer
REMAGIC_SERVICE=remagic-live-safety.service
REMAGIC_SAFETY_CONF=/run/systemd/system/xochitl.service.d/xochitl-service-override.conf
REMAGIC_ROLLBACK_HELPER=/run/remagic-live-rollback.sh
REMAGIC_ROLLBACK_DONE=/run/remagic-live-rollback.done

EXPECTED_MODEL='reMarkable Ferrari'
EXPECTED_SERIAL=0A247209DABC7917
EXPECTED_FIRMWARE=3.28.0.169
EXPECTED_BUILD=20260806095513
EXPECTED_XOCHITL_SHA256=43a9d5d0acc5b998264c16586e11b848f3b83d2d63b5fd322b09c0977d94d3d4
EXPECTED_XOVI_SHA256=d4df820c25c634c511de11067279d8310fa4f656dc52bd4540db6beac4ffd446
EXPECTED_QRR_SHA256=6726f561557406f36347e43fc2b44a88deef4fb273d2ece88f48f427dad8800f
EXPECTED_BROKER_SHA256=61c0c7b0d4e2c7623147a87c63d6a4aaec868019e67fb0e1bdb1fcb215f6e155
EXPECTED_APPLOAD_SHA256=9a6d55d21852976e7c6cf34b1d09e5ca6e428547aa8c03d53d91b1bb9ff87b9a
EXPECTED_FRAMEBUFFER_SPY_SHA256=0a999dffbcb4026b59d6626a15360ef9388747448fdeeb97e4dab155425e3e1e
EXPECTED_HASHTAB_SHA256=ecb0cfbd6828c374e48139064436a12f2c04778a90192b9dd85887edbdbe256a
EXPECTED_REMAGIC_SHA256=fb785d0f6a4efe3f58137b95fd979307cafa0d8d52e3e1d263d0f0df77ac81a7
EXPECTED_START_SHA256=bf15dfd641deea3e4487b9182957938a3dc824c340383c9243b7f118bfe829dc
EXPECTED_STOCK_SHA256=e29494c9fff5ede390b06f1f5e27ca59e4f7bc81d25889822a123ccad1fd686d
EXPECTED_SERVICE_CONF_SHA256=6036f7776f8775529f94056fafe066ff373f5aa6bca39633bfd4dabfc1552ffd
EXPECTED_APPLEDOUBLE_SHA256=a502dbe0e569c3718c449b86480d0cd4cdc23e3a450814de360e5b0a5e08c5d3
EXPECTED_STOCK_UNIT_SHA256=23f537cf59d527bfbf4823f372385d613e1ade0961c98831c935a372018f9566
EXPECTED_STOCK_OVERRIDE_SHA256=a9432caffacb29d6fcb35136dcc3cb43d8737eb6c2efcb35ea335725f42082d1
EXPECTED_DISPATCH_MANIFEST_SHA256=4c0b0adba890becb4aa85678c3dc345a9d8909f65a5b9734b809b4746341a32c
EXPECTED_DISPATCH_BINARY_SHA256=d700b7c8c3df4d5750d0844169a0d50324f9d7fd2a8ac4f8667a40efa26ceab4
EXPECTED_DATES_QMD_SHA256=2d4681414ac00b534b2f21d179365601ce9e876c7cfbf6c6c8d25a2f8738e580
EXPECTED_BASELINE_SHA256=1e89ad1fcde7920760ed2a7d44d892e9a0be46acc5d5e05ffaac7d087fbce138
EXPECTED_CANDIDATE_SHA256=1eb2037f28c9891fbdc4a97d1e2916b8e923fe04004ae1ced03b5de73f59a60e

hash_file() {
    local path=$1
    sha256sum "$path" | cut -d' ' -f1
}

exact_root_file() {
    local path=$1
    local expected=$2
    [ -f "$path" ] && [ ! -L "$path" ] || return 1
    [ "$(stat -c %u:%g "$path")" = 0:0 ] || return 1
    [ "$(hash_file "$path")" = "$expected" ] || return 1
}

exact_owned_file() {
    local path=$1
    local expected=$2
    local owner_mode=$3
    [ -f "$path" ] && [ ! -L "$path" ] || return 1
    [ "$(stat -c %u:%g:%a "$path")" = "$owner_mode" ] || return 1
    [ "$(hash_file "$path")" = "$expected" ] || return 1
}

root_is_read_only() {
    [ "$(findmnt -n -o OPTIONS / | tr ',' '\n' | grep -c '^ro$')" -eq 1 ]
}

read_serial() {
    local path
    for path in /sys/devices/soc0/serial_number /proc/device-tree/serial-number; do
        if [ -f "$path" ]; then
            tr -d '\000[:space:]' <"$path"
            return 0
        fi
    done
    return 1
}

read_firmware() {
    awk -F= '$1 == "IMG_VERSION" { value=$2; gsub(/^"|"$/, "", value); print value; exit }' /etc/os-release
}

dispatch_running() {
    local executable
    local resolved
    for executable in /proc/[0-9]*/exe; do
        [ -L "$executable" ] || continue
        resolved=$(readlink -f "$executable" 2>/dev/null || true)
        [ "$resolved" = "$DISPATCH_ROOT/remarkable-dispatch" ] && return 0
    done
    return 1
}

verify_stage() {
    local expected_names
    local actual_names
    local path
    local listed_names
    expected_names=$(printf '%s\n' \
        SHA256SUMS \
        baseline.sha256 \
        candidate.qmd \
        device-install.sh \
        rollback.sh | sort)
    actual_names=
    for path in "$STAGE"/* "$STAGE"/.[!.]* "$STAGE"/..?*; do
        [ -e "$path" ] || [ -L "$path" ] || continue
        [ -f "$path" ] && [ ! -L "$path" ] || return 1
        actual_names="${actual_names}${path##*/}
"
    done
    actual_names=$(printf '%s' "$actual_names" | sort)
    [ "$actual_names" = "$expected_names" ] || return 1
    exact_root_file "$STAGE/SHA256SUMS" "$REVIEWED_MANIFEST_SHA256" || return 1
    [ "$(wc -l <"$STAGE/SHA256SUMS" | tr -d ' ')" = 4 ] || return 1
    listed_names=$(awk 'NF == 2 { print $2 }' "$STAGE/SHA256SUMS" | sort)
    [ "$listed_names" = "$(printf '%s\n' baseline.sha256 candidate.qmd device-install.sh rollback.sh | sort)" ] || return 1
    (cd "$STAGE" && sha256sum -c SHA256SUMS) >&2 || return 1
    exact_root_file "$STAGE/baseline.sha256" "$EXPECTED_BASELINE_SHA256" || return 1
    exact_root_file "$STAGE/candidate.qmd" "$EXPECTED_CANDIDATE_SHA256" || return 1
    [ -x "$STAGE/device-install.sh" ] || return 1
    [ -x "$STAGE/rollback.sh" ] || return 1
}

qmd_names() {
    local names=
    local path
    local name
    for path in "$QDIR"/* "$QDIR"/.[!.]* "$QDIR"/..?*; do
        [ -e "$path" ] || [ -L "$path" ] || continue
        name=${path##*/}
        case "$name" in
            *.qmd|*.qrr|*.rcc)
                [ -f "$path" ] && [ ! -L "$path" ] || return 1
                names="${names}${name}
"
                ;;
        esac
    done
    printf '%s' "$names" | sort
}

verify_qmd_set() {
    local mode=$1
    local expected
    [ -d "$QDIR" ] && [ ! -L "$QDIR" ] || return 1
    [ "$(stat -c %u:%g "$QDIR")" = 0:0 ] || return 1
    (cd "$QDIR" && sha256sum -c "$STAGE/baseline.sha256") >&2 || return 1
    # Dates was independently promoted at 11:16 UTC. Pin its observed live
    # ownership/mode as well as its content while the other baseline entries
    # remain hash- and inventory-gated by the reviewed manifest.
    exact_owned_file "$QDIR/notebook-date-index.qmd" "$EXPECTED_DATES_QMD_SHA256" 0:0:600 || return 1
    expected=$(awk '{ print $2 }' "$STAGE/baseline.sha256")
    if [ "$mode" = candidate ]; then
        exact_root_file "$TARGET" "$EXPECTED_CANDIDATE_SHA256" || return 1
        [ "$(stat -c %a "$TARGET")" = 644 ] || return 1
        expected="${expected}
${TARGET##*/}"
    else
        [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] || return 1
    fi
    expected=$(printf '%s\n' "$expected" | sed '/^$/d' | sort)
    [ "$(qmd_names)" = "$expected" ] || return 1
}

verify_extensions() {
    local names=
    local path
    local name
    [ -d "$EXTENSIONS" ] && [ ! -L "$EXTENSIONS" ] || return 1
    [ "$(stat -c %u:%g "$EXTENSIONS")" = 0:0 ] || return 1
    for path in "$EXTENSIONS"/* "$EXTENSIONS"/.[!.]* "$EXTENSIONS"/..?*; do
        [ -e "$path" ] || [ -L "$path" ] || continue
        name=${path##*/}
        [ -f "$path" ] && [ ! -L "$path" ] || return 1
        names="${names}${name}
"
    done
    [ "$(printf '%s' "$names" | sort)" = \
        "$(printf '%s\n' ._appload.so ._qt-resource-rebuilder.so ._xovi-message-broker.so appload.so framebuffer-spy.so qt-resource-rebuilder.so xovi-message-broker.so | sort)" ] || return 1
    # Preserve only the three AppleDouble files observed in the live preimage.
    # In particular, the absence of ._framebuffer-spy.so remains contractual.
    exact_owned_file "$EXTENSIONS/._appload.so" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755 || return 1
    exact_owned_file "$EXTENSIONS/._qt-resource-rebuilder.so" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755 || return 1
    exact_owned_file "$EXTENSIONS/._xovi-message-broker.so" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755 || return 1
}

direct_entry_names() {
    local directory=$1
    local names=
    local path
    for path in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
        [ -e "$path" ] || [ -L "$path" ] || continue
        names="${names}${path##*/}
"
    done
    printf '%s' "$names" | sort
}

verify_empty_hook_dir() {
    local directory=$1
    [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
    [ "$(stat -c %u:%g:%a "$directory")" = 0:0:755 ] || return 1
    [ -z "$(direct_entry_names "$directory")" ] || return 1
}

verify_service_tree() {
    [ -d "$SERVICE_ROOT" ] && [ ! -L "$SERVICE_ROOT" ] || return 1
    [ "$(stat -c %u:%g:%a "$SERVICE_ROOT")" = 0:0:755 ] || return 1
    [ "$(direct_entry_names "$SERVICE_ROOT")" = "$(printf '%s\n' ._xochitl.service xochitl.service | sort)" ] || return 1
    exact_owned_file "$SERVICE_ROOT/._xochitl.service" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755 || return 1

    [ -d "$SERVICE_DIR" ] && [ ! -L "$SERVICE_DIR" ] || return 1
    [ "$(stat -c %u:%g:%a "$SERVICE_DIR")" = 0:0:755 ] || return 1
    [ "$(direct_entry_names "$SERVICE_DIR")" = \
        "$(printf '%s\n' ._extensions.d ._exthome ._qt-resource-rebuilder.conf extensions.d exthome qt-resource-rebuilder.conf | sort)" ] || return 1
    exact_owned_file "$SERVICE_DIR/._extensions.d" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755 || return 1
    exact_owned_file "$SERVICE_DIR/._exthome" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755 || return 1
    exact_owned_file "$SERVICE_DIR/._qt-resource-rebuilder.conf" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:644 || return 1
    exact_owned_file "$SERVICE_CONF" "$EXPECTED_SERVICE_CONF_SHA256" 0:0:644 || return 1
    [ -L "$SERVICE_DIR/extensions.d" ] || return 1
    [ "$(readlink "$SERVICE_DIR/extensions.d")" = /home/root/xovi/extensions.d ] || return 1
    [ -L "$SERVICE_DIR/exthome" ] || return 1
    [ "$(readlink "$SERVICE_DIR/exthome")" = /home/root/xovi/exthome ] || return 1

    verify_empty_hook_dir "$SCRIPT_ROOT/pre-start"
    verify_empty_hook_dir "$SCRIPT_ROOT/post-start"
    verify_empty_hook_dir "$SCRIPT_ROOT/pre-stock"
    verify_empty_hook_dir "$SCRIPT_ROOT/post-stock"
}

verify_systemd_capabilities() {
    local help
    help=$(systemctl --help)
    printf '%s\n' "$help" | grep -F -- '--kill-whom=WHOM' >/dev/null || return 1
    printf '%s\n' "$help" | grep -F -- '--signal=SIGNAL' >/dev/null || return 1
}

no_other_mutation_active() {
    local active
    active=$(systemctl list-units \
        --type=service --type=timer \
        --state=activating,active,deactivating \
        --no-legend --plain | awk '{ print $1 }') || return 1
    if printf '%s\n' "$active" | grep -Eq \
        '^(smart-remarkable-install\.service|smart-remarkable-llm-(canary|watchdog)-.*\.(service|timer)|rmstream-shortcut-(install|rollback)\.(service|timer)|notebook-ui-repair-(install|rollback)\.(service|timer)|notebook-date-index-(install|rollback)\.(service|timer)|dates-(calendar|v3|v3-panel|sync-pro)-(install|rollback)\.(service|timer)|remarkable-beta-os-pro-bettertoc-upgrade.*\.(service|timer))$'; then
        return 1
    fi
    [ ! -e /run/smart-remarkable-llm-button/deployment.lock ] &&
        [ ! -L /run/smart-remarkable-llm-button/deployment.lock ] || return 1
    [ ! -e /run/remarkable-beta-os-pro-bettertoc-upgrade.lock ] &&
        [ ! -L /run/remarkable-beta-os-pro-bettertoc-upgrade.lock ] || return 1
}

remagic_runtime_is_clear() {
    ! systemctl is-active --quiet "$REMAGIC_TIMER" || return 1
    ! systemctl is-active --quiet "$REMAGIC_SERVICE" || return 1
    [ ! -e "$REMAGIC_SAFETY_CONF" ] && [ ! -L "$REMAGIC_SAFETY_CONF" ] || return 1
    [ ! -e "$REMAGIC_ROLLBACK_HELPER" ] && [ ! -L "$REMAGIC_ROLLBACK_HELPER" ] || return 1
    [ ! -e "$REMAGIC_ROLLBACK_DONE" ] && [ ! -L "$REMAGIC_ROLLBACK_DONE" ] || return 1
}

verify_dispatch_manifest() {
    [ -d "$DISPATCH_ROOT" ] && [ ! -L "$DISPATCH_ROOT" ] || return 1
    [ "$(stat -c %u:%g:%a "$DISPATCH_ROOT")" = 0:0:755 ] || return 1
    exact_owned_file "$DISPATCH_BINARY" "$EXPECTED_DISPATCH_BINARY_SHA256" 0:0:755 || return 1
    # AppLoad preserves the manifest's observed desktop-copy ownership. Keep
    # that exact preimage rather than weakening every other root-owned check.
    exact_owned_file "$DISPATCH_MANIFEST" "$EXPECTED_DISPATCH_MANIFEST_SHA256" 501:20:644 || return 1
    grep -Fqx '  "id": "remarkable-dispatch",' "$DISPATCH_MANIFEST" || return 1
    grep -Fqx '  "name": "Dispatch",' "$DISPATCH_MANIFEST" || return 1
    grep -Fqx '  "qtfb": true,' "$DISPATCH_MANIFEST" || return 1
    grep -Fqx '  "aspectRatio": "original",' "$DISPATCH_MANIFEST" || return 1
    grep -Fqx '  "disablesWindowedMode": true' "$DISPATCH_MANIFEST" || return 1
}

verify_xovi_process() {
    local pid=$1
    local path
    [ "$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)" = "$XOCHITL" ] || return 1
    tr '\0' '\n' <"/proc/$pid/environ" | grep -Fx "LD_PRELOAD=$XOVI" >/dev/null || return 1
    for path in "$XOVI" "$QRR" "$BROKER" "$APPLOAD" "$FRAMEBUFFER_SPY"; do
        awk -v expected="$path" '$NF == expected { found=1 } END { exit !found }' "/proc/$pid/maps" || return 1
    done
}

verify_live() {
    local mode=$1
    local pid
    [ "$(tr -d '\000' </proc/device-tree/model)" = "$EXPECTED_MODEL" ]
    [ "$(read_serial)" = "$EXPECTED_SERIAL" ]
    [ "$(read_firmware)" = "$EXPECTED_FIRMWARE" ]
    [ "$(tr -d '[:space:]' </etc/version)" = "$EXPECTED_BUILD" ]
    exact_root_file "$XOCHITL" "$EXPECTED_XOCHITL_SHA256"
    exact_root_file "$XOVI" "$EXPECTED_XOVI_SHA256"
    exact_root_file "$QRR" "$EXPECTED_QRR_SHA256"
    exact_root_file "$BROKER" "$EXPECTED_BROKER_SHA256"
    exact_root_file "$APPLOAD" "$EXPECTED_APPLOAD_SHA256"
    exact_root_file "$FRAMEBUFFER_SPY" "$EXPECTED_FRAMEBUFFER_SPY_SHA256"
    exact_root_file "$HASHTAB" "$EXPECTED_HASHTAB_SHA256"
    exact_root_file "$REMAGIC" "$EXPECTED_REMAGIC_SHA256"
    exact_root_file "$START" "$EXPECTED_START_SHA256"
    exact_root_file "$STOCK" "$EXPECTED_STOCK_SHA256"
    exact_owned_file "$STOCK_UNIT" "$EXPECTED_STOCK_UNIT_SHA256" 0:0:644
    exact_owned_file "$STOCK_OVERRIDE" "$EXPECTED_STOCK_OVERRIDE_SHA256" 0:0:644
    verify_service_tree
    verify_systemd_capabilities
    no_other_mutation_active
    remagic_runtime_is_clear
    verify_extensions
    verify_qmd_set "$mode"
    verify_dispatch_manifest
    root_is_read_only
    ! dispatch_running
    systemctl is-active --quiet xochitl.service
    [ "$(systemctl show -p FragmentPath --value xochitl.service)" = "$STOCK_UNIT" ]
    [ "$(systemctl show -p NRestarts --value xochitl.service)" = 0 ]
    pid=$(systemctl show -p MainPID --value xochitl.service)
    case "$pid" in ""|0|*[!0-9]*) return 1 ;; esac
    verify_xovi_process "$pid"
}

snapshot() {
    local mode=$1
    verify_live "$mode"
    printf 'model=%s\n' "$EXPECTED_MODEL"
    printf 'serial=%s\nfirmware=%s\nbuild=%s\n' "$EXPECTED_SERIAL" "$EXPECTED_FIRMWARE" "$EXPECTED_BUILD"
    sha256sum "$XOCHITL" "$XOVI" "$QRR" "$BROKER" "$APPLOAD" "$FRAMEBUFFER_SPY" "$HASHTAB" "$REMAGIC" "$START" "$STOCK" "$STOCK_UNIT" "$STOCK_OVERRIDE" "$DISPATCH_BINARY" "$DISPATCH_MANIFEST"
    sha256sum "$EXTENSIONS/._appload.so" "$EXTENSIONS/._qt-resource-rebuilder.so" "$EXTENSIONS/._xovi-message-broker.so"
    sha256sum "$SERVICE_ROOT/._xochitl.service" "$SERVICE_DIR/._extensions.d" "$SERVICE_DIR/._exthome" "$SERVICE_DIR/._qt-resource-rebuilder.conf" "$SERVICE_CONF"
    printf 'extensions_link=%s\n' "$(readlink "$SERVICE_DIR/extensions.d")"
    printf 'exthome_link=%s\n' "$(readlink "$SERVICE_DIR/exthome")"
    printf 'start_stock_hooks=empty\n'
    (cd "$QDIR" && sha256sum $(qmd_names))
    printf 'pid=%s\n' "$(systemctl show -p MainPID --value xochitl.service)"
    printf 'nrestarts=%s\n' "$(systemctl show -p NRestarts --value xochitl.service)"
    printf 'root=ro\n'
}

write_marker() {
    local destination=$1
    local content=$2
    local temporary="$RECOVERY/.marker.$$.tmp"
    printf '%s\n' "$content" >"$temporary"
    chown root:root "$temporary"
    chmod 0600 "$temporary"
    mv -f "$temporary" "$destination"
}

ensure_private_dir() {
    local directory=$1
    if [ -e "$directory" ] || [ -L "$directory" ]; then
        [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
        [ "$(readlink -f "$directory")" = "$directory" ] || return 1
        [ "$(stat -c %u:%g:%a "$directory")" = 0:0:700 ] || return 1
        return 0
    fi
    mkdir "$directory" || return 1
    chown root:root "$directory" || return 1
    chmod 0700 "$directory" || return 1
    [ "$(stat -c %u:%g:%a "$directory")" = 0:0:700 ] || return 1
}

verify_stage
mkdir "$LOCK" 2>/dev/null || {
    echo "another Dispatch/AppLoad latency transaction holds $LOCK" >&2
    exit 1
}
chown root:root "$LOCK"
chmod 0700 "$LOCK"
printf '%s\n' "$ID" >"$LOCK/owner"
chown root:root "$LOCK/owner"
chmod 0600 "$LOCK/owner"
cleanup_lock() {
    if [ -f "$LOCK/owner" ] && [ ! -L "$LOCK/owner" ] &&
        [ "$(cat "$LOCK/owner")" = "$ID" ]; then
        rm -f "$LOCK/owner"
        rmdir "$LOCK" 2>/dev/null || true
    fi
}
trap cleanup_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$ACTION" = prepare ]; then
    [ ! -e "$RECOVERY" ] && [ ! -L "$RECOVERY" ]
    ensure_private_dir "$RECOVERY_PARENT"
    ensure_private_dir "$RECOVERY_BASE"
    mkdir "$RECOVERY"
    chown root:root "$RECOVERY"
    chmod 0700 "$RECOVERY"
    snapshot baseline >"$RECOVERY/before.snapshot"
    cp -p "$STAGE/rollback.sh" "$RECOVERY/rollback.sh"
    chown root:root "$RECOVERY/rollback.sh"
    chmod 0700 "$RECOVERY/rollback.sh"
    tar -czf "$RECOVERY/safety-backup.tgz" -C /home/root \
        xovi/exthome/qt-resource-rebuilder \
        xovi/exthome/appload/remarkable-dispatch/external.manifest.json
    chown root:root "$RECOVERY/safety-backup.tgz"
    chmod 0600 "$RECOVERY/safety-backup.tgz"
    write_marker "$RECOVERY/prepared" "prepared:$ID"
    sync
    printf 'recovery=%s\n' "$RECOVERY"
    printf 'safety_backup_sha256=%s\n' "$(hash_file "$RECOVERY/safety-backup.tgz")"
    exit 0
fi

[ "$ACTION" = activate ]
[ "$(systemctl show -p MainPID --value "$TRANSACTION_UNIT")" = "$$" ]
systemctl is-active --quiet "$TRANSACTION_UNIT"
[ -f "$RECOVERY/prepared" ] && [ ! -L "$RECOVERY/prepared" ]
[ "$(cat "$RECOVERY/prepared")" = "prepared:$ID" ]
[ -f "$RECOVERY/mac-backup-verified" ] && [ ! -L "$RECOVERY/mac-backup-verified" ]
[ "$(stat -c %u:%g:%a "$RECOVERY/mac-backup-verified")" = 0:0:600 ]
[ ! -e "$RECOVERY/committed" ] && [ ! -L "$RECOVERY/committed" ]
[ ! -e "$RECOVERY/rolled-back" ] && [ ! -L "$RECOVERY/rolled-back" ]
snapshot baseline >"$RECOVERY/rechecked.snapshot"
cmp "$RECOVERY/before.snapshot" "$RECOVERY/rechecked.snapshot"
cmp "$STAGE/rollback.sh" "$RECOVERY/rollback.sh"
systemctl is-active --quiet "$TIMER_UNIT" && exit 1 || true
systemctl is-active --quiet "$SERVICE_UNIT" && exit 1 || true

systemd-run \
    --unit="${TIMER_UNIT%.timer}" \
    --on-active=180 \
    --timer-property=AccuracySec=1 \
    /bin/bash "$RECOVERY/rollback.sh" "$RECOVERY" "$ID"
systemctl is-active --quiet "$TIMER_UNIT"
arm_rollback() {
    systemctl start --no-block "$SERVICE_UNIT" >/dev/null 2>&1 || true
}
rollback_on_exit() {
    rc=$?
    trap - EXIT HUP INT TERM
    arm_rollback
    exit "$rc"
}
trap rollback_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

write_marker "$RECOVERY/activation-attempted" "activation-attempted:$ID"
cp "$STAGE/candidate.qmd" "$RECOVERY/candidate.ready"
chown root:root "$RECOVERY/candidate.ready"
chmod 0644 "$RECOVERY/candidate.ready"
[ "$(hash_file "$RECOVERY/candidate.ready")" = "$EXPECTED_CANDIDATE_SHA256" ]
sync
mv "$RECOVERY/candidate.ready" "$TARGET"
sync

REMAGIC_SAMPLE_SECONDS=30 /bin/bash "$REMAGIC"
verify_live candidate
candidate_marker='[qmldiff]: Loading file dispatch-appload-partial-repaint-3.28.0.169.qmd'
[ "$(grep -Fc "$candidate_marker" /tmp/remagic-live-test.log)" = 1 ]
[ "$(grep -Ec '\[qmldiff\]: Loading file [^ ]+\.qmd$' /tmp/remagic-live-test.log)" = 11 ]
while read -r _ qmd_name; do
    [ "$(grep -Fc "[qmldiff]: Loading file $qmd_name" /tmp/remagic-live-test.log)" = 1 ]
done <"$STAGE/baseline.sha256"
grep -Fq '[qmldiff]: Processing file /appload/qml/window.qml...' /tmp/remagic-live-test.log
if grep -Fq '[qmldiff]: Failed to load file' /tmp/remagic-live-test.log; then
    exit 1
fi
if grep -Ei 'ReferenceError|TypeError|is not a type|Cannot assign|is not installed' /tmp/remagic-live-test.log |
    grep -Ei 'dispatch-appload|window\.qml|FBController'; then
    exit 1
fi
snapshot candidate >"$RECOVERY/after.snapshot"
cp /tmp/remagic-live-test.log "$RECOVERY/remagic-live-test.log"
chown root:root "$RECOVERY/remagic-live-test.log"
chmod 0600 "$RECOVERY/remagic-live-test.log"
pid=$(systemctl show -p MainPID --value xochitl.service)
write_marker "$RECOVERY/committed.ready" "committed:$ID:$pid"
sync
mv "$RECOVERY/committed.ready" "$RECOVERY/committed"
sync

trap - EXIT HUP INT TERM
systemctl stop "$TIMER_UNIT"
systemctl reset-failed "$SERVICE_UNIT" >/dev/null 2>&1 || true
cleanup_lock
printf 'dispatch_appload_latency=committed pid=%s recovery=%s\n' "$pid" "$RECOVERY"
