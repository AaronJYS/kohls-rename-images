# JYS file tools

## Web app

A static browser app with two tools, selected from the top navigation:
**Image name converter** and **PDF to Excel**. All file processing happens on
the user's device. No files are uploaded and no installation is required.
Switching tools keeps the current selections and work in memory; reloading the
page clears them.

### Image name converter

Uses the naming rules from `rename_images.py`. Folder access requires desktop
Chrome or Edge on Windows or macOS.

1. Press **Select folder** and grant access to the source folder.
2. Review the filename preview and warnings. Optionally load a custom color CSV
   or require every color to be recognized.
3. Press **Create renamed folder**. Keep the tab open until completion.
4. Find `<source>_Kohl` **inside the selected folder**, along with the preserved
   subfolder structure and `_rename_log.csv`.

Existing output folders are not overwritten: later runs use `_Kohl_2`,
`_Kohl_3`, etc. Generated folders contain a `.kohls-renamer.json` marker so future
scans exclude them, including incomplete runs. Keep this marker in the output.
Selecting a generated output itself is rejected; select its original parent.

### AAFES PDF to Excel

Open **PDF to Excel** (or `/#pdf-to-excel`), then select or drop one or more
text-based AAFES **Stand-alone Order** PDFs. Extraction starts automatically.
Review the rows and any warnings, then choose **Download Excel** for the selected
PDF or **Download all (ZIP)** for all successful workbooks. Failed PDFs are listed
individually and do not prevent the remaining files from being processed.

Each `<source>_extracted.xlsx` contains a **Purchase Orders** sheet with:

| Column | Source / value | Excel type |
| --- | --- | --- |
| Trading Partner | AAFES in the centered page heading | Text |
| Document Type | Stand-alone Order in the upper-right header | Text |
| Document Num | PO number beneath the document type | Text |
| Alt Document | `Vendor <Vendor #> MF` | Text |
| Store Num | Store # in the shipping address | Text |
| Currency Code | Intentionally blank | Blank |
| Amount | Full printed PO total, repeated per line | Number, two decimal places |
| Date Processed | Local calendar date when the batch is selected | Date (`mm/dd/yyyy`) |
| Date Ack | Date directly beneath the PO number | Date (`mm/dd/yyyy`) |
| Business System Code | `211` | Number |
| Integration Status | `0` | Number |
| User Defined Field #1 | SKU from the line-item row | Text |
| User Defined Field #2 | UPC from the line-item row | Text |
| User Defined Field #3 | Requested Ship in the delivery schedule | Date (`m/d/yyyy`) |

The header is frozen, filters are enabled, and column widths fit the data.
Identifiers preserve leading zeros. **Amount repeats the full order total on
every line; count it only once per Document Num when totaling orders.**
Workbooks are downloaded through the browser; source
PDFs are not changed. Duplicate output names inside ZIPs receive `_2`, `_3`, etc.

The coordinate-based parser is ported from
[AAfes_Pdf_to_Excel](https://github.com/JYS-Enterprise-Inc/AAfes_Pdf_to_Excel),
commit `56ef7bc2412249e4188d6196bae56cb80b845b83`. It locates the PO number in the
top-right header, detects table columns from their positions, groups words into
rows with a 2.5-point tolerance, follows continuation pages, reads vendor styles
and requested dates, removes repeated `(PO, line number)` pairs, and totals
amounts within each PDF. The requested 14-column mapping replaces the original
eight-column export while retaining one row per unique PO line and one workbook
per PDF. See [the extraction mapping](docs/pdf-to-excel-mapping.md) for layout
anchors, derivations, and the interpretation of the Boardfish annotations.

Browser adaptations:

- PDF.js extracts positioned text in a local worker; JSZip packages Excel's
  standard XML files. Both are pinned and bundled in `web/vendor/` with licenses.
- Dates, store, and column layout reset when a different PO begins, preventing
  metadata from leaking from the previous PO when headers are missing.
- The Vendor # value is found within its header cell, including when the label
  is centered and the value is left-aligned. This is distinct from Vendor's Style #.
- Printed totals below the final Package Description block are checked against
  the sum of unique line amounts. A mismatch produces a warning; Amount uses
  the printed total. If no printed total is found, the original calculated
  total is used and a review warning is shown.
- Date Processed is captured once per file selection in the user's local
  timezone. Date Ack comes from the PO header, not the footer or requested dates.
- Unreadable lines, missing fields, unsupported pages, and conflicting duplicate
  lines produce review warnings. For duplicate lines, the first copy is kept.
- Leading-zero identifiers and formula-looking text are always written as text.
- The browser processes one PDF at a time. Stop cancels the current extraction;
  already-completed PDFs remain available. Remove a stopped file and add it again
  to retry.

**Limits:** text-based AAFES layouts only; no OCR. Scans, photographs, damaged
PDFs, and password-protected files require correction before conversion. Up to
50 PDFs can be selected, with limits of 50 MB, 2,000 pages, and 100,000 extracted
lines per PDF. PDF-to-Excel uses a standard file picker and does not require the
image tool's folder-access API. Use a current desktop browser. Keep the tab open
while processing or preparing downloads.

### Run locally

From this repository:

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory web
```

On Windows, use `py` instead of `python3` if needed. Open
`http://127.0.0.1:4173/` in Chrome or Edge. Opening `index.html` directly as a
`file://` URL is not supported. Production hosting must use HTTPS.

### Develop and test

The browser app has no build step or package-install requirement. PDF.js and
JSZip are served locally from `web/vendor/`. Tests require Node.js
22+ and Python 3.9–3.12 (`python3` on PATH, or set `PYTHON` to its executable).

```bash
npm test
```

- `web/renamer.js` — pure filename parsing, role assignment, collision planning,
  color CSV parsing, and log generation; defaults mirror the Python tool.
- `web/folder-io.js` — folder snapshot, output exclusion, streamed copying,
  progress, cancellation, and completion markers.
- `web/app.js` — folder-picker permissions, preview, options, and UI state.
- `web/tool-nav.js` — navigation that preserves each tool's in-memory state.
- `web/aafes-parser.js` — pure AAFES extraction and per-order totals.
- `web/pdf-reader.js` — PDF.js text positioning, limits, progress, and cancellation.
- `web/excel-export.js` — typed XLSX output and batch ZIP downloads.
- `web/pdf-app.js` — PDF selection, per-file status, preview, and downloads.
- `web/index.html` and `web/styles.css` — interface and responsive styling.
- `tests/` — Python parity checks and filesystem integration tests using temporary
  files, including disk-write failures, cancellation, and source preservation.
- `tests/aafes.test.mjs` — AAFES parser regressions, original-script fixture
  parity, input validation, and independent ZIP/XML checks of Excel output.
  All PDF fixtures are synthetic. See `tests/fixtures/README.md` for provenance.

The snapshot and complete rename plan are prepared before an output directory is
created, preventing recursive self-copying. Large files are streamed; only file
metadata and the plan are held for the whole folder. Tests run on Windows,
macOS, and Linux before Pages deployment.

### GitHub Pages deployment

In **Settings → Pages**, choose **GitHub Actions** as the source. The
`.github/workflows/pages.yml` workflow tests changes and publishes **only `web/`**
after a successful push to `main`. Pull requests run tests without deploying.
The Python source, tests, and local files are not part of the published site.

### Image converter behavior and limits

- Supported images are JPG/JPEG, PNG, TIF/TIFF, WebP, GIF, and BMP. File bytes and
  extensions are preserved; images are not converted. Other files and image names
  that do not match the pattern are copied unchanged.
- Original files are not modified. The only addition to the source is the new
  output directory. Folder permissions cover its contents; select only the folder
  you want processed.
- Strict color validation blocks copying **before any output is created**.
- Collisions are resolved in the preview with `_DUP2`, `_DUP3`, etc. Comparisons
  are case-insensitive for Windows and common macOS filesystems. Existing source
  rename logs are preserved; the new log receives a suffix if necessary.
- Color CSVs accept an optional `code,name` header, quoted fields and a UTF-8 BOM.
  Invalid output names are rejected before copying. Role overrides and behavior
  switches can be changed in `web/renamer.js`; parity tests flag drift from Python.
- A stopped or failed run may leave a partial output folder. The UI reports the
  failure, and its marker stays `incomplete`. It can be removed manually. Rescan
  the source and retry to make a fresh output.
- Source files changed after the preview cause a visible error when copied.
  Newly added files require another scan. Do not edit the source during copying.
- Filesystem timestamps, permissions, extended attributes, and symbolic links
  are not preserved like a native filesystem copy. Locked files, cloud-only files,
  unavailable drives, and disk limits can prevent completion.
- Safari and Firefox show an unsupported-browser message. Browser permissions
  may need renewal. Keep the tab open; background or interrupted tabs cannot
  guarantee completion. Folder operations are not atomic across the whole run.

## Python command-line tool

Copies an image folder and renames its contents to retailer spec. **The original
folder is never touched** — every rename happens inside a copy.

```
51104.BK (1).jpg      ->  51104_Black_MAIN.jpg
51104.BK (2).jpg      ->  51104_Black_ALT.jpg
51104.BK (3).jpg      ->  51104_Black_ALT2.jpg
22003_Black (1).jpg   ->  22003_Black_MAIN.jpg
51104.BK dims.jpg     ->  51104_Black_DIMS.jpg
```

Colors may be written as a short code (`BK`, `NV`, `CG`) or spelled out
(`Black`, `BLACK`, `black`) — both resolve to the canonical name.

## Usage

```bash
rename-images "C:\path\to\folder"
rename-images "C:\path\to\folder" --dry-run
rename-images "C:\path\to\folder" --out "C:\path\to\Renamed"
rename-images "C:\path\to\folder" --colors colors.csv
rename-images "C:\path\to\folder" --strict
```

Without an install, run the script directly:

```bash
python rename_images.py "C:\path\to\folder" --dry-run
```

| Flag        | Effect                                                          |
| ----------- | --------------------------------------------------------------- |
| `--dry-run` | Preview only — copies nothing, writes nothing                   |
| `--out`     | Destination folder (default: `<folder>_Kohl` beside the source) |
| `--colors`  | CSV of `code,name` pairs merged into the built-in color map     |
| `--strict`  | Exit non-zero if any color code is unmapped                     |

A `_rename_log.csv` of every old → new name is written into the copy.

## Roles

`(1)` is always `MAIN`. Remaining shots become `ALT`, `ALT2`, `ALT3`… in index
order, renumbered contiguously so gaps in the source numbering leave no holes.
Filenames containing a dimension keyword (`dim`, `dimension`, `measure`,
`ruler`, `scale`) become `DIMS`; those containing a GenAI keyword (`genai`,
`gen-ai`, `ai-model`…) get a `GENAI` segment. `ROLE_OVERRIDES` and `GENAI_FILES`
at the top of `rename_images.py` force specific files when the automatic pass
gets it wrong.

## Building a distributable

See [BUILD.md](BUILD.md) — wheel for Python users, PyInstaller executable for
everyone else.
