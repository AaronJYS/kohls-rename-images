#!/usr/bin/env bash
#
# build_standalone.sh — build the standalone rename-images executable.
#
# Run this from the project folder:
#
#     ./build_standalone.sh
#
# It creates a throwaway virtual environment, installs PyInstaller into it,
# and produces ONE self-contained file in dist/ that runs on a machine with
# no Python installed.
#
# NOTE: you can only build for the OS you are running on. A Windows .exe must
# be built on Windows (run this in Git Bash), a Mac binary on a Mac.

set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="rename-images"
SCRIPT="rename_images.py"
VENV=".build-venv"

# --- 1. find a usable Python -------------------------------------------------
PY=""
for candidate in python3 python py; do
    if command -v "$candidate" >/dev/null 2>&1; then
        PY="$candidate"
        break
    fi
done

if [ -z "$PY" ]; then
    echo "ERROR: Python not found. Install Python 3.8+ from https://python.org"
    echo "       (On Windows, tick 'Add Python to PATH' during install.)"
    exit 1
fi

echo "==> Using $($PY --version 2>&1) at $(command -v "$PY")"

if [ ! -f "$SCRIPT" ]; then
    echo "ERROR: $SCRIPT not found. Run this script from the project folder."
    exit 1
fi

# --- 2. throwaway build environment -----------------------------------------
echo "==> Creating build environment in $VENV/"
rm -rf "$VENV"
"$PY" -m venv "$VENV"

# Windows venvs put executables in Scripts/, everyone else in bin/
if [ -x "$VENV/bin/python" ]; then
    VPY="$VENV/bin/python"
else
    VPY="$VENV/Scripts/python.exe"
fi

echo "==> Installing PyInstaller (needs internet, ~30s)"
"$VPY" -m pip install --quiet --upgrade pip
"$VPY" -m pip install --quiet --upgrade pyinstaller

# --- 3. build ----------------------------------------------------------------
echo "==> Building $APP_NAME (this takes a minute)"
rm -rf build "$APP_NAME.spec" "dist/$APP_NAME" "dist/$APP_NAME.exe"
"$VPY" -m PyInstaller \
    --onefile \
    --console \
    --name "$APP_NAME" \
    --clean \
    "$SCRIPT"

# --- 4. tidy up and report ---------------------------------------------------
rm -rf build "$APP_NAME.spec" "$VENV"

if [ -f "dist/$APP_NAME.exe" ]; then
    OUT="dist/$APP_NAME.exe"
else
    OUT="dist/$APP_NAME"
    # Stop macOS Gatekeeper from blocking the file on the recipient's machine.
    if [ "$(uname)" = "Darwin" ]; then
        xattr -d com.apple.quarantine "$OUT" 2>/dev/null || true
    fi
fi

echo
echo "==> Done. Send this one file to whoever needs it:"
echo
echo "       $(pwd)/$OUT     ($(du -h "$OUT" | cut -f1))"
echo
echo "    Quick test (previews only, changes nothing):"
echo
echo "       $OUT /path/to/image/folder --dry-run"
echo
