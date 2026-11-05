#!/bin/bash
# Exact-device, app-only publication. Run only after the native owner's own
# stop/recovery action. No system partition, notebook or boot-service writes.
set -Eeuo pipefail
umask 077
ACTION=${1:?}; STAGE=${2:?}; MANIFEST=${3:?}
[[ "$STAGE" =~ ^/home/root/.codex-staging/dot-send-[0-9TZ-]+$ ]]
[[ "$MANIFEST" =~ ^[a-f0-9]{64}$ ]]
test "$(sha256sum "$STAGE/SHA256SUMS" | cut -d ' ' -f1)" = "$MANIFEST"
(cd "$STAGE" && sha256sum -c SHA256SUMS >/dev/null)
test "$(cat /sys/devices/soc0/machine)" = 'reMarkable Ferrari'
grep -Fxq 'IMG_VERSION="3.30.0.108"' /etc/os-release
test "$(sha256sum /sys/devices/soc0/serial_number | cut -d ' ' -f1)" = 106f4d0672a9c180cdb151938872747026d6d39ab56fd73ed01c814ed0ff8d38
test "$(sha256sum /usr/bin/xochitl | cut -d ' ' -f1)" = 31d33b05e85af85b06a5a92edf710532a0a122ed4cf51e702c19eed0feb6753b
awk '$2=="/" && $4 ~ /(^|,)ro(,|$)/ {ok=1} END {exit !ok}' /proc/mounts
APP=/home/root/xovi/exthome/appload/smart-remarkable
QMD=/home/root/xovi/exthome/qt-resource-rebuilder/smart-remarkable-llm.qmd
BACK=/home/root/.codex-backups/$(basename "$STAGE")
if [ "$ACTION" = prepare ]; then
 test ! -e "$BACK"; mkdir -m700 "$BACK"
 tar -czf "$BACK/preimages.tgz" -C /home/root xovi/exthome/appload/smart-remarkable xovi/exthome/qt-resource-rebuilder/smart-remarkable-llm.qmd .config/smart-remarkable/settings.conf
 sha256sum "$BACK/preimages.tgz"
 exit 0
fi
test "$ACTION" = install
test "$(cat "$BACK/mac-backup-verified")" = "mac-backup:$(sha256sum "$BACK/preimages.tgz" | cut -d ' ' -f1)"
test "$(sha256sum "$APP/smart_remarkable" | cut -d ' ' -f1)" = ff1163616735b3dd5d0c1923e868ad23cda2049108cdfa977087ed1c7fed2484
# Maintenance publishes the four new app QMDs before this app-only delta.
test "$(sha256sum "$QMD" | cut -d ' ' -f1)" = 765db93308c83e032777cded8c460ca8f80b391995f8c8294171a2c76ca89d1f
! systemctl is-active --quiet smart-remarkable-session.service
! systemctl is-active --quiet riddle-takeover.service
PID=$(systemctl show xochitl -p MainPID --value); test "$PID" -gt 0
test "$(systemctl show xochitl -p NRestarts --value)" = 0
! grep -Fq '/home/root/xovi/xovi.so' "/proc/$PID/maps"
test -d "$APP"; test ! -L "$APP"; test ! -e "$BACK/previous-app"
NEXT="$BACK/next-app"; cp -a "$APP" "$NEXT"
cp -a "$STAGE/app/." "$NEXT/"
# Preserve the already-paired private Dot configuration verbatim.
cmp "$APP/.dot.env" "$NEXT/.dot.env"
. "$NEXT/scripts/dot-runtime-env.sh"
smart_load_dot_runtime_env "$NEXT/.dot.env"
unset DOT_TABLET_KEY
find "$NEXT" -type d -exec chmod 755 {} \;
chmod 755 "$NEXT/smart_remarkable" "$NEXT/appload-launch.sh" "$NEXT"/scripts/*.sh
chmod 644 "$NEXT/external.manifest.json" "$NEXT/integration/DotSendStatus.qml"
cmp "$APP/.env" "$NEXT/.env"
cp -p "$QMD" "$BACK/previous.qmd"
APP_MOVED=0; QMD_MOVED=0; COMMITTED=0
rollback() {
 if [ "$COMMITTED" = 0 ]; then
  if [ "$QMD_MOVED" = 1 ]; then cp -p "$BACK/previous.qmd" "$QMD"; fi
  if [ "$APP_MOVED" = 1 ]; then
   test ! -e "$APP" || mv "$APP" "$BACK/failed-app"
   mv "$BACK/previous-app" "$APP"
  fi
 fi
}
trap rollback EXIT
printf 'publishing\n' >"$BACK/phase"
mv "$APP" "$BACK/previous-app"; APP_MOVED=1
mv "$NEXT" "$APP"
cp "$STAGE/smart-remarkable-llm.qmd" "$QMD.next"; chmod 644 "$QMD.next"
QMD_MOVED=1; mv "$QMD.next" "$QMD"
(cd "$APP" && sha256sum -c DOT-SEND-FILES.sha256 >/dev/null)
cmp "$BACK/previous-app/.env" "$APP/.env"
cmp "$BACK/previous-app/.dot.env" "$APP/.dot.env"
test "$PID" = "$(systemctl show xochitl -p MainPID --value)"
COMMITTED=1; printf 'installed\n' >"$BACK/phase"
printf 'Send-only Smart files installed; native owner activation still required.\n'
