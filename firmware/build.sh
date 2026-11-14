#!/usr/bin/env bash
# Compile the ESP32 firmware, pack LittleFS, and produce a merged flash image
# plus an ESP Web Tools manifest. Run from anywhere.
set -euo pipefail
export PATH="${HOME}/.local/bin:${PATH}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKETCH="${ROOT}/firmware/WifiRadar"
DATA="${ROOT}/firmware/data"
OUT="${ROOT}/firmware/build-out"
FLASH="${ROOT}/flash"
FQBN="esp32:esp32:esp32:PartitionScheme=no_ota,FlashSize=4M"
FS_OFFSET=0x210000
FS_SIZE=0x1E0000

MKLITTLEFS="${HOME}/.arduino15/packages/esp32/tools/mklittlefs/4.0.2-db0513a/mklittlefs"
BOOTAPP0="${HOME}/.arduino15/packages/esp32/hardware/esp32/3.3.12/tools/partitions/boot_app0.bin"
# esptool 5 ships as a directory with an executable named esptool
ESPTOOL="$(find "${HOME}/.arduino15/packages/esp32/tools/esptool_py" -type f -name esptool | head -n1)"
if [[ -z "${ESPTOOL}" ]]; then
  ESPTOOL="$(find "${HOME}/.arduino15/packages/esp32/tools/esptool_py" -type f -name esptool.py | head -n1)"
fi

echo "== Packing web assets into ${DATA}"
rm -rf "${DATA}"
mkdir -p "${DATA}/js" "${DATA}/icons"
cp "${ROOT}/index.html" "${ROOT}/style.css" "${ROOT}/sw.js" \
   "${ROOT}/manifest.webmanifest" "${ROOT}/favicon.svg" "${DATA}/"
cp "${ROOT}/js/"*.js "${DATA}/js/"
cp "${ROOT}/icons/"*.png "${DATA}/icons/"
# gzip each text asset; the firmware serves *.gz with Content-Encoding
find "${DATA}" -type f \( -name '*.html' -o -name '*.css' -o -name '*.js' -o -name '*.svg' -o -name '*.webmanifest' \) -print0 \
  | while IFS= read -r -d '' f; do
      gzip -9 -c "${f}" > "${f}.gz"
      rm -f "${f}"
    done

mkdir -p "${OUT}" "${FLASH}"

echo "== Compiling ${FQBN}"
arduino-cli compile \
  --fqbn "${FQBN}" \
  --output-dir "${OUT}" \
  --build-property "build.partitions=no_ota" \
  --warnings default \
  "${SKETCH}"

echo "== Building LittleFS image (${FS_SIZE} bytes)"
"${MKLITTLEFS}" -c "${DATA}" -s "${FS_SIZE}" -p 256 -b 4096 "${OUT}/littlefs.bin"

APP_BIN="$(ls "${OUT}"/*.ino.bin | head -n1)"
BOOTLOADER="$(ls "${OUT}"/*bootloader*.bin | head -n1)"
PARTITIONS="$(ls "${OUT}"/*.partitions.bin | head -n1)"
if [[ -z "${APP_BIN}" || -z "${BOOTLOADER}" || -z "${PARTITIONS}" ]]; then
  echo "Missing compile artifacts in ${OUT}" >&2
  ls -la "${OUT}" >&2
  exit 1
fi

echo "== Merging flash image"
# esptool 5 uses merge-bin; fall back to merge_bin
MERGE_CMD=( "${ESPTOOL}" )
"${ESPTOOL}" --chip esp32 merge-bin \
  -o "${OUT}/wifi-radar-esp32.bin" \
  --flash-mode dio \
  --flash-freq 40m \
  --flash-size 4MB \
  0x1000 "${BOOTLOADER}" \
  0x8000 "${PARTITIONS}" \
  0xe000 "${BOOTAPP0}" \
  0x10000 "${APP_BIN}" \
  "${FS_OFFSET}" "${OUT}/littlefs.bin"

cp -f "${OUT}/wifi-radar-esp32.bin" "${FLASH}/wifi-radar-esp32.bin"

python3 - << PY
import json, os
flash = "${FLASH}"
manifest = {
  "name": "Wi-Fi Radar",
  "version": "1.0.0",
  "new_install_prompt_erase": True,
  "builds": [
    {
      "chipFamily": "ESP32",
      "parts": [
        {"path": "wifi-radar-esp32.bin", "offset": 0}
      ]
    }
  ]
}
with open(os.path.join(flash, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
size = os.path.getsize(os.path.join(flash, "wifi-radar-esp32.bin"))
print(f"Merged image: {size} bytes")
PY

echo "== Done"
ls -la "${FLASH}" "${OUT}"/*.bin
