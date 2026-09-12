#!/usr/bin/env bash
# Камера в браузере доступна только на localhost или https, поэтому нужен сервер.
# bridge.py заодно превращает жесты в системные горячие клавиши.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$DIR/bridge.py" "${1:-8010}"
