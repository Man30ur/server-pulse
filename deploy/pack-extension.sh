#!/usr/bin/env bash
set -euo pipefail

# Packages extension/ into dist/server-pulse-extension.zip for GitHub Releases or Chrome Web Store.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
EXT_DIR="${ROOT_DIR}/extension"
OUT_DIR="${ROOT_DIR}/dist"
OUT_ZIP="${OUT_DIR}/server-pulse-extension.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_ZIP"

python3 - "$EXT_DIR" "$OUT_ZIP" <<'PY'
import os, sys, zipfile

ext_dir, out_zip = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for root, _, files in os.walk(ext_dir):
        for name in sorted(files):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, ext_dir)
            zf.write(full, rel)
print(f"Created {out_zip} ({os.path.getsize(out_zip)} bytes)")
PY
