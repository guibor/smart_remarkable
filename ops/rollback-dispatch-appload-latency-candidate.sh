#!/bin/bash
# Device-side emergency rollback for the Ferrari 3.28.0.169 Dispatch/AppLoad
# repaint candidate. This script is copied into the root-only recovery bundle
# before activation and is launched by an independent systemd timer.
set -u
umask 077

RECOVERY=${1:-}
ID=${2:-}

[[ "$ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || exit 2
EXPECTED_RECOVERY="/home/root/.smart-remarkable-recovery/dispatch-appload-latency/$ID"
[ "$RECOVERY" = "$EXPECTED_RECOVERY" ] || exit 2
[ -d "$RECOVERY" ] && [ ! -L "$RECOVERY" ] || exit 2
[ "$(readlink -f "$RECOVERY")" = "$RECOVERY" ] || exit 2

QDIR=/home/root/xovi/exthome/qt-resource-rebuilder
TARGET="$QDIR/dispatch-appload-partial-repaint-3.28.0.169.qmd"
STOCK=/home/root/xovi/stock
XOCHITL=/usr/bin/xochitl
XOVI_ROOT=/home/root/xovi
SERVICE_ROOT="$XOVI_ROOT/services"
SERVICE_DIR="$SERVICE_ROOT/xochitl.service"
SERVICE_CONF="$SERVICE_DIR/qt-resource-rebuilder.conf"
SCRIPT_ROOT="$XOVI_ROOT/scripts"
STOCK_UNIT=/usr/lib/systemd/system/xochitl.service
STOCK_OVERRIDE=/usr/lib/systemd/system/xochitl.service.d/xochitl-service-override.conf
EXPECTED_CANDIDATE_SHA256=1eb2037f28c9891fbdc4a97d1e2916b8e923fe04004ae1ced03b5de73f59a60e
EXPECTED_STOCK_SHA256=e29494c9fff5ede390b06f1f5e27ca59e4f7bc81d25889822a123ccad1fd686d
EXPECTED_XOCHITL_SHA256=43a9d5d0acc5b998264c16586e11b848f3b83d2d63b5fd322b09c0977d94d3d4
EXPECTED_SERVICE_CONF_SHA256=6036f7776f8775529f94056fafe066ff373f5aa6bca39633bfd4dabfc1552ffd
EXPECTED_APPLEDOUBLE_SHA256=a502dbe0e569c3718c449b86480d0cd4cdc23e3a450814de360e5b0a5e08c5d3
EXPECTED_STOCK_UNIT_SHA256=23f537cf59d527bfbf4823f372385d613e1ade0961c98831c935a372018f9566
EXPECTED_STOCK_OVERRIDE_SHA256=a9432caffacb29d6fcb35136dcc3cb43d8737eb6c2efcb35ea335725f42082d1
TRANSACTION_UNIT="dispatch-appload-latency-install-$ID.service"
LOCK=/run/dispatch-appload-latency.lock
REMAGIC_TIMER=remagic-live-safety.timer
REMAGIC_SERVICE=remagic-live-safety.service
REMAGIC_SAFETY_CONF=/run/systemd/system/xochitl.service.d/xochitl-service-override.conf
REMAGIC_ROLLBACK_HELPER=/run/remagic-live-rollback.sh
REMAGIC_ROLLBACK_DONE=/run/remagic-live-rollback.done

hash_file() {
    sha256sum "$1" | cut -d' ' -f1
}

exact_owned_file() {
    path=$1
    expected=$2
    owner_mode=$3
    [ -f "$path" ] && [ ! -L "$path" ] || return 1
    [ "$(stat -c %u:%g:%a "$path")" = "$owner_mode" ] || return 1
    [ "$(hash_file "$path")" = "$expected" ] || return 1
}

direct_entry_names() {
    directory=$1
    names=
    for path in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
        [ -e "$path" ] || [ -L "$path" ] || continue
        names="${names}${path##*/}
"
    done
    printf '%s' "$names" | sort
}

empty_hook_dir() {
    directory=$1
    [ -d "$directory" ] && [ ! -L "$directory" ] || return 1
    [ "$(stat -c %u:%g:%a "$directory")" = 0:0:755 ] || return 1
    [ -z "$(direct_entry_names "$directory")" ] || return 1
}

stock_surface_is_exact() {
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
    [ -L "$SERVICE_DIR/extensions.d" ] &&
        [ "$(readlink "$SERVICE_DIR/extensions.d")" = /home/root/xovi/extensions.d ] || return 1
    [ -L "$SERVICE_DIR/exthome" ] &&
        [ "$(readlink "$SERVICE_DIR/exthome")" = /home/root/xovi/exthome ] || return 1
    empty_hook_dir "$SCRIPT_ROOT/pre-start" || return 1
    empty_hook_dir "$SCRIPT_ROOT/post-start" || return 1
    empty_hook_dir "$SCRIPT_ROOT/pre-stock" || return 1
    empty_hook_dir "$SCRIPT_ROOT/post-stock" || return 1
}

write_marker() {
    destination=$1
    content=$2
    temporary="$RECOVERY/.marker.$$.tmp"
    printf '%s\n' "$content" >"$temporary" || return 1
    chown root:root "$temporary" || return 1
    chmod 0600 "$temporary" || return 1
    mv -f "$temporary" "$destination" || return 1
}

# A completed transaction owns the candidate. A late timer must be harmless.
if [ -f "$RECOVERY/committed" ] && [ ! -L "$RECOVERY/committed" ]; then
    exit 0
fi
if [ -f "$RECOVERY/rolled-back" ] && [ ! -L "$RECOVERY/rolled-back" ]; then
    exit 0
fi

# Freeze the only reviewed activation owner before looking at the target. This
# prevents a watchdog/installer race after the rollback decision. The option
# spellings were read-only qualified on the target systemd 255 and are checked
# again rather than silently accepting an unsupported no-op.
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
            count=$((count + 1))
            sleep 1
        done
        [ ! -e "/proc/$transaction_pid" ] || exit 1
        ;;
esac

unknown_target=0
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    if [ -f "$TARGET" ] && [ ! -L "$TARGET" ] &&
        [ "$(hash_file "$TARGET")" = "$EXPECTED_CANDIDATE_SHA256" ]; then
        mv -f "$TARGET" "$RECOVERY/removed-candidate.qmd" || exit 1
    else
        # Never delete or overwrite bytes that are not this reviewed candidate.
        unknown_target=1
        write_marker "$RECOVERY/manual-intervention-required" \
            "unexpected target preserved; stock mode requested" || true
    fi
fi
sync

# If activation started, restore the independently pinned stock UI. This leaves
# the root filesystem untouched and Xovi unloaded; reactivation is a later,
# separate guarded operation.
if [ -e "$RECOVERY/activation-attempted" ] || [ "$unknown_target" -eq 1 ]; then
    [ -f "$STOCK" ] && [ ! -L "$STOCK" ] || exit 1
    [ "$(hash_file "$STOCK")" = "$EXPECTED_STOCK_SHA256" ] || exit 1
    [ -f "$XOCHITL" ] && [ ! -L "$XOCHITL" ] || exit 1
    [ "$(hash_file "$XOCHITL")" = "$EXPECTED_XOCHITL_SHA256" ] || exit 1
    exact_owned_file "$STOCK_UNIT" "$EXPECTED_STOCK_UNIT_SHA256" 0:0:644 || exit 1
    exact_owned_file "$STOCK_OVERRIDE" "$EXPECTED_STOCK_OVERRIDE_SHA256" 0:0:644 || exit 1
    stock_surface_is_exact || exit 1
    # A SIGKILL during the nested ReMagic canary bypasses its shell EXIT trap.
    # Disarm and remove only that exact wrapper's documented volatile safety
    # files before the outer rollback requests stock mode.
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
    count=$((count + 1))
    sleep 1
done
[ "$count" -lt 30 ] || exit 1
[ "$(findmnt -n -o OPTIONS / | tr ',' '\n' | grep -c '^ro$')" -eq 1 ] || exit 1

write_marker "$RECOVERY/rolled-back" "stock:$pid" || exit 1
if [ -d "$LOCK" ] && [ ! -L "$LOCK" ] &&
    [ -f "$LOCK/owner" ] && [ ! -L "$LOCK/owner" ] &&
    [ "$(cat "$LOCK/owner")" = "$ID" ]; then
    rm -f "$LOCK/owner"
    rmdir "$LOCK" 2>/dev/null || true
fi
[ "$unknown_target" -eq 0 ] || exit 1
exit 0
