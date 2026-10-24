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
grep -Fxq 'IMG_VERSION="3.29.0.153"' /etc/os-release
test "$(sha256sum /sys/devices/soc0/serial_number | cut -d ' ' -f1)" = 106f4d0672a9c180cdb151938872747026d6d39ab56fd73ed01c814ed0ff8d38
test "$(sha256sum /usr/bin/xochitl | cut -d ' ' -f1)" = 9d6d844d793b6242345c7c25667451620c48b2cc28986a21049fa8d534042dd4
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
test "$(sha256sum "$APP/smart_remarkable" | cut -d ' ' -f1)" = 4c9605f7f9e6be898230c3c5d607fa36fc1ce815ad85cc8f6f04e625be314f1e
test "$(sha256sum "$QMD" | cut -d ' ' -f1)" = 5a39997620a99b2ef8fe54e5c166034df9861e3c2f78a9dfe711e10a4b7c622c
! systemctl is-active --quiet smart-remarkable-session.service
! systemctl is-active --quiet riddle-takeover.service
PID=$(systemctl show xochitl -p MainPID --value); test "$PID" -gt 0
test "$(systemctl show xochitl -p NRestarts --value)" = 0
! grep -q '/companion-.*runtime' "/proc/$PID/maps"
test -d "$APP"; test ! -L "$APP"; test ! -e "$BACK/previous-app"
NEXT="$BACK/next-app"; cp -a "$APP" "$NEXT"
cp -a "$STAGE/app/." "$NEXT/"
# Read the existing paired Dot configuration as data; never source/eval it.
URL= KEY= NU=0 NK=0
while IFS= read -r line || [ -n "$line" ]; do
 case "$line" in
 DISPATCH_SERVER_DOT_URL=*) URL=${line#*=}; NU=$((NU+1));;
 DISPATCH_CREDENTIAL_DOT=*) KEY=${line#*=}; NK=$((NK+1));;
 esac
done </home/root/xovi/exthome/appload/remarkable-dot/settings.env
test "$NU:$NK" = 1:1
URL=${URL%\"}; URL=${URL#\"}; KEY=${KEY%\"}; KEY=${KEY#\"}
URL=${URL%\'}; URL=${URL#\'}; KEY=${KEY%\'}; KEY=${KEY#\'}
case "$URL" in https://*/dot) ;; https://*) URL=${URL%/}/dot;; *) exit 1;; esac
printf 'DOT_BASE_URL=%s\nDOT_TABLET_KEY=%s\n' "$URL" "$KEY" >"$NEXT/.dot.env"
chmod 600 "$NEXT/.dot.env"; unset KEY
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
test "$PID" = "$(systemctl show xochitl -p MainPID --value)"
COMMITTED=1; printf 'installed\n' >"$BACK/phase"
printf 'Send-only Smart files installed; native owner activation still required.\n'
