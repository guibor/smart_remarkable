#!/bin/bash
# Mac-side controller for the exact Ferrari 3.28.0.169 Dispatch document-menu
# canary. It performs no device action unless --activate is explicitly present.
set -Eeuo pipefail
umask 077

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET=${1:-}
MODE_FLAG=${2:-}
CONFIRMATION=${3:-}
ACTIVATE=${4:-}
EXPECTED_HOST_FINGERPRINT=SHA256:dByHweKZkjDlZRBHdBisT5VD2kV85lClgtJExnDaTeE
SSH_KEY=${REMARKABLE_SSH_KEY:-$HOME/.ssh/id_ed25519_remarkable_new}

usage() {
    cat >&2 <<'USAGE'
usage:
  deploy-dispatch-document-menu-candidate.sh VERIFIED_IPV4 --inert --activate
  deploy-dispatch-document-menu-candidate.sh VERIFIED_IPV4 --functional \
    --confirm-inert-visible=INERT_TRANSACTION_ID --activate

Install the inert disabled row first. Promote the functional launcher only
after the inert Dispatch row is physically visible in notebook and PDF menus,
absent from EPUB, and the stock UI is stable.
USAGE
    exit 2
}

case "$MODE_FLAG" in
    --inert)
        MODE=inert
        [ "$CONFIRMATION" = --activate ] && [ -z "$ACTIVATE" ] || usage
        ;;
    --functional)
        MODE=functional
        case "$CONFIRMATION" in
            --confirm-inert-visible=*) INERT_ID=${CONFIRMATION#*=} ;;
            *) usage ;;
        esac
        [[ "$INERT_ID" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || usage
        [ "$ACTIVATE" = --activate ] || usage
        ;;
    *) usage ;;
esac
[[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
[ -f "$SSH_KEY" ] && [ ! -L "$SSH_KEY" ] || {
    echo "missing non-symlinked SSH key: $SSH_KEY" >&2
    exit 1
}

# Every local artifact/composition/runtime-harness/rollback simulation must
# pass before the first network packet is sent.
"$REPO/ops/dry-run-dispatch-document-menu-transaction.sh"

ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
LOCAL=$REPO/tmp/$ID
STAGE=/home/root/.codex-staging/dispatch-document-menu-$ID
RECOVERY=/home/root/.smart-remarkable-recovery/dispatch-document-menu/$ID
mkdir -p "$REPO/tmp"
[ -d "$REPO/tmp" ] && [ ! -L "$REPO/tmp" ] && [ "$(readlink -f "$REPO/tmp")" = "$REPO/tmp" ] || {
    echo "unsafe repository tmp directory" >&2
    exit 1
}
chmod 0700 "$REPO/tmp"
mkdir "$LOCAL"
chmod 0700 "$LOCAL"

cp "$REPO/xovi-qmd/dispatch-document-menu-3.28.0.169.baseline.sha256" "$LOCAL/baseline.sha256"
cp "$REPO/xovi-qmd/dispatch-document-menu-3.28.0.169.qmd" "$LOCAL/functional.qmd"
cp "$REPO/xovi-qmd/dispatch-document-menu-inert-3.28.0.169.qmd" "$LOCAL/inert.qmd"
cp "$REPO/qml/DispatchLauncher.qml" "$LOCAL/panel.qml"
cp "$REPO/ops/device-install-dispatch-document-menu-candidate.sh" "$LOCAL/device-install.sh"
cp "$REPO/ops/rollback-dispatch-document-menu-candidate.sh" "$LOCAL/rollback.sh"
chmod 0600 "$LOCAL/baseline.sha256" "$LOCAL/functional.qmd" "$LOCAL/inert.qmd" "$LOCAL/panel.qml"
chmod 0700 "$LOCAL/device-install.sh" "$LOCAL/rollback.sh"
(cd "$LOCAL" && shasum -a 256 \
    baseline.sha256 device-install.sh functional.qmd inert.qmd panel.qml rollback.sh >SHA256SUMS)
chmod 0600 "$LOCAL/SHA256SUMS"
(cd "$LOCAL" && shasum -a 256 -c SHA256SUMS) >/dev/null
REVIEWED=$(shasum -a 256 "$LOCAL/SHA256SUMS" | awk '{ print $1 }')

KNOWN_HOSTS=$LOCAL/known_hosts
ssh-keyscan -T 5 -t ed25519 "$TARGET" >"$KNOWN_HOSTS" 2>/dev/null
chmod 0600 "$KNOWN_HOSTS"
fingerprints=$(ssh-keygen -lf "$KNOWN_HOSTS" -E sha256 | awk '{ print $2 }')
[ "$(printf '%s\n' "$fingerprints" | sed '/^$/d' | wc -l | tr -d ' ')" -eq 1 ]
[ "$fingerprints" = "$EXPECTED_HOST_FINGERPRINT" ] || {
    echo "refusing SSH: target is not the pinned Ferrari host key" >&2
    exit 1
}

SSH_OPTS=(
    -o BatchMode=yes
    -o PasswordAuthentication=no
    -o KbdInteractiveAuthentication=no
    -o StrictHostKeyChecking=yes
    -o UserKnownHostsFile="$KNOWN_HOSTS"
    -o ConnectTimeout=8
    -o ServerAliveInterval=5
    -o ServerAliveCountMax=2
    -i "$SSH_KEY"
)

if [ "$MODE" = functional ]; then
    inert_commit=$(ssh "${SSH_OPTS[@]}" "root@$TARGET" \
        "test -f '/home/root/.smart-remarkable-recovery/dispatch-document-menu/$INERT_ID/committed' && test ! -L '/home/root/.smart-remarkable-recovery/dispatch-document-menu/$INERT_ID/committed' && cat '/home/root/.smart-remarkable-recovery/dispatch-document-menu/$INERT_ID/committed'")
    case "$inert_commit" in
        "committed:inert:$INERT_ID:"*) ;;
        *) echo "the physically approved inert transaction is not the committed live predecessor" >&2; exit 1 ;;
    esac
    printf '%s\n' "$inert_commit" >"$LOCAL/inert-physical-confirmation"
    chmod 0600 "$LOCAL/inert-physical-confirmation"
fi

ssh "${SSH_OPTS[@]}" "root@$TARGET" \
    "test ! -e '$STAGE' && mkdir -m 700 '$STAGE' && chown root:root '$STAGE'"
scp -O "${SSH_OPTS[@]}" \
    "$LOCAL/SHA256SUMS" "$LOCAL/baseline.sha256" "$LOCAL/device-install.sh" \
    "$LOCAL/functional.qmd" "$LOCAL/inert.qmd" "$LOCAL/panel.qml" "$LOCAL/rollback.sh" \
    "root@$TARGET:$STAGE/"
ssh "${SSH_OPTS[@]}" "root@$TARGET" \
    "chown root:root '$STAGE/'* && chmod 600 '$STAGE/SHA256SUMS' '$STAGE/baseline.sha256' '$STAGE/functional.qmd' '$STAGE/inert.qmd' '$STAGE/panel.qml' && chmod 700 '$STAGE/device-install.sh' '$STAGE/rollback.sh'"

prepare_output=$(ssh "${SSH_OPTS[@]}" "root@$TARGET" \
    "/bin/bash '$STAGE/device-install.sh' prepare '$MODE' '$STAGE' '$REVIEWED' '$ID'")
printf '%s\n' "$prepare_output"
REMOTE_BACKUP_SHA=$(printf '%s\n' "$prepare_output" | awk -F= '$1 == "safety_backup_sha256" { print $2; found=1 } END { if (!found) exit 1 }')
[[ "$REMOTE_BACKUP_SHA" =~ ^[0-9a-f]{64}$ ]]
scp -O "${SSH_OPTS[@]}" "root@$TARGET:$RECOVERY/safety-backup.tgz" "$LOCAL/safety-backup.tgz"
LOCAL_BACKUP_SHA=$(shasum -a 256 "$LOCAL/safety-backup.tgz" | awk '{ print $1 }')
[ "$LOCAL_BACKUP_SHA" = "$REMOTE_BACKUP_SHA" ]
ssh "${SSH_OPTS[@]}" "root@$TARGET" \
    "test \"\$(sha256sum '$RECOVERY/safety-backup.tgz' | cut -d' ' -f1)\" = '$LOCAL_BACKUP_SHA' && umask 077 && printf '%s\n' 'mac-backup:$LOCAL_BACKUP_SHA' >'$RECOVERY/mac-backup-verified' && chown root:root '$RECOVERY/mac-backup-verified' && chmod 600 '$RECOVERY/mac-backup-verified'"

ssh "${SSH_OPTS[@]}" "root@$TARGET" \
    "systemd-run --unit='dispatch-document-menu-install-$ID' --collect --wait --pipe --property=RuntimeMaxSec=150 /bin/bash '$STAGE/device-install.sh' activate '$MODE' '$STAGE' '$REVIEWED' '$ID'"

scp -O "${SSH_OPTS[@]}" \
    "root@$TARGET:$RECOVERY/committed" \
    "root@$TARGET:$RECOVERY/after.snapshot" \
    "root@$TARGET:$RECOVERY/remagic-live-test.log" \
    "$LOCAL/"
pid=$(awk -F= '$1 == "pid" { print $2; found=1 } END { if (!found) exit 1 }' "$LOCAL/after.snapshot")
grep -Fqx "committed:$MODE:$ID:$pid" "$LOCAL/committed"
printf 'dispatch_document_menu=%s-committed\n' "$MODE"
printf 'transaction_id=%s\n' "$ID"
printf 'deployment_evidence=%s\n' "$LOCAL"
printf 'reviewed_stage_manifest_sha256=%s\n' "$REVIEWED"
printf 'off_device_backup_sha256=%s\n' "$LOCAL_BACKUP_SHA"
