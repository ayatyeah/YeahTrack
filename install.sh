#!/usr/bin/env bash
# Ставит YeahTrack как две пользовательские службы systemd:
#   yeahtrack         — мост жестов и раздача страницы
#   yeahtrack-daemon  — фоновый трекер рук без окна
# Права root не нужны, всё живёт в ~/.config/systemd/user.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8010}"
UNITS="$HOME/.config/systemd/user"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now yeahtrack-daemon.service yeahtrack.service 2>/dev/null || true
  rm -f "$UNITS/yeahtrack.service" "$UNITS/yeahtrack-daemon.service"
  systemctl --user daemon-reload
  echo "службы удалены"
  exit 0
fi

command -v python3 >/dev/null || { echo "нужен python3"; exit 1; }
python3 -c 'import dbus' 2>/dev/null || {
  echo "нужен python3-dbus:  sudo dnf install python3-dbus"; exit 1; }

mkdir -p "$UNITS"
for u in yeahtrack yeahtrack-daemon; do
  sed -e "s|@DIR@|$DIR|g" -e "s|@PORT@|$PORT|g" \
      "$DIR/systemd/$u.service.in" > "$UNITS/$u.service"
done

systemctl --user daemon-reload
systemctl --user enable --now yeahtrack.service

# автозапуск служб без графического входа
loginctl enable-linger "$USER" >/dev/null 2>&1 || true

echo
echo "мост:     http://localhost:$PORT"
systemctl --user --no-pager --lines=0 status yeahtrack.service | sed -n '1,3p'
echo
echo "фоновый трекер (займёт камеру, обычная страница её тогда не получит):"
echo "  systemctl --user enable --now yeahtrack-daemon"
echo "  systemctl --user stop yeahtrack-daemon      # отпустить камеру"
echo "  journalctl --user -u yeahtrack-daemon -f    # смотреть лог"
echo "снести всё:  ./install.sh --uninstall"
