#!/bin/bash
# Build the deterministic content manifest for a locally staged AppLoad bundle.
# The manifest deliberately excludes itself; its own SHA-256 is passed to the
# device installer and preserved in the device-side recovery metadata.
set -Eeuo pipefail
umask 077
export LC_ALL=C

if [ "$#" -ne 1 ]; then
    echo "usage: $0 STAGE_DIRECTORY" >&2
    exit 2
fi

STAGE_INPUT=$1
test -d "$STAGE_INPUT"
test ! -L "$STAGE_INPUT"
STAGE=$(CDPATH= cd -- "$STAGE_INPUT" && pwd -P)
MANIFEST="$STAGE/STAGED-FILES.sha256"
if [ -e "$MANIFEST" ] || [ -L "$MANIFEST" ]; then
    test -f "$MANIFEST"
    test ! -L "$MANIFEST"
fi

TEMP_MANIFEST=$(mktemp "${TMPDIR:-/tmp}/smart-remarkable-staged-files.XXXXXX")
cleanup() {
    status=$?
    trap - EXIT
    rm -f "$TEMP_MANIFEST"
    exit "$status"
}
trap cleanup EXIT

(
    cd "$STAGE"
    if [ -n "$(find . -type l -print)" ]; then
        echo "Staged bundle cannot contain symlinks" >&2
        exit 1
    fi
    if [ -n "$(find . ! -type d ! -type f -print)" ]; then
        echo "Staged bundle can contain only regular files and directories" >&2
        exit 1
    fi

    find . -type f ! -path './STAGED-FILES.sha256' -print |
        sort |
        while IFS= read -r relative_path; do
            case "$relative_path" in
                *\\*|*$'\n'*|*$'\r'*)
                    echo "Unsupported staged filename: $relative_path" >&2
                    exit 1
                    ;;
            esac
            digest=$(shasum -a 256 "$relative_path" | awk 'NR == 1 { print $1 }')
            case "$digest" in
                *[!0-9a-f]*|"")
                    echo "Invalid SHA-256 for staged file: $relative_path" >&2
                    exit 1
                    ;;
            esac
            test "${#digest}" -eq 64
            printf '%s  %s\n' "$digest" "$relative_path"
        done
) >"$TEMP_MANIFEST"

test -s "$TEMP_MANIFEST"
install -m 0644 "$TEMP_MANIFEST" "$MANIFEST"
(
    cd "$STAGE"
    shasum -a 256 --strict --status -c STAGED-FILES.sha256
)
