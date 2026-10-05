# JYS file tools

## Web app

A static browser app with four tools, selected from the top navigation:
**Image name converter**, **PDF to Excel**, **Hamrick’s PO to 940**, and
**Synapse Order Verifier**. All processing happens on
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
Review the rows, then choose **Download Excel** for the selected
PDF or **Download all (ZIP)** for all successful workbooks. Failed PDFs are listed
individually and do not prevent the remaining files from being processed.
The interface shows file selection, the item preview, and download controls.
The file switcher appears when multiple converted PDFs are available.

Each `<source>_extracted.xlsx` contains two sheets. **Purchase Orders** has one row
per line item and these columns, in order, matching the preview:

| Column | Source / value | Excel type |
| --- | --- | --- |
| PO | Document number beneath the document type | Text |
| Vendor's Style | Code directly beneath `Vendor's Style #` for the item | Text |
| SKU | First number under `SKU #` for the item, with leading zeros preserved | Text |
| Qty | First number in the item's Qty column | Number |
| Unit Price | Value in the item's Price column | Number, two decimal places |
| Total Qty for same PO | Sum of Qty for all items with this PO in the PDF | Number |
| Total Price for same PO | Sum of item prices (Unit Price × Qty) for this PO in the PDF | Number, two decimal places |
| Total Qty for same SKU | Sum of Qty for all items with this SKU across POs in the PDF | Number |
| Total Price for same SKU | Sum of item prices (Unit Price × Qty) for this SKU across POs in the PDF | Number, two decimal places |
| Requested Ship Date | Date under Requested Ship | Date (`yyyy/mm/dd`) |
| Requested Delivery Date | Date under Requested Delivery | Date (`yyyy/mm/dd`) |

**Summary** has one row per unique, nonblank Vendor's Style, in first-seen order:

| Column | Source / value | Excel type |
| --- | --- | --- |
| Vendor's Style | Item's Vendor's Style, with leading zeros preserved | Text |
| Total Qty | Sum of Qty for all items with this style across POs in the PDF | Number |
| Unit Price | Source unit price shared by all items with this style in the PDF | Number, two decimal places |
| Total Price | Sum of item prices (Unit Price × Qty) for this style across POs in the PDF | Number, two decimal places |

Summary also lists **All POs** in **F4**, two columns to the right of Total Price,
with column E left blank. Unique PO numbers start at **F5** in their first-seen
order in Purchase Orders. The list includes POs whose items have missing styles
and preserves leading zeros. Each workbook lists only its own PDF's POs.

Both sheets have frozen headers and column widths that fit the data, with no
header sort/filter dropdowns. Purchase Orders inserts one blank row before each
item whose PO differs from the previous item, preserving source order. There is
no spacer before the first item or after the last. Summary keeps styles in
first-seen order without spacer rows.
Cells use plain Excel styling with visible gridlines, no colored fills or custom
borders, and regular headers. Date and number formats are preserved.
PO, style, and SKU identifiers preserve leading zeros. Multiple items from the same
PO remain separate rows, in source order. PO and SKU totals repeat on each matching
item row; the summary totals each Vendor's Style once. All totals are calculated separately
for each PDF. Price totals sum
each item's unit price times quantity, rounded to cents per item; printed line
amounts and full PO totals do not replace these calculations. Duplicate PO/line
pairs are counted once. Items missing a SKU remain in Purchase Orders with blank
SKU total cells. Items missing a Vendor's Style remain in Purchase Orders and are
excluded from the summary. Repeated PO and SKU totals should not be summed again
down the detail sheet.
Every item with the same Vendor's Style must have the same unit price within its PDF.
Conflicting prices block the Excel or ZIP download and display an error naming
the style, both prices, and their PO numbers.
Workbooks are downloaded through the browser; source
PDFs are not changed. Duplicate output names inside ZIPs receive `_2`, `_3`, etc.

The coordinate-based parser is ported from
[AAfes_Pdf_to_Excel](https://github.com/JYS-Enterprise-Inc/AAfes_Pdf_to_Excel),
commit `56ef7bc2412249e4188d6196bae56cb80b845b83`. It locates the PO number in the
top-right header, detects table columns from their positions, groups words into
rows with a 2.5-point tolerance, follows continuation pages, reads vendor styles
and requested dates, removes repeated `(PO, line number)` pairs, and totals
amounts within each PDF. Each workbook contains eleven detail columns and a
four-column Vendor's Style summary with an All POs list. See [the extraction mapping](docs/pdf-to-excel-mapping.md)
for layout anchors and derivations.

Browser adaptations:

Parser diagnostics remain available internally for validation; the interface
shows conversion errors without an issues dropdown or review-note badges.

- PDF.js extracts positioned text in a local worker; JSZip packages Excel's
  standard XML files. Both are pinned and bundled in `web/vendor/` with licenses.
- Extraction uses unrotated page coordinates normalized to a consistent width,
  so stored page rotations and uniformly scaled PDFs retain the same layout anchors.
- Quantity and unit price validation share one number parser. Accounting negatives,
  currency symbols, dot/comma decimals, and properly grouped thousands are
  supported. `1,234` keeps the AAFES thousands meaning; `12,50` means `12.50`.
- Dates, store, and column layout reset when a different PO begins, preventing
  metadata from leaking from the previous PO when headers are missing.
- Vendor's Style comes from the item's detail block, not its SKU or the order's
  Vendor #. Inline style values are also supported.
- Printed totals below the final Package Description block are checked against
  the sum of unique line amounts. A mismatch produces a warning. This diagnostic
  does not change the exported price totals. Missing printed amounts do not
  prevent conversion when quantity and unit price are readable.
- The first standalone amount after Package Description closes that block.
  Later numeric footer values are ignored with a review warning and cannot
  overwrite the printed total, even if a footer value matches the line sum.
- Both requested dates come from the delivery schedule and carry forward only
  within the same PO. Missing dates stay blank with a review warning.
- Unreadable lines, missing fields, unsupported pages, and conflicting duplicate
  lines produce review warnings. For duplicate lines, the first copy is kept.
- Conflicting requested dates produce a review warning, and each exported item
  retains its own extracted dates.
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

### Hamrick’s PO to 940

Open **Hamrick’s PO to 940** (or `/#hamricks-po-to-940`) and select or drop one
`.xls`, `.xlsx`, or `.xlsm` purchase order. Select a worksheet when the workbook
contains several. Review all stores, then select **Download CSV** to
download the complete selected worksheet. The preview shows all populated rows
without pagination or blank spacer rows. Preview and downloads always include
every store with nonzero item quantities in that worksheet.
Large previews render the rows near the scroll position to stay responsive;
scrolling still reaches every row, and CSV export always uses the complete data.

The converter builds the 940 template using these rules:

- Detect `CORRECTED STYLE#` or `CORRECT STYLE#`, `Style Number`, and positive
  `Store i` headings, either on one row or split over two adjacent rows. Header
  and PO-label searches ignore capitalization and extra whitespace. Spaces between
  heading parts are optional: `CorrectStyle#`, `CorrectedStyle #`, `StyleNumber`,
  and `Store12` also match. Headings must match the entire cell after trimming;
  a split store number must be in the cell directly below `Store`.
  Prefer the corrected-style column for item Facility values; use the same row's
  `Style Number` when the corrected column is missing, its value is blank, or its
  value contains `no` or `change`, ignoring capitalization. These are substring
  checks, including inside longer words, and apply only to corrected-style values.
  Skip rows with no usable style value. At least one style column is required. Preserve
  identifiers' original casing and leading zeros, and keep duplicate styles as
  separate source rows.
- Process store columns from left to right, including nonconsecutive store numbers.
  Preserve source order for each store's styles. Ignore columns that are not stores.
- Emit the 29 specified 940 column headings. Each store gets an `H` header with
  facility `RED`, priority `A`, and company `HAMRICK'S`.
- Find the first cell containing the substring `PO`, ignoring capitalization,
  by scanning rows from top to bottom and cells from left to right. Take the
  first nonblank cell to its right on the same row as the Customer PO. Preserve
  formatted leading zeros. Reference is `PO-i`, with at least two digits for
  the store number.
- Starting below the **first matching PO label**, scan downward in that label's
  column for labels containing `department`, `ship`, or `cancel`, ignoring
  capitalization. Read each value from the PO-value column on the
  matching row. Department becomes Ship to Contact name. Stop once department is
  nonempty and both date values are nonempty and nonzero. Repeated labels replace
  earlier values until all three are populated. Throw an error if the scan's
  zero-based row index `x` exceeds 300 before the completion check, following the
  `input[x + 1]` scan. The workbook reader still permits at most 300 worksheet rows.
  Export dates as `yyyymmdd`. Excel serial dates respect the workbook's 1900 or
  1904 date system; a zero serial is treated as missing by this lookup. Text dates support `YYYY-MM-DD`,
  `YYYY/MM/DD`, `YYYYMMDD`, `MM/DD/YYYY`, and `D-MMM-YYYY`, including two-digit
  years for the last two formats (00–29 mean 2000–2029; 30–99 mean 1930–1999).
- Find the first cell matching `1 Gaffney` or `1Gaffney`, ignoring capitalization
  and surrounding whitespace. Starting there, read the store directory down that
  same column through row index 300. Match each exported store by its complete
  unpadded number at the beginning of the cell text. Ship to Address2 is `Store `
  followed by that cell's trimmed text, preserving its casing and internal spacing:
  `6 Columbia` becomes `Store 6 Columbia`. Missing directory entries cause an error.
  Stores with no item lines need no directory entry. Reference still uses the
  store number padded to at least two digits.
- Fill Ship to Address 1 with `742 Peachoid Road`, City with `Gaffney`, State
  with `SC`, Postal Code with `29341`, Country with `USA`, Shipment Type with `L`,
  Carrier with `CITY`, and Shipment Terms with `COL`. Leave Third Party Account #
  through Bill to Country inclusive empty.
- Emit consecutive item rows with `L`, style, nonzero quantity, and `EA`.
  Skip blank/zero allocations and omit stores with no entries, including their
  subheaders. Do not emit blank spacer rows. A worksheet with no entries produces
  only the column headings. Signed entries that sum to zero are still retained.

CSV uses 29 fields per row, quoted commas/newlines, and CRLF line endings.
No empty rows or empty store orders are emitted. Formula-looking source values
must be reviewed before CSV export; the converter does not silently change them.

Parsing happens in a local worker and can be stopped. Missing or ambiguous
headings, missing PO labels or values, missing/invalid shipping dates, invalid
quantities, Excel error cells, and formulas without saved results produce actionable errors.
Macros are never executed or retained in exports. Formula results are read from
the saved workbook; recalculate and save in Excel first if formulas have changed. Nonmatching worksheets
show their own errors while valid worksheets remain available.
Stop and the 60-second deadline cover both the initial file read and parsing.
Incomplete XLSX/XLSM containers are rejected before entering the Excel parser, and a
failed or stopped read can be retried immediately.

Limits: 25 MB per workbook, 30 worksheets, 300 rows and 300 columns per
worksheet, and 100,000 generated rows per
workbook. Excel `.xls`, `.xlsx`, and `.xlsm` files are supported; encrypted, damaged,
or text files renamed to `.xls` must be resaved in Excel.

SheetJS CE 0.20.3 and its legacy codepage support are bundled locally with their
license in `web/vendor/sheetjs/`. Customer samples and generated outputs are not
included in the repository. All committed Hamrick’s tests use synthetic data.

### Synapse Order Verifier

1. Copy a Synapse grid with its header row and up to 100 order entries.
2. Paste into **Order data**, then use the editable **Item / Price** grid under
   **Paste price list**. Paste a list of items into an Item cell, a list of prices
   into a Price cell, or a two-column Excel range into an Item cell. Values fill
   downward from that cell; blank cells and rows preserve alignment. Rows expand
   automatically up to 500 entries, with a blank row available for the next item.
   Click any cell to edit it; Tab moves between cells and Enter or the up/down
   arrows move within a column. Lists can include their column headers.
   The earlier `Item / Quantity / Price` format is also accepted: Item and Price
   fill the grid, and Quantity is ignored.
   In each Item code, spaces and hyphens become periods, repeated periods collapse,
   and a period remains only when immediately followed by an ASCII letter (A–Z or
   a–z). Cleanup applies only to newly pasted Item text. Manual edits, including
   spaces and hyphens, stay as entered, even when more rows are pasted later.
   Prices keep their decimals and signs; tabs and line
   breaks preserve columns and rows.
3. Review **Item**, **Quantity Ship**, **Quantity Picked**, and **Wholesale Unit
   Price**. Prices come from the single price-list entry with the same Item.
   After this conversion, matching requires an exact Item, including suffixes
   and casing.
4. Press **Copy for Excel**, then paste into an Excel worksheet. Only **Item**,
   **Quantity Ship**, and **Wholesale Unit Price** are copied, with numeric prices
   and **no headers or TOTAL row**. The selected fallback text uses the same
   output. Selecting text in the review and using the normal copy command copies
   only the selection. Rows with both **Quantity Ship** and **Quantity Picked**
   equal to zero are omitted from the Excel copy but stay visible in the review.
   Other rows are retained, and missing export cells stay blank. If every row has
   both quantities at zero, there is nothing to copy and the copy button is disabled.

Rows remain in their original order, including repeated items. Columns are matched
by header name; empty source cells and quoted descriptions do not shift the data.
Numeric quantities support decimals, signs, and comma thousands separators. Totals
use exact decimal arithmetic and stay visible in the review; the price total is
the sum of the available unit prices. A missing Item, quantity, or price highlights
the review row red. Unmatched Items and duplicate price-list entries leave the
price blank and highlight the row, even when duplicate prices agree. Zero is a
valid value. Totals include available values; an entirely missing column has no total.
Nonnumeric values, missing required Synapse headers, and pastes over the row limits
are rejected. Each paste is limited to 2 MB. A paste that exceeds the grid's
row or column limits leaves existing cells intact. An invalid edit removes stale
results. Both inputs stay in memory when switching tabs; each **Clear** button
removes its own input, and a page reload clears both.

### Run locally

From this repository:

```bash
python3 serve.py
```

On Windows, use `py` instead of `python3` if needed. Open
`http://127.0.0.1:4173/` in Chrome or Edge. The development server disables caching
for the page, scripts, and workers; reload the page after changing the code.
`npm start` runs the same server. Opening `index.html` directly as a
`file://` URL is not supported. Production hosting must use HTTPS.

### Develop and test

The browser app has no build step or package-install requirement. PDF.js,
JSZip, and SheetJS are served locally from `web/vendor/`. Tests require Node.js
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
- `web/hamricks-converter.js` — store/style detection, 940 template rules, and CSV output.
- `web/hamricks-reader.js` and `web/hamricks-worker.js` — local Excel parsing and validation.
- `web/hamricks-zip.js` — ZIP bounds checks and compatibility with streamed entries.
- `web/hamricks-file.js` — cancellable file reads, worker cleanup, and a shared timeout.
- `web/hamricks-preview.js` — cached previews with bounded rendering for large worksheets.
- `web/hamricks-export.js` — typed 940 Excel output for programmatic use and validation.
- `web/hamricks-app.js` — workbook selection, worksheet/store previews, and downloads.
- `web/synapse-parser.js` — order/price grid validation, unique Item matching, exact totals, and Excel-ready text/HTML.
- `web/synapse-app.js` — paste inputs, price/quantity review, missing-value highlighting, and clipboard export.
- `web/synapse-price-grid.js` — editable Item/Price cells, column/range paste, and automatic row expansion.
- `web/index.html` and `web/styles.css` — interface and responsive styling.
- `scripts/version-asset-urls.mjs` — adds the deployed commit to module, worker,
  and stylesheet URLs during Pages deployment.
- [Shared interface conventions](docs/ui-conventions.md) — typography, spacing,
  reusable controls, and wording rules for all tabs.
- `tests/` — Python parity checks and filesystem integration tests using temporary
  files, including disk-write failures, cancellation, and source preservation.
- `tests/aafes.test.mjs` — AAFES parser regressions, original-script fixture
  parity, input validation, and independent ZIP/XML checks of Excel output.
  All PDF fixtures are synthetic. See `tests/fixtures/README.md` for provenance.
- `tests/hamricks.test.mjs` — synthetic XLS/XLSX/XLSM inputs, ignored VBA data,
  PO and shipping metadata, date systems, store allocation, blank rows,
  CSV escaping, and typed Excel output.
- `tests/hamricks-reliability.test.mjs` — truncated and malformed archives,
  file/worker failures, cancellation, timeout, retry, and preview window boundaries.
- `tests/hamricks-preview.test.mjs` — preview reuse, complete scrolling, worksheet
  changes, clearing, text resizing, and browser API fallbacks.
- `tests/version-asset-urls.test.mjs` — deploy URL versioning, including modules
  and workers loaded after the page, with vendor files left unchanged.
- `tests/synapse.test.mjs` — synthetic clipboard grids, unique price matching,
  100/500-row limits, missing values, exact totals, and three-column clipboard formats.
- `tests/synapse-app.test.mjs` — native selection copying and the dedicated Excel
  export remain independent.

Hamrick’s regression fixtures are generated in memory. Stress-test inputs,
downloads, screenshots, and reports belong in an OS temporary directory outside
the repository.

The snapshot and complete rename plan are prepared before an output directory is
created, preventing recursive self-copying. Large files are streamed; only file
metadata and the plan are held for the whole folder. Tests run on Windows,
macOS, and Linux before Pages deployment.

### GitHub Pages deployment

In **Settings → Pages**, choose **GitHub Actions** as the source. The
`.github/workflows/pages.yml` workflow tests changes and publishes **only `web/`**
after a successful push to `main`. Pull requests run tests without deploying.
The Python source, tests, and local files are not part of the published site.

Before publishing the production and beta sites, the workflow appends
`?v=<commit>` to each first-party module, worker, and stylesheet URL. GitHub
Pages lets browsers reuse files for up to 10 minutes, and even a hard refresh
does not refetch files requested after the page loads, such as the Excel export
module and the Hamrick’s worker. With versioned URLs, the browser never reuses
files from an earlier deploy after a reload. GitHub's CDN ignores the `?v=`
query, so a reload loads the new deploy once GitHub has replaced the CDN's
cached files. Opening the site from a bookmark within 10 minutes of an earlier
visit can still show the previous deploy until the page is reloaded.

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
