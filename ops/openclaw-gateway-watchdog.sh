#!/usr/bin/env bash
set -euo pipefail

USER_NAME="mdf"
PORT="18789"
STARTUP_GRACE_SECONDS="90"
USER_ID="$(id -u "$USER_NAME")"
RUNTIME_DIR="/run/user/${USER_ID}"

log() {
  logger -t openclaw-watchdog "$*"
}

user_systemctl() {
  runuser -u "$USER_NAME" -- env XDG_RUNTIME_DIR="$RUNTIME_DIR" systemctl --user "$@"
}

gateway_healthy() {
  python3 - "$PORT" <<'PY'
import socket, sys
port = int(sys.argv[1])
for host in ("127.0.0.1", "::1"):
    try:
        with socket.create_connection((host, port), timeout=3):
            raise SystemExit(0)
    except Exception:
        pass
raise SystemExit(1)
PY
}

gateway_age_seconds() {
  local started_us now_us
  started_us="$(user_systemctl show openclaw-gateway.service --property=ActiveEnterTimestampMonotonic --value)"
  now_us="$(awk '{printf "%.0f", $1 * 1000000}' /proc/uptime)"
  if [[ "$started_us" =~ ^[0-9]+$ ]] && (( started_us > 0 && now_us >= started_us )); then
    printf '%s\n' "$(( (now_us - started_us) / 1000000 ))"
  else
    printf '%s\n' "$STARTUP_GRACE_SECONDS"
  fi
}

wait_for_gateway() {
  local waited=0
  while (( waited < STARTUP_GRACE_SECONDS )); do
    if user_systemctl is-active --quiet openclaw-gateway.service && gateway_healthy; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

if [[ ! -S "${RUNTIME_DIR}/systemd/private" ]]; then
  log "user systemd socket missing for ${USER_NAME}"
  exit 1
fi

active=0
if user_systemctl is-active --quiet openclaw-gateway.service; then
  active=1
fi

healthy=0
if gateway_healthy; then
  healthy=1
fi

if [[ "$active" -eq 1 && "$healthy" -eq 1 ]]; then
  exit 0
fi

if [[ "$active" -eq 1 ]]; then
  age="$(gateway_age_seconds)"
  if (( age < STARTUP_GRACE_SECONDS )); then
    log "gateway still starting age=${age}s; deferring restart"
    exit 0
  fi
fi

log "gateway unhealthy active=${active} healthy=${healthy}; restarting"
user_systemctl restart openclaw-gateway.service

if ! wait_for_gateway; then
  log "gateway failed to become healthy within ${STARTUP_GRACE_SECONDS}s after restart"
  exit 1
fi

log "gateway recovered"
