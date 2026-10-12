#!/bin/bash
# One-time setup on the host: lets the «Обновить» button in the app's settings run deploy/update.sh.
# Usage: sudo ./deploy/install-updater.sh      Remove: sudo ./deploy/install-updater.sh --remove
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запусти через sudo"; exit 1; }
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NAME=kkal-update
if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now $NAME.path 2>/dev/null || true
  rm -f /etc/systemd/system/$NAME.path /etc/systemd/system/$NAME.service "$APP_DIR/data/updater/installed"
  systemctl daemon-reload; echo "Удалено"; exit 0
fi
chmod +x "$APP_DIR/deploy/update.sh"
mkdir -p "$APP_DIR/data/updater"
chown 1000:1000 "$APP_DIR/data" "$APP_DIR/data/updater"   # the app (user node, uid 1000) writes the request file
cat > /etc/systemd/system/$NAME.service <<UNIT
[Unit]
Description=Update kkal from git (requested from the app)
[Service]
Type=oneshot
ExecStart=$APP_DIR/deploy/update.sh
TimeoutStartSec=20min
UNIT
cat > /etc/systemd/system/$NAME.path <<UNIT
[Unit]
Description=Watch for update requests from the kkal app
[Path]
PathExists=$APP_DIR/data/updater/request
Unit=$NAME.service
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now $NAME.path
date +%s000 > "$APP_DIR/data/updater/installed"
echo "Готово. Кнопка «Обновить» в настройках приложения теперь работает."
echo "Журнал последнего обновления: $APP_DIR/data/updater/log"
