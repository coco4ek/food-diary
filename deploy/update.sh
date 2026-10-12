#!/bin/bash
# Runs ON THE HOST (not in the container), started by systemd when the app asks for an update:
# git pull + docker compose up -d --build. Progress goes to data/updater/ for the admin screen.
set -uo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
U="$APP_DIR/data/updater"
mkdir -p "$U"
exec 9>"$U/.lock"
flock -n 9 || { echo "update already running"; exit 0; }
rm -f "$U/request"
umask 022
LOG="$U/log"; : > "$LOG"
OWNER="$(stat -c %U "$APP_DIR")"
g() { if [ "$(id -un)" = "$OWNER" ]; then git -C "$APP_DIR" "$@"; else runuser -u "$OWNER" -- git -C "$APP_DIR" "$@"; fi; }
status() { # state message
  printf '{"state":"%s","message":"%s","at":%s,"from":"%s","to":"%s"}\n' "$1" "$2" "$(date +%s000)" "${FROM:-}" "${TO:-}" > "$U/status.json.tmp"
  mv "$U/status.json.tmp" "$U/status.json"
}
step() { echo; echo "▶ $*"; }
{
  FROM="$(g rev-parse --short HEAD 2>/dev/null)"
  status running "Скачиваю обновление"
  step "git pull ($(g rev-parse --abbrev-ref HEAD))"
  if ! g pull --ff-only 2>&1; then
    status failed "git pull не удался: на сервере есть свои правки или нет доступа к GitHub. Подробности в журнале."; exit 1
  fi
  TO="$(g rev-parse --short HEAD)"
  if [ "$FROM" = "$TO" ] && [ "${1:-}" != "--force" ] && [ ! -f "$U/force" ]; then
    status done "Уже последняя версия ($TO)"; exit 0
  fi
  rm -f "$U/force"
  echo; g log --oneline "$FROM..$TO" 2>/dev/null | head -20
  status running "Собираю новую версию $TO — это займёт пару минут"
  step "docker compose up -d --build"
  cd "$APP_DIR"
  if ! docker compose up -d --build 2>&1; then
    status failed "Сборка не удалась, работает прежняя версия. Подробности в журнале."; exit 1
  fi
  step "проверка"
  for i in $(seq 1 30); do
    if [ "$(docker inspect -f '{{.State.Health.Status}}' kkal 2>/dev/null)" = "healthy" ]; then
      status done "Обновлено: $FROM → $TO"; docker image prune -f >/dev/null 2>&1; exit 0
    fi
    sleep 3
  done
  status failed "Новая версия запустилась, но не отвечает. Проверь: docker compose logs kkal"
} >> "$LOG" 2>&1
