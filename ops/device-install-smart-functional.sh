#!/bin/bash
# Guarded device-side 12->12 transaction for the Ferrari 3.28.0.169 Smart lasso
# inert-to-functional promotion. It is inert until run by the reviewed Mac controller.
set -Eeuo pipefail
umask 077

ACTION=${1:-}
MODE=${2:-}
STAGE=${3:-}
REVIEWED_MANIFEST_SHA256=${4:-}
ID=${5:-}

case "$ACTION" in prepare|activate) ;;
    *) echo "usage: $0 prepare|activate functional STAGE REVIEWED_SHA256 ID" >&2; exit 2 ;;
esac
case "$MODE" in functional) ;;
    *) echo "only functional promotion is supported" >&2; exit 2 ;;
esac
[[ "$ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || exit 2
[[ "$REVIEWED_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || exit 2
case "$STAGE" in
    /home/root/.codex-staging/smart-functional-*) ;;
    *) echo "invalid stage path" >&2; exit 2 ;;
esac
[ -d "$STAGE" ] && [ ! -L "$STAGE" ] || exit 2
[ "$(readlink -f "$STAGE")" = "$STAGE" ] || exit 2
[ "$(stat -c %u:%g:%a "$STAGE")" = 0:0:700 ] || exit 2

XOVI_ROOT=/home/root/xovi
QDIR=$XOVI_ROOT/exthome/qt-resource-rebuilder
TARGET=$QDIR/smart-remarkable-llm.qmd
PANEL_DIR=/home/root/.local/lib/remarkable-dispatch-shortcut
PANEL=$PANEL_DIR/DispatchLauncher.qml
XOCHITL=/usr/bin/xochitl
XOVI=$XOVI_ROOT/xovi.so
EXTENSIONS=$XOVI_ROOT/extensions.d
QRR=$EXTENSIONS/qt-resource-rebuilder.so
BROKER=$EXTENSIONS/xovi-message-broker.so
APPLOAD=$EXTENSIONS/appload.so
FRAMEBUFFER_SPY=$EXTENSIONS/framebuffer-spy.so
HASHTAB=$QDIR/hashtab
REMAGIC=$XOVI_ROOT/remagic-live-test-safe.sh
START=$XOVI_ROOT/start
STOCK=$XOVI_ROOT/stock
SERVICE_ROOT=$XOVI_ROOT/services
SERVICE_DIR=$SERVICE_ROOT/xochitl.service
SERVICE_CONF=$SERVICE_DIR/qt-resource-rebuilder.conf
SCRIPT_ROOT=$XOVI_ROOT/scripts
STOCK_UNIT=/usr/lib/systemd/system/xochitl.service
STOCK_OVERRIDE=/usr/lib/systemd/system/xochitl.service.d/xochitl-service-override.conf
DISPATCH_ROOT=$XOVI_ROOT/exthome/appload/remarkable-dispatch
DISPATCH_BINARY=$DISPATCH_ROOT/remarkable-dispatch
DISPATCH_MANIFEST=$DISPATCH_ROOT/external.manifest.json
RECOVERY_PARENT=/home/root/.smart-remarkable-recovery
RECOVERY_BASE=$RECOVERY_PARENT/smart-functional
RECOVERY=$RECOVERY_BASE/$ID
LOCK=/run/smart-remarkable-llm-button/deployment.lock
TIMER_UNIT=smart-functional-rollback-$ID.timer
SERVICE_UNIT=smart-functional-rollback-$ID.service
TRANSACTION_UNIT=smart-functional-install-$ID.service
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
EXPECTED_DISPATCH_BINARY_SHA256=f9896596941caa77ae9a1ba88da8e1ca09cc4f08f0f52560b800b54efe8875cc
EXPECTED_DATES_QMD_SHA256=2d4681414ac00b534b2f21d179365601ce9e876c7cfbf6c6c8d25a2f8738e580
EXPECTED_LATENCY_QMD_SHA256=1eb2037f28c9891fbdc4a97d1e2916b8e923fe04004ae1ced03b5de73f59a60e
EXPECTED_BASELINE_SHA256=8d4ff75e807e23918436204bf79977bceb14d915ac4130ed2d134c45a4b0aaac
EXPECTED_FUNCTIONAL_SHA256=afcde7847b31409c3e503d39af67264c6e7e824dc7e6ddba8d403d297330c05a
EXPECTED_INERT_SHA256=1952fa9d383ece8e5d0e05915e8e4bf6745ac40eeeb1522567dc4011706fea25
EXPECTED_PANEL_SHA256=bf05247511a245fdc84fae41e03a8a2b749ad1d3ef622470a59da76646e8b0f7

hash_file() { sha256sum "$1" | cut -d' ' -f1; }
exact_root_file() {
    local path=$1 expected=$2
    [ -f "$path" ] && [ ! -L "$path" ] || return 1
    [ "$(stat -c %u:%g "$path")" = 0:0 ] || return 1
    [ "$(hash_file "$path")" = "$expected" ] || return 1
}
exact_owned_file() {
    local path=$1 expected=$2 owner_mode=$3
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
        if [ -f "$path" ]; then tr -d '\000[:space:]' <"$path"; return 0; fi
    done
    return 1
}
read_firmware() {
    awk -F= '$1 == "IMG_VERSION" { value=$2; gsub(/^"|"$/, "", value); print value; exit }' /etc/os-release
}
dispatch_running() {
    local executable resolved
    for executable in /proc/[0-9]*/exe; do
        [ -L "$executable" ] || continue
        resolved=$(readlink -f "$executable" 2>/dev/null || true)
        [ "$resolved" = "$DISPATCH_BINARY" ] && return 0
    done
    return 1
}
qmd_names() {
    local path name names=
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
direct_entry_names() {
    local directory=$1 path names=
    for path in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
        [ -e "$path" ] || [ -L "$path" ] || continue
        names="${names}${path##*/}
"
    done
    printf '%s' "$names" | sort
}
verify_stage() {
    local path actual= expected listed
    expected=$(printf '%s\n' SHA256SUMS artifact-compatibility-contract.sh compatibility.env baseline.sha256 device-install.sh functional.qmd inert.qmd panel.qml rollback.sh | sort)
    for path in "$STAGE"/* "$STAGE"/.[!.]* "$STAGE"/..?*; do
        [ -e "$path" ] || [ -L "$path" ] || continue
        [ -f "$path" ] && [ ! -L "$path" ] || return 1
        actual="${actual}${path##*/}
"
    done
    [ "$(printf '%s' "$actual" | sort)" = "$expected" ] || return 1
    exact_root_file "$STAGE/SHA256SUMS" "$REVIEWED_MANIFEST_SHA256" || return 1
    [ "$(wc -l <"$STAGE/SHA256SUMS" | tr -d ' ')" -eq 8 ] || return 1
    listed=$(awk 'NF == 2 { print $2 }' "$STAGE/SHA256SUMS" | sort)
    [ "$listed" = "$(printf '%s\n' artifact-compatibility-contract.sh compatibility.env baseline.sha256 device-install.sh functional.qmd inert.qmd panel.qml rollback.sh | sort)" ] || return 1
    (cd "$STAGE" && sha256sum -c SHA256SUMS) >&2 || return 1
    exact_owned_file "$STAGE/compatibility.env" ada3ee6de46e829016c4aeb3abe3975c394bd15894c58c09d615c96c69b3e12d 0:0:600 || return 1
    exact_owned_file "$STAGE/artifact-compatibility-contract.sh" 7762045036ec6777e0925579f8c00410eb6e55a50b0416d930bb7e839aa274e1 0:0:600 || return 1
    exact_root_file "$STAGE/baseline.sha256" "$EXPECTED_BASELINE_SHA256" || return 1
    exact_root_file "$STAGE/functional.qmd" "$EXPECTED_FUNCTIONAL_SHA256" || return 1
    exact_root_file "$STAGE/inert.qmd" "$EXPECTED_INERT_SHA256" || return 1
    exact_root_file "$STAGE/panel.qml" "$EXPECTED_PANEL_SHA256" || return 1
    [ "$(stat -c %u:%g:%a "$STAGE/SHA256SUMS")" = 0:0:600 ] || return 1
    [ "$(stat -c %u:%g:%a "$STAGE/baseline.sha256")" = 0:0:600 ] || return 1
    [ "$(stat -c %u:%g:%a "$STAGE/functional.qmd")" = 0:0:600 ] || return 1
    [ "$(stat -c %u:%g:%a "$STAGE/inert.qmd")" = 0:0:600 ] || return 1
    [ "$(stat -c %u:%g:%a "$STAGE/panel.qml")" = 0:0:600 ] || return 1
    [ "$(stat -c %u:%g:%a "$STAGE/device-install.sh")" = 0:0:700 ] || return 1
    [ "$(stat -c %u:%g:%a "$STAGE/rollback.sh")" = 0:0:700 ]
}
verify_qmd_set() {
    local state=$1 expected target_hash=
    [ -d "$QDIR" ] && [ ! -L "$QDIR" ] && [ "$(stat -c %u:%g "$QDIR")" = 0:0 ] || return 1
    (cd "$QDIR" && sha256sum -c "$STAGE/baseline.sha256") >&2 || return 1
    exact_owned_file "$QDIR/notebook-date-index.qmd" "$EXPECTED_DATES_QMD_SHA256" 0:0:600 || return 1
    exact_owned_file "$QDIR/dispatch-appload-partial-repaint-3.28.0.169.qmd" "$EXPECTED_LATENCY_QMD_SHA256" 0:0:644 || return 1
    local digest name mode
    while read -r digest name; do
        mode=644; [ "$name" != notebook-date-index.qmd ] || mode=600
        exact_owned_file "$QDIR/$name" "$digest" "0:0:$mode" || return 1
    done <"$STAGE/baseline.sha256"
    expected=$(awk '{ print $2 }' "$STAGE/baseline.sha256")
    case "$state" in
        baseline) [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] || return 1 ;;
        inert) target_hash=$EXPECTED_INERT_SHA256 ;;
        functional) target_hash=$EXPECTED_FUNCTIONAL_SHA256 ;;
        *) return 1 ;;
    esac
    if [ -n "$target_hash" ]; then
        exact_owned_file "$TARGET" "$target_hash" 0:0:644 || return 1
        expected="${expected}
${TARGET##*/}"
    fi
    expected=$(printf '%s\n' "$expected" | sed '/^$/d' | sort)
    [ "$(qmd_names)" = "$expected" ]
}
verify_panel_state() {
    case "$1" in
        absent)
            [ ! -e "$PANEL_DIR" ] && [ ! -L "$PANEL_DIR" ]
            ;;
        installed)
            [ -d "$PANEL_DIR" ] && [ ! -L "$PANEL_DIR" ] || return 1
            [ "$(stat -c %u:%g:%a "$PANEL_DIR")" = 0:0:755 ] || return 1
            [ "$(direct_entry_names "$PANEL_DIR")" = DispatchLauncher.qml ] || return 1
            exact_owned_file "$PANEL" "$EXPECTED_PANEL_SHA256" 0:0:644
            ;;
        *) return 1 ;;
    esac
}
verify_extensions() {
    local names= path
    [ -d "$EXTENSIONS" ] && [ ! -L "$EXTENSIONS" ] || return 1
    [ "$(stat -c %u:%g "$EXTENSIONS")" = 0:0 ] || return 1
    for path in "$EXTENSIONS"/* "$EXTENSIONS"/.[!.]* "$EXTENSIONS"/..?*; do
        [ -e "$path" ] || [ -L "$path" ] || continue
        [ -f "$path" ] && [ ! -L "$path" ] || return 1
        names="${names}${path##*/}
"
    done
    [ "$(printf '%s' "$names" | sort)" = "$(printf '%s\n' ._appload.so ._qt-resource-rebuilder.so ._xovi-message-broker.so appload.so framebuffer-spy.so qt-resource-rebuilder.so xovi-message-broker.so | sort)" ] || return 1
    exact_owned_file "$EXTENSIONS/._appload.so" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755 || return 1
    exact_owned_file "$EXTENSIONS/._qt-resource-rebuilder.so" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755 || return 1
    exact_owned_file "$EXTENSIONS/._xovi-message-broker.so" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755
}
verify_empty_hook_dir() {
    local directory=$1
    [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
    [ "$(stat -c %u:%g:%a "$directory")" = 0:0:755 ] || return 1
    [ -z "$(direct_entry_names "$directory")" ]
}
verify_service_tree() {
    [ -d "$SERVICE_ROOT" ] && [ ! -L "$SERVICE_ROOT" ] || return 1
    [ "$(stat -c %u:%g:%a "$SERVICE_ROOT")" = 0:0:755 ] || return 1
    [ "$(direct_entry_names "$SERVICE_ROOT")" = "$(printf '%s\n' ._xochitl.service xochitl.service | sort)" ] || return 1
    exact_owned_file "$SERVICE_ROOT/._xochitl.service" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755 || return 1
    [ -d "$SERVICE_DIR" ] && [ ! -L "$SERVICE_DIR" ] || return 1
    [ "$(stat -c %u:%g:%a "$SERVICE_DIR")" = 0:0:755 ] || return 1
    [ "$(direct_entry_names "$SERVICE_DIR")" = "$(printf '%s\n' ._extensions.d ._exthome ._qt-resource-rebuilder.conf extensions.d exthome qt-resource-rebuilder.conf | sort)" ] || return 1
    exact_owned_file "$SERVICE_DIR/._extensions.d" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755 || return 1
    exact_owned_file "$SERVICE_DIR/._exthome" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755 || return 1
    exact_owned_file "$SERVICE_DIR/._qt-resource-rebuilder.conf" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:644 || return 1
    exact_owned_file "$SERVICE_CONF" "$EXPECTED_SERVICE_CONF_SHA256" 0:0:644 || return 1
    [ -L "$SERVICE_DIR/extensions.d" ] && [ "$(readlink "$SERVICE_DIR/extensions.d")" = /home/root/xovi/extensions.d ] || return 1
    [ -L "$SERVICE_DIR/exthome" ] && [ "$(readlink "$SERVICE_DIR/exthome")" = /home/root/xovi/exthome ] || return 1
    verify_empty_hook_dir "$SCRIPT_ROOT/pre-start" || return 1
    verify_empty_hook_dir "$SCRIPT_ROOT/post-start" || return 1
    verify_empty_hook_dir "$SCRIPT_ROOT/pre-stock" || return 1
    verify_empty_hook_dir "$SCRIPT_ROOT/post-stock"
}
verify_systemd_capabilities() {
    local help
    help=$(systemctl --help) || return 1
    printf '%s\n' "$help" | grep -F -- '--kill-whom=WHOM' >/dev/null || return 1
    printf '%s\n' "$help" | grep -F -- '--signal=SIGNAL' >/dev/null
}
no_other_mutation_active() {
    local active
    active=$(systemctl list-units --type=service --type=timer --state=activating,active,deactivating --no-legend --plain | awk '{ print $1 }') || return 1
    active=$(printf '%s\n' "$active" |
        grep -Fvx "$TRANSACTION_UNIT" |
        grep -Fvx "$TIMER_UNIT" |
        grep -Fvx "$SERVICE_UNIT" || true)
    if printf '%s\n' "$active" | grep -Eq '^(smart-remarkable-install\.service|smart-remarkable-llm-(canary|watchdog)-.*\.(service|timer)|rmstream-shortcut-(install|rollback)\.(service|timer)|notebook-ui-repair-(install|rollback)\.(service|timer)|notebook-date-index-(install|rollback)\.(service|timer)|dates-.*-(install|rollback)\.(service|timer)|dispatch-appload-latency-.*\.(service|timer)|(dispatch-document-menu|smart-functional)-(install|rollback)-.*\.(service|timer)|remarkable-beta-os-pro-bettertoc-upgrade.*\.(service|timer))$'; then
        return 1
    fi
    [ -f "$LOCK/owner" ] && [ ! -L "$LOCK/owner" ] &&
        [ "$(cat "$LOCK/owner")" = "$ID" ] || return 1
    [ ! -e /run/dispatch-document-menu.lock ] && [ ! -L /run/dispatch-document-menu.lock ] || return 1
    [ ! -e /run/remarkable-beta-os-pro-bettertoc-upgrade.lock ] &&
        [ ! -L /run/remarkable-beta-os-pro-bettertoc-upgrade.lock ]
}
remagic_runtime_is_clear() {
    ! systemctl is-active --quiet "$REMAGIC_TIMER" || return 1
    ! systemctl is-active --quiet "$REMAGIC_SERVICE" || return 1
    [ ! -e "$REMAGIC_SAFETY_CONF" ] && [ ! -L "$REMAGIC_SAFETY_CONF" ] || return 1
    [ ! -e "$REMAGIC_ROLLBACK_HELPER" ] && [ ! -L "$REMAGIC_ROLLBACK_HELPER" ] || return 1
    [ ! -e "$REMAGIC_ROLLBACK_DONE" ] && [ ! -L "$REMAGIC_ROLLBACK_DONE" ]
}
verify_dispatch() {
    [ -d "$DISPATCH_ROOT" ] && [ ! -L "$DISPATCH_ROOT" ] || return 1
    [ "$(stat -c %u:%g:%a "$DISPATCH_ROOT")" = 0:0:755 ] || return 1
    exact_owned_file "$DISPATCH_BINARY" "$EXPECTED_DISPATCH_BINARY_SHA256" 0:0:755 || return 1
    exact_owned_file "$DISPATCH_MANIFEST" "$EXPECTED_DISPATCH_MANIFEST_SHA256" 501:20:644 || return 1
    grep -Fqx '  "id": "remarkable-dispatch",' "$DISPATCH_MANIFEST" || return 1
    grep -Fqx '  "name": "Dispatch",' "$DISPATCH_MANIFEST" || return 1
    grep -Fqx '  "qtfb": true,' "$DISPATCH_MANIFEST" || return 1
    grep -Fqx '  "aspectRatio": "original",' "$DISPATCH_MANIFEST" || return 1
    grep -Fqx '  "disablesWindowedMode": true' "$DISPATCH_MANIFEST"
}
verify_xovi_process() {
    local pid=$1 path
    [ "$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)" = "$XOCHITL" ] || return 1
    tr '\0' '\n' <"/proc/$pid/environ" | grep -Fx "LD_PRELOAD=$XOVI" >/dev/null || return 1
    for path in "$XOVI" "$QRR" "$BROKER" "$APPLOAD" "$FRAMEBUFFER_SPY"; do
        awk -v expected="$path" '$NF == expected { found=1 } END { exit !found }' "/proc/$pid/maps" || return 1
    done
}
verify_smart() {
    # This validates the complete installed manifest without printing secrets.
    . "$STAGE/artifact-compatibility-contract.sh"
    smart_contract_load "$STAGE/compatibility.env"
    smart_contract_require_complete
    smart_contract_installed_client_is_exact /home/root/xovi/exthome/appload/smart-remarkable
    exact_owned_file /home/root/xovi/exthome/appload/smart-remarkable/STAGED-FILES.sha256 62f9cb6c49c9a2d023242906a7b4905ab3c3e8b59db47851cde31db8bae4808f 0:0:644
    local unit executable resolved
    for unit in riddle-takeover.service smart-remarkable-once.service smart-remarkable-session.service; do
        ! systemctl is-active --quiet "$unit" || return 1
    done
    for executable in /proc/[0-9]*/exe; do
        [ -L "$executable" ] || continue
        resolved=$(readlink -f "$executable" 2>/dev/null || true)
        case "$resolved" in */smart_remarkable|*/riddle) return 1 ;; esac
    done
}
preserved_snapshot() {
    local file
    for file in /home/root/.config/gestik.json /home/root/.local/share/gestik-beta/gestik.json; do
        [ -f "$file" ] && [ ! -L "$file" ] || return 1
        sha256sum "$file"
        stat -c '%u:%g:%a %n' "$file"
    done
    # No notebook/date files are restored. Preserve only device settings and app bytes.
    local app=/home/root/xovi/exthome/appload/smart-remarkable
    sha256sum "$app/STAGED-FILES.sha256"
    for file in "$app/.env" /home/root/.config/smart-remarkable/settings.conf; do
        if [ -e "$file" ] || [ -L "$file" ]; then
            [ -f "$file" ] && [ ! -L "$file" ] || return 1
            sha256sum "$file"; stat -c '%u:%g:%a %n' "$file"
        fi
    done
}
verify_live() {
    local state=$1 panel_state=$2 pid
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
    exact_owned_file "$REMAGIC" "$EXPECTED_REMAGIC_SHA256" 0:0:700
    exact_owned_file "$START" "$EXPECTED_START_SHA256" 0:0:755
    exact_owned_file "$STOCK" "$EXPECTED_STOCK_SHA256" 0:0:755
    exact_owned_file "$STOCK_UNIT" "$EXPECTED_STOCK_UNIT_SHA256" 0:0:644
    exact_owned_file "$STOCK_OVERRIDE" "$EXPECTED_STOCK_OVERRIDE_SHA256" 0:0:644
    verify_service_tree
    verify_systemd_capabilities
    verify_extensions
    no_other_mutation_active
    remagic_runtime_is_clear
    verify_qmd_set "$state"
    verify_panel_state "$panel_state"
    verify_dispatch
    verify_smart
    root_is_read_only
    ! dispatch_running
    systemctl is-active --quiet xochitl.service
    [ "$(systemctl show -p FragmentPath --value xochitl.service)" = "$STOCK_UNIT" ]
    [ "$(systemctl show -p NRestarts --value xochitl.service)" = 0 ]
    pid=$(systemctl show -p MainPID --value xochitl.service)
    [[ "$pid" =~ ^[1-9][0-9]*$ ]]
    verify_xovi_process "$pid"
}
snapshot() {
    local state=$1 panel_state=$2
    verify_live "$state" "$panel_state"
    preserved_snapshot
    printf 'mode=%s\nstate=%s\n' "$MODE" "$state"
    sha256sum "$XOCHITL" "$XOVI" "$QRR" "$BROKER" "$APPLOAD" "$FRAMEBUFFER_SPY" "$HASHTAB" "$REMAGIC" "$START" "$STOCK" "$STOCK_UNIT" "$STOCK_OVERRIDE" "$DISPATCH_BINARY" "$DISPATCH_MANIFEST"
    sha256sum "$EXTENSIONS/._appload.so" "$EXTENSIONS/._qt-resource-rebuilder.so" "$EXTENSIONS/._xovi-message-broker.so"
    sha256sum "$SERVICE_ROOT/._xochitl.service" "$SERVICE_DIR/._extensions.d" "$SERVICE_DIR/._exthome" "$SERVICE_DIR/._qt-resource-rebuilder.conf" "$SERVICE_CONF"
    printf 'extensions_link=%s\nexthome_link=%s\nstart_stock_hooks=empty\n' "$(readlink "$SERVICE_DIR/extensions.d")" "$(readlink "$SERVICE_DIR/exthome")"
    (cd "$QDIR" && sha256sum $(qmd_names))
    [ "$panel_state" = absent ] || sha256sum "$PANEL"
    printf 'pid=%s\nnrestarts=%s\nroot=ro\n' "$(systemctl show -p MainPID --value xochitl.service)" "$(systemctl show -p NRestarts --value xochitl.service)"
}
write_marker() {
    local destination=$1 content=$2 temporary=$RECOVERY/.marker.$$.tmp
    printf '%s\n' "$content" >"$temporary"
    chown root:root "$temporary"; chmod 0600 "$temporary"; mv -f "$temporary" "$destination"
}
ensure_private_dir() {
    local directory=$1
    if [ -e "$directory" ] || [ -L "$directory" ]; then
        [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
        [ "$(readlink -f "$directory")" = "$directory" ] || return 1
        [ "$(stat -c %u:%g:%a "$directory")" = 0:0:700 ]
    else
        mkdir "$directory"; chown root:root "$directory"; chmod 0700 "$directory"
    fi
}

verify_stage
ensure_private_dir /run/smart-remarkable-llm-button
mkdir "$LOCK" 2>/dev/null || { echo "another Smart lasso transaction is active" >&2; exit 1; }
chown root:root "$LOCK"; chmod 0700 "$LOCK"
printf '%s\n' "$ID" >"$LOCK/owner"; chown root:root "$LOCK/owner"; chmod 0600 "$LOCK/owner"
cleanup_lock() {
    if [ -f "$LOCK/owner" ] && [ ! -L "$LOCK/owner" ] && [ "$(cat "$LOCK/owner")" = "$ID" ]; then
        rm -f "$LOCK/owner"; rmdir "$LOCK" 2>/dev/null || true
    fi
}
trap cleanup_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

PRE_STATE=inert
PRE_PANEL=installed

if [ "$ACTION" = prepare ]; then
    [ ! -e "$RECOVERY" ] && [ ! -L "$RECOVERY" ]
    ensure_private_dir "$RECOVERY_PARENT"; ensure_private_dir "$RECOVERY_BASE"
    mkdir "$RECOVERY"; chown root:root "$RECOVERY"; chmod 0700 "$RECOVERY"
    snapshot "$PRE_STATE" "$PRE_PANEL" >"$RECOVERY/before.snapshot"
    preserved_snapshot >"$RECOVERY/preserved.snapshot"
    marker=/home/root/.smart-remarkable-recovery/llm-button/inert-qualified
    [ -f "$marker" ] && [ ! -L "$marker" ]
    [ "$(stat -c %u:%g:%a "$marker")" = 0:0:600 ]
    grep -Fqx DEVICE_SERIAL=0A247209DABC7917 "$marker"
    grep -Fqx FIRMWARE_VERSION=3.28.0.169 "$marker"
    grep -Fqx QMD_SHA256=1952fa9d383ece8e5d0e05915e8e4bf6745ac40eeeb1522567dc4011706fea25 "$marker"
    grep -Fqx TRANSACTION_ID=20260814T232837Z-37203 "$marker"
    cp -p "$marker" "$RECOVERY/prior-inert-qualified"
    cp -p "$STAGE/rollback.sh" "$RECOVERY/rollback.sh"; chown root:root "$RECOVERY/rollback.sh"; chmod 0700 "$RECOVERY/rollback.sh"
    cp "$STAGE/baseline.sha256" "$RECOVERY/baseline.sha256"; chown root:root "$RECOVERY/baseline.sha256"; chmod 0600 "$RECOVERY/baseline.sha256"
    cp "$STAGE/SHA256SUMS" "$RECOVERY/stage.SHA256SUMS"; chown root:root "$RECOVERY/stage.SHA256SUMS"; chmod 0600 "$RECOVERY/stage.SHA256SUMS"
    write_marker "$RECOVERY/reviewed-stage-manifest.sha256" "$REVIEWED_MANIFEST_SHA256"
    cp -p "$TARGET" "$RECOVERY/prior-target.qmd"
    cp -p "$PANEL" "$RECOVERY/prior-panel.qml"
    exact_owned_file "$RECOVERY/prior-target.qmd" "$EXPECTED_INERT_SHA256" 0:0:644
    exact_owned_file "$RECOVERY/prior-panel.qml" "$EXPECTED_PANEL_SHA256" 0:0:644
    tar -czf "$RECOVERY/safety-backup.tgz" -C /home/root \
        xovi/exthome/qt-resource-rebuilder \
        .local/lib/remarkable-dispatch-shortcut/DispatchLauncher.qml \
        xovi/exthome/appload/smart-remarkable \
        .config/gestik.json .local/share/gestik-beta/gestik.json .config/smart-remarkable

    chown root:root "$RECOVERY/safety-backup.tgz"; chmod 0600 "$RECOVERY/safety-backup.tgz"
    write_marker "$RECOVERY/prepared" "prepared:$MODE:$ID"
    sync
    printf 'recovery=%s\n' "$RECOVERY"
    printf 'safety_backup_sha256=%s\n' "$(hash_file "$RECOVERY/safety-backup.tgz")"
    exit 0
fi

[ "$(systemctl show -p MainPID --value "$TRANSACTION_UNIT")" = "$$" ]
systemctl is-active --quiet "$TRANSACTION_UNIT"
[ -f "$RECOVERY/prepared" ] && [ ! -L "$RECOVERY/prepared" ]
[ "$(stat -c %u:%g:%a "$RECOVERY/prepared")" = 0:0:600 ]
[ "$(cat "$RECOVERY/prepared")" = "prepared:$MODE:$ID" ]
[ -f "$RECOVERY/mac-backup-verified" ] && [ ! -L "$RECOVERY/mac-backup-verified" ]
[ "$(stat -c %u:%g:%a "$RECOVERY/mac-backup-verified")" = 0:0:600 ]
[ "$(cat "$RECOVERY/mac-backup-verified")" = "mac-backup:$(hash_file "$RECOVERY/safety-backup.tgz")" ]
[ ! -e "$RECOVERY/committed" ] && [ ! -e "$RECOVERY/rolled-back" ]
snapshot "$PRE_STATE" "$PRE_PANEL" >"$RECOVERY/rechecked.snapshot"
cmp "$RECOVERY/before.snapshot" "$RECOVERY/rechecked.snapshot"
cmp "$STAGE/rollback.sh" "$RECOVERY/rollback.sh"
[ "$(findmnt -n -o FSTYPE /sys/fs/cgroup/unified)" = cgroup2 ]
[ -r /sys/fs/cgroup/unified/cgroup.controllers ]
[ "$(systemctl show -p ControlGroup --value "$TRANSACTION_UNIT")" = "/system.slice/$TRANSACTION_UNIT" ]
[ -r "/sys/fs/cgroup/unified/system.slice/$TRANSACTION_UNIT/cgroup.events" ]

systemd-run --unit="${TIMER_UNIT%.timer}" --on-active=180 --timer-property=AccuracySec=1 \
    /bin/bash "$RECOVERY/rollback.sh" "$RECOVERY" "$MODE" "$ID"
systemctl is-active --quiet "$TIMER_UNIT"
arm_rollback() { systemctl start --no-block "$SERVICE_UNIT" >/dev/null 2>&1 || true; }
rollback_on_exit() { local rc=$?; trap - EXIT HUP INT TERM; arm_rollback; exit "$rc"; }
trap rollback_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

write_marker "$RECOVERY/activation-attempted" "activation-attempted:$MODE:$ID"
CANDIDATE=$STAGE/functional.qmd
EXPECTED_CANDIDATE=$EXPECTED_FUNCTIONAL_SHA256
POST_STATE=functional
cp "$CANDIDATE" "$RECOVERY/candidate.ready"; chown root:root "$RECOVERY/candidate.ready"; chmod 0644 "$RECOVERY/candidate.ready"
[ "$(hash_file "$RECOVERY/candidate.ready")" = "$EXPECTED_CANDIDATE" ]
sync; mv -f "$RECOVERY/candidate.ready" "$TARGET"; sync

REMAGIC_SAMPLE_SECONDS=30 /bin/bash "$REMAGIC"
verify_live "$POST_STATE" installed
marker='[qmldiff]: Loading file smart-remarkable-llm.qmd'
[ "$(grep -Fc "$marker" /tmp/remagic-live-test.log)" -eq 1 ]
[ "$(grep -Ec '\[qmldiff\]: Loading file [^ ]+\.qmd$' /tmp/remagic-live-test.log)" -eq 12 ]
while read -r _ qmd_name; do
    [ "$(grep -Fc "[qmldiff]: Loading file $qmd_name" /tmp/remagic-live-test.log)" -eq 1 ]
done <"$STAGE/baseline.sha256"
grep -Fq '[qmldiff]: Processing file /qt/qml/xofm/libs/toolbar/qml/SettingsMenu.qml...' /tmp/remagic-live-test.log
grep -Fq '[qmldiff]: Processing file /appload/qml/window.qml...' /tmp/remagic-live-test.log
if [ "$MODE" = functional ]; then
    grep -Fq '[qmldiff]: Processing file /qml/common/SceneSelectionHandler.qml...' /tmp/remagic-live-test.log
    grep -Fq '[qmldiff]: Processing file /qml/device/view/documentview/DeviceSceneView.qml...' /tmp/remagic-live-test.log
    grep -Fq '[qmldiff]: Processing file /qml/device/view/main/MainView.qml...' /tmp/remagic-live-test.log
fi
! grep -Fq '[qmldiff]: Failed to load file' /tmp/remagic-live-test.log
if grep -Ei 'ReferenceError|TypeError|is not a type|Cannot assign|is not installed|QQmlComponent: Component is not ready' /tmp/remagic-live-test.log |
    grep -Ei 'smart-remarkable|SceneSelectionHandler|DeviceSceneView|SelectionContextualMenu'; then
    exit 1
fi

preserved_snapshot >"$RECOVERY/preserved.after.snapshot"
cmp "$RECOVERY/preserved.snapshot" "$RECOVERY/preserved.after.snapshot"
snapshot "$POST_STATE" installed >"$RECOVERY/after.snapshot"
cp /tmp/remagic-live-test.log "$RECOVERY/remagic-live-test.log"; chown root:root "$RECOVERY/remagic-live-test.log"; chmod 0600 "$RECOVERY/remagic-live-test.log"
pid=$(systemctl show -p MainPID --value xochitl.service)
write_marker "$RECOVERY/committed.ready" "committed:$MODE:$ID:$pid"
sync; mv "$RECOVERY/committed.ready" "$RECOVERY/committed"; sync

trap - EXIT HUP INT TERM
systemctl stop "$TIMER_UNIT"
systemctl reset-failed "$SERVICE_UNIT" >/dev/null 2>&1 || true
cleanup_lock
printf 'smart_functional=%s-committed pid=%s recovery=%s\n' "$MODE" "$pid" "$RECOVERY"
