import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { COLUMNS, extractPages, groupOrders, toDate, toNumber, localDate, addOrderTotals } from "../web/aafes-parser.js";
import { textItemsToWords, validatePDF, MAX_PDF_BYTES } from "../web/pdf-reader.js";
import { createWorkbook, createWorkbookArchive, excelDate, outputName } from "../web/excel-export.js";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/aafes-words.json", import.meta.url), "utf8"));
const copy = () => structuredClone(fixtures);

test("purchase orders collapse to one row with paired identifier lists and one total", () => {
  const { records, orders, orderCount } = extractPages(fixtures);
  assert.equal(records.length, 4);
  assert.equal(orderCount, 2);
  assert.equal(orders.length, 2);
  assert.deepEqual(orders.map((row) => [row.po, row.order_total, row.line_count]), [
    ["0069749254", 1320.81, 3], ["0069749253", -17.25, 1],
  ]);
  assert.equal(orders[0].sku, "003278934\n000765432\n009999999");
  assert.equal(orders[0].upc, "000123456789\n000123456789\n000123456789");
  assert.deepEqual(orders[0].line_items.map((row) => row.source_page), [1, 1, 2]);
  assert.equal(records[0].sku, "003278934"); // Grouping never mutates raw extraction.
});

test("grouping retains source order and blank identifier slots without summing repeated totals", () => {
  const lines = [
    { po: "0000000001", sku: "", upc: "00001", order_total: 0, store: "", requested_ship: null },
    { po: "0000000002", sku: "00002", upc: "00002", order_total: 15 },
    { po: "0000000001", sku: "00003", upc: "", order_total: 0, store: "001", requested_ship: "2026-09-28" },
  ];
  const { orders, warnings } = groupOrders(lines);
  assert.equal(warnings.length, 0);
  assert.deepEqual(orders.map((row) => row.po), ["0000000001", "0000000002"]);
  assert.equal(orders[0].sku, "\n00003");
  assert.equal(orders[0].upc, "00001\n");
  assert.equal(orders[0].order_total, 0);
  assert.equal(orders[0].store, "001");
  assert.equal(orders[0].requested_ship, "2026-09-28");
});

test("conflicting order-level fields are reported while the first nonblank value is retained", () => {
  const { orders, warnings } = groupOrders([
    { po: "0000000001", sku: "001", upc: "01", store: "001", requested_ship: "2026-09-28" },
    { po: "0000000001", sku: "002", upc: "02", store: "002", requested_ship: "2026-09-29" },
  ]);
  assert.equal(orders[0].store, "001");
  assert.equal(orders[0].requested_ship, "2026-09-28");
  assert.match(warnings.join(" "), /conflicting Store Num, User Defined Field #3/);
});

test("all extracted fields match the original Python converter's result for the synthetic PDF", async () => {
  const expected = JSON.parse(await readFile(new URL("./fixtures/aafes-expected.json", import.meta.url), "utf8"));
  const legacyFields = Object.keys(expected[0]);
  const actual = extractPages(fixtures).records.map((row) =>
    Object.fromEntries(legacyFields.map((key) => [key, row[key]])));
  assert.deepEqual(actual, expected);
});

test("the 14-column layout maps order headers, vendor cell, SKU, UPC, and requested ship", () => {
  assert.deepEqual(COLUMNS.map(([, label]) => label), [
    "Trading Partner", "Document Type", "Document Num", "Alt Document", "Store Num",
    "Currency Code", "Amount", "Date Processed", "Date Ack", "Business System Code",
    "Integration Status", "User Defined Field #1", "User Defined Field #2", "User Defined Field #3",
  ]);
  const { records, warnings } = extractPages(fixtures, { processedDate: "2026-09-15" });
  assert.deepEqual(COLUMNS.map(([key]) => records[0][key]), [
    "AAFES", "Stand-alone Order", "0069749254", "Vendor 00045678 MF", "000123", "",
    1320.81, "2026-09-15", "2026-07-17", 211, 0, "003278934", "000123456789", "2026-09-01",
  ]);
  assert.equal(records[2].alt_document, "Vendor 00045678 MF");
  assert.equal(records[2].date_ack, "2026-07-17");
  assert.equal(records[3].alt_document, "Vendor 00087654 MF");
  assert.equal(records[3].date_ack, "2026-07-18");
  assert.ok(records.every((row) => row.date_processed === "2026-09-15" && row.currency_code === ""));
  assert.equal(warnings.length, 1); // Only the intentional repeated line.
});

test("printed document totals take priority and disagreement with the line sum is reported", () => {
  const pages = copy();
  pages[1].words.find((word) => word.text === "1,320.81").text = "1,300.00";
  const { records, warnings } = extractPages(pages);
  assert.deepEqual(records.map((row) => row.order_total), [1300, 1300, 1300, -17.25]);
  assert.equal(records[0].amount, 34.5);
  assert.match(warnings.join(" "), /printed total 1300.00 differs.*1320.81/);
});

test("a missing printed total falls back to the original unique-line sum with a warning", () => {
  const pages = copy();
  pages[1].words = pages[1].words.filter((word) => word.text !== "1,320.81");
  const { records, warnings } = extractPages(pages);
  assert.equal(records[0].order_total, 1320.81);
  assert.match(warnings.join(" "), /PO 0069749254: no printed total.*calculated/);
});

test("new orders cannot inherit another order's partner, type, acknowledgment, or vendor", () => {
  const pages = copy();
  pages[3].words = pages[3].words.filter((word) =>
    !["AAFES", "Stand-alone", "Order", "7/18/2026", "Vendor", "00087654"].includes(word.text));
  const { records, warnings } = extractPages(pages);
  assert.equal(records[3].trading_partner, "");
  assert.equal(records[3].document_type, "");
  assert.equal(records[3].date_ack, null);
  assert.equal(records[3].alt_document, "");
  assert.match(warnings.join(" "), /PO 0069749253: missing Trading Partner, Document Type, Vendor #, Date Ack/);
});

test("AAFES extraction follows continuation pages, keeps identifiers, and totals each PO once", () => {
  const result = extractPages(fixtures);
  assert.equal(result.records.length, 4);
  assert.equal(result.orderCount, 2);
  assert.deepEqual(result.records.map(({ po, sku, qty, amount, order_total, source_page }) =>
    [po, sku, qty, amount, order_total, source_page]), [
    ["0069749254", "003278934", 2, 34.5, 1320.81, 1],
    ["0069749254", "000765432", 3, 51.75, 1320.81, 1],
    ["0069749254", "009999999", 1000, 1234.56, 1320.81, 2],
    ["0069749253", "003278934", -1, -17.25, -17.25, 4],
  ]);
  assert.deepEqual(result.records.map((row) => row.vendor_style), ["BX06772.BK", "22003.NV", "70000.CG", "RETURN.BK"]);
  assert.equal(result.records[2].requested_ship, "2026-09-01");
  assert.equal(result.records[2].requested_del, "2026-09-09");
  assert.match(result.warnings.join(" "), /1 repeated PO line/);
});

test("a new PO with no dates does not inherit the preceding order's dates", () => {
  const pages = copy();
  pages[3].words = pages[3].words.filter((word) => word.top < 100 || word.top > 117);
  const { records, warnings } = extractPages(pages);
  assert.equal(records[3].requested_ship, null);
  assert.equal(records[3].requested_del, null);
  assert.match(warnings.join(" "), /missing Requested Ship/);
});

test("conflicting duplicates keep the first row and report the conflict", () => {
  const pages = copy();
  pages[2].words.find((word) => word.text === "34.50").text = "99.00";
  const result = extractPages(pages);
  assert.equal(result.records.length, 4);
  assert.equal(result.records[0].amount, 34.5);
  assert.match(result.warnings.join(" "), /differs from an earlier copy/);
});

test("unreadable line values and unknown table layouts are reported instead of silently included", () => {
  const pages = copy();
  pages[0].words.find((word) => word.text === "51.75").text = "unreadable";
  pages[3].words = pages[3].words.filter((word) => word.text !== "SKU");
  const result = extractPages(pages);
  assert.equal(result.records.length, 2);
  assert.match(result.warnings.join(" "), /Line 00002.*skipped/);
  assert.match(result.warnings.join(" "), /table columns could not be recognized/);
});

test("blank/scanned PDFs and line items without a PO number produce no misleading workbook", () => {
  assert.throws(() => extractPages([{ width: 612, words: [] }]), /No purchase order line items/);
  const pages = [copy()[0]];
  pages[0].words = pages[0].words.filter((word) => word.text !== "0069749254");
  assert.throws(() => extractPages(pages), /No purchase order line items/);
  const result = extractPages([...fixtures, { width: 612, words: [] }]);
  assert.match(result.warnings.join(" "), /1 page\(s\) had no readable text/);
});

test("date validation rejects rollover dates and Excel serials use the 1900 date system", () => {
  assert.equal(toDate("2/29/2024"), "2024-02-29");
  for (const value of ["2/29/2026", "4/31/2026", "13/1/2026", "0/1/2026", "9/1/26"]) assert.equal(toDate(value), null);
  assert.equal(excelDate("1900-01-01"), 1);
  assert.equal(excelDate("1900-03-01"), 61);
  assert.equal(excelDate("2026-09-01"), 46266);
  assert.equal(toNumber("$1,234.50"), 1234.5);
  assert.equal(toNumber("-17.25"), -17.25);
  assert.equal(localDate(new Date(2026, 8, 14, 23, 59)), "2026-09-14");
});

test("file validation catches wrong types, zero-byte files, and oversized inputs", () => {
  assert.doesNotThrow(() => validatePDF({ name: "ORDER.PDF", size: 100 }));
  assert.throws(() => validatePDF({ name: "order.txt", size: 100 }), /Choose a PDF/);
  assert.throws(() => validatePDF({ name: "order.pdf", size: 0 }), /empty/);
  assert.throws(() => validatePDF({ name: "order.pdf", size: MAX_PDF_BYTES + 1 }), /50 MB/);
});

test("order totals round the final sum rather than individual line amounts", () => {
  const records = [{ po: "0012345678", amount: 0.105 }, { po: "0012345678", amount: 0.105 }];
  addOrderTotals(records);
  assert.deepEqual(records.map((row) => row.order_total), [0.21, 0.21]);
});

test("PDF text items split into positioned words using measured widths", () => {
  const content = { styles: { f: { ascent: 0.8 } }, items: [{ str: "Qty Amount", fontName: "f", width: 100, transform: [10, 0, 0, 10, 50, 200] }] };
  const words = textItemsToWords(content, { transform: [], scale: 1 }, { transform: (_, matrix) => matrix }, (text) => text.length);
  assert.deepEqual(words, [
    { text: "Qty", x0: 50, x1: 80, top: 192 },
    { text: "Amount", x0: 90, x1: 150, top: 192 },
  ]);
});

test("exported XLSX is a valid ZIP with typed identifiers, numbers, dates, filters, and frozen header", async () => {
  const records = extractPages(fixtures, { processedDate: "2026-09-15" }).orders;
  records[0].alt_document = '=HYPERLINK("https://example.com") & <style>';
  const bytes = await createWorkbook(records);
  // Independent check using Python's standard ZIP/XML readers, not the writer.
  const result = spawnSync(process.env.PYTHON || "python3", ["-B", "-c", `
import sys,io,zipfile,xml.etree.ElementTree as E,json
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.testzip() is None
for name in z.namelist():
    if name.endswith(('.xml','.rels')): E.fromstring(z.read(name))
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
s=E.fromstring(z.read('xl/worksheets/sheet1.xml'))
cells={c.attrib['r']:c for c in s.findall('.//s:c',ns)}
assert cells['A2'].find('.//s:t',ns).text=='AAFES'
assert cells['B2'].find('.//s:t',ns).text=='Stand-alone Order'
assert cells['C2'].attrib['t']=='inlineStr'
assert cells['C2'].find('.//s:t',ns).text=='0069749254'
assert cells['D2'].find('.//s:t',ns).text.startswith('=HYPERLINK')
assert cells['E2'].find('.//s:t',ns).text=='000123'
assert len(cells['F2'])==0
assert cells['L2'].find('.//s:t',ns).text.splitlines()==['003278934','000765432','009999999']
assert cells['M2'].find('.//s:t',ns).text.splitlines()==['000123456789']*3
assert cells['C3'].find('.//s:t',ns).text=='0069749253'
assert s.find('.//s:f',ns) is None
assert float(cells['G2'].find('s:v',ns).text)==1320.81
assert int(cells['H2'].find('s:v',ns).text)==46280
assert int(cells['I2'].find('s:v',ns).text)==46220
assert int(cells['J2'].find('s:v',ns).text)==211
assert int(cells['K2'].find('s:v',ns).text)==0
assert int(cells['N2'].find('s:v',ns).text)==46266
styles=E.fromstring(z.read('xl/styles.xml'))
formats={f.attrib['numFmtId']:f.attrib['formatCode'] for f in styles.findall('s:numFmts/s:numFmt',ns)}
xfs=styles.findall('s:cellXfs/s:xf',ns)
assert formats[xfs[int(cells['H2'].attrib['s'])].attrib['numFmtId']]=='yyyy/mm/dd'
assert formats[xfs[int(cells['I2'].attrib['s'])].attrib['numFmtId']]=='yyyy/mm/dd'
assert formats[xfs[int(cells['N2'].attrib['s'])].attrib['numFmtId']]=='yyyy/mm/dd'
assert xfs[int(cells['L2'].attrib['s'])].find('s:alignment',ns).attrib['wrapText']=='1'
assert s.find('s:autoFilter',ns).attrib['ref']=='A1:N3'
assert s.find('.//s:pane',ns).attrib['state']=='frozen'
print(json.dumps({'rows':len(s.findall('.//s:row',ns)),'columns':len(s.findall('.//s:row',ns)[0])}))
`], { input: bytes, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(JSON.parse(result.stdout), { rows: 3, columns: COLUMNS.length });
});

test("identifier lists exceeding one Excel cell use a complete paired Order Items sheet", async () => {
  const lines = Array.from({ length: 3 }, (_, i) => ({
    po: "0000000001", line_no: `0000${i + 1}`, sku: String(i).repeat(12000), upc: `00000000${i}`, order_total: 75,
  }));
  const { orders, warnings } = groupOrders(lines);
  assert.match(warnings.join(" "), /additional Order Items sheet/);
  const bytes = await createWorkbook(orders);
  const zip = await globalThis.JSZip.loadAsync(bytes);
  const main = await zip.file("xl/worksheets/sheet1.xml").async("string");
  const detail = await zip.file("xl/worksheets/sheet2.xml").async("string");
  const book = await zip.file("xl/workbook.xml").async("string");
  assert.match(main, /dimension ref="A1:N2"/);
  assert.match(main, /3 values \(see Order Items\)/);
  assert.match(detail, /dimension ref="A1:D4"/);
  assert.match(book, /sheet name="Order Items"/);
  for (const row of lines) {
    assert.ok(detail.includes(row.sku));
    assert.ok(detail.includes(row.upc));
    assert.ok(detail.includes(row.line_no));
  }
});

test("short identifier lists respect Excel's 253-line-break cell limit", async () => {
  const lines = Array.from({ length: 255 }, (_, i) => ({
    po: "0000000001", line_no: String(i + 1).padStart(6, "0"), sku: String(i), upc: `000${i}`, order_total: 255,
  }));
  const atLimit = groupOrders(lines.slice(0, 254));
  assert.equal(atLimit.warnings.length, 0);
  const normal = await globalThis.JSZip.loadAsync(await createWorkbook(atLimit.orders));
  assert.equal(normal.file("xl/worksheets/sheet2.xml"), null);
  const aboveLimit = groupOrders(lines);
  assert.match(aboveLimit.warnings.join(" "), /additional Order Items sheet/);
  const overflow = await globalThis.JSZip.loadAsync(await createWorkbook(aboveLimit.orders));
  assert.match(await overflow.file("xl/worksheets/sheet1.xml").async("string"), /255 values \(see Order Items\)/);
  assert.match(await overflow.file("xl/worksheets/sheet2.xml").async("string"), /dimension ref="A1:D256"/);
});

test("batch ZIP disambiguates duplicate filenames and preserves separate workbooks", async () => {
  const records = extractPages(fixtures).orders;
  const bytes = await createWorkbookArchive([{ name: "orders.pdf", records }, { name: "ORDERS.PDF", records }]);
  const zip = await globalThis.JSZip.loadAsync(bytes);
  assert.deepEqual(Object.keys(zip.files), ["orders_extracted.xlsx", "ORDERS_extracted_2.xlsx"]);
  for (const item of Object.values(zip.files)) {
    const workbook = await globalThis.JSZip.loadAsync(await item.async("uint8array"));
    assert.ok(workbook.file("xl/worksheets/sheet1.xml"));
    assert.match(await workbook.file("xl/worksheets/sheet1.xml").async("string"), /dimension ref="A1:N3"/);
  }
  assert.equal(outputName("../../orders.PDF"), ".._.._orders_extracted.xlsx");
  await assert.rejects(createWorkbook([]), /no extracted purchase orders/);
});
