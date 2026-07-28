#!/bin/bash
# BusyBox-compatible device transaction for the Smart Remarkable QML button.
# The watchdog is the sole rollback owner once ARMED exists.
set -Eeuo pipefail
umask 077

ACTION=${1:-}
PHASE=${2:-}
ID=${3:-}

case "$PHASE" in
    inert|functional|refresh-inert|refresh-functional) ;;
    *) echo "Invalid phase" >&2; exit 2 ;;
esac
[[ "$ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || {
    echo "Invalid transaction id" >&2
    exit 2
}

QRR_HOME=/home/root/xovi/exthome/qt-resource-rebuilder
TARGET="$QRR_HOME/smart-remarkable-llm.qmd"
RECOVERY_BASE=/home/root/.smart-remarkable-recovery
RECOVERY_ROOT="$RECOVERY_BASE/llm-button"
RECOVERY="$RECOVERY_ROOT/$ID"
STATE_DIR=/run/smart-remarkable-llm-button
GLOBAL_LOCK="$STATE_DIR/deployment.lock"
STATUS="$STATE_DIR/$ID.status"
ARMED="$STATE_DIR/$ID.armed"
HEALTHY="$STATE_DIR/$ID.healthy"
ACK="$STATE_DIR/$ID.ack"
COMMIT="$STATE_DIR/$ID.commit"
VALIDATED="$STATE_DIR/$ID.validated"
ROLLBACK_DONE="$STATE_DIR/$ID.rollback-done"
WATCHDOG_READY="$STATE_DIR/$ID.watchdog-ready"
ROLLBACK_LOCK="$STATE_DIR/$ID.rollback.lock"
PREPARED_TMP="$QRR_HOME/.smart-remarkable-llm.$ID.tmp"
TXN_UNIT="smart-remarkable-llm-canary-$ID.service"
WATCHDOG_UNIT="smart-remarkable-llm-watchdog-$ID.service"
ARCHIVE="/home/root/.smart-remarkable-llm-canary-$ID.tar"
REMOTE_SCRIPT="/home/root/.smart-remarkable-llm-canary-$ID.sh"

STOCK=/home/root/xovi/stock
XOCHITL=/usr/bin/xochitl
XOVI=/home/root/xovi/xovi.so
EXTENSIONS=/home/root/xovi/extensions.d
QRR="$EXTENSIONS/qt-resource-rebuilder.so"
BROKER="$EXTENSIONS/xovi-message-broker.so"
APPLOAD="$EXTENSIONS/appload.so"
HASHTAB="$QRR_HOME/hashtab"
SERVICE_ROOT=/home/root/xovi/services
SERVICE_DIR="$SERVICE_ROOT/xochitl.service"
SERVICE_CONF="$SERVICE_DIR/qt-resource-rebuilder.conf"
ACTIVE_DROPIN=/etc/systemd/system/xochitl.service.d
STOCK_UNIT=/usr/lib/systemd/system/xochitl.service
STOCK_OVERRIDE=/usr/lib/systemd/system/xochitl.service.d/xochitl-service-override.conf
APP_MANIFEST=/home/root/xovi/exthome/appload/smart-remarkable/external.manifest.json

ensure_private_dir() {
    directory=$1
    if [ -L "$directory" ]; then
        return 1
    fi
    if [ -e "$directory" ]; then
        [ -d "$directory" ] || return 1
        [ "$(stat -c %u:%g:%a "$directory")" = 0:0:700 ] || return 1
        return 0
    fi
    mkdir -p "$directory" || return 1
    chown root:root "$directory" || return 1
    chmod 0700 "$directory" || return 1
    [ "$(stat -c %u:%g:%a "$directory")" = 0:0:700 ] || return 1
}

ensure_private_dir "$STATE_DIR"

write_one_line() {
    destination=$1
    content=$2
    temporary="$STATE_DIR/.$ID.$$.tmp"
    printf '%s\n' "$content" >"$temporary" || return 1
    chown root:root "$temporary" || return 1
    chmod 0600 "$temporary" || return 1
    mv -f "$temporary" "$destination" || return 1
}

write_two_lines() {
    destination=$1
    first=$2
    second=$3
    temporary="$STATE_DIR/.$ID.$$.tmp"
    {
        printf '%s\n' "$first" &&
        printf '%s\n' "$second"
    } >"$temporary" || return 1
    chown root:root "$temporary" || return 1
    chmod 0600 "$temporary" || return 1
    mv -f "$temporary" "$destination" || return 1
}

root_is_read_only() {
    [ "$(findmnt -n -o OPTIONS / | tr ',' '\n' | grep -c '^ro$')" -eq 1 ]
}

serial_number() {
    tr -d '[:space:]' </sys/devices/soc0/serial_number
}

firmware_version() {
    awk -F= '
        $1 == "IMG_VERSION" && !found {
            value=$2
            gsub(/^"|"$/, "", value)
            found=1
        }
        END { if (!found) exit 1; print value }
    ' /etc/os-release
}

firmware_build() {
    tr -d '[:space:]' </etc/version
}

file_is_exact_regular() {
    path=$1
    expected_sha=$2
    [ -f "$path" ] || return 1
    [ ! -L "$path" ] || return 1
    [ "$(stat -c %u:%g "$path")" = 0:0 ] || return 1
    [ "$(sha256sum "$path" | cut -d' ' -f1)" = "$expected_sha" ] || return 1
}

process_maps_exact_file() {
    pid=$1
    path=$2
    awk -v expected="$path" \
        '$NF == expected { found=1 } END { exit !found }' "/proc/$pid/maps"
}

process_has_environment() {
    pid=$1
    expected=$2
    tr '\0' '\n' <"/proc/$pid/environ" |
        grep -Fx "$expected" >/dev/null
}

xovi_process_is_exact() {
    pid=$1
    process_has_environment "$pid" "LD_PRELOAD=$XOVI" || return 1
    process_has_environment "$pid" "QML_DISABLE_DISK_CACHE=1" || return 1
    xovi_root=$(tr '\0' '\n' <"/proc/$pid/environ" |
        awk -F= '
            $1 == "XOVI_ROOT" && !found {
                value=substr($0, length($1) + 2)
                found=1
            }
            END { if (!found) exit 1; print value }
        ') || return 1
    [ "$(readlink -f "$xovi_root")" = "$SERVICE_DIR" ] || return 1
    process_maps_exact_file "$pid" "$XOVI" || return 1
    process_maps_exact_file "$pid" "$QRR" || return 1
    process_maps_exact_file "$pid" "$BROKER" || return 1
    process_maps_exact_file "$pid" "$APPLOAD" || return 1
    return 0
}

wait_for_xochitl() {
    mode=$1
    count=0
    while [ "$count" -lt 30 ]; do
        if systemctl is-active --quiet xochitl.service; then
            pid=$(systemctl show -p MainPID --value xochitl.service)
            case "$pid" in
                ""|0|*[!0-9]*) ;;
                *)
                    if [ "$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)" = "$XOCHITL" ]; then
                        if [ "$mode" = stock ]; then
                            if ! tr '\0' '\n' <"/proc/$pid/environ" |
                                grep -E '^LD_PRELOAD=' >/dev/null; then
                                printf '%s\n' "$pid"
                                return 0
                            fi
                        elif xovi_process_is_exact "$pid"; then
                            printf '%s\n' "$pid"
                            return 0
                        fi
                    fi
                    ;;
            esac
        fi
        count=$((count + 1))
        sleep 1
    done
    return 1
}

proc_stats() {
    pid=$1
    awk '
        /^VmRSS:/ { rss=$2 }
        /^Threads:/ { threads=$2 }
        END {
            if (!rss || !threads) exit 1
            print rss, threads
        }
    ' "/proc/$pid/status"
}

smart_process_running() {
    for exe in /proc/[0-9]*/exe; do
        [ -L "$exe" ] || continue
        executable=$(readlink "$exe" 2>/dev/null) || continue
        [ "${executable##*/}" = smart_remarkable ] && return 0
    done
    return 1
}

lock_is_owned() {
    [ -f "$GLOBAL_LOCK/owner" ] &&
        [ ! -L "$GLOBAL_LOCK/owner" ] &&
        [ "$(stat -c %u:%g:%a "$GLOBAL_LOCK/owner")" = 0:0:600 ] &&
        [ "$(cat "$GLOBAL_LOCK/owner")" = "$ID" ]
}

release_global_lock() {
    if lock_is_owned; then
        rm -f "$GLOBAL_LOCK/owner"
        rmdir "$GLOBAL_LOCK" 2>/dev/null || true
    fi
}

directory_has_no_entries() {
    directory=$1
    [ -d "$directory" ] || return 1
    [ ! -L "$directory" ] || return 1
    [ "$(stat -c %u:%g "$directory")" = 0:0 ] || return 1
    entries=$(find "$directory" -mindepth 1 -maxdepth 1 ! -name '._*' -print) ||
        return 1
    [ -z "$entries" ] || return 1
    return 0
}

stock_inputs_are_exact() {
    expected_stock_sha=$1
    expected_service_conf_sha=$2
    expected_unit_sha=$3
    expected_stock_override_sha=$4
    file_is_exact_regular "$STOCK" "$expected_stock_sha" || return 1
    [ -x "$STOCK" ] || return 1
    [ -d "$SERVICE_ROOT" ] || return 1
    [ ! -L "$SERVICE_ROOT" ] || return 1
    [ "$(stat -c %u:%g "$SERVICE_ROOT")" = 0:0 ] || return 1
    [ -d "$SERVICE_DIR" ] || return 1
    [ ! -L "$SERVICE_DIR" ] || return 1
    [ "$(stat -c %u:%g "$SERVICE_DIR")" = 0:0 ] || return 1
    directory_has_no_entries /home/root/xovi/scripts/pre-stock || return 1
    directory_has_no_entries /home/root/xovi/scripts/post-stock || return 1

    service_names=
    for path in "$SERVICE_ROOT"/*; do
        [ -e "$path" ] || continue
        name=${path##*/}
        case "$name" in ._*) continue ;; esac
        [ -d "$path" ] || return 1
        [ ! -L "$path" ] || return 1
        service_names="${service_names}${name}
"
    done
    service_names=$(printf '%s' "$service_names" | sort) || return 1
    [ "$service_names" = xochitl.service ] || return 1

    [ -L "$SERVICE_DIR/extensions.d" ] || return 1
    [ "$(readlink "$SERVICE_DIR/extensions.d")" = "$EXTENSIONS" ] || return 1
    [ -L "$SERVICE_DIR/exthome" ] || return 1
    [ "$(readlink "$SERVICE_DIR/exthome")" = /home/root/xovi/exthome ] || return 1
    file_is_exact_regular "$SERVICE_CONF" "$expected_service_conf_sha" || return 1
    file_is_exact_regular "$STOCK_UNIT" "$expected_unit_sha" || return 1
    file_is_exact_regular "$STOCK_OVERRIDE" "$expected_stock_override_sha" || return 1

    service_entries=
    for path in "$SERVICE_DIR"/*; do
        [ -e "$path" ] || [ -L "$path" ] || continue
        name=${path##*/}
        case "$name" in ._*) continue ;; esac
        service_entries="${service_entries}${name}
"
    done
    service_entries=$(printf '%s' "$service_entries" | sort) || return 1
    [ "$service_entries" = "$(printf 'extensions.d\nexthome\nqt-resource-rebuilder.conf\n')" ] ||
        return 1
    return 0
}

active_dropins_are_exact() {
    expected_service_conf_sha=$1
    expected_active_xovi_sha=$2
    expected_unit_sha=$3
    expected_stock_override_sha=$4
    [ "$(findmnt -n -o FSTYPE -T "$ACTIVE_DROPIN")" = tmpfs ] || return 1
    file_is_exact_regular "$ACTIVE_DROPIN/00-xovi.conf" "$expected_active_xovi_sha" ||
        return 1
    file_is_exact_regular \
        "$ACTIVE_DROPIN/qt-resource-rebuilder.conf" \
        "$expected_service_conf_sha" || return 1
    [ -L "$ACTIVE_DROPIN/extensions.d" ] || return 1
    [ "$(stat -c %u:%g "$ACTIVE_DROPIN/extensions.d")" = 0:0 ] || return 1
    [ "$(readlink "$ACTIVE_DROPIN/extensions.d")" = "$EXTENSIONS" ] || return 1
    [ -L "$ACTIVE_DROPIN/exthome" ] || return 1
    [ "$(stat -c %u:%g "$ACTIVE_DROPIN/exthome")" = 0:0 ] || return 1
    [ "$(readlink "$ACTIVE_DROPIN/exthome")" = /home/root/xovi/exthome ] || return 1
    file_is_exact_regular "$STOCK_UNIT" "$expected_unit_sha" || return 1
    file_is_exact_regular "$STOCK_OVERRIDE" "$expected_stock_override_sha" || return 1

    dropin_entries=
    for path in "$ACTIVE_DROPIN"/*; do
        [ -e "$path" ] || [ -L "$path" ] || continue
        name=${path##*/}
        case "$name" in ._*) continue ;; esac
        dropin_entries="${dropin_entries}${name}
"
    done
    dropin_entries=$(printf '%s' "$dropin_entries" | sort) || return 1
    [ "$dropin_entries" = \
        "$(printf '00-xovi.conf\nextensions.d\nexthome\nqt-resource-rebuilder.conf\n')" ] ||
        return 1

    active_paths=$(systemctl show -p DropInPaths --value xochitl.service) || return 1
    active_paths=$(printf '%s\n' $active_paths | sort) || return 1
    expected_paths=$(printf '%s\n' \
        "$ACTIVE_DROPIN/00-xovi.conf" \
        "$ACTIVE_DROPIN/qt-resource-rebuilder.conf" \
        "$STOCK_OVERRIDE" | sort) || return 1
    [ "$active_paths" = "$expected_paths" ] || return 1
    return 0
}

extensions_are_exact() {
    [ -d "$EXTENSIONS" ] || return 1
    [ ! -L "$EXTENSIONS" ] || return 1
    [ "$(stat -c %u:%g "$EXTENSIONS")" = 0:0 ] || return 1
    extension_names=
    for path in "$EXTENSIONS"/*; do
        [ -e "$path" ] || [ -L "$path" ] || continue
        name=${path##*/}
        case "$name" in ._*) continue ;; esac
        [ -f "$path" ] || return 1
        [ ! -L "$path" ] || return 1
        extension_names="${extension_names}${name}
"
    done
    extension_names=$(printf '%s' "$extension_names" | sort) || return 1
    [ "$extension_names" = "$(printf 'appload.so\nqt-resource-rebuilder.so\nxovi-message-broker.so\n')" ] ||
        return 1
    return 0
}

mod_files_are_exact() {
    phase=$1
    better_toc="$QRR_HOME/betterToc-beta-3.28.0.163.qmd"
    better_toc_collapse="$QRR_HOME/bettertoc-collapse-beta-3.28.0.163.qmd"
    gestik="$QRR_HOME/gestik-beta-3.28.0.163.qmd"
    ghostbuster="$QRR_HOME/ghostbuster-beta-3.28.0.163.qmd"
    pen_memory="$QRR_HOME/penLayerMemory-beta-3.28.0.163.qmd"
    quick_settings="$QRR_HOME/quickSettingsTimer-beta-3.28.0.163.qmd"
    toc_from_selection="$QRR_HOME/tocFromSelection-beta-3.28.0.163.qmd"
    [ -d "$QRR_HOME" ] || return 1
    [ ! -L "$QRR_HOME" ] || return 1
    [ "$(stat -c %u:%g "$QRR_HOME")" = 0:0 ] || return 1
    for specification in \
        "$better_toc:$BETTER_TOC_QMD_SHA256" \
        "$better_toc_collapse:$BETTER_TOC_COLLAPSE_QMD_SHA256" \
        "$gestik:$GESTIK_QMD_SHA256" \
        "$ghostbuster:$GHOSTBUSTER_QMD_SHA256" \
        "$pen_memory:$PEN_LAYER_MEMORY_QMD_SHA256" \
        "$quick_settings:$QUICK_SETTINGS_TIMER_QMD_SHA256" \
        "$toc_from_selection:$TOC_FROM_SELECTION_QMD_SHA256"
    do
        path=${specification%%:*}
        expected_sha=${specification#*:}
        file_is_exact_regular "$path" "$expected_sha" || return 1
        [ "$(stat -c %a "$path")" = 644 ] || return 1
    done
    expected_names="$(printf '%s\n' \
        betterToc-beta-3.28.0.163.qmd \
        bettertoc-collapse-beta-3.28.0.163.qmd \
        gestik-beta-3.28.0.163.qmd \
        ghostbuster-beta-3.28.0.163.qmd \
        penLayerMemory-beta-3.28.0.163.qmd \
        quickSettingsTimer-beta-3.28.0.163.qmd \
        tocFromSelection-beta-3.28.0.163.qmd)"
    names=
    # Include visible and hidden direct entries. Ordinary metadata is ignored,
    # but every .qmd/.qrr/.rcc—dotfile or otherwise—must appear in the exact
    # expected-name set below.
    for path in "$QRR_HOME"/* "$QRR_HOME"/.[!.]* "$QRR_HOME"/..?*; do
        [ -e "$path" ] || [ -L "$path" ] || continue
        name=${path##*/}
        case "$name" in
            *.qmd|*.qrr|*.rcc)
                [ -f "$path" ] || return 1
                [ ! -L "$path" ] || return 1
                names="${names}${name}
"
                ;;
        esac
    done
    names=$(printf '%s' "$names" | sort) || return 1
    if [ "$phase" != inert ]; then
        expected_names="${expected_names}
smart-remarkable-llm.qmd"
    fi
    expected_names=$(printf '%s\n' "$expected_names" | sort) || return 1
    [ "$names" = "$expected_names" ] || return 1
    return 0
}

stock_state_is_healthy() {
    expected_xochitl_sha=$1
    [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ] || return 1
    root_is_read_only || return 1
    file_is_exact_regular "$XOCHITL" "$expected_xochitl_sha" || return 1
    stock_pid=$(wait_for_xochitl stock) || return 1
    case "$stock_pid" in ""|0|*[!0-9]*) return 1 ;; esac
    return 0
}

safe_stock() {
    expected_stock_sha=$1
    expected_service_conf_sha=$2
    expected_xochitl_sha=$3
    expected_unit_sha=$4
    expected_stock_override_sha=$5

    exec 9>"$ROLLBACK_LOCK" || return 1
    chmod 0600 "$ROLLBACK_LOCK" || { exec 9>&-; return 1; }
    if ! /usr/bin/flock -x 9; then
        exec 9>&-
        return 1
    fi

    recovered=0
    recovery_error=0
    stock_inputs_ok=0
    if stock_inputs_are_exact \
        "$expected_stock_sha" \
        "$expected_service_conf_sha" \
        "$expected_unit_sha" \
        "$expected_stock_override_sha"; then
        stock_inputs_ok=1
    fi
    ensure_private_dir "$RECOVERY_BASE" || recovery_error=1
    ensure_private_dir "$RECOVERY_ROOT" || recovery_error=1
    ensure_private_dir "$RECOVERY" || recovery_error=1

    if [ "$recovery_error" -eq 0 ] &&
        { [ -e "$TARGET" ] || [ -L "$TARGET" ]; }; then
        mv -f "$TARGET" "$RECOVERY/removed-by-rollback.qmd" ||
            recovery_error=1
    fi
    sync || recovery_error=1

    systemctl reset-failed xochitl.service >/dev/null 2>&1 || true
    stock_status=1
    # The recovery directory and QMD move are independent from the trust
    # decision for the rollback executable. If the exact stock inputs are
    # valid, restore the stock UI even when a /home recovery write failed;
    # stock_state_is_healthy still refuses terminal success until the QMD is
    # absent and every postcondition holds.
    if [ "$stock_inputs_ok" -eq 1 ]; then
        if /bin/bash "$STOCK"; then
            stock_status=0
        else
            stock_status=$?
        fi
    fi
    if [ "$recovery_error" -eq 0 ] &&
        [ "$stock_status" -eq 0 ] &&
        stock_state_is_healthy "$expected_xochitl_sha"; then
        recovered=1
    elif [ "$stock_inputs_ok" -eq 1 ]; then
        systemctl reset-failed xochitl.service >/dev/null 2>&1 || true
        if systemctl restart xochitl.service &&
            [ "$recovery_error" -eq 0 ] &&
            stock_state_is_healthy "$expected_xochitl_sha"; then
            recovered=1
        fi
    fi

    if [ "$recovered" -eq 1 ]; then
        rollback_pid=$(systemctl show -p MainPID --value xochitl.service) ||
            recovered=0
        case "$rollback_pid" in
            ""|0|*[!0-9]*) recovered=0 ;;
        esac
    fi
    if [ "$recovered" -eq 1 ]; then
        rm -f "$ARMED" "$HEALTHY" "$ACK" "$COMMIT" "$VALIDATED" ||
            recovered=0
    fi
    if [ "$recovered" -eq 1 ]; then
        write_one_line "$ROLLBACK_DONE" "rollback:$PHASE:$rollback_pid" ||
            recovered=0
    fi
    /usr/bin/flock -u 9 || true
    exec 9>&-
    [ "$recovered" -eq 1 ]
}

terminal_cleanup() {
    systemctl stop "$TXN_UNIT" >/dev/null 2>&1 || true
    release_global_lock
    rm -f "$PREPARED_TMP"
    rm -f "$ARCHIVE"
    rm -f "$REMOTE_SCRIPT"
}

watchdog_main() {
    expected_qmd_sha=${4:?expected qmd sha required}
    expected_serial=${5:?expected serial required}
    expected_stock_sha=${6:?expected stock sha required}
    expected_service_conf_sha=${7:?expected service conf sha required}
    expected_xochitl_sha=${8:?expected xochitl sha required}
    expected_unit_sha=${9:?expected unit sha required}
    expected_stock_override_sha=${10:?expected stock override sha required}

    case "$expected_qmd_sha$expected_stock_sha$expected_service_conf_sha$expected_xochitl_sha$expected_unit_sha$expected_stock_override_sha" in
        *[!0-9a-f]*) exit 2 ;;
    esac
    [ "${#expected_qmd_sha}" -eq 64 ]
    [ "${#expected_stock_sha}" -eq 64 ]
    [ "${#expected_service_conf_sha}" -eq 64 ]
    [ "${#expected_xochitl_sha}" -eq 64 ]
    [ "${#expected_unit_sha}" -eq 64 ]
    [ "${#expected_stock_override_sha}" -eq 64 ]
    case "$expected_serial" in *[!0-9A-F]*) exit 2 ;; esac
    [ "${#expected_serial}" -eq 16 ]
    [ "$(serial_number)" = "$expected_serial" ]
    root_is_read_only
    lock_is_owned
    [ -x /usr/bin/flock ]
    stock_inputs_are_exact \
        "$expected_stock_sha" \
        "$expected_service_conf_sha" \
        "$expected_unit_sha" \
        "$expected_stock_override_sha"
    file_is_exact_regular "$XOCHITL" "$expected_xochitl_sha"

    write_two_lines "$WATCHDOG_READY" "ID=$ID" "QMD_SHA256=$expected_qmd_sha"

    # Wait longer than the transaction's complete preflight. At the deadline,
    # stop the bound transaction first so it cannot mutate after this decision.
    count=0
    while [ "$count" -lt 150 ]; do
        if [ -f "$ARMED" ]; then
            break
        fi
        if [ -f "$STATUS" ]; then
            terminal_cleanup
            exit 0
        fi
        count=$((count + 1))
        sleep 1
    done
    if [ ! -f "$ARMED" ]; then
        systemctl stop "$TXN_UNIT" >/dev/null 2>&1 || true
        if [ -f "$ARMED" ]; then
            :
        else
            write_one_line "$STATUS" "failure:prearm:watchdog-timeout"
            terminal_cleanup
            exit 0
        fi
    fi

    # A malformed ARMED file is itself a rollback request.
    armed_valid=1
    [ ! -L "$ARMED" ] || armed_valid=0
    [ "$(stat -c %u:%g:%a "$ARMED" 2>/dev/null || true)" = 0:0:600 ] || armed_valid=0
    grep -Fqx "ID=$ID" "$ARMED" 2>/dev/null || armed_valid=0
    grep -Fqx "QMD_SHA256=$expected_qmd_sha" "$ARMED" 2>/dev/null || armed_valid=0
    if [ "$armed_valid" -ne 1 ]; then
        write_one_line "$STATUS" "failure:armed:malformed-marker"
        safe_stock \
            "$expected_stock_sha" \
            "$expected_service_conf_sha" \
            "$expected_xochitl_sha" \
            "$expected_unit_sha" \
            "$expected_stock_override_sha" ||
            exit 1
        terminal_cleanup
        exit 0
    fi

    count=0
    while [ "$count" -lt 120 ]; do
        if [ -f "$COMMIT" ]; then
            committed=$(cat "$COMMIT")
            case "$committed" in
                "success:$PHASE:"*)
                    committed_pid=${committed##*:}
                    case "$committed_pid" in ""|0|*[!0-9]*) committed_pid=0 ;; esac
                    if [ "$committed_pid" != 0 ] &&
                        [ "$committed" = "success:$PHASE:$committed_pid" ] &&
                        [ "$(systemctl show -p MainPID --value xochitl.service)" = "$committed_pid" ] &&
                        file_is_exact_regular "$TARGET" "$expected_qmd_sha" &&
                        root_is_read_only &&
                        xovi_process_is_exact "$committed_pid"; then
                        if write_one_line \
                            "$VALIDATED" \
                            "validated:$PHASE:$committed_pid"; then
                            terminal_cleanup
                            exit 0
                        fi
                        write_one_line "$STATUS" \
                            "failure:armed:validated-marker-write" || true
                        break
                    fi
                    ;;
            esac
            write_one_line "$STATUS" "failure:armed:invalid-commit"
            break
        fi
        if [ -f "$STATUS" ]; then
            break
        fi
        if [ -f "$HEALTHY" ]; then
            healthy=$(cat "$HEALTHY")
            case "$healthy" in
                "healthy:$PHASE:"*)
                    healthy_pid=${healthy##*:}
                    case "$healthy_pid" in ""|0|*[!0-9]*) healthy_pid=0 ;; esac
                    if [ "$healthy_pid" = 0 ] ||
                        [ "$healthy" != "healthy:$PHASE:$healthy_pid" ] ||
                        [ "$(systemctl show -p MainPID --value xochitl.service)" != "$healthy_pid" ] ||
                        ! file_is_exact_regular "$TARGET" "$expected_qmd_sha" ||
                        ! root_is_read_only; then
                        write_one_line "$STATUS" "failure:armed:post-health-change"
                        break
                    fi
                    ;;
                *)
                    write_one_line "$STATUS" "failure:armed:malformed-healthy"
                    break
                    ;;
            esac
        fi
        if ! systemctl is-active --quiet "$TXN_UNIT"; then
            sleep 1
            [ -f "$COMMIT" ] && continue
            write_one_line "$STATUS" "failure:armed:transaction-stopped"
            break
        fi
        count=$((count + 1))
        sleep 1
    done

    systemctl stop "$TXN_UNIT" >/dev/null 2>&1 || true
    if [ ! -f "$STATUS" ]; then
        write_one_line "$STATUS" "failure:armed:watchdog-timeout"
    fi
    if safe_stock \
        "$expected_stock_sha" \
        "$expected_service_conf_sha" \
        "$expected_xochitl_sha" \
        "$expected_unit_sha" \
        "$expected_stock_override_sha"; then
        terminal_cleanup
        exit 0
    fi
    # ARMED and the global lock deliberately remain for a systemd restart to
    # retry recovery. Never report terminal success after incomplete stock.
    write_one_line "$STATUS" "failure:rollback:incomplete"
    exit 1
}

acknowledge_main() {
    expected_qmd_sha=${4:?expected qmd sha required}
    expected_pid=${5:?expected pid required}
    case "$expected_qmd_sha" in *[!0-9a-f]*) exit 2 ;; esac
    [ "${#expected_qmd_sha}" -eq 64 ]
    case "$expected_pid" in ""|0|*[!0-9]*) exit 2 ;; esac
    lock_is_owned
    [ -f "$HEALTHY" ]
    [ "$(cat "$HEALTHY")" = "healthy:$PHASE:$expected_pid" ]
    [ ! -f "$STATUS" ]
    systemctl is-active --quiet "$WATCHDOG_UNIT"
    file_is_exact_regular "$TARGET" "$expected_qmd_sha"
    root_is_read_only
    sleep 5
    [ "$(systemctl show -p MainPID --value xochitl.service)" = "$expected_pid" ]
    systemctl is-active --quiet xochitl.service
    xovi_process_is_exact "$expected_pid"
    file_is_exact_regular "$TARGET" "$expected_qmd_sha"
    root_is_read_only
    [ ! -f "$STATUS" ]
    write_one_line "$ACK" "ack:$PHASE:$expected_pid"
}

load_allowlist() {
    allowlist=$1
    seen=" "
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            ""|\#*) continue ;;
            [A-Z0-9_]*=*) ;;
            *) return 1 ;;
        esac
        key=${line%%=*}
        value=${line#*=}
        case "$key" in
            DEVICE_SERIAL|FIRMWARE_VERSION|FIRMWARE_BUILD|XOCHITL_SHA256|XOCHITL_BUILD_ID|\
            HASHTAB_SHA256|XOVI_SHA256|QRR_SHA256|MESSAGE_BROKER_SHA256|APPLOAD_SHA256|\
            STOCK_SCRIPT_SHA256|XOVI_XOCHITL_SERVICE_CONF_SHA256|\
            ACTIVE_XOVI_DROPIN_SHA256|XOCHITL_UNIT_SHA256|XOCHITL_STOCK_OVERRIDE_SHA256|\
            SCENE_SELECTION_HANDLER_RESOURCE_HASH|SELECTION_CONTEXTUAL_MENU_RESOURCE_HASH|\
            PEN_LAYER_MEMORY_QMD_SHA256|QUICK_SETTINGS_TIMER_QMD_SHA256|\
            BETTER_TOC_QMD_SHA256|BETTER_TOC_COLLAPSE_QMD_SHA256|\
            GESTIK_QMD_SHA256|GHOSTBUSTER_QMD_SHA256|TOC_FROM_SELECTION_QMD_SHA256|\
            PREVIOUS_BUTTON_QMD_SHA256|SOURCE_QMD_SHA256|BUTTON_QMD_SHA256|INERT_SOURCE_QMD_SHA256|\
            INERT_BUTTON_QMD_SHA256) ;;
            *) return 1 ;;
        esac
        case "$value" in ""|*[!A-Za-z0-9._-]*) return 1 ;; esac
        case "$seen" in *" $key "*) return 1 ;; esac
        seen="$seen$key "
        printf -v "$key" '%s' "$value"
    done <"$allowlist"
    for key in \
        DEVICE_SERIAL FIRMWARE_VERSION FIRMWARE_BUILD XOCHITL_SHA256 XOCHITL_BUILD_ID \
        HASHTAB_SHA256 XOVI_SHA256 QRR_SHA256 MESSAGE_BROKER_SHA256 APPLOAD_SHA256 \
        STOCK_SCRIPT_SHA256 XOVI_XOCHITL_SERVICE_CONF_SHA256 \
        ACTIVE_XOVI_DROPIN_SHA256 XOCHITL_UNIT_SHA256 XOCHITL_STOCK_OVERRIDE_SHA256 \
        SCENE_SELECTION_HANDLER_RESOURCE_HASH SELECTION_CONTEXTUAL_MENU_RESOURCE_HASH \
        PEN_LAYER_MEMORY_QMD_SHA256 QUICK_SETTINGS_TIMER_QMD_SHA256 \
        BETTER_TOC_QMD_SHA256 BETTER_TOC_COLLAPSE_QMD_SHA256 \
        GESTIK_QMD_SHA256 GHOSTBUSTER_QMD_SHA256 TOC_FROM_SELECTION_QMD_SHA256 \
        PREVIOUS_BUTTON_QMD_SHA256 SOURCE_QMD_SHA256 BUTTON_QMD_SHA256 INERT_SOURCE_QMD_SHA256 \
        INERT_BUTTON_QMD_SHA256
    do
        case "$seen" in *" $key "*) ;; *) return 1 ;; esac
        eval "value=\${$key-}"
        [ -n "$value" ] || return 1
    done
}

install_main() {
    archive_sha=${4:?archive sha required}
    confirmation=${5:?confirmation required}
    case "$archive_sha" in *[!0-9a-f]*) exit 2 ;; esac
    [ "${#archive_sha}" -eq 64 ]
    if [ "$PHASE" = inert ]; then
        [ "$confirmation" = none ]
    else
        [[ "$confirmation" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]]
    fi

    ARMED_WRITTEN=0
    COMMITTED_WRITTEN=0
    on_exit() {
        rc=$?
        trap - EXIT HUP INT TERM
        if [ "$rc" -ne 0 ] && [ "$COMMITTED_WRITTEN" -eq 0 ]; then
            if [ "$ARMED_WRITTEN" -eq 1 ] || [ -f "$ARMED" ]; then
                write_one_line "$STATUS" "failure:armed:$rc" || true
            else
                write_one_line "$STATUS" "failure:prearm:$rc" || true
            fi
        fi
        exit "$rc"
    }
    trap on_exit EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    [ -f "$ARCHIVE" ]
    [ ! -L "$ARCHIVE" ]
    [ "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" = "$archive_sha" ]
    [ "$(tar -tf "$ARCHIVE")" = "$(printf 'compatibility.env\nbutton.qmd')" ]

    ensure_private_dir "$RECOVERY_BASE"
    ensure_private_dir "$RECOVERY_ROOT"
    [ ! -e "$RECOVERY" ] && [ ! -L "$RECOVERY" ]
    mkdir "$RECOVERY"
    chown root:root "$RECOVERY"
    chmod 0700 "$RECOVERY"
    STAGE="$RECOVERY/stage"
    mkdir "$STAGE"
    chown root:root "$STAGE"
    chmod 0700 "$STAGE"
    tar -xf "$ARCHIVE" -C "$STAGE"
    ALLOWLIST="$STAGE/compatibility.env"
    BUTTON="$STAGE/button.qmd"
    chown root:root "$ALLOWLIST" "$BUTTON"
    chmod 0600 "$ALLOWLIST"
    chmod 0644 "$BUTTON"
    [ -f "$ALLOWLIST" ] && [ ! -L "$ALLOWLIST" ]
    [ -f "$BUTTON" ] && [ ! -L "$BUTTON" ]
    load_allowlist "$ALLOWLIST"

    case "$DEVICE_SERIAL" in *[!0-9A-F]*) exit 2 ;; esac
    [ "${#DEVICE_SERIAL}" -eq 16 ]
    case "$XOCHITL_BUILD_ID" in *[!0-9a-f]*) exit 2 ;; esac
    [ "${#XOCHITL_BUILD_ID}" -eq 40 ]
    for value in \
        "$XOCHITL_SHA256" "$HASHTAB_SHA256" "$XOVI_SHA256" "$QRR_SHA256" \
        "$MESSAGE_BROKER_SHA256" "$APPLOAD_SHA256" "$STOCK_SCRIPT_SHA256" \
        "$XOVI_XOCHITL_SERVICE_CONF_SHA256" "$ACTIVE_XOVI_DROPIN_SHA256" \
        "$XOCHITL_UNIT_SHA256" "$XOCHITL_STOCK_OVERRIDE_SHA256" \
        "$PEN_LAYER_MEMORY_QMD_SHA256" "$QUICK_SETTINGS_TIMER_QMD_SHA256" \
        "$BETTER_TOC_QMD_SHA256" "$BETTER_TOC_COLLAPSE_QMD_SHA256" \
        "$GESTIK_QMD_SHA256" "$GHOSTBUSTER_QMD_SHA256" "$TOC_FROM_SELECTION_QMD_SHA256" \
        "$PREVIOUS_BUTTON_QMD_SHA256" \
        "$SOURCE_QMD_SHA256" "$BUTTON_QMD_SHA256" \
        "$INERT_SOURCE_QMD_SHA256" "$INERT_BUTTON_QMD_SHA256"
    do
        case "$value" in *[!0-9a-f]*) exit 2 ;; esac
        [ "${#value}" -eq 64 ]
    done

    if [ "$PHASE" = inert ] || [ "$PHASE" = refresh-inert ]; then
        EXPECTED_BUTTON_SHA=$INERT_BUTTON_QMD_SHA256
    else
        EXPECTED_BUTTON_SHA=$BUTTON_QMD_SHA256
    fi
    [ "$(sha256sum "$BUTTON" | cut -d' ' -f1)" = "$EXPECTED_BUTTON_SHA" ]

    # Complete fresh fingerprint.
    [ "$(serial_number)" = "$DEVICE_SERIAL" ]
    [ "$(firmware_version)" = "$FIRMWARE_VERSION" ]
    [ "$(firmware_build)" = "$FIRMWARE_BUILD" ]
    file_is_exact_regular "$XOCHITL" "$XOCHITL_SHA256"
    file_is_exact_regular "$XOVI" "$XOVI_SHA256"
    file_is_exact_regular "$QRR" "$QRR_SHA256"
    file_is_exact_regular "$BROKER" "$MESSAGE_BROKER_SHA256"
    file_is_exact_regular "$APPLOAD" "$APPLOAD_SHA256"
    file_is_exact_regular "$HASHTAB" "$HASHTAB_SHA256"
    stock_inputs_are_exact \
        "$STOCK_SCRIPT_SHA256" \
        "$XOVI_XOCHITL_SERVICE_CONF_SHA256" \
        "$XOCHITL_UNIT_SHA256" \
        "$XOCHITL_STOCK_OVERRIDE_SHA256"
    active_dropins_are_exact \
        "$XOVI_XOCHITL_SERVICE_CONF_SHA256" \
        "$ACTIVE_XOVI_DROPIN_SHA256" \
        "$XOCHITL_UNIT_SHA256" \
        "$XOCHITL_STOCK_OVERRIDE_SHA256"
    extensions_are_exact
    mod_files_are_exact "$PHASE"
    [ -f "$APP_MANIFEST" ] && [ ! -L "$APP_MANIFEST" ]
    grep -Fq '"id": "smart-remarkable"' "$APP_MANIFEST"
    root_is_read_only
    [ "$(systemctl show -p FragmentPath --value xochitl.service)" = /usr/lib/systemd/system/xochitl.service ]
    systemctl is-active --quiet xochitl.service
    for unit in \
        riddle-takeover.service \
        smart-remarkable-once.service \
        smart-remarkable-session.service
    do
        if systemctl is-active --quiet "$unit"; then
            echo "Refusing canary while $unit is active" >&2
            exit 1
        fi
    done
    if smart_process_running; then
        echo "Refusing canary while smart_remarkable is running" >&2
        exit 1
    fi
    lock_is_owned

    BASE_PID=$(systemctl show -p MainPID --value xochitl.service)
    case "$BASE_PID" in ""|0|*[!0-9]*) exit 1 ;; esac
    [ "$(readlink -f "/proc/$BASE_PID/exe")" = "$XOCHITL" ]
    xovi_process_is_exact "$BASE_PID"
    BASE_NRESTARTS=$(systemctl show -p NRestarts --value xochitl.service)
    case "$BASE_NRESTARTS" in ""|*[!0-9]*) exit 1 ;; esac
    set -- $(proc_stats "$BASE_PID")
    BASE_RSS=$1
    BASE_THREADS=$2
    [ "$BASE_RSS" -le 1258291 ]
    [ "$BASE_THREADS" -le 256 ]

    if [ "$PHASE" = inert ]; then
        [ ! -e "$TARGET" ] && [ ! -L "$TARGET" ]
        printf '%s\n' PREVIOUS_STATE=absent >"$RECOVERY/previous-state"
    elif [ "$PHASE" = functional ]; then
        file_is_exact_regular "$TARGET" "$INERT_BUTTON_QMD_SHA256"
        [ "$(stat -c %a "$TARGET")" = 644 ]
        INERT_MARKER="$RECOVERY_ROOT/inert-qualified"
        [ -f "$INERT_MARKER" ] && [ ! -L "$INERT_MARKER" ]
        [ "$(stat -c %u:%g:%a "$INERT_MARKER")" = 0:0:600 ]
        grep -Fqx "DEVICE_SERIAL=$DEVICE_SERIAL" "$INERT_MARKER"
        grep -Fqx "FIRMWARE_VERSION=$FIRMWARE_VERSION" "$INERT_MARKER"
        grep -Fqx "QMD_SHA256=$INERT_BUTTON_QMD_SHA256" "$INERT_MARKER"
        grep -Fqx "TRANSACTION_ID=$confirmation" "$INERT_MARKER"
        cp "$TARGET" "$RECOVERY/previous-inert.qmd"
        chown root:root "$RECOVERY/previous-inert.qmd"
        chmod 0600 "$RECOVERY/previous-inert.qmd"
        printf '%s\n' PREVIOUS_STATE=inert >"$RECOVERY/previous-state"
    elif [ "$PHASE" = refresh-inert ]; then
        file_is_exact_regular "$TARGET" "$PREVIOUS_BUTTON_QMD_SHA256"
        [ "$(stat -c %a "$TARGET")" = 644 ]
        # A refresh may follow either the original functional promotion or a
        # later refresh-functional promotion. Historical markers are retained
        # for recovery, so bind this transaction to exactly one marker whose
        # complete device/QMD identity and transaction id match the supplied
        # confirmation.
        FUNCTIONAL_MARKER_MATCHES=0
        for FUNCTIONAL_MARKER in \
            "$RECOVERY_ROOT/functional-qualified" \
            "$RECOVERY_ROOT/refresh-functional-qualified"
        do
            if [ -e "$FUNCTIONAL_MARKER" ] || [ -L "$FUNCTIONAL_MARKER" ]; then
                [ -f "$FUNCTIONAL_MARKER" ] && [ ! -L "$FUNCTIONAL_MARKER" ]
                [ "$(stat -c %u:%g:%a "$FUNCTIONAL_MARKER")" = 0:0:600 ]
                if grep -Fqx "DEVICE_SERIAL=$DEVICE_SERIAL" "$FUNCTIONAL_MARKER" &&
                    grep -Fqx "FIRMWARE_VERSION=$FIRMWARE_VERSION" "$FUNCTIONAL_MARKER" &&
                    grep -Fqx "FIRMWARE_BUILD=$FIRMWARE_BUILD" "$FUNCTIONAL_MARKER" &&
                    grep -Fqx "XOCHITL_SHA256=$XOCHITL_SHA256" "$FUNCTIONAL_MARKER" &&
                    grep -Fqx "QMD_SHA256=$PREVIOUS_BUTTON_QMD_SHA256" "$FUNCTIONAL_MARKER" &&
                    grep -Fqx "TRANSACTION_ID=$confirmation" "$FUNCTIONAL_MARKER"; then
                    FUNCTIONAL_MARKER_MATCHES=$((FUNCTIONAL_MARKER_MATCHES + 1))
                fi
            fi
        done
        [ "$FUNCTIONAL_MARKER_MATCHES" -eq 1 ]
        cp "$TARGET" "$RECOVERY/previous-functional.qmd"
        chown root:root "$RECOVERY/previous-functional.qmd"
        chmod 0600 "$RECOVERY/previous-functional.qmd"
        printf '%s\n' PREVIOUS_STATE=functional >"$RECOVERY/previous-state"
    else
        file_is_exact_regular "$TARGET" "$INERT_BUTTON_QMD_SHA256"
        [ "$(stat -c %a "$TARGET")" = 644 ]
        REFRESH_INERT_MARKER="$RECOVERY_ROOT/refresh-inert-qualified"
        [ -f "$REFRESH_INERT_MARKER" ] && [ ! -L "$REFRESH_INERT_MARKER" ]
        [ "$(stat -c %u:%g:%a "$REFRESH_INERT_MARKER")" = 0:0:600 ]
        grep -Fqx "DEVICE_SERIAL=$DEVICE_SERIAL" "$REFRESH_INERT_MARKER"
        grep -Fqx "FIRMWARE_VERSION=$FIRMWARE_VERSION" "$REFRESH_INERT_MARKER"
        grep -Fqx "FIRMWARE_BUILD=$FIRMWARE_BUILD" "$REFRESH_INERT_MARKER"
        grep -Fqx "XOCHITL_SHA256=$XOCHITL_SHA256" "$REFRESH_INERT_MARKER"
        grep -Fqx "QMD_SHA256=$INERT_BUTTON_QMD_SHA256" "$REFRESH_INERT_MARKER"
        grep -Fqx "TRANSACTION_ID=$confirmation" "$REFRESH_INERT_MARKER"
        cp "$TARGET" "$RECOVERY/previous-refresh-inert.qmd"
        chown root:root "$RECOVERY/previous-refresh-inert.qmd"
        chmod 0600 "$RECOVERY/previous-refresh-inert.qmd"
        printf '%s\n' PREVIOUS_STATE=refresh-inert >"$RECOVERY/previous-state"
    fi
    chown root:root "$RECOVERY/previous-state"
    chmod 0600 "$RECOVERY/previous-state"

    temporary=$PREPARED_TMP
    [ ! -e "$temporary" ] && [ ! -L "$temporary" ]
    cp "$BUTTON" "$temporary"
    chown root:root "$temporary"
    chmod 0644 "$temporary"
    [ "$(sha256sum "$temporary" | cut -d' ' -f1)" = "$EXPECTED_BUTTON_SHA" ]

    # Last pre-mutation guardian check, then atomically persist ARMED before the
    # QMD rename. Any kill from this point is recoverable by the watchdog.
    systemctl is-active --quiet "$WATCHDOG_UNIT"
    lock_is_owned
    [ -f "$WATCHDOG_READY" ] && [ ! -L "$WATCHDOG_READY" ]
    [ "$(stat -c %u:%g:%a "$WATCHDOG_READY")" = 0:0:600 ]
    grep -Fqx "ID=$ID" "$WATCHDOG_READY"
    grep -Fqx "QMD_SHA256=$EXPECTED_BUTTON_SHA" "$WATCHDOG_READY"
    [ ! -f "$STATUS" ]
    armed_tmp="$STATE_DIR/.$ID.armed.$$"
    {
        printf 'ID=%s\n' "$ID"
        printf 'QMD_SHA256=%s\n' "$EXPECTED_BUTTON_SHA"
    } >"$armed_tmp"
    chown root:root "$armed_tmp"
    chmod 0600 "$armed_tmp"
    mv "$armed_tmp" "$ARMED"
    sync
    ARMED_WRITTEN=1
    mv "$temporary" "$TARGET"
    sync

    START_EPOCH=$(date +%s)
    systemctl restart xochitl.service
    NEW_PID=$(wait_for_xochitl xovi)
    [ "$NEW_PID" != "$BASE_PID" ]
    POST_NRESTARTS=$(systemctl show -p NRestarts --value xochitl.service)
    [ "$POST_NRESTARTS" = "$BASE_NRESTARTS" ]

    QMD_LOADED=0
    count=0
    while [ "$count" -lt 15 ]; do
        if journalctl -u xochitl.service --since="@$START_EPOCH" --no-pager |
            grep -F '[qmldiff]: Loading file smart-remarkable-llm.qmd' >/dev/null; then
            QMD_LOADED=1
            break
        fi
        count=$((count + 1))
        sleep 1
    done
    [ "$QMD_LOADED" -eq 1 ]

    RSS_LIMIT=$((BASE_RSS + 196608))
    [ "$RSS_LIMIT" -le 1258291 ] || RSS_LIMIT=1258291
    THREAD_LIMIT=$((BASE_THREADS + 48))
    [ "$THREAD_LIMIT" -le 256 ] || THREAD_LIMIT=256
    count=0
    while [ "$count" -lt 10 ]; do
        sleep 3
        systemctl is-active --quiet xochitl.service
        [ "$(systemctl show -p MainPID --value xochitl.service)" = "$NEW_PID" ]
        [ "$(systemctl show -p NRestarts --value xochitl.service)" = "$POST_NRESTARTS" ]
        xovi_process_is_exact "$NEW_PID"
        set -- $(proc_stats "$NEW_PID")
        [ "$1" -le "$RSS_LIMIT" ]
        [ "$2" -le "$THREAD_LIMIT" ]
        root_is_read_only
        count=$((count + 1))
    done
    if journalctl -u xochitl.service --since="@$START_EPOCH" --no-pager |
        grep -Ei \
            'segfault|core dumped|dumped core|Failed with result|status=.*(SEGV|ABRT)|\[qmldiff\].*(Failed|Error|panic)|\[qt-resource-rebuilder\].*(terrible|Error|abort)' \
            >/dev/null; then
        exit 1
    fi

    marker_tmp="$RECOVERY_ROOT/.$PHASE-qualified.$$"
    {
        printf 'DEVICE_SERIAL=%s\n' "$DEVICE_SERIAL"
        printf 'FIRMWARE_VERSION=%s\n' "$FIRMWARE_VERSION"
        printf 'FIRMWARE_BUILD=%s\n' "$FIRMWARE_BUILD"
        printf 'XOCHITL_SHA256=%s\n' "$XOCHITL_SHA256"
        printf 'QMD_SHA256=%s\n' "$EXPECTED_BUTTON_SHA"
        printf 'TRANSACTION_ID=%s\n' "$ID"
        printf 'XOCHITL_PID=%s\n' "$NEW_PID"
    } >"$marker_tmp"
    chown root:root "$marker_tmp"
    chmod 0600 "$marker_tmp"
    mv -f "$marker_tmp" "$RECOVERY_ROOT/$PHASE-qualified"
    write_one_line "$HEALTHY" "healthy:$PHASE:$NEW_PID"

    count=0
    while [ "$count" -lt 45 ]; do
        if [ -f "$ACK" ] && [ "$(cat "$ACK")" = "ack:$PHASE:$NEW_PID" ]; then
            break
        fi
        systemctl is-active --quiet "$WATCHDOG_UNIT"
        [ ! -f "$STATUS" ]
        [ "$(systemctl show -p MainPID --value xochitl.service)" = "$NEW_PID" ]
        root_is_read_only
        count=$((count + 1))
        sleep 1
    done
    [ -f "$ACK" ]
    [ "$(cat "$ACK")" = "ack:$PHASE:$NEW_PID" ]
    [ ! -f "$STATUS" ]
    [ "$(systemctl show -p MainPID --value xochitl.service)" = "$NEW_PID" ]
    xovi_process_is_exact "$NEW_PID"
    file_is_exact_regular "$TARGET" "$EXPECTED_BUTTON_SHA"
    root_is_read_only

    commit_tmp="$STATE_DIR/.$ID.commit.$$"
    printf 'success:%s:%s\n' "$PHASE" "$NEW_PID" >"$commit_tmp"
    chown root:root "$commit_tmp"
    chmod 0600 "$commit_tmp"
    COMMITTED_WRITTEN=1
    mv "$commit_tmp" "$COMMIT"
    trap - EXIT HUP INT TERM
    exit 0
}

case "$ACTION" in
    watchdog) watchdog_main "$@" ;;
    acknowledge) acknowledge_main "$@" ;;
    install) install_main "$@" ;;
    *) echo "Invalid action" >&2; exit 2 ;;
esac
