# AAFES PDF to Excel: field mapping

The preview and export contain **one row per line item**, preserving source
order and including each unique `(PO number, line number)` pair once. Each input
PDF produces its own workbook with a **Purchase Orders** sheet.

## Fields in export order

| Column | Location or derivation |
| --- | --- |
| PO | Document number in the upper-right header, beneath `Stand-alone Order`. Preserve the 8–12 digit number as text, including leading zeros. |
| Vendor's Style | The item's code directly beneath `Vendor's Style #`. An inline value after the label is also supported. Preserve the code as text, including leading zeros and punctuation. |
| SKU | First number under `SKU #` on the item's line. Preserve it as text, including leading zeros. |
| Qty | First quantity on the item's line under the PDF's `Qty` column. Additional values farther down the detail block are not added or substituted. |
| Unit Price | Numeric value under `Price` on the same item line. |
| Total Qty for same PO | Sum of `Qty` for every unique item with the same PO in this PDF. |
| Total Price for same PO | Sum of `Unit Price × Qty`, rounded to cents per item, for every unique item with the same PO in this PDF. |
| Total Qty for same SKU | Sum of `Qty` for every unique item with the same SKU across all POs in this PDF. |
| Total Price for same SKU | Sum of `Unit Price × Qty`, rounded to cents per item, for every unique item with the same SKU across all POs in this PDF. |
| Requested Ship Date | Date under `Requested Ship`, carried across that PO's continuation pages. Display `yyyy/mm/dd`. |
| Requested Delivery Date | Date under `Requested Delivery`, carried across that PO's continuation pages. Display `yyyy/mm/dd`. |

## Extraction mechanics

PDF.js reads positioned text in the unrotated page coordinate system, normalized
to a 612-point width. This handles stored page rotation and uniform scaling
before applying header distances and row tolerances.

Warnings described below are internal parser diagnostics. The interface shows
conversion failures directly and does not display a separate issues panel.

1. Locate the PO in the upper-right header, within the top 145 points. Reset
   dates and table bounds when a different PO starts.
2. Read the dates beneath `Requested Ship` and `Requested Delivery`. Missing
   dates stay blank and produce a review warning.
3. Identify the table headers `Line`, `UPC`, `SKU`, `Description`, `Qty`, `UOM`,
   `Price`, and `Amount`. Midpoints between header centers define columns;
   positioned words within 2.5 points form a row. Reuse the table bounds on
   continuation pages.
4. Accept item rows with a line number, numeric quantity, and numeric unit price.
   The shared number parser supports accounting negatives, currency symbols,
   dot or comma decimals, and properly grouped thousands. `1,234` retains the
   AAFES thousands convention; `12,50` means `12.50`. Malformed quantities or
   prices produce a review warning and the item is skipped.
5. Find `Vendor's Style #` within that item's detail block, stopping before the
   next item. Read the code immediately below the label, or beside it if inline.
   Do not substitute the SKU, UPC, or header's `Vendor #`. Missing styles remain
   blank with a review warning.
6. Calculate each item's price from quantity and unit price. Omit repeated PO/line
   pairs, keeping the first copy and warning on conflicting data, including
   unit prices and requested dates. Then sum quantities and calculated item
   prices independently by PO and by SKU. Decimal addition preserves fractional
   quantities and cents. Each group's totals repeat on every matching item row.
   SKU groups span POs within the PDF; files in a batch are never combined.
   Missing SKUs have blank SKU totals, and identifiers with different leading
   zeros remain distinct. Negative and zero quantities contribute normally.
7. Keep printed amounts and PO totals for diagnostic reconciliation. A mismatch
   between a printed PO total and the extracted amount sum produces a warning,
   without replacing exported item totals. The first standalone amount after
   `Package Description` closes that block; later numeric footer values are
   ignored with a review warning. Missing printed amounts or totals do not
   prevent exporting readable item quantities and prices.

## Workbook behavior

Identifiers use text cells, quantities and prices use numeric cells, and both
requested dates use real Excel date cells formatted `yyyy/mm/dd`. Prices display
two decimal places. The header is frozen, filters span **A:K**, and column widths
fit the data. Cells use plain Excel styling with visible gridlines, regular
headers, no colored fills, and no custom borders. Formula-looking identifiers
remain text. Missing values are blank in Excel and shown as an em dash in the
preview.

Multiple items with the same PO or style remain separate rows. Group totals are
repeated values, not additive columns to sum again down the sheet. There are no
aggregated SKU/UPC cells or additional identifier sheets. The extraction and
export limits remain 100,000 source lines per PDF.

## Compatibility and verification

The coordinate-based extraction foundation is ported from
[AAfes_Pdf_to_Excel](https://github.com/JYS-Enterprise-Inc/AAfes_Pdf_to_Excel)
at commit `56ef7bc2412249e4188d6196bae56cb80b845b83`. Internal source fields remain
available for extraction parity and reconciliation; the preview and export use
the eleven fields above.

Synthetic fixtures verify extraction parity, multiple POs, continuation pages,
duplicate lines, leading zeros, item-specific styles and quantities, calculated
totals, PO/SKU grouping, varied unit prices, decimal quantities, per-file totals,
missing fields, requested dates, and independent XLSX ZIP/XML validation.
Stress regressions cover numeric footers, accounting negatives, currency
symbols, comma decimals, and malformed numeric values. Batch checks verify
separate workbooks and duplicate filename handling.
