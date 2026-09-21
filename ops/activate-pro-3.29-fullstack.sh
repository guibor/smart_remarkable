#!/bin/bash
# Exact Ferrari activation only: file publication belongs to the maintenance
# transaction. No package install, root remount, boot hook, notebook or server edit.
set -Eeuo pipefail
umask 077
ACTION=${1:-}; STAGE=${2:-}; REVIEWED=${3:-}; ID=${4:-}
case "$ACTION" in prepare|activate|commit|watchdog) ;; *) exit 2;; esac
[[ "$ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || exit 2
[[ "$REVIEWED" =~ ^[a-f0-9]{64}$ ]] || exit 2
[ "$STAGE" = "/home/root/.codex-staging/pro329-apps-$ID" ] || exit 2
X=/home/root/xovi
Q=$X/exthome/qt-resource-rebuilder
EXT=$X/extensions.d
DATES=/home/root/.local/lib/notebook-date-index
DATA=/home/root/.local/share/notebook-date-index
STATE=/home/root/.codex-backups/pro329-apps-$ID
OWNER=pro329-apps-install-$ID.service
WATCH=pro329-apps-watchdog-$ID.service
DROP=/run/systemd/system/xochitl.service.d/zzzz-pro329-apps-$ID.conf
UNIT=/run/systemd/system/xochitl.service
VENDOR=/run/systemd/system/xochitl.service.d/xochitl-service-override.conf
LOCK=/run/pro329-apps-activation.lock
MAX_SECONDS=180

hash() { sha256sum "$1" | cut -d' ' -f1; }
exact() {
    [ -f "$1" ] && [ ! -L "$1" ] && [ "$(readlink -f "$1")" = "$1" ] || return 1
    [ "$(hash "$1")" = "$2" ]
}
private_dir() {
    [ -d "$1" ] && [ ! -L "$1" ] && [ "$(readlink -f "$1")" = "$1" ] || return 1
    [ "$(stat -c %u:%g:%a "$1")" = 0:0:700 ]
}
mark() { printf '%s\n' "$2" >"$STATE/.$$.marker"; mv "$STATE/.$$.marker" "$STATE/$1"; }
root_ro() { [ "$(findmnt -n -o OPTIONS / | tr ',' '\n' | grep -c '^ro$')" = 1 ]; }
read_pid() { systemctl show -p MainPID --value "$1"; }
pid_start() { awk '{print $22}' "/proc/$1/stat"; }
names() {
    local p
    for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do
        [ -e "$p" ] || [ -L "$p" ] || continue
        printf '%s\n' "${p##*/}"
    done | sort
}
qmd_names() {
    local name
    while IFS= read -r name; do
        case "$name" in *.qmd|*.qrr|*.rcc) printf '%s\n' "$name";; esac
    done < <(names "$Q")
}
verify_stage() {
    private_dir "$STAGE"
    [ "$(names "$STAGE")" = "$(printf '%s\n' SHA256SUMS activate.sh qmd.sha256 | sort)" ]
    exact "$STAGE/SHA256SUMS" "$REVIEWED"
    [ "$(awk 'NF==2 {print $2}' "$STAGE/SHA256SUMS" | sort)" = "$(printf '%s\n' activate.sh qmd.sha256 | sort)" ]
    [ "$(wc -l <"$STAGE/SHA256SUMS")" -eq 2 ]
    (cd "$STAGE" && sha256sum -c SHA256SUMS) >/dev/null
    [ "$(find "$STAGE" -type l | wc -l)" -eq 0 ]
    [ "$(stat -c %u:%g:%a "$STAGE/activate.sh")" = 0:0:700 ]
    [ "$(stat -c %u:%g:%a "$STAGE/qmd.sha256")" = 0:0:600 ]
    [ "$(stat -c %u:%g:%a "$STAGE/SHA256SUMS")" = 0:0:600 ]
    # Manifest content is additionally pinned in the reviewed script below.
    exact "$STAGE/qmd.sha256" 6dadc2f4a6317c7a3edf32b4535c2a35afdd562b58ff08aa6b1421a18b0b932a
}
verify_device() {
    [ "$(tr -d '\r\n' </sys/devices/soc0/machine)" = 'reMarkable Ferrari' ] || return 1
    [ "$(hash /sys/devices/soc0/serial_number)" = 106f4d0672a9c180cdb151938872747026d6d39ab56fd73ed01c814ed0ff8d38 ] || return 1
    grep -Fxq 'IMG_VERSION="3.29.0.148"' /etc/os-release || return 1
    [ "$(tr -d '[:space:]' </etc/version)" = 20260911125116 ] || return 1
    exact /usr/bin/xochitl 4f433281c71a29d07921665b4724420735f3c88aceb431067f3a432b3f89f6a4 || return 1
    exact /usr/lib/systemd/system/xochitl.service 23f537cf59d527bfbf4823f372385d613e1ade0961c98831c935a372018f9566 || return 1
    exact /usr/lib/systemd/system/xochitl.service.d/xochitl-service-override.conf a9432caffacb29d6fcb35136dcc3cb43d8737eb6c2efcb35ea335725f42082d1 || return 1
    root_ro
}
verify_files() {
    exact "$X/xovi.so" d4df820c25c634c511de11067279d8310fa4f656dc52bd4540db6beac4ffd446
    exact "$EXT/qt-resource-rebuilder.so" 6726f561557406f36347e43fc2b44a88deef4fb273d2ece88f48f427dad8800f
    exact "$EXT/xovi-message-broker.so" 61c0c7b0d4e2c7623147a87c63d6a4aaec868019e67fb0e1bdb1fcb215f6e155
    exact "$EXT/appload.so" 5b2dd6c066da6932d88a1d62be1068ca5ba751f481636dd51f727221db62e3ad
    exact "$EXT/framebuffer-spy.so" 0a999dffbcb4026b59d6626a15360ef9388747448fdeeb97e4dab155425e3e1e
    local entry
    while IFS= read -r entry; do
        case "$entry" in
            appload.so|framebuffer-spy.so|qt-resource-rebuilder.so|xovi-message-broker.so) ;;
            ._appload.so|._qt-resource-rebuilder.so|._xovi-message-broker.so)
                exact "$EXT/$entry" a502dbe0e569c3718c449b86480d0cd4cdc23e3a450814de360e5b0a5e08c5d3 ;;
            *) return 1;;
        esac
    done < <(names "$EXT")
    exact "$Q/hashtab" 1f2a0f7177dac3cdfc030ff32b4643170dd2ef6e2f6c6369b4c4168513ce01f0
    [ "$(readlink -f "$Q")" = "$Q" ] && [ ! -L "$Q" ]
    (cd "$Q" && sha256sum -c "$STAGE/qmd.sha256") >/dev/null
    [ "$(qmd_names)" = "$(awk '{print $2}' "$STAGE/qmd.sha256" | sort)" ]
    while read -r expected name; do exact "$Q/$name" "$expected"; done <"$STAGE/qmd.sha256"
    exact "$DATES/notebook-date-index" 445f532f18a7bf26d429aff0a481ab02ea3b74bef9b73f956f9b5ad77a09f979
    exact "$DATES/DatesPanel.qml" 5280822baf8891bfb3f091d4c598f03413cc78373b76761eebe2fc133517b23a
    exact "$DATES/DateTree.js" 336c47e7f619734214467b9f30e5324b82deeccae4977106bf8c64310f1e87dd
    exact /home/root/.local/lib/rmstream-shortcut/ScreenSharing.qml bc453c77f41e04778642bdaa15db590f5a43021cd17a99486be1fd2b422ea149
    exact /home/root/.local/lib/remarkable-dispatch-shortcut/DispatchLauncher.qml 6f4280660a519c2a36a84f26dc3109cd50f59022a759974a9ce0ceff7bb53077
    exact "$X/exthome/appload/remarkable-dispatch/remarkable-dispatch" f9896596941caa77ae9a1ba88da8e1ca09cc4f08f0f52560b800b54efe8875cc
    exact "$X/exthome/appload/remarkable-dispatch/external.manifest.json" 4c0b0adba890becb4aa85678c3dc345a9d8909f65a5b9734b809b4746341a32c
    exact "$X/exthome/appload/smart-remarkable/smart_remarkable" 4c9605f7f9e6be898230c3c5d607fa36fc1ce815ad85cc8f6f04e625be314f1e
    private_dir "$DATA"
    for p in settings.json token sync.json; do
        [ -f "$DATA/$p" ] && [ ! -L "$DATA/$p" ]
        [ "$(stat -c %u:%g:%a "$DATA/$p")" = 0:0:600 ]
    done
    [ "$(find "$DATA" -type l | wc -l)" -eq 0 ]
    [ "$(readlink "$X/services/xochitl.service/extensions.d")" = "$EXT" ]
    [ "$(readlink "$X/services/xochitl.service/exthome")" = "$X/exthome" ]
    exact "$X/services/xochitl.service/qt-resource-rebuilder.conf" 6036f7776f8775529f94056fafe066ff373f5aa6bca39633bfd4dabfc1552ffd
}
settings_snapshot() {
    sha256sum /home/root/.config/gestik.json /home/root/.local/share/gestik-beta/gestik.json \
        "$DATA/settings.json" "$DATA/token" "$DATA/sync.json" \
        "$X/exthome/appload/remarkable-dispatch/settings.env"
    # Capture private configuration hashes only; never print their contents.
    for p in "$X/exthome/appload/smart-remarkable/.env" /home/root/.config/smart-remarkable/settings.conf \
        /home/root/.ssh/id_dropbear_smart_remarkable_bridge /home/root/.ssh/known_hosts; do
        [ ! -e "$p" ] || sha256sum "$p"
    done
}
no_app_running() {
    local p resolved
    for p in /proc/[0-9]*/exe; do
        [ -L "$p" ] || continue
        resolved=$(readlink -f "$p" 2>/dev/null || true)
        case "$resolved" in
            */smart_remarkable|*/riddle|*/remarkable-dispatch|*/rmstream|"$X/exthome/appload/rmstream/"*) return 1;;
        esac
    done
}
stock_process() {
    # Explicit returns matter: rollback calls this function in an AND-list,
    # where Bash deliberately disables errexit inside the whole function.
    systemctl is-active --quiet xochitl.service || return 1
    local p; p=$(read_pid xochitl.service) || return 1
    [[ "$p" =~ ^[1-9][0-9]*$ ]] || return 1
    [ "$(readlink -f "/proc/$p/exe")" = /usr/bin/xochitl ] || return 1
    [ -r "/proc/$p/maps" ] && [ -r "/proc/$p/environ" ] || return 1
    ! grep -Fq "$X/xovi.so" "/proc/$p/maps" || return 1
    ! tr '\0' '\n' <"/proc/$p/environ" | grep -q '^LD_PRELOAD=.' || return 1
    [ "$(systemctl show -p NRestarts --value xochitl.service)" = 0 ]
}
candidate_process() {
    systemctl is-active --quiet xochitl.service
    systemctl is-active --quiet notebook-date-index.service
    local p item; p=$(read_pid xochitl.service); [[ "$p" =~ ^[1-9][0-9]*$ ]]
    [ "$(readlink -f "/proc/$p/exe")" = /usr/bin/xochitl ]
    for item in "$X/xovi.so" "$EXT/qt-resource-rebuilder.so" "$EXT/appload.so" "$EXT/xovi-message-broker.so" "$EXT/framebuffer-spy.so"; do
        awk -v expected="$item" '$NF == expected {found=1} END {exit !found}' "/proc/$p/maps"
    done
    [ "$(systemctl show -p NRestarts --value xochitl.service)" = 0 ]
    verify_runtime_policy candidate
    [ "$(systemctl show -p NRestarts --value notebook-date-index.service)" = 0 ]
    local d; d=$(read_pid notebook-date-index.service)
    [ "$(readlink -f "/proc/$d/exe")" = "$DATES/notebook-date-index" ]
    [ "$(tr '\0' '\n' <"/proc/$d/cmdline" | wc -l)" -eq 1 ]
}
verify_log() {
    [ "$(grep -Ec '\[qmldiff\]: Loading file [^ ]+\.qmd$' "$STATE/xochitl.log")" -eq 11 ]
    local name
    while read -r _ name; do
        [ "$(grep -Fc "[qmldiff]: Loading file $name" "$STATE/xochitl.log")" -eq 1 ]
    done <"$STAGE/qmd.sha256"
    ! grep -Eiq 'Failed to load file|ReferenceError|TypeError|is not a type|Cannot assign|QQmlComponent: Component is not ready|Binding loop' "$STATE/xochitl.log"
}
no_other_owner() {
    local units
    units=$(systemctl list-units --type=service --type=timer --state=active,activating,deactivating --no-legend --plain | awk '{print $1}')
    ! printf '%s\n' "$units" | grep -Ev "^($OWNER|$WATCH)$" | grep -Eq '^(remagic-live|remarkable-beta-os-(hashtab|pro-bettertoc)|smart-remarkable-llm|dates-.*-(install|rollback)|dispatch-.*-(install|rollback)|notebook-ui-repair|rmstream-shortcut-(install|rollback))'
}
absent() { [ ! -e "$1" ] && [ ! -L "$1" ]; }
baseline_policy() {
    absent "$UNIT" && absent "$VENDOR" && absent "$DROP" || return 1
    [ "$(systemctl show -p FragmentPath --value xochitl.service)" = /usr/lib/systemd/system/xochitl.service ] || return 1
    [ "$(systemctl show -p DropInPaths --value xochitl.service)" = /usr/lib/systemd/system/xochitl.service.d/xochitl-service-override.conf ]
}
render_mode() {
    case "$1" in candidate|stock) ;; *) return 1;; esac
    # OnFailure is a dependency: an empty assignment cannot remove it. The
    # pinned full unit AND same-basename vendor drop-in are shadowed below.
    printf '[Unit]\nOnFailureJobMode=replace\nStartLimitAction=none\n[Service]\nRestart=no\n'
    if [ "$1" = candidate ]; then
        printf 'Environment="LD_PRELOAD=%s/xovi.so" "XOVI_ROOT=%s/services/xochitl.service/" "QML_DISABLE_DISK_CACHE=1"\n' "$X" "$X"
        printf 'StandardOutput=append:%s/xochitl.log\nStandardError=append:%s/xochitl.log\n' "$STATE" "$STATE"
    else
        printf 'UnsetEnvironment=LD_PRELOAD XOVI_ROOT QMLDIFF_HASHTAB_CREATE\n'
    fi
}
make_policy_sources() {
    # Only these two pinned OnFailure lines change; preserve all other bytes,
    # including stock ExecStart, GPU/TEE dependencies and allocator settings.
    sed '/^[[:space:]]*OnFailure[[:space:]]*=/d' /usr/lib/systemd/system/xochitl.service >"$STATE/unit.shadow"
    sed '/^[[:space:]]*OnFailure[[:space:]]*=/d' /usr/lib/systemd/system/xochitl.service.d/xochitl-service-override.conf >"$STATE/vendor.shadow"
    render_mode candidate >"$STATE/policy-candidate.conf"
    render_mode stock >"$STATE/policy-stock.conf"
    verify_policy_sources
}
verify_policy_sources() {
    exact "$STATE/unit.shadow" 0cbc768bc2b28a15992e11185538c9ae7ce496fb354a75ab112ddd7f646ca863 || return 1
    exact "$STATE/vendor.shadow" 9b9b319cc0c9173bcfee48ed9210937d292f4a8cea5e26011e5d23ee624af83c || return 1
    local mode expected
    for mode in stock candidate; do
        expected=$(render_mode "$mode" | sha256sum | cut -d' ' -f1) || return 1
        exact "$STATE/policy-$mode.conf" "$expected" || return 1
    done
}
owned_or_absent() {
    absent "$1" && return 0
    case "$1" in
        "$UNIT") exact "$UNIT" 0cbc768bc2b28a15992e11185538c9ae7ce496fb354a75ab112ddd7f646ca863;;
        "$VENDOR") exact "$VENDOR" 9b9b319cc0c9173bcfee48ed9210937d292f4a8cea5e26011e5d23ee624af83c;;
        "$DROP") exact "$DROP" "$(hash "$STATE/policy-candidate.conf")" || exact "$DROP" "$(hash "$STATE/policy-stock.conf")";;
        *) return 1;;
    esac
}
publish_owned() {
    local source=$1 target=$2 temporary=$2.pro329-$ID.ready.$$
    owned_or_absent "$target"
    absent "$temporary"
    cp "$source" "$temporary"
    chown root:root "$temporary"; chmod 0644 "$temporary"
    exact "$temporary" "$(hash "$source")"
    owned_or_absent "$target"
    mv -f "$temporary" "$target"
}
verify_runtime_policy() {
    verify_policy_sources || return 1
    exact "$UNIT" 0cbc768bc2b28a15992e11185538c9ae7ce496fb354a75ab112ddd7f646ca863 || return 1
    exact "$VENDOR" 9b9b319cc0c9173bcfee48ed9210937d292f4a8cea5e26011e5d23ee624af83c || return 1
    exact "$DROP" "$(hash "$STATE/policy-$1.conf")" || return 1
    [ "$(systemctl show -p FragmentPath --value xochitl.service)" = "$UNIT" ] || return 1
    [ "$(systemctl show -p DropInPaths --value xochitl.service)" = "$VENDOR $DROP" ] || return 1
    [ -z "$(systemctl show -p OnFailure --value xochitl.service)" ] || return 1
    [ "$(systemctl show -p Restart --value xochitl.service)" = no ]
}
write_policy() {
    local mode=$1
    verify_policy_sources
    owned_or_absent "$UNIT"; owned_or_absent "$VENDOR"; owned_or_absent "$DROP"
    mkdir -p /run/systemd/system/xochitl.service.d
    [ "$(readlink -f /run/systemd/system)" = /run/systemd/system ]
    [ "$(readlink -f /run/systemd/system/xochitl.service.d)" = /run/systemd/system/xochitl.service.d ]
    publish_owned "$STATE/unit.shadow" "$UNIT"
    publish_owned "$STATE/vendor.shadow" "$VENDOR"
    publish_owned "$STATE/policy-$mode.conf" "$DROP"
    systemctl daemon-reload
    # This is a real manager gate before any stop/restart, not a text assumption.
    verify_runtime_policy "$mode"
}
remove_owned_policy() {
    verify_policy_sources
    # Check every destination before removing any file. Never remove a foreign
    # file or symlink, even if an interrupted publication only reached one file.
    owned_or_absent "$UNIT"; owned_or_absent "$VENDOR"; owned_or_absent "$DROP"
    rm -f "$DROP" "$VENDOR" "$UNIT"
    systemctl daemon-reload
    baseline_policy
}
owner_alive() {
    local p start; read -r p start <"$STATE/owner"
    [ "$(read_pid "$OWNER")" = "$p" ] && [ -r "/proc/$p/stat" ] && [ "$(pid_start "$p")" = "$start" ]
}
decision_committed() {
    [ -f "$STATE/decision" ] && [ ! -L "$STATE/decision" ] &&
        [ -f "$STATE/ready" ] &&
        [ "$(cat "$STATE/decision")" = "commit:$ID:$(cat "$STATE/ready")" ]
}
rollback() {
    # A hard link publishes the complete decision atomically. There is no
    # crash window between claiming the decision and writing its contents.
    mark rollback-ready "rollback:$ID"
    if ! ln "$STATE/rollback-ready" "$STATE/decision" 2>/dev/null; then
        decision_committed && return 0
        [ -f "$STATE/decision" ] && [ ! -L "$STATE/decision" ] || return 1
        [ "$(cat "$STATE/decision")" = "rollback:$ID" ] || return 1
        [ ! -e "$STATE/rolled-back" ] || return 0
        # Only the single systemd watchdog may resume its own interrupted
        # rollback. No second writer or fresh decision is introduced.
    fi
    mark abort "$1"
    systemctl kill --kill-whom=all --signal=KILL "$OWNER" 2>/dev/null || true
    systemctl stop "$OWNER" 2>/dev/null || true
    # Always quiesce the transaction before changing its activation surface.
    [ "$(read_pid "$OWNER")" = 0 ] || return 1
    verify_device
    # A failed pre-restart gate may leave the original stock process untouched.
    # Recover the temporary policy directly; do not restart a healthy stock UI.
    if ! stock_process; then
        write_policy stock
        systemctl stop xochitl.service
        systemctl reset-failed xochitl.service
        systemctl start xochitl.service
        local n; for n in $(seq 1 30); do stock_process && break; sleep 1; done
    fi
    [ ! -e "$STATE/dates-started" ] || systemctl stop notebook-date-index.service
    stock_process
    # Remove only our three /run files, after stock is proved healthy.
    remove_owned_policy
    stock_process
    root_ro
    mark rolled-back "stock:$(read_pid xochitl.service)"
    rmdir "$LOCK" 2>/dev/null || true
}

verify_stage
verify_device
if [ "$ACTION" = prepare ]; then
    verify_files; stock_process; no_other_owner; no_app_running
    baseline_policy
    [ ! -e "$STATE" ] && [ ! -L "$STATE" ]
    ! systemctl is-active --quiet notebook-date-index.service
    ! pidof notebook-date-index >/dev/null
    mkdir -m 0700 "$STATE"
    make_policy_sources
    settings_snapshot >"$STATE/settings.sha256"
    tar -czf "$STATE/safety-backup.tgz" -C /home/root xovi/exthome/qt-resource-rebuilder \
        .local/lib/notebook-date-index .local/share/notebook-date-index \
        .local/lib/rmstream-shortcut .local/lib/remarkable-dispatch-shortcut
    tar -tzf "$STATE/safety-backup.tgz" >/dev/null
    mark prepared "$REVIEWED"
    sync
    printf 'recovery=%s\nbackup_sha256=%s\n' "$STATE" "$(hash "$STATE/safety-backup.tgz")"
    exit 0
fi
private_dir "$STATE"
[ "$(cat "$STATE/prepared")" = "$REVIEWED" ]
if [ "$ACTION" = watchdog ]; then
    [ "$(read_pid "$WATCH")" = "$$" ]
    attempts=0
    [ ! -e "$STATE/watchdog-attempts" ] || attempts=$(cat "$STATE/watchdog-attempts")
    [[ "$attempts" =~ ^[0-3]$ ]]
    if [ "$attempts" -ge 3 ]; then
        mark manual-intervention-required watchdog-retry-limit
        exit 0
    fi
    mark watchdog-attempts "$(( attempts + 1 ))"
    mark watchdog-ready ready
    if [ ! -e "$STATE/deadline" ]; then mark deadline "$(( $(date +%s) + MAX_SECONDS ))"; fi
    deadline=$(cat "$STATE/deadline"); [[ "$deadline" =~ ^[0-9]+$ ]]
    if [ -e "$STATE/decision" ]; then
        decision_committed && exit 0
        rollback watchdog-retry
        exit
    fi
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if decision_committed; then exit 0; fi
        if ! owner_alive; then rollback owner-died; exit; fi
        if [ -e "$STATE/abort-requested" ]; then rollback activation-failed; exit; fi
        sleep 1
    done
    rollback no-fresh-client-commit
    exit
fi
if [ "$ACTION" = commit ]; then
    [ -f "$STATE/ready" ] && [ ! -e "$STATE/abort" ]
    owner_alive; candidate_process; verify_files; verify_device; verify_log; no_app_running
    sha256sum -c "$STATE/settings.sha256" >/dev/null
    [ "$(read_pid xochitl.service)" = "$(cat "$STATE/ready")" ]
    mark commit-ready "commit:$ID:$(cat "$STATE/ready")"
    ln "$STATE/commit-ready" "$STATE/decision"
    # This single atomic link is the commit. It remains valid if the Mac's SSH
    # connection disappears before the following informational response.
    sync
    printf 'pro329_fullstack=committed recovery=%s\n' "$STATE"
    exit 0
fi
[ "$ACTION" = activate ]
[ "$(read_pid "$OWNER")" = "$$" ]
[ "$(systemctl show -p Type --value "$OWNER")" = exec ]
[ "$(systemctl show -p KillMode --value "$OWNER")" = control-group ]
[ "$(cat "$STATE/mac-backup-verified")" = "mac-backup:$(hash "$STATE/safety-backup.tgz")" ]
[ ! -e "$STATE/decision" ] && [ ! -e "$STATE/owner" ]
verify_files; stock_process; no_other_owner; no_app_running
! systemctl is-active --quiet notebook-date-index.service
! pidof notebook-date-index >/dev/null
sha256sum -c "$STATE/settings.sha256" >/dev/null
baseline_policy
mkdir "$LOCK"
mark owner "$$ $(pid_start $$)"
systemd-run --unit="${WATCH%.service}" --collect --property=Type=exec --property=KillMode=control-group \
    --property=Restart=on-failure --property=RestartSec=1 --property=RuntimeMaxSec=360 \
    /bin/bash "$STAGE/activate.sh" watchdog "$STAGE" "$REVIEWED" "$ID"
for n in $(seq 1 10); do [ ! -e "$STATE/watchdog-ready" ] || break; sleep 1; done
[ -e "$STATE/watchdog-ready" ]; systemctl is-active --quiet "$WATCH"
trap 'touch "$STATE/abort-requested"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
write_policy candidate
mark dates-started owned
systemd-run --unit=notebook-date-index --collect --property=Restart=on-failure --property=RestartSec=5 \
    --property=MemoryMax=96M --property=NoNewPrivileges=yes "$DATES/notebook-date-index"
systemctl reset-failed xochitl.service
systemctl restart xochitl.service
sleep 3
candidate_process
candidate_pid=$(read_pid xochitl.service)
for n in $(seq 1 30); do
    candidate_process
    [ "$(read_pid xochitl.service)" = "$candidate_pid" ]
    systemctl is-active --quiet "$WATCH"
    sleep 1
done
verify_log
verify_files; verify_device; no_app_running
sha256sum -c "$STATE/settings.sha256" >/dev/null
mark ready "$candidate_pid"
while ! decision_committed; do
    candidate_process
    [ "$(read_pid xochitl.service)" = "$candidate_pid" ]
    systemctl is-active --quiet "$WATCH"
    sleep 1
done
trap - EXIT HUP INT TERM
rmdir "$LOCK"
printf 'pro329_fullstack=active pid=%s recovery=%s\n' "$candidate_pid" "$STATE"
