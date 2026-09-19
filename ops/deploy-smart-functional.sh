#!/bin/bash
# Mac-side controller for exact Ferrari 3.28.0.169 Smart functional promotion.
# Both existing buttons become usable; there is no new inert installation. It performs no device action unless --activate is explicitly present.
set -Eeuo pipefail
umask 077

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET=${1:-}
CONFIRMATION=${2:-}
SERVER_VERIFIED=${3:-}
ACTIVATE=${4:-}
MODE=functional
EXPECTED_HOST_FINGERPRINT=SHA256:dByHweKZkjDlZRBHdBisT5VD2kV85lClgtJExnDaTeE
SSH_KEY=${REMARKABLE_SSH_KEY:-$HOME/.ssh/id_ed25519_remarkable_new}
usage() {
    echo "usage: $0 VERIFIED_FERRARI_IPV4 --confirm-inert-visible=20260814T232837Z-37203 --server-verified --activate" >&2
    echo "Only use after live server semantics/capabilities have passed; enables both existing Smart icons." >&2
    exit 2
}
[ "$CONFIRMATION" = --confirm-inert-visible=20260814T232837Z-37203 ] || usage
[ "$SERVER_VERIFIED" = --server-verified ] && [ "$ACTIVATE" = --activate ] && [ "$#" -eq 4 ] || usage
INERT_ID=20260814T232837Z-37203
[[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
[ -f "$SSH_KEY" ] && [ ! -L "$SSH_KEY" ] || {
    echo "missing non-symlinked SSH key: $SSH_KEY" >&2
    exit 1
}

# Every local artifact/composition/protocol/rollback simulation must
# pass before the first network packet is sent.
/bin/bash "$REPO/tests/smart-functional-test.sh"

ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
LOCAL=$REPO/tmp/$ID
STAGE=/home/root/.codex-staging/smart-functional-$ID
RECOVERY=/home/root/.smart-remarkable-recovery/smart-functional/$ID
mkdir -p "$REPO/tmp"
[ -d "$REPO/tmp" ] && [ ! -L "$REPO/tmp" ] && [ "$(readlink -f "$REPO/tmp")" = "$REPO/tmp" ] || {
    echo "unsafe repository tmp directory" >&2
    exit 1
}
chmod 0700 "$REPO/tmp"
mkdir "$LOCAL"
chmod 0700 "$LOCAL"

cp "$REPO/ops/smart-functional-peers.sha256" "$LOCAL/baseline.sha256"
cp "$REPO/xovi-qmd/llm-button-3.28.0.169.qmd" "$LOCAL/functional.qmd"
cp "$REPO/xovi-qmd/llm-button-inert-3.28.0.169.qmd" "$LOCAL/inert.qmd"
cp "$REPO/qml/DispatchLauncher.qml" "$LOCAL/panel.qml"
cp "$REPO/ops/device-install-smart-functional.sh" "$LOCAL/device-install.sh"
cp "$REPO/ops/rollback-smart-functional.sh" "$LOCAL/rollback.sh"
cp "$REPO/ops/artifact-compatibility-contract.sh" "$LOCAL/artifact-compatibility-contract.sh"
cp "$REPO/xovi-qmd/compatibility-3.28.0.169.env" "$LOCAL/compatibility.env"
chmod 0600 "$LOCAL/artifact-compatibility-contract.sh" "$LOCAL/compatibility.env"
chmod 0600 "$LOCAL/baseline.sha256" "$LOCAL/functional.qmd" "$LOCAL/inert.qmd" "$LOCAL/panel.qml"
chmod 0700 "$LOCAL/device-install.sh" "$LOCAL/rollback.sh"
(cd "$LOCAL" && shasum -a 256 \
    artifact-compatibility-contract.sh compatibility.env baseline.sha256 device-install.sh functional.qmd inert.qmd panel.qml rollback.sh >SHA256SUMS)
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

# The fixed historical receipt is reverified in prepare. This is an explicit
# operator acknowledgement, not evidence fabricated by the controller.
printf '%s\n' "$CONFIRMATION" "$SERVER_VERIFIED" >"$LOCAL/operator-acknowledgements"

ssh "${SSH_OPTS[@]}" "root@$TARGET" \
    "test ! -e '$STAGE' && mkdir -m 700 '$STAGE' && chown root:root '$STAGE'"
scp -O "${SSH_OPTS[@]}" \
    "$LOCAL/SHA256SUMS" "$LOCAL/artifact-compatibility-contract.sh" "$LOCAL/compatibility.env" "$LOCAL/baseline.sha256" "$LOCAL/device-install.sh" \
    "$LOCAL/functional.qmd" "$LOCAL/inert.qmd" "$LOCAL/panel.qml" "$LOCAL/rollback.sh" \
    "root@$TARGET:$STAGE/"
ssh "${SSH_OPTS[@]}" "root@$TARGET" \
    "chown root:root '$STAGE/'* && chmod 600 '$STAGE/artifact-compatibility-contract.sh' '$STAGE/compatibility.env' '$STAGE/SHA256SUMS' '$STAGE/baseline.sha256' '$STAGE/functional.qmd' '$STAGE/inert.qmd' '$STAGE/panel.qml' && chmod 700 '$STAGE/device-install.sh' '$STAGE/rollback.sh'"

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
    "systemd-run --unit='smart-functional-install-$ID' --collect --wait --pipe --property=RuntimeMaxSec=150 /bin/bash '$STAGE/device-install.sh' activate '$MODE' '$STAGE' '$REVIEWED' '$ID'"

scp -O "${SSH_OPTS[@]}" \
    "root@$TARGET:$RECOVERY/committed" \
    "root@$TARGET:$RECOVERY/after.snapshot" \
    "root@$TARGET:$RECOVERY/remagic-live-test.log" \
    "$LOCAL/"
pid=$(awk -F= '$1 == "pid" { print $2; found=1 } END { if (!found) exit 1 }' "$LOCAL/after.snapshot")
grep -Fqx "committed:$MODE:$ID:$pid" "$LOCAL/committed"
printf 'smart_functional=%s-committed\n' "$MODE"
printf 'transaction_id=%s\n' "$ID"
printf 'deployment_evidence=%s\n' "$LOCAL"
printf 'reviewed_stage_manifest_sha256=%s\n' "$REVIEWED"
printf 'off_device_backup_sha256=%s\n' "$LOCAL_BACKUP_SHA"
