# AAFES PDF to Excel: field mapping

This mapping follows the supplied `pdf_to_excel_layout.bf` board, inspected in
Boardfish, and the supplied text-based AAFES PDF. The output keeps the source
converter's row structure: one row per unique `(PO number, line number)` and one
workbook per input PDF. Metadata repeats on continuation-page line items.

## Fields in export order

| Column | Location or derivation |
| --- | --- |
| Trading Partner | `AAFES` in the centered heading near the top of the page. |
| Document Type | `Stand-alone Order` above the PO number in the upper-right header. |
| Document Num | The 8–12 digit PO number in the upper-right header. Preserve it as text. |
| Alt Document | Read the numeric value in the `Vendor #` cell and format `Vendor <number> MF`. Preserve leading zeros. |
| Store Num | Read the number after `Store #` in the shipping address. Preserve it as text. |
| Currency Code | Always blank. |
| Amount | Read the right-aligned printed order total below the final `Package Description` / notes block. Repeat it on every line of that PO. |
| Date Processed | Local calendar date at the start of the file selection, shared by every file in that batch. Display `mm/dd/yyyy`. |
| Date Ack | Read the nearest date directly below the PO number, aligned with its right edge. Display `mm/dd/yyyy`. |
| Business System Code | Constant numeric `211`. |
| Integration Status | Constant numeric `0`. |
| User Defined Field #1 | SKU from the current line-item row. Preserve it as text. |
| User Defined Field #2 | UPC from the current line-item row. Preserve it as text. |
| User Defined Field #3 | Date under `Requested Ship`, carried across that PO's continuation pages. Display `m/d/yyyy`. |

The board labels both the SKU and UPC annotations “User Defined Field #1.”
The implementation interprets the UPC annotation as **#2**, with SKU as **#1**
and Requested Ship as **#3**. The board's “Vender” annotation is normalized to
the `Vendor` spelling used by the PDF and the annotation's explanation.

## Extraction mechanics

PDF.js reads text and its position, with coordinates measured in PDF points
from the top-left. The algorithm uses labels and relative alignment instead
of assuming the example's values or copying a rectangular text block.

1. Locate the PO in the upper-right header (within the top 145 points). Reset
   the previous PO's dates, store, and table bounds when a different PO starts.
2. Read partner, document type, and acknowledgment date from the heading.
   Locate `Vendor #` and infer its cell from neighboring header centers: its
   value can start well to the left of the centered label. Do not substitute
   the separate `Vendor's Style #` detail field.
3. Identify the line-table headers `Line`, `UPC`, `SKU`, `Description`, `Qty`,
   `UOM`, `Price`, and `Amount`. Midpoints between header centers define the
   column boundaries. Group positioned words into rows within 2.5 points.
4. Accept rows with a line number and numeric quantity/amount. Read SKU and UPC
   from that same row. Reuse the table bounds on continuation pages. Omit
   duplicate PO/line pairs, keeping the first copy and reporting conflicts.
5. Find the total after `Package Description`: a lone numeric cell aligned with
   the Amount column. Footer dates and multi-cell page-count rows do not qualify.
   Compare it with the rounded sum of unique line amounts. Use the printed
   total and warn on a mismatch. If absent, use the calculated total and warn.
6. Apply order metadata to every extracted line, add the constants and processing
   date, then export only the 14 columns above. Missing extracted fields remain
   blank with a review warning; they are not filled with example values.

The workbook uses text cells for identifiers, numeric cells for money and
constants, and real Excel date cells. Headers are frozen, filters span A:N,
and column widths are fitted to the data. Amount is an order-level value;
count it once per Document Num when aggregating multiple line items.

## Compatibility and verification

The extraction foundation is ported from
[AAfes_Pdf_to_Excel](https://github.com/JYS-Enterprise-Inc/AAfes_Pdf_to_Excel)
at commit `56ef7bc2412249e4188d6196bae56cb80b845b83`. The original eight-column
schema is intentionally replaced by the requested mapping. Quantity, line
amount, and vendor style remain internal to extraction and validation.

Synthetic fixtures verify original-script extraction parity, multiple POs,
continuation pages, duplicate lines, leading zeros, the 14-column mapping,
missing metadata, total reconciliation, and XLSX cell types and date formats.
The supplied six-page PDF is used for local browser acceptance testing; its
contents are not included in the repository or served with the app.
