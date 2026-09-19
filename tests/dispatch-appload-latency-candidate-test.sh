#!/bin/bash
set -Eeuo pipefail

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD=$REPO/ops/build-dispatch-appload-latency-candidate.sh
DRY_RUN=$REPO/ops/dry-run-dispatch-appload-latency-transaction.sh
INSTALLER=$REPO/ops/device-install-dispatch-appload-latency-candidate.sh
ROLLBACK=$REPO/ops/rollback-dispatch-appload-latency-candidate.sh
CONTROLLER=$REPO/ops/deploy-dispatch-appload-latency-candidate.sh
CANDIDATE=$REPO/xovi-qmd/dispatch-appload-partial-repaint-3.28.0.169.qmd
SOURCE=$REPO/xovi-qmd/dispatch-appload-partial-repaint-3.28.0.169.source.qmd
BASELINE=$REPO/xovi-qmd/dispatch-appload-partial-repaint-3.28.0.169.baseline.sha256

bash -n "$BUILD" "$DRY_RUN" "$INSTALLER" "$ROLLBACK" "$CONTROLLER"
[ "$(shasum -a 256 "$SOURCE" | awk '{ print $1 }')" = 424b1ca4859e38de5dc07e5e33a7c18a532a61fb821edbe9a3cbce3985e12e6e ]
[ "$(shasum -a 256 "$CANDIDATE" | awk '{ print $1 }')" = 1eb2037f28c9891fbdc4a97d1e2916b8e923fe04004ae1ced03b5de73f59a60e ]
[ "$(shasum -a 256 "$BASELINE" | awk '{ print $1 }')" = 1e89ad1fcde7920760ed2a7d44d892e9a0be46acc5d5e05ffaac7d087fbce138 ]
[ "$(wc -l <"$BASELINE" | tr -d ' ')" = 10 ]
grep -Fqx '2d4681414ac00b534b2f21d179365601ce9e876c7cfbf6c6c8d25a2f8738e580  notebook-date-index.qmd' "$BASELINE"

for term in \
    'root.fullscreen' \
    'root.disablesWindowedMode' \
    'root.appName === "Dispatch"' \
    'root.scaledContentWidth === root.globalWidth' \
    'root.scaledContentHeight === root.globalHeight' \
    'qtfbKey !== -1'; do
    grep -Fq "$term" "$SOURCE"
done

grep -Fq -- '--on-active=180' "$INSTALLER"
grep -Fq 'trap rollback_on_exit EXIT' "$INSTALLER"
grep -Fq "trap 'exit 129' HUP" "$INSTALLER"
grep -Fq "trap 'exit 130' INT" "$INSTALLER"
grep -Fq "trap 'exit 143' TERM" "$INSTALLER"
grep -Fq 'unexpected target preserved; stock mode requested' "$ROLLBACK"
grep -Fq 'systemctl kill --kill-whom=all --signal=KILL "$TRANSACTION_UNIT"' "$ROLLBACK"
grep -Fq 'EXPECTED_DISPATCH_BINARY_SHA256=d700b7c8c3df4d5750d0844169a0d50324f9d7fd2a8ac4f8667a40efa26ceab4' "$INSTALLER"
grep -Fq 'EXPECTED_DATES_QMD_SHA256=2d4681414ac00b534b2f21d179365601ce9e876c7cfbf6c6c8d25a2f8738e580' "$INSTALLER"
grep -Fq 'exact_owned_file "$QDIR/notebook-date-index.qmd" "$EXPECTED_DATES_QMD_SHA256" 0:0:600' "$INSTALLER"
grep -Fq 'EXPECTED_START_SHA256=bf15dfd641deea3e4487b9182957938a3dc824c340383c9243b7f118bfe829dc' "$INSTALLER"
grep -Fq 'EXPECTED_SERVICE_CONF_SHA256=6036f7776f8775529f94056fafe066ff373f5aa6bca39633bfd4dabfc1552ffd' "$INSTALLER"
grep -Fq 'EXPECTED_APPLEDOUBLE_SHA256=a502dbe0e569c3718c449b86480d0cd4cdc23e3a450814de360e5b0a5e08c5d3' "$INSTALLER"
grep -Fq 'EXPECTED_STOCK_UNIT_SHA256=23f537cf59d527bfbf4823f372385d613e1ade0961c98831c935a372018f9566' "$INSTALLER"
grep -Fq 'EXPECTED_STOCK_OVERRIDE_SHA256=a9432caffacb29d6fcb35136dcc3cb43d8737eb6c2efcb35ea335725f42082d1' "$INSTALLER"
grep -Fq 'verify_service_tree' "$INSTALLER"
grep -Fq "printf '%s\\n' ._appload.so ._qt-resource-rebuilder.so ._xovi-message-broker.so appload.so framebuffer-spy.so qt-resource-rebuilder.so xovi-message-broker.so" "$INSTALLER"
grep -Fq 'exact_owned_file "$EXTENSIONS/._appload.so" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755' "$INSTALLER"
grep -Fq 'exact_owned_file "$EXTENSIONS/._qt-resource-rebuilder.so" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755' "$INSTALLER"
grep -Fq 'exact_owned_file "$EXTENSIONS/._xovi-message-broker.so" "$EXPECTED_APPLEDOUBLE_SHA256" 0:0:755' "$INSTALLER"
if grep -Fq 'exact_owned_file "$EXTENSIONS/._framebuffer-spy.so"' "$INSTALLER"; then
    echo "installer unexpectedly admits an unobserved ._framebuffer-spy.so" >&2
    exit 1
fi
grep -Fq 'sha256sum "$EXTENSIONS/._appload.so" "$EXTENSIONS/._qt-resource-rebuilder.so" "$EXTENSIONS/._xovi-message-broker.so"' "$INSTALLER"
grep -Fq 'no_other_mutation_active' "$INSTALLER"
grep -Fq -- '--kill-whom=WHOM' "$INSTALLER"
grep -Fq -- '--signal=SIGNAL' "$INSTALLER"
grep -Fq 'stock_surface_is_exact' "$ROLLBACK"
grep -Fq '501:20:644' "$INSTALLER"
grep -Fq '0:0:755' "$INSTALLER"
grep -Fq 'Loading file dispatch-appload-partial-repaint-3.28.0.169.qmd' "$INSTALLER"
grep -Fq 'Loading file [^ ]+\.qmd$' "$INSTALLER"
grep -Fq 'Processing file /appload/qml/window.qml...' "$INSTALLER"
grep -Fq '[qmldiff]: Failed to load file' "$INSTALLER"
grep -Fq 'if [ "$MODE" != --activate ]' "$CONTROLLER"
grep -Fq 'dry-run-dispatch-appload-latency-transaction.sh' "$CONTROLLER"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/dispatch-appload-test.XXXXXX")
cleanup() {
    status=$?
    trap - EXIT
    rm -rf "$WORK"
    exit "$status"
}
trap cleanup EXIT HUP INT TERM

APPLOAD=/Users/mdf/code/remarkable-device-backups/0A247209DABC7917/20260730T170508Z-3.28.0.164-pre-xovi/core/appload.so
cp "$APPLOAD" "$WORK/wrong-appload.so"
printf '\0' >>"$WORK/wrong-appload.so"
if APPLOAD_SO="$WORK/wrong-appload.so" "$DRY_RUN" >"$WORK/wrong-appload.log" 2>&1; then
    echo "dry-run accepted a modified AppLoad preimage" >&2
    exit 1
fi
grep -Fq 'AppLoad preimage hash mismatch' "$WORK/wrong-appload.log"

HASHTAB=/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.28.0.169/hashtab
cp "$HASHTAB" "$WORK/wrong-hashtab"
printf '\0' >>"$WORK/wrong-hashtab"
if HASHTAB="$WORK/wrong-hashtab" "$DRY_RUN" >"$WORK/wrong-hashtab.log" 2>&1; then
    echo "dry-run accepted a modified firmware hashtable" >&2
    exit 1
fi
grep -Fq 'firmware hashtable hash mismatch' "$WORK/wrong-hashtab.log"

DISPATCH=/Users/mdf/code/remarkable-device-backups/0A247209DABC7917/20260919T100629Z-dispatch-e6e2233/remarkable-dispatch.installed-e6e2233
cp "$DISPATCH" "$WORK/wrong-dispatch"
printf '\0' >>"$WORK/wrong-dispatch"
if DISPATCH_BINARY="$WORK/wrong-dispatch" "$DRY_RUN" >"$WORK/wrong-dispatch.log" 2>&1; then
    echo "dry-run accepted a modified Dispatch binary" >&2
    exit 1
fi
grep -Fq 'current Dispatch binary hash mismatch' "$WORK/wrong-dispatch.log"

"$DRY_RUN" >"$WORK/dry-run.log" 2>&1
grep -Fqx 'dry_run=passed' "$WORK/dry-run.log"
grep -Fqx 'device_contact=none' "$WORK/dry-run.log"
grep -Fqx 'candidate_sha256=1eb2037f28c9891fbdc4a97d1e2916b8e923fe04004ae1ced03b5de73f59a60e' "$WORK/dry-run.log"

echo 'dispatch_appload_latency_candidate_tests=passed'
