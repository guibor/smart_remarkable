#!/bin/bash
set -Eeuo pipefail
export LC_ALL=C

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILDER="$REPO/ops/build-staged-sha256-manifest.sh"
CONTROLLER="$REPO/ops/install-smart-openclaw.sh"
DEVICE_INSTALLER="$REPO/ops/device-install-smart-openclaw.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/smart-remarkable-manifest-test.XXXXXX")
STAGE="$WORK/stage"
FIRST_MANIFEST="$WORK/first.sha256"

cleanup() {
    status=$?
    trap - EXIT
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT

mkdir -p "$STAGE/scripts"
printf 'binary fixture\n' >"$STAGE/smart_remarkable"
printf 'tracked fixture\n' >"$STAGE/tracked-input.txt"
printf 'untracked fixture\n' >"$STAGE/untracked-input.txt"
printf '#!/bin/sh\nexit 0\n' >"$STAGE/scripts/runner.sh"

/bin/bash "$BUILDER" "$STAGE"
test "$(wc -l <"$STAGE/STAGED-FILES.sha256" | tr -d ' ')" -eq 4
test "$(sed -n 's/^[0-9a-f][0-9a-f]*  //p' "$STAGE/STAGED-FILES.sha256")" = "$(printf '%s\n' \
    './scripts/runner.sh' \
    './smart_remarkable' \
    './tracked-input.txt' \
    './untracked-input.txt')"
(
    cd "$STAGE"
    shasum -a 256 --strict --status -c STAGED-FILES.sha256
)
cp "$STAGE/STAGED-FILES.sha256" "$FIRST_MANIFEST"

/bin/bash "$BUILDER" "$STAGE"
cmp -s "$FIRST_MANIFEST" "$STAGE/STAGED-FILES.sha256"

printf 'changed untracked fixture\n' >"$STAGE/untracked-input.txt"
/bin/bash "$BUILDER" "$STAGE"
if cmp -s "$FIRST_MANIFEST" "$STAGE/STAGED-FILES.sha256"; then
    echo "Manifest did not change when an untracked staged input changed" >&2
    exit 1
fi
(
    cd "$STAGE"
    shasum -a 256 --strict --status -c STAGED-FILES.sha256
)

ln -s tracked-input.txt "$STAGE/linked-input.txt"
if /bin/bash "$BUILDER" "$STAGE" >/dev/null 2>&1; then
    echo "Manifest builder accepted a staged symlink" >&2
    exit 1
fi
rm -f "$STAGE/linked-input.txt"

bash -n "$BUILDER" "$CONTROLLER" "$DEVICE_INSTALLER"
grep -F 'STAGED_MANIFEST_SHA=' "$CONTROLLER" >/dev/null
grep -F 'test "$BINARY_SHA" = "$EXPECTED_SMART_REMARKABLE_SHA256"' "$CONTROLLER" >/dev/null
grep -F 'BUNDLE_SOURCE_PATHS=(' "$CONTROLLER" >/dev/null
grep -F "printf 'source_inputs=SOURCE-INPUTS.sha256" "$CONTROLLER" >/dev/null
grep -F "printf 'source_inputs_sha256=%s" "$CONTROLLER" >/dev/null
test "$(grep -h '^EXPECTED_ARCHIVE_MEMBERS=' "$CONTROLLER" "$DEVICE_INSTALLER" |
    wc -l | tr -d ' ')" -eq 2
grep -F 'test "$(tar -tf "$ARCHIVE")" = "$EXPECTED_ARCHIVE_MEMBERS"' "$DEVICE_INSTALLER" >/dev/null
grep -F "'\$STAGED_MANIFEST_SHA' '\$DEVICE_INSTALLER_SHA'" "$CONTROLLER" >/dev/null
grep -F 'EXPECTED_STAGED_MANIFEST_SHA=${5:?staged manifest sha256 required}' "$DEVICE_INSTALLER" >/dev/null
grep -F 'test "$(sha256sum "$0" | cut -d' "$DEVICE_INSTALLER" >/dev/null
grep -F "find . -type f ! -path './STAGED-FILES.sha256'" "$DEVICE_INSTALLER" >/dev/null
grep -F "printf 'staged_files_begin" "$DEVICE_INSTALLER" >/dev/null
grep -F 'cat "$payload_root/STAGED-FILES.sha256"' "$DEVICE_INSTALLER" >/dev/null
grep -F "printf 'source_inputs_begin" "$DEVICE_INSTALLER" >/dev/null
grep -F 'cat "$payload_root/SOURCE-INPUTS.sha256"' "$DEVICE_INSTALLER" >/dev/null
prepared_line=$(grep -n 'write_recovery_metadata prepared "$STAGE"' "$DEVICE_INSTALLER" | cut -d: -f1)
backup_line=$(grep -n 'mv "$APP" "$BACKUP"' "$DEVICE_INSTALLER" | tail -n 1 | cut -d: -f1)
test "$prepared_line" -lt "$backup_line"

echo "staged-file manifest tests passed"
