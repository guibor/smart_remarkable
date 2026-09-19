#!/bin/bash
# Independent device-side rollback for the Ferrari 3.28.0.169 Smart lasso
# functional promotion. The reviewed installer copies this file into the
# root-only recovery directory before it arms the 180-second timer.
set -eu
umask 077

RECOVERY=${1:-}
MODE=${2:-}
ID=${3:-}

case "$MODE" in functional) ;;
    *) exit 2 ;;
esac
[[ "$ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || exit 2
EXPECTED_RECOVERY=/home/root/.smart-remarkable-recovery/smart-functional/$ID
[ "$RECOVERY" = "$EXPECTED_RECOVERY" ] || exit 2
[ -d "$RECOVERY" ] && [ ! -L "$RECOVERY" ] || exit 2
[ "$(readlink -f "$RECOVERY")" = "$RECOVERY" ] || exit 2
[ "$(stat -c %u:%g:%a "$RECOVERY")" = 0:0:700 ] || exit 2

XOVI_ROOT=/home/root/xovi
QDIR=$XOVI_ROOT/exthome/qt-resource-rebuilder
TARGET=$QDIR/smart-remarkable-llm.qmd
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
TRANSACTION_UNIT=smart-functional-install-$ID.service
LOCK=/run/smart-remarkable-llm-button/deployment.lock
REMAGIC_TIMER=remagic-live-safety.timer
REMAGIC_SERVICE=remagic-live-safety.service
REMAGIC_SAFETY_CONF=/run/systemd/system/xochitl.service.d/xochitl-service-override.conf
REMAGIC_ROLLBACK_HELPER=/run/remagic-live-rollback.sh
REMAGIC_ROLLBACK_DONE=/run/remagic-live-rollback.done

EXPECTED_BASELINE_SHA256=8d4ff75e807e23918436204bf79977bceb14d915ac4130ed2d134c45a4b0aaac
EXPECTED_INERT_SHA256=1952fa9d383ece8e5d0e05915e8e4bf6745ac40eeeb1522567dc4011706fea25
EXPECTED_FUNCTIONAL_SHA256=afcde7847b31409c3e503d39af67264c6e7e824dc7e6ddba8d403d297330c05a
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

# BEGIN installer-quiescence gate (also exercised with mocked systemd/cgroup data).
rec=$RECOVERY
installer=$TRANSACTION_UNIT
installer_group="/system.slice/$installer"
installer_quiescent() {
  local load active main control group populated
  load=$(systemctl show "$installer" -p LoadState --value) || return 1
  active=$(systemctl show "$installer" -p ActiveState --value) || return 1
  main=$(systemctl show "$installer" -p MainPID --value) || return 1
  control=$(systemctl show "$installer" -p ControlPID --value) || return 1
  group=$(systemctl show "$installer" -p ControlGroup --value) || return 1
  case "$load" in
    loaded)
      case "$active" in inactive|failed) ;; *) return 1 ;; esac
      test "$main" = 0 && test "$control" = 0 || return 1
      ;;
    not-found)
      # Collected transient units may omit service-only properties.
      case "$active" in ''|inactive) ;; *) return 1 ;; esac
      case "$main:$control" in :|0:|:0|0:0) ;; *) return 1 ;; esac
      test -z "$group" || return 1
      ;;
    *) return 1 ;;
  esac
  case "$group" in ''|"$installer_group") ;; *) return 1 ;; esac
  # Population includes descendants; MainPID alone cannot prove quiescence.
  # Both qualified tablets use this exact cgroup2 mount in a hybrid hierarchy.
  test "$(findmnt -n -o FSTYPE /sys/fs/cgroup/unified)" = cgroup2 || return 1
  test -r /sys/fs/cgroup/unified/cgroup.controllers || return 1
  if test ! -e "/sys/fs/cgroup/unified$installer_group" && test ! -L "/sys/fs/cgroup/unified$installer_group"; then return 0; fi
  test ! -L "/sys/fs/cgroup/unified$installer_group" || return 1
  populated=$(awk '$1 == "populated" { count++; value=$2 } END { if (count != 1) exit 1; print value }' "/sys/fs/cgroup/unified$installer_group/cgroup.events") || return 1
  test "$populated" = 0
}
systemctl kill --kill-whom=all --signal=KILL "$TRANSACTION_UNIT" 2>/dev/null || true
quiescent=0
for attempt in $(seq 1 20); do
  if installer_quiescent; then quiescent=1; break; fi
  sleep 1
done
test "$quiescent" = 1
# Commit may win between the first marker check and SIGKILL. Recheck only after
# neither the installer nor any descendant can race with file restoration.
test ! -e "$rec/committed" || exit 0
test ! -e "$rec/rolled-back" || exit 0
# END installer-quiescence gate

MANUAL=0
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
sync

if [ "$MANUAL" -eq 0 ]; then
    exact_owned_file "$RECOVERY/baseline.sha256" "$EXPECTED_BASELINE_SHA256" 0:0:600 || exit 1
    exact_owned_file "$TARGET" "$EXPECTED_INERT_SHA256" 0:0:644 || mark_manual 'inert QMD restoration failed'
    expected=$(awk '{ print $2 }' "$RECOVERY/baseline.sha256")
    expected="$(printf '%s\n' "$expected" "${TARGET##*/}" | sort)"
    (cd "$QDIR" && sha256sum -c "$RECOVERY/baseline.sha256") >/dev/null 2>&1 || mark_manual 'peer QMD drift'
    [ "$(qmd_names)" = "$expected" ] || mark_manual 'QMD inventory drift'
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

# BEGIN stock-stability gate (tested with mocked process/systemd state).
stock_start_time() {
    # The comm field may contain spaces or parentheses; field 22 is the
    # twentieth field after its final ") ", not the raw whitespace field 22.
    awk '{ line=$0; sub(/^.*\) /,"",line); n=split(line,f," ");
        if (n < 20 || f[20] !~ /^[0-9]+$/) exit 1; print f[20] }' "/proc/$1/stat"
}
stock_identity() {
    local current_pid started environment
    systemctl is-active --quiet xochitl.service || return 1
    [ "$(systemctl show -p NRestarts --value xochitl.service)" = 0 ] || return 1
    current_pid=$(systemctl show -p MainPID --value xochitl.service) || return 1
    case "$current_pid" in ""|0|*[!0-9]*) return 1 ;; esac
    started=$(stock_start_time "$current_pid") || return 1
    [ "$(readlink -f "/proc/$current_pid/exe")" = "$XOCHITL" ] || return 1
    environment=$(tr '\0' '\n' <"/proc/$current_pid/environ") || return 1
    if printf '%s\n' "$environment" | grep -q '^LD_PRELOAD='; then return 1; fi
    # Absence of LD_PRELOAD alone does not prove that old XOVI mappings left.
    awk 'index($0,"/home/root/xovi/") { found=1 }
        END { exit (NR == 0 || found) }' "/proc/$current_pid/maps" || return 1
    [ "$(stock_start_time "$current_pid")" = "$started" ] || return 1
    [ "$(systemctl show -p MainPID --value xochitl.service)" = "$current_pid" ] || return 1
    [ "$(systemctl show -p NRestarts --value xochitl.service)" = 0 ] || return 1
    [ "$(findmnt -n -o OPTIONS / | tr ',' '\n' | grep -c '^ro$')" -eq 1 ] || return 1
    printf '%s:%s\n' "$current_pid" "$started"
}
stock_stable_identity() {
    local attempt=0 initial= sample
    while [ "$attempt" -lt 30 ]; do
        if initial=$(stock_identity); then break; fi
        attempt=$((attempt + 1)); sleep 1
    done
    [ "$attempt" -lt 30 ] || return 1
    # Prove the same process incarnation over five further one-second samples.
    for attempt in 1 2 3 4 5; do
        sleep 1
        sample=$(stock_identity) || return 1
        [ "$sample" = "$initial" ] || return 1
    done
    printf '%s\n' "$initial"
}
identity=$(stock_stable_identity) || exit 1
pid=${identity%%:*}
# END stock-stability gate

write_marker "$RECOVERY/rolled-back" "stock:$MODE:$pid" || exit 1
if [ -d "$LOCK" ] && [ ! -L "$LOCK" ] &&
    [ -f "$LOCK/owner" ] && [ ! -L "$LOCK/owner" ] &&
    [ "$(cat "$LOCK/owner")" = "$ID" ]; then
    rm -f "$LOCK/owner"
    rmdir "$LOCK" 2>/dev/null || true
fi
[ "$MANUAL" -eq 0 ] || exit 1
exit 0
