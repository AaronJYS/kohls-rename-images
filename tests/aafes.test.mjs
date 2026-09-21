import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { extractPages, toDate, toNumber, localDate, addOrderTotals, addGroupedTotals } from "../web/aafes-parser.js";
import { textItemsToWords, validatePDF, MAX_PDF_BYTES } from "../web/pdf-reader.js";
import { createWorkbook, createWorkbookArchive, excelDate, outputName } from "../web/excel-export.js";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/aafes-words.json", import.meta.url), "utf8"));
const copy = () => structuredClone(fixtures);

test("extraction matches the Python fixture across POs, continuation pages, and duplicate lines", async () => {
  const expected = JSON.parse(await readFile(new URL("./fixtures/aafes-expected.json", import.meta.url), "utf8"));
  const legacyFields = Object.keys(expected[0]);
  const result = extractPages(fixtures);
  const actual = result.records.map((row) =>
    Object.fromEntries(legacyFields.map((key) => [key, row[key]])));
  assert.deepEqual(actual, expected);
  assert.equal(result.orderCount, 2);
  assert.deepEqual(result.orders.map((order) => order.line_count), [3, 1]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /1 repeated PO line/);
});

test("PO and SKU totals include each matching item at its own unit price", () => {
  const pages = [copy()[0]];
  pages[0].words.find((word) => word.text === "000765432").text = "003278934";
  pages[0].words.find((word) => word.text === "17.25" && word.top > 250).text = "20.00";
  const { records } = extractPages(pages);
  assert.deepEqual(records.map((row) => row.total_price), [34.5, 60]);
  for (const row of records) {
    assert.equal(row.po_total_qty, 5);
    assert.equal(row.po_total_price, 94.5);
    assert.equal(row.sku_total_qty, 5);
    assert.equal(row.sku_total_price, 94.5);
  }
});

test("group totals keep fractional quantities exact and include zero and negative lines", () => {
  const records = [
    { po: "001", sku: "0001", qty: 0.1, total_price: 0.1 },
    { po: "001", sku: "0001", qty: 0.2, total_price: 0.2 },
    { po: "002", sku: "0001", qty: -0.1, total_price: -0.1 },
    { po: "002", sku: "0001", qty: 0, total_price: 0 },
  ];
  addGroupedTotals(records);
  assert.deepEqual(records.map((row) => [row.po_total_qty, row.po_total_price, row.sku_total_qty, row.sku_total_price]), [
    [0.3, 0.3, 0.2, 0.2], [0.3, 0.3, 0.2, 0.2], [-0.1, -0.1, 0.2, 0.2], [-0.1, -0.1, 0.2, 0.2],
  ]);
});

test("SKU summaries omit missing identifiers and keep leading-zero SKUs distinct", async () => {
  const records = [
    { po: "001", sku: "0001", qty: 1, total_price: 10 },
    { po: "001", sku: "1", qty: 2, total_price: 20 },
    { po: "001", sku: "", qty: 3, total_price: 30 },
    { po: "002", sku: "", qty: 4, total_price: 40 },
  ];
  addGroupedTotals(records);
  assert.deepEqual(records.map((row) => [row.po_total_qty, row.po_total_price, row.sku_total_qty, row.sku_total_price]), [
    [6, 60, 1, 10], [6, 60, 2, 20], [6, 60, null, null], [4, 40, null, null],
  ]);
  const zip = await globalThis.JSZip.loadAsync(await createWorkbook(records));
  const summary = await zip.file("xl/worksheets/sheet2.xml").async("string");
  assert.match(summary, /dimension ref="A1:C3"/);
  assert.deepEqual([...summary.matchAll(/<t xml:space="preserve">(.*?)<\/t>/g)].map((match) => match[1]),
    ["SKU", "Total Qty", "Total Price", "0001", "1"]);
  const blanks = await globalThis.JSZip.loadAsync(await createWorkbook(records.slice(2)));
  assert.match(await blanks.file("xl/worksheets/sheet2.xml").async("string"), /dimension ref="A1:C1"/);
});

test("printed totals and numeric footers cannot replace calculated item or group prices", () => {
  const pages = copy();
  const total = pages[1].words.find((word) => word.text === "1,320.81");
  total.text = "1,300.00";
  pages[1].words.push({ ...total, text: "1,320.81", top: total.top + 20 });
  const { records, warnings } = extractPages(pages);
  assert.deepEqual(records.map((row) => row.order_total), [1300, 1300, 1300, -17.25]);
  assert.equal(records[0].amount, 34.5);
  assert.deepEqual(records.map((row) => row.total_price), [34.5, 51.75, 17250, -17.25]);
  assert.deepEqual(records.map((row) => row.po_total_price), [17336.25, 17336.25, 17336.25, -17.25]);
  assert.match(warnings.join(" "), /printed total 1300.00 differs.*1320.81/);
  assert.match(warnings.join(" "), /extra numeric values below the printed total were ignored/);
});

test("line prices export normally when the printed PO total is absent", () => {
  const pages = copy();
  pages[1].words = pages[1].words.filter((word) => word.text !== "1,320.81");
  const { records, warnings } = extractPages(pages);
  assert.equal(records[0].order_total, 1320.81);
  assert.deepEqual(records.map((row) => row.total_price), [34.5, 51.75, 17250, -17.25]);
  assert.ok(!warnings.some((warning) => /no printed total/.test(warning)));
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
  assert.ok(!warnings.some((warning) => /missing Trading Partner|Document Type|Vendor #|Date Ack/.test(warning)));
});

test("a new PO with no dates does not inherit the preceding order's dates", () => {
  const pages = copy();
  pages[3].words = pages[3].words.filter((word) => word.top < 100 || word.top > 117);
  const { records, warnings } = extractPages(pages);
  assert.equal(records[3].requested_ship, null);
  assert.equal(records[3].requested_del, null);
  assert.match(warnings.join(" "), /missing Requested Ship/);
  assert.match(warnings.join(" "), /Requested Delivery Date/);
});

test("Vendor's Style and Qty come from the item, excluding later quantities and identifiers", () => {
  const pages = [copy()[0]];
  pages[0].words.find((word) => word.text === "BX06772.BK").text = "000ABC123BK";
  const quantity = pages[0].words.find((word) => word.text === "2");
  pages[0].words.push({ ...quantity, text: "999", top: quantity.top + 12 });
  const { records } = extractPages(pages);
  assert.equal(records[0].vendor_style, "000ABC123BK");
  assert.equal(records[0].qty, 2);
  assert.equal(records[0].total_price, 34.5);
  assert.equal(records[1].qty, 3);
});

test("missing styles stay blank and produce a review note without borrowing the next item's style", () => {
  const pages = [copy()[0]];
  pages[0].words = pages[0].words.filter((word) => word.text !== "BX06772.BK");
  const { records, warnings } = extractPages(pages);
  assert.equal(records[0].vendor_style, "");
  assert.equal(records[1].vendor_style, "22003.NV");
  assert.match(warnings.join(" "), /missing Vendor's Style/);
});

test("zero, negative, and fractional quantities calculate line totals from unit prices", () => {
  for (const [qty, price, total] of [
    ["0", "17.25", 0], ["-2", "17.25", -34.5], ["2.5", "0.10", 0.25], ["3", "0.10", 0.3],
    ["1", "1.005", 1.01], ["3", "9.995", 29.99], ["-3", "9.995", -29.99],
  ]) {
    const pages = [copy()[0]];
    pages[0].words.find((word) => word.text === "2").text = qty;
    pages[0].words.find((word) => word.text === "17.25").text = price;
    assert.equal(extractPages(pages).records[0].total_price, total);
  }
});

test("conflicting duplicate prices or amounts keep the first row and report the conflict", () => {
  for (const value of ["17.25", "34.50"]) {
    const pages = copy();
    pages[2].words.find((word) => word.text === value).text = "99.00";
    const { records, warnings } = extractPages(pages);
    assert.equal(records.length, 4);
    assert.equal(records[0].price, 17.25);
    assert.equal(records[0].amount, 34.5);
    assert.equal(records[0].total_price, 34.5);
    assert.match(warnings.join(" "), /differs from an earlier copy/);
  }
});

test("unreadable line values and unknown table layouts are reported instead of silently included", () => {
  const pages = copy();
  pages[0].words.find((word) => word.text === "17.25" && word.top > 250).text = "unreadable";
  pages[3].words = pages[3].words.filter((word) => word.text !== "SKU");
  const result = extractPages(pages);
  assert.equal(result.records.length, 2);
  assert.match(result.warnings.join(" "), /Line 00002.*skipped/);
  assert.match(result.warnings.join(" "), /table columns could not be recognized/);
});

test("missing or unreadable printed line amounts do not discard items with usable prices", () => {
  const pages = [copy()[0]];
  pages[0].words = pages[0].words.filter((word) => word.text !== "34.50");
  pages[0].words.find((word) => word.text === "51.75").text = "unreadable";
  const { records } = extractPages(pages);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((row) => row.total_price), [34.5, 51.75]);
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
  assert.equal(localDate(new Date(2026, 8, 14, 23, 59)), "2026-09-14");
});

test("amount parsing supports common number formats and rejects malformed values", () => {
  for (const [text, expected] of [
    ["($ 1,234.50)", -1234.5], ["$ -17.25", -17.25], ["€1.234,50", 1234.5],
    ["12,50", 12.5], ["1,234", 1234], ["0,105", 0.105], [".50", 0.5], ["0", 0],
  ]) assert.equal(toNumber(text), expected, text);
  for (const text of ["", "$", "--12.50", "(12.50", "1,,234", "1.23,45", "123abc"])
    assert.equal(toNumber(text), text, text);
});

test("accounting negatives, currency symbols, and comma decimals preserve extracted totals", () => {
  const expected = extractPages(fixtures);
  for (const format of [
    (value) => value.startsWith("-") ? `(${value.slice(1)})` : value,
    (value) => `$ ${value}`,
    (value) => value.replaceAll(",", "_").replace(".", ",").replaceAll("_", "."),
  ]) {
    const pages = copy();
    for (const page of pages) {
      for (const word of page.words) {
        if (word.x0 >= 470 && /^-?[\d,]+\.\d+$/.test(word.text)) word.text = format(word.text);
      }
    }
    assert.deepEqual(extractPages(pages), expected);
  }
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

test("XLSX exports typed purchase-order details and a unique SKU summary with filters and frozen headers", async () => {
  const records = extractPages(fixtures).records;
  records[3].vendor_style = '=HYPERLINK("https://example.com") & <style>';
  records[3].qty = -1.5;
  records[3].total_price = -25.88;
  addGroupedTotals(records);
  const bytes = await createWorkbook(records);
  // Independent check using Python's standard ZIP/XML readers, not the writer.
  const result = spawnSync(process.env.PYTHON || "python3", ["-B", "-c", `
import sys,io,zipfile,xml.etree.ElementTree as E,json
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert z.testzip() is None
for name in z.namelist():
    if name.endswith(('.xml','.rels')): E.fromstring(z.read(name))
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'p':'http://schemas.openxmlformats.org/package/2006/relationships',
    'c':'http://schemas.openxmlformats.org/package/2006/content-types'}
workbook=E.fromstring(z.read('xl/workbook.xml'))
sheets=workbook.findall('s:sheets/s:sheet',ns)
assert [sheet.attrib['name'] for sheet in sheets]==['Purchase Orders','SKU QTY Summed']
rels=E.fromstring(z.read('xl/_rels/workbook.xml.rels'))
targets={r.attrib['Id']:r.attrib['Target'] for r in rels}
types=E.fromstring(z.read('[Content_Types].xml'))
worksheet_parts=[part.attrib['PartName'] for part in types if part.attrib.get('ContentType','').endswith('.worksheet+xml')]
assert worksheet_parts==['/xl/worksheets/sheet1.xml','/xl/worksheets/sheet2.xml']
for i,sheet in enumerate(sheets,1):
    assert targets[sheet.attrib['{'+ns['r']+'}id']]==f'worksheets/sheet{i}.xml'
s=E.fromstring(z.read('xl/worksheets/sheet1.xml'))
cells={c.attrib['r']:c for c in s.findall('.//s:c',ns)}
assert [c.find('.//s:t',ns).text for c in s.find('s:sheetData/s:row',ns)]==['PO',"Vendor's Style",'SKU','Qty','Unit Price','Total Qty for same PO','Total Price for same PO','Requested Ship Date','Requested Delivery Date']
assert cells['A2'].attrib['t']=='inlineStr'
assert cells['A2'].find('.//s:t',ns).text=='0069749254'
assert cells['B2'].attrib['t']=='inlineStr'
assert cells['B2'].find('.//s:t',ns).text=='BX06772.BK'
assert cells['B3'].find('.//s:t',ns).text=='22003.NV'
assert cells['B4'].find('.//s:t',ns).text=='70000.CG'
assert cells['B5'].find('.//s:t',ns).text.startswith('=HYPERLINK')
assert cells['A5'].find('.//s:t',ns).text=='0069749253'
assert all(cells[f'C{i}'].attrib['t']=='inlineStr' for i in range(2,6))
assert [cells[f'C{i}'].find('.//s:t',ns).text for i in range(2,6)]==['003278934','000765432','009999999','003278934']
assert s.find('.//s:f',ns) is None
assert int(cells['D2'].find('s:v',ns).text)==2
assert float(cells['E2'].find('s:v',ns).text)==17.25
assert [float(cells[f'F{i}'].find('s:v',ns).text) for i in range(2,6)]==[1005,1005,1005,-1.5]
assert [float(cells[f'G{i}'].find('s:v',ns).text) for i in range(2,6)]==[17336.25,17336.25,17336.25,-25.88]
assert float(cells['D5'].find('s:v',ns).text)==-1.5
assert int(cells['H2'].find('s:v',ns).text)==46266
assert int(cells['I2'].find('s:v',ns).text)==46274
styles=E.fromstring(z.read('xl/styles.xml'))
formats={f.attrib['numFmtId']:f.attrib['formatCode'] for f in styles.findall('s:numFmts/s:numFmt',ns)}
xfs=styles.findall('s:cellXfs/s:xf',ns)
assert formats[xfs[int(cells['H2'].attrib['s'])].attrib['numFmtId']]=='yyyy/mm/dd'
assert formats[xfs[int(cells['I2'].attrib['s'])].attrib['numFmtId']]=='yyyy/mm/dd'
assert xfs[int(cells['E2'].attrib['s'])].attrib['numFmtId']=='4'
assert xfs[int(cells['G2'].attrib['s'])].attrib['numFmtId']=='4'
assert xfs[int(cells['D5'].attrib['s'])].attrib['numFmtId']=='0'
assert xfs[int(cells['F5'].attrib['s'])].attrib['numFmtId']=='0'
assert s.find('s:autoFilter',ns).attrib['ref']=='A1:I5'
assert s.find('.//s:pane',ns).attrib['state']=='frozen'
summary=E.fromstring(z.read('xl/worksheets/sheet2.xml'))
rows=summary.findall('s:sheetData/s:row',ns)
assert [c.find('.//s:t',ns).text for c in rows[0]]==['SKU','Total Qty','Total Price']
values=[]
for row in rows[1:]:
    sku,qty,price=row
    assert sku.attrib['t']=='inlineStr'
    assert xfs[int(qty.attrib['s'])].attrib['numFmtId']=='0'
    assert xfs[int(price.attrib['s'])].attrib['numFmtId']=='4'
    values.append([sku.find('.//s:t',ns).text,float(qty.find('s:v',ns).text),float(price.find('s:v',ns).text)])
assert values==[['003278934',0.5,8.62],['000765432',3,51.75],['009999999',1000,17250]]
assert summary.find('.//s:f',ns) is None
assert summary.find('s:autoFilter',ns).attrib['ref']=='A1:C4'
assert summary.find('.//s:pane',ns).attrib['state']=='frozen'
print(json.dumps({'detailRows':len(s.findall('.//s:row',ns)),'summaryRows':len(rows)}))
`], { input: bytes, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(JSON.parse(result.stdout), { detailRows: 5, summaryRows: 4 });
});

test("export preserves blank missing dates", async () => {
  const row = extractPages(fixtures).records[0];
  const bytes = await createWorkbook([{ ...row, requested_ship: null, requested_del: null }]);
  const zip = await globalThis.JSZip.loadAsync(bytes);
  const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(sheet, /<c r="H2" s="1"\/>/);
  assert.match(sheet, /<c r="I2" s="1"\/>/);
});

test("batch ZIP disambiguates filenames and keeps SKU totals within each workbook", async () => {
  const results = [
    { name: "orders.pdf", records: extractPages([fixtures[0]]).records },
    { name: "ORDERS.PDF", records: extractPages([fixtures[3]]).records },
  ];
  const bytes = await createWorkbookArchive(results);
  const zip = await globalThis.JSZip.loadAsync(bytes);
  assert.deepEqual(Object.keys(zip.files), ["orders_extracted.xlsx", "ORDERS_extracted_2.xlsx"]);
  for (const [index, item] of Object.values(zip.files).entries()) {
    const workbook = await globalThis.JSZip.loadAsync(await item.async("uint8array"));
    const details = await workbook.file("xl/worksheets/sheet1.xml").async("string");
    assert.ok(details.includes(`dimension ref="A1:I${results[index].records.length + 1}"`));
    const summary = await workbook.file("xl/worksheets/sheet2.xml").async("string");
    const totals = [...summary.matchAll(/<v>(.*?)<\/v>/g)].map((match) => Number(match[1]));
    assert.deepEqual(totals, index === 0 ? [2, 34.5, 3, 51.75] : [-1, -17.25]);
  }
  assert.equal(outputName("../../orders.PDF"), ".._.._orders_extracted.xlsx");
  await assert.rejects(createWorkbook([]), /no extracted purchase orders/);
});
