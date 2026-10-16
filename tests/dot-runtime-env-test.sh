#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$ROOT/scripts/dot-runtime-env.sh"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
key=abcdefghijklmnopqrstuvwxyz0123456789_ABCDEFG
printf 'DOT_BASE_URL=https://example.test/dot\nDOT_TABLET_KEY=%s\n' "$key" > "$dir/env"
smart_load_dot_runtime_env "$dir/env"
[ "$DOT_BASE_URL" = https://example.test/dot ] && [ "$DOT_TABLET_KEY" = "$key" ]
for url in http://example.test/dot 'https://u@example.test/dot' 'https://example.test/dot?k=x' '$(touch /tmp/unsafe)/dot'; do
    printf 'DOT_BASE_URL=%s\nDOT_TABLET_KEY=%s\n' "$url" "$key" > "$dir/env"
    if smart_load_dot_runtime_env "$dir/env"; then echo 'Invalid URL accepted' >&2; exit 1; fi
done
printf 'DOT_BASE_URL=https://example.test/dot\nDOT_BASE_URL=https://else.test/dot\n' > "$dir/env"
if smart_load_dot_runtime_env "$dir/env"; then exit 1; fi
ln -s "$dir/env" "$dir/link"
if smart_load_dot_runtime_env "$dir/link"; then exit 1; fi
echo 'Dot environment parser tests passed'
