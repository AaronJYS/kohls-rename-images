#!/usr/bin/env python3
"""
rename_images.py — copy an image folder and rename its contents to retailer spec.

Input filenames look like:   51104.BK (1).jpg
                              22003.Black (2).JPG
                              22003_Black (2).jpg
Output filenames look like:  51104_Black_MAIN.jpg
                             51104_Black_ALT.jpg
                             51104_Black_ALT2.jpg
                             51104_Black_GENAI_MAIN.jpg
                             51104_Black_DIMS.jpg

Colors can be written either as a short code (BK, BR, NV, ...) that gets looked
up in COLOR_MAP, OR spelled out in full (Black, Brown, Navy, ...) directly in
the filename. Spelled-out colors are matched case-insensitively against the
full names already in COLOR_MAP so "BLACK", "black", and "Black" all become
"Black" in the output. A spelled-out color that isn't recognized at all is
used exactly as typed and flagged in the unmapped-color warning at the end.

The ORIGINAL FOLDER IS NEVER TOUCHED. Everything happens in a copy.

Usage
-----
    python rename_images.py "C:\\path\\to\\folder"
    python rename_images.py "C:\\path\\to\\folder" --dry-run
    python rename_images.py "C:\\path\\to\\folder" --out "C:\\path\\to\\Renamed"
    python rename_images.py "C:\\path\\to\\folder" --colors colors.csv

A log of every old -> new name is written to _rename_log.csv inside the copy.
"""

import argparse
import csv
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

# ---------------------------------------------------------------------------
# 1. COLOR CODE -> COLOR NAME.  Add your codes here (or use --colors a CSV).
#    Filenames can use either the short code (left) OR the full name (right)
#    spelled out directly — e.g. "51104.BK (1).jpg" and "51104.Black (1).jpg"
#    both resolve to "Black". Matching against the full name is case-insensitive.
# ---------------------------------------------------------------------------
COLOR_MAP = {
    "BK": "Black",
    "BR": "Brown",
    "BN": "Bone",
    "TN": "Tan",
    "NV": "Navy",
    "GY": "Grey",
    "WH": "White",
    "RD": "Red",
    "BL": "Blue",
    "CG": "Cognac",
    "SD": "Saddle",
    "BUR": "Burgundy",
    "CAM": "Camel",
    "OLV": "Olive",
    "TAU": "Taupe",
    "YL": "Yellow",
    "TP": "Taupe",
    "CM": "Camel",
    "OL": "Olive",
    "ST": "Stone",
}

# ---------------------------------------------------------------------------
# 2. ROLE OVERRIDES — force a specific original file to a specific role.
#    Key = original filename (case-insensitive). Value = MAIN | DIMS | ALT | ALT3 ...
#    Anything not listed gets its role from sort order (see logic below).
# ---------------------------------------------------------------------------
ROLE_OVERRIDES = {
    # "51104.BK (6).jpg": "DIMS",
    # "51104.BK (3).jpg": "MAIN",
}

# Original filenames (case-insensitive) that contain an AI-generated model.
GENAI_FILES = {
    # "51104.BK (2).jpg",
}

# Fallback auto-detection: if these substrings appear in the ORIGINAL filename,
# the role/flag is applied automatically. Set to () to disable.
DIMS_KEYWORDS = ("dim", "measure", "ruler", "scale")
GENAI_KEYWORDS = ("genai", "gen-ai", "gen_ai", "aimodel", "ai-model")

# ---------------------------------------------------------------------------
# 3. BEHAVIOUR SWITCHES
# ---------------------------------------------------------------------------
# Requirement reads "ALT (ALT2, ALT3, etc.)" so the first alt is unnumbered.
# Set True if a retailer wants ALT1, ALT2, ALT3 instead.
NUMBER_FIRST_ALT = False

# The numbered shot that is always the MAIN view, e.g. "51104.BK (1).jpg".
MAIN_INDEX = 1

# If a style/color group has no (1), promote the lowest-numbered remaining shot
# and warn. Set False to leave the group without a MAIN and just report it.
PROMOTE_LOWEST_IF_NO_MAIN = True

# Force extensions to lowercase (.jpg -> .jpg). Some PIMs are picky.
LOWERCASE_EXTENSION = False

# Require the style number to contain at least one digit. Keeps ordinary
# filenames from being misread as style/color. Turn off if you have
# letters-only style numbers.
REQUIRE_DIGIT_IN_STYLE = True

# Maximum letters allowed in the color token. 4 is enough for codes like "BK"
# or "BUR"; raised to 20 so spelled-out names like "Black" or "Burgundy" also
# match.
COLOR_MAX_LEN = 20

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".gif", ".bmp"}

# ---------------------------------------------------------------------------

# 51104.BK (1)  /  51104.BK  /  51104_BK_1  /  DP-1234.BK (12)  /  51104.TN (3) dims
# 22003.Black (2)  /  22003_Black (2)  — spelled-out colors work the same way.
# The lookahead forces the style to contain at least one digit, so ordinary
# filenames like "weird-name.jpg" aren't mistaken for a style/color pair.
_STYLE = r"(?=[A-Za-z0-9\-]*\d)" if REQUIRE_DIGIT_IN_STYLE else ""
FILENAME_RE = re.compile(
    rf"""^\s*
        (?P<style>{_STYLE}[A-Za-z0-9][A-Za-z0-9\-]*?)   # style number
        [._\-\s]+
        (?P<color>[A-Za-z]{{1,{COLOR_MAX_LEN}}}\d?)     # color code or full name
        (?:                                             # optional index
            [._\-\s]*\((?P<idx_paren>\d+)\)
          | [._\-\s]+(?P<idx_plain>\d+)
        )?
        (?:[\s._\-]+.*)?                                # optional trailing text
        \s*$""",
    re.VERBOSE,
)


def load_color_map(csv_path):
    """Merge a two-column CSV (code,name) into COLOR_MAP."""
    with open(csv_path, newline="", encoding="utf-8-sig") as fh:
        for row in csv.reader(fh):
            if len(row) >= 2 and row[0].strip():
                COLOR_MAP[row[0].strip().upper()] = row[1].strip()


def parse(path):
    """Return (style, color_code, index, sku_raw, color_raw) or None if the
    name doesn't match.

    sku_raw is just the style number exactly as written in the source filename
    ("51104"), which is the prefix used in the renamed file.
    color_raw is the color exactly as typed ("BK", "Black", "BLACK", ...), used
    as a last-resort fallback if it can't be resolved through COLOR_MAP.
    """
    m = FILENAME_RE.match(path.stem)
    if not m:
        return None
    idx = m.group("idx_paren") or m.group("idx_plain")
    color_raw = m.group("color")
    return (
        m.group("style").upper(),
        color_raw.upper(),
        int(idx) if idx else 0,
        m.group("style"),
        color_raw,
    )


def has_keyword(name, keywords):
    low = name.lower()
    return any(k in low for k in keywords)


def alt_label(n):
    """n=1 -> 'ALT' (or 'ALT1'), n=2 -> 'ALT2', ..."""
    if n == 1 and not NUMBER_FIRST_ALT:
        return "ALT"
    return f"ALT{n}"


def assign_roles(files, notes=None, label=""):
    """
    files: list of (path, index) for ONE style+color group, already sorted.
    Returns dict {path: role}.

    The (1) shot is always MAIN. Everything else falls through to ALT, ALT2, ...
    in index order, renumbered contiguously so gaps in the source numbering
    (1, 2, 6, 10) don't leave holes in the ALT sequence.
    """
    roles = {}
    taken = set()
    notes = notes if notes is not None else []

    # Pass 1 — explicit overrides win over everything.
    for path, _ in files:
        forced = ROLE_OVERRIDES.get(path.name) or ROLE_OVERRIDES.get(path.name.upper())
        if forced:
            roles[path] = forced.upper()
            taken.add(forced.upper())

    # Pass 2 — keyword-detected dimension shots.
    for path, _ in files:
        if path in roles:
            continue
        if has_keyword(path.stem, DIMS_KEYWORDS) and "DIMS" not in taken:
            roles[path] = "DIMS"
            taken.add("DIMS")

    # Pass 3 — the (1) shot is the MAIN.
    if "MAIN" not in taken:
        free = [p for p, i in files if p not in roles]
        main = next((p for p, i in files if i == MAIN_INDEX and p in free), None)

        if main is None and len(files) == 1 and files[0][1] == 0 and free:
            main = free[0]  # single un-numbered image, e.g. "22890.CG.jpg"

        if main is None and free:
            if PROMOTE_LOWEST_IF_NO_MAIN:
                main = free[0]
                notes.append(
                    f"{label}: no ({MAIN_INDEX}) shot — promoted {main.name} to MAIN"
                )
            else:
                notes.append(f"{label}: no ({MAIN_INDEX}) shot — group has NO MAIN")

        if main is not None:
            roles[main] = "MAIN"

    # Pass 4 — everything else in index order: ALT, ALT2, ALT3, ...
    alt_n = 1
    for path, _ in files:
        if path in roles:
            continue
        while alt_label(alt_n) in taken:
            alt_n += 1
        roles[path] = alt_label(alt_n)
        taken.add(roles[path])
        alt_n += 1

    return roles


def is_genai(path):
    return (
        path.name in GENAI_FILES
        or path.name.upper() in {n.upper() for n in GENAI_FILES}
        or has_keyword(path.stem, GENAI_KEYWORDS)
    )


def resolve_color_name(code, color_raw, name_lookup, unknown_codes):
    """Turn a parsed color token into its canonical display name.

    1. Exact match against a short code in COLOR_MAP (e.g. "BK" -> "Black").
    2. Case-insensitive match against a full name already in COLOR_MAP's
       values (e.g. "BLACK"/"black"/"Black" -> "Black").
    3. Fall back to the color exactly as typed in the filename, and flag it
       as unmapped so it shows up in the end-of-run report.
    """
    if code in COLOR_MAP:
        return COLOR_MAP[code]
    if code in name_lookup:
        return name_lookup[code]
    unknown_codes.add(code)
    return color_raw


def build_name(sku, color_name, role, genai, ext):
    parts = [sku, color_name]
    if genai and role != "DIMS":  # spec has no GENAI variant for DIMS
        parts.append("GENAI")
    parts.append(role)
    if LOWERCASE_EXTENSION:
        ext = ext.lower()
    return "_".join(parts) + ext


def process(src, out, dry_run, strict):
    src = Path(src).expanduser().resolve()
    if not src.is_dir():
        sys.exit(f"Not a folder: {src}")

    dest = Path(out).expanduser().resolve() if out else src.parent / f"{src.name}_Kohl"
    if dest.exists() and not dry_run:
        sys.exit(f"Destination already exists, move or delete it first: {dest}")

    print(f"Source : {src}")
    print(f"Copy   : {dest}{'   (DRY RUN — nothing written)' if dry_run else ''}\n")

    if not dry_run:
        shutil.copytree(src, dest)
    work_root = dest if not dry_run else src

    # Reverse lookup so spelled-out full names (any case) normalize to the
    # canonical casing already used in COLOR_MAP's values.
    name_lookup = {v.upper(): v for v in COLOR_MAP.values()}

    # Group by (folder, style, color) so ALT numbering restarts per colorway.
    groups = defaultdict(list)
    group_sku = {}
    group_color_raw = {}
    skipped, unknown_codes = [], set()

    for path in sorted(work_root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in IMAGE_EXTS:
            continue
        parsed = parse(path)
        if not parsed:
            skipped.append(path)
            continue
        style, code, idx, sku_raw, color_raw = parsed
        key = (path.parent, style, code)
        groups[key].append((path, idx))
        group_sku.setdefault(key, sku_raw)
        group_color_raw.setdefault(key, color_raw)

    log, collisions = [], 0
    notes = []

    for (folder, style, code), files in sorted(groups.items()):
        files.sort(key=lambda t: (t[1], t[0].name.lower()))
        color_name = resolve_color_name(
            code, group_color_raw[(folder, style, code)], name_lookup, unknown_codes
        )
        sku = group_sku[(folder, style, code)]
        roles = assign_roles(files, notes, f"{sku} {color_name}")

        for path, _ in files:
            new_name = build_name(
                sku, color_name, roles[path], is_genai(path), path.suffix
            )
            target = folder / new_name

            if target != path and target.exists():
                stem, ext = target.stem, target.suffix
                n = 2
                while (folder / f"{stem}_DUP{n}{ext}").exists():
                    n += 1
                target = folder / f"{stem}_DUP{n}{ext}"
                collisions += 1

            print(f"  {path.name:<32} ->  {target.name}")
            log.append([str(path.relative_to(work_root)), target.name])
            if not dry_run and target != path:
                path.rename(target)

    # ---- report -----------------------------------------------------------
    print(f"\nRenamed {len(log)} image(s) across {len(groups)} style/color group(s).")
    if notes:
        print(f"  !! {len(notes)} group(s) need a look:")
        for n in notes:
            print(f"       {n}")
    if collisions:
        print(
            f"  !! {collisions} name collision(s) -> suffixed _DUP2 etc. Review these."
        )
    if skipped:
        print(
            f"  !! {len(skipped)} file(s) did not match the expected pattern and were left alone:"
        )
        for p in skipped[:15]:
            print(f"       {p.name}")
        if len(skipped) > 15:
            print(f"       ... and {len(skipped) - 15} more")
    if unknown_codes:
        print(
            f"  !! Color(s) not recognized in COLOR_MAP, used as typed: {', '.join(sorted(unknown_codes))}"
        )
        if strict:
            sys.exit("Aborting because --strict was set.")

    if not dry_run:
        with open(dest / "_rename_log.csv", "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["original", "renamed"])
            w.writerows(log)
        print(f"\nLog written to {dest / '_rename_log.csv'}")


def main():
    ap = argparse.ArgumentParser(
        description="Copy an image folder and rename to retailer spec."
    )
    ap.add_argument("folder", help="Path to the source image folder")
    ap.add_argument(
        "--out", help="Destination folder (default: <folder>_RENAMED next to it)"
    )
    ap.add_argument(
        "--colors", help="CSV of code,name pairs to merge into the color map"
    )
    ap.add_argument("--dry-run", action="store_true", help="Preview only, copy nothing")
    ap.add_argument(
        "--strict", action="store_true", help="Fail if any color code is unmapped"
    )
    args = ap.parse_args()

    if args.colors:
        load_color_map(args.colors)
    process(args.folder, args.out, args.dry_run, args.strict)


if __name__ == "__main__":
    main()
