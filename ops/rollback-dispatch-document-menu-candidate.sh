#!/bin/bash
# Independent device-side rollback for the Ferrari 3.28.0.169 Dispatch
# notebook/PDF shortcut. The reviewed installer copies this file into the
# root-only recovery directory before it arms the 180-second timer.
set -u
umask 077

RECOVERY=${1:-}
MODE=${2:-}
ID=${3:-}

case "$MODE" in inert|functional) ;;
    *) exit 2 ;;
esac
[[ "$ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || exit 2
EXPECTED_RECOVERY=/home/root/.smart-remarkable-recovery/dispatch-document-menu/$ID
[ "$RECOVERY" = "$EXPECTED_RECOVERY" ] || exit 2
[ -d "$RECOVERY" ] && [ ! -L "$RECOVERY" ] || exit 2
[ "$(readlink -f "$RECOVERY")" = "$RECOVERY" ] || exit 2
[ "$(stat -c %u:%g:%a "$RECOVERY")" = 0:0:700 ] || exit 2

XOVI_ROOT=/home/root/xovi
QDIR=$XOVI_ROOT/exthome/qt-resource-rebuilder
TARGET=$QDIR/dispatch-document-menu-3.28.0.169.qmd
LATENCY_QMD=$QDIR/dispatch-appload-partial-repaint-3.28.0.169.qmd
PANEL_DIR=/home/root/.local/lib/remarkable-dispatch-shortcut
PANEL=$PANEL_DIR/DispatchLauncher.qml
STOCK=$XOVI_ROOT/stock
XOCHITL=/usr/bin/xochitl
SERVICE_ROOT=$XOVI_ROOT/services
SERVICE_DIR=$SERVICE_ROOT/xochitl.service
SERVICE_CONF=$SERVICE_DIR/qt-resource-rebuilder.conf
SCRIPT_ROOT=$XOVI_ROOT/scripts
STOCK_UNIT=/usr/lib/systemd/system/xochitl.service
STOCK_OVERRIDE=/usr/lib/systemd/system/xochitl.service.d/xochitl-service-override.conf
TRANSACTION_UNIT=dispatch-document-menu-install-$ID.service
LOCK=/run/dispatch-document-menu.lock
REMAGIC_TIMER=remagic-live-safety.timer
REMAGIC_SERVICE=remagic-live-safety.service
REMAGIC_SAFETY_CONF=/run/systemd/system/xochitl.service.d/xochitl-service-override.conf
REMAGIC_ROLLBACK_HELPER=/run/remagic-live-rollback.sh
REMAGIC_ROLLBACK_DONE=/run/remagic-live-rollback.done

EXPECTED_BASELINE_SHA256=0f19ada5bd92364e61a2abeefae79a14171fbebc0f498813123fe3e60d7eed9d
EXPECTED_INERT_SHA256=5a685b3142a339b370436c8f6563344d4b4684ddbab3f288f812ab6087a32fc1
EXPECTED_FUNCTIONAL_SHA256=883f275b59736e92cf55e0d49c39a649ed3ea66f2bb7500a88d54659f655aece
EXPECTED_PANEL_SHA256=bf05247511a245fdc84fae41e03a8a2b749ad1d3ef622470a59da76646e8b0f7
EXPECTED_LATENCY_QMD_SHA256=1eb2037f28c9891fbdc4a97d1e2916b8e923fe04004ae1ced03b5de73f59a60e
EXPECTED_STOCK_SHA256=e29494c9fff5ede390b06f1f5e27ca59e4f7bc81d25889822a123ccad1fd686d
EXPECTED_XOCHITL_SHA256=43a9d5d0acc5b998264c16586e11b848f3b83d2d63b5fd322b09c0977d94d3d4
EXPECTED_SERVICE_CONF_SHA256=6036f7776f8775529f94056fafe066ff373f5aa6bca39633bfd4dabfc1552ffd
EXPECTED_APPLEDOUBLE_SHA256=a502dbe0e569c3718c449b86480d0cd4cdc23e3a450814de360e5b0a5e08c5d3
EXPECTED_STOCK_UNIT_SHA256=23f537cf59d527bfbf4823f372385d613e1ade0961c98831c935a372018f9566
EXPECTED_STOCK_OVERRIDE_SHA256=a9432caffacb29d6fcb35136dcc3cb43d8737eb6c2efcb35ea335725f42082d1

hash_file() { sha256sum "$1" | cut -d' ' -f1; }
exact_owned_file() {
    local path=$1 expected=$2 owner_mode=$3
    [ -f "$path" ] && [ ! -L "$path" ] || return 1
    [ "$(stat -c %u:%g:%a "$path")" = "$owner_mode" ] || return 1
    [ "$(hash_file "$path")" = "$expected" ]
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
empty_hook_dir() {
    local directory=$1
    [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
    [ "$(stat -c %u:%g:%a "$directory")" = 0:0:755 ] || return 1
    [ -z "$(direct_entry_names "$directory")" ]
}
stock_surface_is_exact() {
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
    empty_hook_dir "$SCRIPT_ROOT/pre-start" || return 1
    empty_hook_dir "$SCRIPT_ROOT/post-start" || return 1
    empty_hook_dir "$SCRIPT_ROOT/pre-stock" || return 1
    empty_hook_dir "$SCRIPT_ROOT/post-stock"
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
baseline_is_exact() {
    exact_owned_file "$RECOVERY/baseline.sha256" "$EXPECTED_BASELINE_SHA256" 0:0:600 || return 1
    (cd "$QDIR" && sha256sum -c "$RECOVERY/baseline.sha256") >/dev/null 2>&1 || return 1
    exact_owned_file "$LATENCY_QMD" "$EXPECTED_LATENCY_QMD_SHA256" 0:0:644 || return 1
    [ "$(qmd_names)" = "$(awk '{ print $2 }' "$RECOVERY/baseline.sha256" | sort)" ]
}
write_marker() {
    local destination=$1 content=$2 temporary=$RECOVERY/.marker.$$.tmp
    printf '%s\n' "$content" >"$temporary" || return 1
    chown root:root "$temporary" || return 1
    chmod 0600 "$temporary" || return 1
    mv -f "$temporary" "$destination"
}
mark_manual() {
    MANUAL=1
    write_marker "$RECOVERY/manual-intervention-required" "$1" || true
}

# A completed transaction owns the promoted state. A late timer is harmless.
if [ -f "$RECOVERY/committed" ] && [ ! -L "$RECOVERY/committed" ]; then exit 0; fi
if [ -f "$RECOVERY/rolled-back" ] && [ ! -L "$RECOVERY/rolled-back" ]; then exit 0; fi

# Freeze the only reviewed writer before inspecting or moving candidate bytes.
transaction_pid=$(systemctl show -p MainPID --value "$TRANSACTION_UNIT" 2>/dev/null || true)
case "$transaction_pid" in
    ""|0|*[!0-9]*) ;;
    *)
        help=$(systemctl --help) || exit 1
        printf '%s\n' "$help" | grep -F -- '--kill-whom=WHOM' >/dev/null || exit 1
        printf '%s\n' "$help" | grep -F -- '--signal=SIGNAL' >/dev/null || exit 1
        systemctl kill --kill-whom=all --signal=KILL "$TRANSACTION_UNIT" || exit 1
        count=0
        while [ "$count" -lt 10 ] && [ -e "/proc/$transaction_pid" ]; do
            count=$((count + 1)); sleep 1
        done
        [ ! -e "/proc/$transaction_pid" ] || exit 1
        ;;
esac

MANUAL=0
if [ "$MODE" = inert ]; then
    if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
        if exact_owned_file "$TARGET" "$EXPECTED_INERT_SHA256" 0:0:644; then
            mv "$TARGET" "$RECOVERY/removed-inert.qmd" || exit 1
        else
            mark_manual 'unexpected shortcut QMD preserved; stock mode requested'
        fi
    fi
    if [ -e "$PANEL_DIR" ] || [ -L "$PANEL_DIR" ]; then
        if [ -d "$PANEL_DIR" ] && [ ! -L "$PANEL_DIR" ] &&
            [ "$(stat -c %u:%g:%a "$PANEL_DIR")" = 0:0:755 ] &&
            [ -z "$(direct_entry_names "$PANEL_DIR")" ]; then
            rmdir "$PANEL_DIR" || exit 1
        elif [ -d "$PANEL_DIR" ] && [ ! -L "$PANEL_DIR" ] &&
            [ "$(stat -c %u:%g:%a "$PANEL_DIR")" = 0:0:755 ] &&
            [ "$(direct_entry_names "$PANEL_DIR")" = DispatchLauncher.qml ] &&
            exact_owned_file "$PANEL" "$EXPECTED_PANEL_SHA256" 0:0:644; then
            mv "$PANEL" "$RECOVERY/removed-panel.qml" || exit 1
            rmdir "$PANEL_DIR" || exit 1
        else
            mark_manual 'unexpected shortcut panel preserved; stock mode requested'
        fi
    fi
else
    exact_owned_file "$RECOVERY/prior-target.qmd" "$EXPECTED_INERT_SHA256" 0:0:644 || exit 1
    exact_owned_file "$RECOVERY/prior-panel.qml" "$EXPECTED_PANEL_SHA256" 0:0:644 || exit 1
    if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
        if exact_owned_file "$TARGET" "$EXPECTED_FUNCTIONAL_SHA256" 0:0:644; then
            mv "$TARGET" "$RECOVERY/removed-functional.qmd" || exit 1
        elif exact_owned_file "$TARGET" "$EXPECTED_INERT_SHA256" 0:0:644; then
            :
        else
            mark_manual 'unexpected functional shortcut QMD preserved; stock mode requested'
        fi
    fi
    if [ "$MANUAL" -eq 0 ] && [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
        cp "$RECOVERY/prior-target.qmd" "$RECOVERY/inert.rollback.ready" || exit 1
        chown root:root "$RECOVERY/inert.rollback.ready" || exit 1
        chmod 0644 "$RECOVERY/inert.rollback.ready" || exit 1
        exact_owned_file "$RECOVERY/inert.rollback.ready" "$EXPECTED_INERT_SHA256" 0:0:644 || exit 1
        mv "$RECOVERY/inert.rollback.ready" "$TARGET" || exit 1
    fi
    if ! [ -d "$PANEL_DIR" ] || [ -L "$PANEL_DIR" ] ||
        [ "$(stat -c %u:%g:%a "$PANEL_DIR" 2>/dev/null || true)" != 0:0:755 ] ||
        [ "$(direct_entry_names "$PANEL_DIR" 2>/dev/null || true)" != DispatchLauncher.qml ] ||
        ! exact_owned_file "$PANEL" "$EXPECTED_PANEL_SHA256" 0:0:644; then
        mark_manual 'functional rollback found an altered panel; bytes preserved; stock mode requested'
    fi
fi
sync

if [ "$MANUAL" -eq 0 ]; then
    if [ "$MODE" = inert ]; then
        baseline_is_exact || mark_manual 'baseline or latency QMD drift after inert rollback; stock mode requested'
    else
        exact_owned_file "$TARGET" "$EXPECTED_INERT_SHA256" 0:0:644 || mark_manual 'inert QMD restoration failed; stock mode requested'
        if [ "$MANUAL" -eq 0 ]; then
            expected=$(awk '{ print $2 }' "$RECOVERY/baseline.sha256")
            expected="${expected}
${TARGET##*/}"
            (cd "$QDIR" && sha256sum -c "$RECOVERY/baseline.sha256") >/dev/null 2>&1 || mark_manual 'baseline drift after functional rollback; stock mode requested'
            exact_owned_file "$LATENCY_QMD" "$EXPECTED_LATENCY_QMD_SHA256" 0:0:644 || mark_manual 'latency QMD drift after functional rollback; stock mode requested'
            [ "$(qmd_names)" = "$(printf '%s\n' "$expected" | sed '/^$/d' | sort)" ] || mark_manual 'QMD inventory drift after functional rollback; stock mode requested'
        fi
    fi
fi

# Once activation was attempted, return to independently pinned stock xochitl.
if [ -e "$RECOVERY/activation-attempted" ] || [ "$MANUAL" -eq 1 ]; then
    exact_owned_file "$STOCK" "$EXPECTED_STOCK_SHA256" 0:0:755 || exit 1
    exact_owned_file "$XOCHITL" "$EXPECTED_XOCHITL_SHA256" 0:0:755 || exit 1
    exact_owned_file "$STOCK_UNIT" "$EXPECTED_STOCK_UNIT_SHA256" 0:0:644 || exit 1
    exact_owned_file "$STOCK_OVERRIDE" "$EXPECTED_STOCK_OVERRIDE_SHA256" 0:0:644 || exit 1
    stock_surface_is_exact || exit 1
    systemctl stop "$REMAGIC_TIMER" "$REMAGIC_SERVICE" 2>/dev/null || true
    systemctl reset-failed "$REMAGIC_SERVICE" 2>/dev/null || true
    rm -f "$REMAGIC_SAFETY_CONF" "$REMAGIC_ROLLBACK_HELPER" "$REMAGIC_ROLLBACK_DONE"
    systemctl daemon-reload || exit 1
    /bin/bash "$STOCK" >"$RECOVERY/rollback-stock.log" 2>&1 || exit 1
fi

count=0
while [ "$count" -lt 30 ]; do
    if systemctl is-active --quiet xochitl.service; then
        pid=$(systemctl show -p MainPID --value xochitl.service)
        case "$pid" in
            ""|0|*[!0-9]*) ;;
            *)
                if [ "$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)" = "$XOCHITL" ] &&
                    ! tr '\0' '\n' <"/proc/$pid/environ" | grep -q '^LD_PRELOAD='; then
                    break
                fi
                ;;
        esac
    fi
    count=$((count + 1)); sleep 1
done
[ "$count" -lt 30 ] || exit 1
[ "$(findmnt -n -o OPTIONS / | tr ',' '\n' | grep -c '^ro$')" -eq 1 ] || exit 1

write_marker "$RECOVERY/rolled-back" "stock:$MODE:$pid" || exit 1
if [ -d "$LOCK" ] && [ ! -L "$LOCK" ] &&
    [ -f "$LOCK/owner" ] && [ ! -L "$LOCK/owner" ] &&
    [ "$(cat "$LOCK/owner")" = "$ID" ]; then
    rm -f "$LOCK/owner"
    rmdir "$LOCK" 2>/dev/null || true
fi
[ "$MANUAL" -eq 0 ] || exit 1
exit 0
