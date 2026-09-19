#!/bin/bash
# Run only against the exact root-private backup printed by prepare.
set -euo pipefail
[[ $# -eq 1 && "$1" =~ ^/var/backups/smart-dispatch-parity/[A-Za-z0-9][A-Za-z0-9_-]{5,79}$ ]] || exit 2
[[ -d "$1" && ! -L "$1" && -f "$1/controller.mjs" && ! -L "$1/controller.mjs" ]] || exit 2
exec /usr/bin/node "$1/controller.mjs" rollback "$1"
