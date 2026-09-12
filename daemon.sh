#!/usr/bin/env bash
# Фоновый трекер: браузер без окна на экране. Жесты работают на любом столе,
# ничего не закрывает вид и не уезжает вместе с рабочим столом.
# Камеру одновременно может стримить только один процесс: закрой обычную
# страницу YeahTrack перед запуском.
set -u
PORT="${1:-8010}"
PROFILE="$HOME/.var/app/com.google.Chrome/yeahtrack-daemon"

# Профиль одноразовый и чистится при каждом старте. Иначе браузер
# восстанавливает вкладки прошлых запусков, и страница крутится в нескольких
# копиях сразу: втрое больше процессора и мусорные цифры в отчёте.
case "$PROFILE" in
  *yeahtrack-daemon) rm -rf "$PROFILE" ;;
  *) echo "подозрительный путь профиля, не чищу: $PROFILE" >&2 ;;
esac
mkdir -p "$PROFILE"

exec flatpak run --die-with-parent --branch=stable --arch=x86_64 --command=/app/extra/chrome com.google.Chrome \
  --headless=new \
  --no-sandbox \
  --user-data-dir="$PROFILE" \
  --use-fake-ui-for-media-stream \
  --autoplay-policy=no-user-gesture-required \
  --disable-gpu \
  --no-first-run --no-default-browser-check \
  --disable-extensions --disable-background-networking \
  --disable-background-timer-throttling \
  --renderer-process-limit=1 \
  --disable-software-rasterizer --mute-audio --no-pings --disable-sync \
  --disable-features=SpareRendererForSitePerProcess,Translate,MediaRouter,OptimizationHints \
  "http://localhost:$PORT/?daemon=1"
