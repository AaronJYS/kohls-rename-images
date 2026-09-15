# Building a distributable

Two ways to hand this tool to someone else. Pick based on who the recipient is.

| Recipient | Use |
| --- | --- |
| Has Python, comfortable with a terminal | [Wheel](#1-wheel-pipinstallable) |
| No Python, just wants to double-click / drag a folder | [Standalone executable](#2-standalone-executable-no-python-needed) |

The script has **no third-party dependencies** — everything it imports ships
with Python. That keeps both builds small and offline-friendly.

---

## 1. Wheel (pip-installable)

Produces `dist/kohls_rename_img-1.0.0-py3-none-any.whl`, a single file that
installs on Windows, macOS, and Linux alike.

### Build

```bash
python -m pip install --upgrade build
python -m build
```

`dist/` will then contain both the wheel (`.whl`) and an sdist (`.tar.gz`).
Ship the `.whl`.

### Install on the target machine

```bash
python -m pip install kohls_rename_img-1.0.0-py3-none-any.whl
```

This puts a `rename-images` command on their PATH:

```bash
rename-images "C:\path\to\folder" --dry-run
rename-images "C:\path\to\folder" --out "C:\path\to\Renamed"
```

To upgrade later, bump `version` in `pyproject.toml`, rebuild, and install with
`--force-reinstall`. To remove: `python -m pip uninstall kohls-rename-img`.

### Recommended: pipx instead of pip

If the recipient has `pipx`, it isolates the tool in its own environment so it
can never collide with their other Python packages:

```bash
pipx install kohls_rename_img-1.0.0-py3-none-any.whl
```

---

## 2. Standalone executable (no Python needed)

For coworkers who don't have Python at all. PyInstaller bundles the interpreter
into one file — roughly 7–15 MB depending on platform.

> **Cross-compiling is not possible.** A Windows `.exe` must be built on
> Windows; a macOS binary must be built on macOS. Build on the same OS the
> recipient uses (a Windows VM or a GitHub Actions `windows-latest` runner both
> work).

### Build

Run the script — it handles the whole thing (throwaway build environment,
PyInstaller install, build, cleanup):

```bash
./build_standalone.sh
```

On Windows, open **Git Bash** in this folder and run the same command. It prints
the path to the finished file when it's done.

<details>
<summary>What it runs, if you'd rather do it by hand</summary>

```bash
python -m pip install --upgrade pyinstaller
pyinstaller --onefile --console --name rename-images rename_images.py
```

</details>

The result lands in `dist/` — `dist\rename-images.exe` on Windows,
`dist/rename-images` on macOS/Linux. That single file is the whole deliverable;
`build/` and `rename-images.spec` are build scratch and don't need to ship.

### Using it

It's a command-line program, so it still needs arguments. Easiest handoff is to
ship the `.exe` next to a one-line batch file the user can drop a folder onto:

**`Rename Images.bat`** (Windows — drag a folder onto this file)

```bat
@echo off
"%~dp0rename-images.exe" %1
pause
```

Dropping a folder on that `.bat` passes the folder path as `%1`, and `pause`
holds the window open so the report stays readable.

### macOS note

An unsigned binary is blocked by Gatekeeper on first run. The recipient can
right-click → **Open** → **Open** once to allow it, or you can strip the
quarantine flag before sending:

```bash
xattr -d com.apple.quarantine dist/rename-images
```

---

## Shipping a custom color map

`COLOR_MAP` in `rename_images.py` is the built-in list of color codes. Two ways
to customize per-retailer:

- **Bake it in** — edit `COLOR_MAP` before building, so the defaults are right
  out of the box.
- **Ship a CSV** — hand over a two-column `colors.csv` (`code,name`) alongside
  the build and have the user pass `--colors colors.csv`. Entries merge into and
  override the built-in map, so no rebuild is needed when a color is added.

```csv
BK,Black
CG,Cognac
BUR,Burgundy
```

---

## Before you ship — smoke test

Run against a throwaway copy of a real image folder and confirm the output
names, then check the executable actually runs on a machine *without* Python:

```bash
rename-images ./sample_folder --dry-run
```

`--dry-run` writes nothing, so it's safe to run against anything. The real run
never modifies the source folder either — it renames inside a copy — but the
dry run is the fastest way to confirm the color map and role assignment are
behaving before handing the build to anyone.
