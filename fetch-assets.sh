#!/usr/bin/env bash
# Скачивает MediaPipe и модель кисти. После этого интернет больше не нужен.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=0.10.14
CDN="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$VERSION"
HAND="https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
POSE="https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"

mkdir -p vendor/wasm models
echo "MediaPipe $VERSION…"
curl -sfL -o vendor/vision_bundle.mjs "$CDN/vision_bundle.mjs"
for f in vision_wasm_internal.js vision_wasm_internal.wasm \
         vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  curl -sfL -o "vendor/wasm/$f" "$CDN/wasm/$f"
done
echo "модель кисти…"
curl -sfL -o models/hand_landmarker.task "$HAND"
echo "модель скелета (режим Дэвида Лэйда)…"
curl -sfL -o models/pose_landmarker_lite.task "$POSE"

du -sh vendor models
echo "готово"
