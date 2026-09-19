#!/bin/bash
# Mac-side controller. It is intentionally inert unless --activate is supplied.
# Never run this until the physical canary window has been approved.
set -Eeuo pipefail
umask 077

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET=${1:-}
MODE=${2:-}
EXPECTED_HOST_FINGERPRINT=SHA256:dByHweKZkjDlZRBHdBisT5VD2kV85lClgtJExnDaTeE
SSH_KEY=${REMARKABLE_SSH_KEY:-$HOME/.ssh/id_ed25519_remarkable_new}

if [ "$MODE" != --activate ]; then
    echo "usage: $0 VERIFIED_IPV4 --activate" >&2
    echo "This performs one guarded xochitl canary; local dry-run alone is the default safe action." >&2
    exit 2
fi
[[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "target must be the separately verified Ferrari IPv4 address" >&2
    exit 2
}
[ -f "$SSH_KEY" ] && [ ! -L "$SSH_KEY" ] || {
    echo "missing non-symlinked SSH key: $SSH_KEY" >&2
    exit 1
}

# Do every exact-input, composition, parse, watchdog, and rollback simulation
# before the first network packet is sent.
"$REPO/ops/dry-run-dispatch-appload-latency-transaction.sh"

ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
LOCAL="$REPO/tmp/$ID"
STAGE="/home/root/.codex-staging/dispatch-appload-latency-$ID"
RECOVERY="/home/root/.smart-remarkable-recovery/dispatch-appload-latency/$ID"
mkdir -p "$LOCAL"
chmod 0700 "$REPO/tmp" "$LOCAL"

cp "$REPO/xovi-qmd/dispatch-appload-partial-repaint-3.28.0.169.baseline.sha256" "$LOCAL/baseline.sha256"
cp "$REPO/xovi-qmd/dispatch-appload-partial-repaint-3.28.0.169.qmd" "$LOCAL/candidate.qmd"
cp "$REPO/ops/device-install-dispatch-appload-latency-candidate.sh" "$LOCAL/device-install.sh"
cp "$REPO/ops/rollback-dispatch-appload-latency-candidate.sh" "$LOCAL/rollback.sh"
chmod 0700 "$LOCAL/device-install.sh" "$LOCAL/rollback.sh"
(cd "$LOCAL" && shasum -a 256 baseline.sha256 candidate.qmd device-install.sh rollback.sh >SHA256SUMS)
(cd "$LOCAL" && shasum -a 256 -c SHA256SUMS) >/dev/null
REVIEWED=$(shasum -a 256 "$LOCAL/SHA256SUMS" | awk '{ print $1 }')

KNOWN_HOSTS="$LOCAL/known_hosts"
ssh-keyscan -T 5 -t ed25519 "$TARGET" >"$KNOWN_HOSTS" 2>/dev/null
chmod 0600 "$KNOWN_HOSTS"
fingerprints=$(ssh-keygen -lf "$KNOWN_HOSTS" -E sha256 | awk '{ print $2 }')
[ "$(printf '%s\n' "$fingerprints" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ]
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

ssh "${SSH_OPTS[@]}" "root@$TARGET" "test ! -e '$STAGE' && mkdir -m 700 '$STAGE'"
scp -O "${SSH_OPTS[@]}" "$LOCAL/"{SHA256SUMS,baseline.sha256,candidate.qmd,device-install.sh,rollback.sh} "root@$TARGET:$STAGE/"
ssh "${SSH_OPTS[@]}" "root@$TARGET" "chown root:root '$STAGE/'* && chmod 600 '$STAGE/SHA256SUMS' '$STAGE/baseline.sha256' '$STAGE/candidate.qmd' && chmod 700 '$STAGE/device-install.sh' '$STAGE/rollback.sh'"

prepare_output=$(ssh "${SSH_OPTS[@]}" "root@$TARGET" \
    "/bin/bash '$STAGE/device-install.sh' prepare '$STAGE' '$REVIEWED' '$ID'")
printf '%s\n' "$prepare_output"
REMOTE_BACKUP_SHA=$(printf '%s\n' "$prepare_output" | awk -F= '$1 == "safety_backup_sha256" { print $2; found=1 } END { if (!found) exit 1 }')
[[ "$REMOTE_BACKUP_SHA" =~ ^[0-9a-f]{64}$ ]]
scp -O "${SSH_OPTS[@]}" "root@$TARGET:$RECOVERY/safety-backup.tgz" "$LOCAL/safety-backup.tgz"
LOCAL_BACKUP_SHA=$(shasum -a 256 "$LOCAL/safety-backup.tgz" | awk '{ print $1 }')
[ "$LOCAL_BACKUP_SHA" = "$REMOTE_BACKUP_SHA" ]
ssh "${SSH_OPTS[@]}" "root@$TARGET" \
    "test \"\$(sha256sum '$RECOVERY/safety-backup.tgz' | cut -d' ' -f1)\" = '$LOCAL_BACKUP_SHA' && umask 077 && printf '%s\\n' 'mac-backup:$LOCAL_BACKUP_SHA' >'$RECOVERY/mac-backup-verified' && chown root:root '$RECOVERY/mac-backup-verified' && chmod 600 '$RECOVERY/mac-backup-verified'"

ssh "${SSH_OPTS[@]}" "root@$TARGET" \
    "systemd-run --unit='dispatch-appload-latency-install-$ID' --collect --wait --pipe --property=RuntimeMaxSec=150 /bin/bash '$STAGE/device-install.sh' activate '$STAGE' '$REVIEWED' '$ID'"

scp -O "${SSH_OPTS[@]}" \
    "root@$TARGET:$RECOVERY/committed" \
    "root@$TARGET:$RECOVERY/after.snapshot" \
    "root@$TARGET:$RECOVERY/remagic-live-test.log" \
    "$LOCAL/"
grep -Fqx "committed:$ID:""$(awk -F= '$1 == "pid" { print $2 }' "$LOCAL/after.snapshot")" "$LOCAL/committed"
printf 'deployment_evidence=%s\n' "$LOCAL"
printf 'reviewed_stage_manifest_sha256=%s\n' "$REVIEWED"
printf 'off_device_backup_sha256=%s\n' "$LOCAL_BACKUP_SHA"
