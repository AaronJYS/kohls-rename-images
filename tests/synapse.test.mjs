import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SYNAPSE_ROWS, MAX_SYNAPSE_PRICES, parseSynapseClipboard, parseSynapsePrices,
  normalizeSynapsePriceInput, normalizeSynapsePriceEdit, normalizeSynapsePricePaste, readSynapsePricePaste,
  matchSynapsePrices, formatSynapsePrice, createSynapseTSV, createSynapseHTML } from "../web/synapse-parser.js";

// Synthetic grids retain the positions and empty columns used by Synapse.
const headers = [
  "Item", "Lot #", "Alias", "UOM", "Description", "Line Status", "Weight UOM",
  "Weight Order", "Weight Entered", "Weight Commit", "Weight Ship", "Weight Pick",
  "Weight Received", "Quantity Order", "Quantity Rcvd", "Quantity Commit",
  "Quantity Ship", "Ship Variance", "Received Variance", "Hazardous", "Consignee SKU",
  "Quantity Entered", "UOM Entered", "Quantity Picked",
  ...Array.from({ length: 130 }, (_, index) => `Unused column ${index + 1}`),
];
const minimalHeader = "Item\tQuantity Ship\tQuantity Picked";
const verify = (orders, prices = "") => matchSynapsePrices(parseSynapseClipboard(orders), parseSynapsePrices(prices));
function grid(entries) {
  return [headers, ...entries.map(([item, ship, picked, description = "Sample item"]) => {
    const cells = Array(headers.length).fill("");
    Object.assign(cells, { 0: item, 1: "(none)", 2: " ", 3: "Each", 4: description, 5: "Active",
      10: "900", 11: "901", 13: "902", 16: ship, 21: "903", 22: "Each", 23: picked });
    return cells;
  })].map((row) => row.join("\t")).join("\r\n");
}

test("extracts the exact quantity headers from a wide clipboard grid and preserves every item and row", () => {
  const result = parseSynapseClipboard(grid([
    ["00001.BK", "2", "2"], ["00002.NV", "5", "4"], ["00003.DP.AF", "7", "7"],
    ["00001.BK", "21", "20"], ["00005.BK", "3", "0"],
  ]));
  assert.deepEqual(result, {
    rows: [
      { item: "00001.BK", ship: "2", picked: "2" }, { item: "00002.NV", ship: "5", picked: "4" },
      { item: "00003.DP.AF", ship: "7", picked: "7" }, { item: "00001.BK", ship: "21", picked: "20" },
      { item: "00005.BK", ship: "3", picked: "0" },
    ],
    totals: { ship: "38", picked: "33" },
  });
});

test("matches headers by name with reordered columns, whitespace, BOM, and different line endings", () => {
  const input = "\uFEFF\r\n\t\t\r\n QUANTITY  PICKED \t Item \tQuantity Ship\r\n4\t001.A\t5\r\n\t\t\r\n0\t002.B\t1\r\n";
  assert.deepEqual(parseSynapseClipboard(input), {
    rows: [{ item: "001.A", ship: "5", picked: "4" }, { item: "002.B", ship: "1", picked: "0" }],
    totals: { ship: "6", picked: "4" },
  });
  assert.equal(parseSynapseClipboard(`${minimalHeader}\rA\t1\t2`).totals.picked, "2");
});

test("quoted descriptions with tabs, newlines, or doubled quotes do not shift the quantity columns", () => {
  const result = parseSynapseClipboard(grid([["001.A", "2", "1", '"Set of ""two""\titems\nwith a case"']]));
  assert.deepEqual(result.rows, [{ item: "001.A", ship: "2", picked: "1" }]);
  assert.deepEqual(parseSynapseClipboard('"Item"\t"Quantity Ship"\t"Quantity Picked"\n"A"\t"1,000"\t"999"').totals,
    { ship: "1000", picked: "999" });
});

test("accepts exactly 100 entries and rejects 101 rather than returning a partial table", () => {
  const entries = Array.from({ length: MAX_SYNAPSE_ROWS }, (_, i) => [`ITEM-${i}`, String(i + 1), "1"]);
  const result = parseSynapseClipboard(grid(entries));
  assert.equal(result.rows.length, 100);
  assert.equal(result.rows.at(-1).item, "ITEM-99");
  assert.deepEqual(result.totals, { ship: "5050", picked: "100" });
  const priced = matchSynapsePrices(result, parseSynapsePrices(entries.map(([item]) => `${item}\t9\t$1.25`).join("\n")));
  const lines = createSynapseTSV(priced).split("\r\n");
  assert.equal(lines.length, 100);
  assert.equal(lines.at(-1), "ITEM-99\t100\t1.25");
  assert.throws(() => parseSynapseClipboard(grid([...entries, ["ONE-TOO-MANY", "1", "1"]])), /no more than 100 entries/);
});

test("decimal and thousands-separated quantities sum exactly, including zero and negative quantities", () => {
  const result = parseSynapseClipboard(`${minimalHeader}\nA\t0.1\t1,234.50\nB\t0.20\t-34.5\nC\t-0\t+.5`);
  assert.deepEqual(result.totals, { ship: "0.3", picked: "1200.5" });
  assert.deepEqual(result.rows.at(-1), { item: "C", ship: "0", picked: "0.5" });
  assert.equal(parseSynapseClipboard(`${minimalHeader}\nA\t-0.1\t0\nB\t0.02\t0`).totals.ship, "-0.08");
});

test("missing or duplicate required headers are explicit errors", () => {
  for (const missing of ["Item", "Quantity Ship", "Quantity Picked"]) {
    const input = minimalHeader.replace(missing, "Different column");
    assert.throws(() => parseSynapseClipboard(`${input}\nA\t1\t2`), new RegExp(`Missing header: ${missing}`));
  }
  assert.throws(() => parseSynapseClipboard(`${minimalHeader}\tQuantity Ship\nA\t1\t2\t3`), /Quantity Ship appears more than once/);
  assert.throws(() => parseSynapseClipboard("Item Quantity Ship Quantity Picked\nA 1 2"), /Missing header/);
});

test("empty, header-only, and oversized input cannot produce an export", () => {
  assert.throws(() => parseSynapseClipboard(" \n\t"), /Paste Synapse rows/);
  assert.throws(() => parseSynapseClipboard(`${minimalHeader}\n\t\t\n`), /no entries/);
  assert.throws(() => parseSynapseClipboard(" ".repeat(2_000_001)), /2 MB/);
});

test("nonnumeric quantities fail with the row and column instead of being counted as zero", () => {
  for (const value of ["N/A", "1O", "1,23", "NaN", "Infinity", "1e3", "0x10", "=1+1", "1 000"]) {
    assert.throws(() => parseSynapseClipboard(`${minimalHeader}\nA\t1\t1\nB\t${value}\t2`), /Row 3: Quantity Ship must contain a number/);
    assert.throws(() => parseSynapseClipboard(`${minimalHeader}\nA\t1\t${value}`), /Row 2: Quantity Picked must contain a number/);
  }
});

test("shifted extra cells and malformed quoted cells are rejected", () => {
  assert.throws(() => parseSynapseClipboard(`${minimalHeader}\nA\t1\t2\tEXTRA`), /Row 2 has more columns/);
  assert.throws(() => parseSynapseClipboard(`${minimalHeader}\n"A\t1\t2`), /unclosed quoted cell/);
  assert.throws(() => parseSynapseClipboard(`${minimalHeader}\n"A"B\t1\t2`), /text after a closing quote/);
  assert.throws(() => parseSynapseClipboard(`${minimalHeader}\n"A\nB"\t1\t2`), /Item must be on one line/);
});

test("empty trailing columns may be omitted without dropping a row", () => {
  const input = grid([["A", "0", "1"]]).replace(/\t+$/, "");
  assert.deepEqual(parseSynapseClipboard(input).rows, [{ item: "A", ship: "0", picked: "1" }]);
});

test("exports escape literal item text for HTML and TSV and keep Excel-like identifiers as text", () => {
  const result = verify(`${minimalHeader}\n00123\t1\t999\n=1+1\t3\t999\nA<&>\"B\t0\t999`,
    '00123\t1\t$2.25\n=1+1\t3\t$4.10\nA<&>"B\t0\t$0.00');
  const plain = createSynapseTSV(result);
  assert.equal(plain, ['\'00123\t1\t2.25', "'=1+1\t3\t4.10", '"A<&>""B"\t0\t0.00'].join("\r\n"));
  const html = createSynapseHTML(result);
  assert.doesNotMatch(html, /<th|<tfoot|999|TOTAL|Quantity Picked/);
  assert.equal((html.match(/<tr>/g) ?? []).length, 3);
  assert.equal((html.match(/<td/g) ?? []).length, 9);
  assert.ok(html.includes('mso-number-format:"\\@"'));
  assert.match(html, />00123<\/td>/);
  assert.match(html, /A&lt;&amp;&gt;&quot;B/);
  assert.match(html, /<td>1<\/td><td>2.25<\/td>/);
});

test("matches a price superset by exact Item alone, preserving Synapse order and repeated items", () => {
  const result = verify(grid([["00002.NV", "5", "4"], ["00001.BK", "2", "2"], ["00002.NV", "1", "1"]]),
    "EXTRA\t2\t$99.00\n00001.BK\t999\t$11.78\n00002.NV\t1\t$8.36");
  assert.deepEqual(result.rows.map(({ item, ship, picked, price, issues }) => [item, ship, picked, price, issues]), [
    ["00002.NV", "5", "4", "8.36", []], ["00001.BK", "2", "2", "11.78", []], ["00002.NV", "1", "1", "8.36", []],
  ]);
  assert.deepEqual(result.totals, { ship: "8", picked: "7", price: "28.5" });
  assert.equal(createSynapseTSV(result), "00002.NV\t5\t8.36\r\n00001.BK\t2\t11.78\r\n00002.NV\t1\t8.36");
});

test("missing matches, suffix differences, and ambiguous duplicates never borrow or guess a price", () => {
  const result = verify(`${minimalHeader}\nA.BK\t1\t1\nA.BK.NX\t2\t2\nB\t3\t3\nC\t4\t4`,
    "A.BK\t1\t$4\nB\t3\t$6\nB\t3\t$6");
  assert.deepEqual(result.rows.map((row) => row.price), ["4", null, null, null]);
  assert.deepEqual(result.rows[0].issues, []);
  assert.match(result.rows[1].issues.join(), /No matching Item/);
  assert.match(result.rows[2].issues.join(), /Multiple price-list entries/);
  assert.match(result.rows[3].issues.join(), /No matching Item/);
  assert.equal(createSynapseTSV(result), "A.BK\t1\t4.00\r\nA.BK.NX\t2\t\r\nB\t3\t\r\nC\t4\t");
});

test("missing values remain in the review and export as empty cells, while zero remains a complete value", () => {
  const result = verify(`${minimalHeader}\n\t1\t2\nA\t\t3\nB\t4\nC\t0\t0\nD\t1\t2\nE\t3\t4`,
    "A\t1\t$2\nB\t4\t$3\nC\t0\t$0\nD\t1\t\nE\t\t$5");
  assert.equal(result.rows.length, 6);
  assert.match(result.rows[0].issues.join(), /Item is missing/);
  assert.match(result.rows[1].issues.join(), /Quantity Ship is missing/);
  assert.match(result.rows[2].issues.join(), /Quantity Picked is missing/);
  assert.deepEqual(result.rows[3].issues, []);
  assert.match(result.rows[4].issues.join(), /entry has no price/);
  assert.deepEqual(result.rows[5].issues, []);
  assert.deepEqual(result.totals, { ship: "9", picked: "11", price: "10" });
  assert.equal(createSynapseTSV(result), "\t1\t\r\nA\t\t2.00\r\nB\t4\t3.00\r\nD\t1\t\r\nE\t3\t5.00");
  assert.doesNotMatch(createSynapseHTML(result), /null|undefined|—/);
});

test("Excel formats omit only rows with both quantities zero, preserving review rows and export order", () => {
  const result = verify(grid([
    ["A", "0", "0"], ["A", "2", "0"], ["B", "0", "3"],
    ["C", "-0.00", "+0.000"], ["D", "", "0"], ["E", "0", ""],
    ["F", "-1.5", "0"], ["G", "0", ".00000000000000000001"],
    ["NO.PRICE", ".0", "0.0"],
  ]), "A\t2\t$1\nB\t3\t$2\nC\t0\t$3\nD\t1\t$4\nE\t1\t$5\nF\t1\t$6\nG\t1\t$7");
  const review = structuredClone(result);
  assert.equal(createSynapseTSV(result), "A\t2\t1.00\r\nB\t0\t2.00\r\nD\t\t4.00\r\nE\t0\t5.00\r\nF\t-1.5\t6.00\r\nG\t0\t7.00");
  const html = createSynapseHTML(result);
  assert.deepEqual([...html.matchAll(/<tr><td[^>]*>(.*?)<\/td>/g)].map((match) => match[1]), ["A", "B", "D", "E", "F", "G"]);
  assert.equal((html.match(/<td/g) ?? []).length, 18);
  assert.deepEqual(result, review, "Export filtering must leave review rows and totals intact.");
});

test("all-zero quantities produce no Excel data rows in either clipboard format", () => {
  const result = verify(grid([["A", "0", "0"], ["B", "-0.00", "+0.0"]]));
  assert.equal(createSynapseTSV(result), "");
  assert.equal(createSynapseHTML(result), "<table><tbody></tbody></table>");
  assert.equal(result.rows.length, 2);
});

test("all missing quantity and price values leave totals unknown rather than inventing zeros", () => {
  const result = verify(grid([["A", "", ""], ["B", "", ""]]));
  assert.deepEqual(result.totals, { ship: null, picked: null, price: null });
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((row) => row.issues.length === 3));
  assert.equal(createSynapseTSV(result), "A\t\t\r\nB\t\t");
  const emptyItem = verify(grid([["", "", "", "Retain this source entry"]]));
  assert.equal(emptyItem.rows.length, 1);
  assert.equal(emptyItem.rows[0].issues.length, 4);
});

test("accepts 500 headerless or headed prices and rejects 501 without truncation", () => {
  const data = Array.from({ length: MAX_SYNAPSE_PRICES }, (_, index) => `ITEM-${index}\t1\t$1.25`).join("\r\n");
  for (const input of [data, `Item\tQuantity\tPrice\r\n${data}`]) {
    assert.equal(parseSynapsePrices(input).rows.length, 500);
    const result = verify(`${minimalHeader}\nITEM-499\t2\t3`, input);
    assert.equal(result.rows[0].price, "1.25");
    assert.deepEqual(result.rows[0].issues, []);
    assert.throws(() => parseSynapsePrices(`${input}\nTOO-MANY\t1\t2`), /no more than 500/);
  }
});

test("price parsing supports currency, quoted tabs, CRLF, whitespace, grouped numbers, and optional headers", () => {
  const input = '\uFEFF Item \t Quantity \t Price \r\n A.BK \t2\t"$1,234.50"\r\nB\t0\t0\r\n\t\t\r\nC\t\t\r\n';
  assert.deepEqual(parseSynapsePrices(input).rows, [
    { item: "A.BK", price: "1234.5" },
    { item: "B", price: "0" },
    { item: "C", price: null },
  ]);
  assert.equal(formatSynapsePrice("1234.5"), "1234.50");
  assert.equal(formatSynapsePrice("0"), "0.00");
  assert.equal(formatSynapsePrice("1.2345"), "1.2345");
  assert.deepEqual(parseSynapsePrices("  \n\t\t").rows, []);
});

test("malformed price inputs fail clearly instead of attaching an incorrect numeric value", () => {
  assert.throws(() => parseSynapsePrices("A\t1\t$8.36\tEXTRA"), /extra columns/);
  assert.deepEqual(parseSynapsePrices("A\tIGNORED\t$8.36").rows, [{ item: "A", price: "8.36" }]);
  for (const value of ["$", "$BAD", "$8.36abc", "$1,23", "=1+1", "Infinity"]) {
    assert.throws(() => parseSynapsePrices(`A\t1\t${value}`), /Price must contain a number/);
  }
  assert.throws(() => parseSynapsePrices(" ".repeat(2_000_001)), /2 MB/);
});

test("price-list normalization cleans Item separators while preserving columns and rows", () => {
  const input = "00123 BK-AF\t2\t$11.78\r\n B--C  \t1\t$3.50\r\n";
  const normalized = normalizeSynapsePriceInput(input);
  assert.equal(normalized, "00123.BK.AF\t2\t$11.78\r\n.B.C\t1\t$3.50\r\n");
  assert.equal(normalizeSynapsePriceInput(normalized), normalized);
  const result = verify(`${minimalHeader}\n00123.BK.AF\t2\t2`, normalized);
  assert.equal(result.rows[0].price, "11.78");
  assert.deepEqual(result.rows[0].issues, []);
});

test("price-list entries that normalize to the same Item remain ambiguous", () => {
  const result = verify(`${minimalHeader}\n00123.BK\t2\t2`,
    normalizeSynapsePriceInput("00123 BK\t2\t$11.78\n00123-BK\t2\t$12.50"));
  assert.equal(result.rows[0].price, null);
  assert.match(result.rows[0].issues.join(), /Multiple price-list entries/);
});

test("Item periods survive only before ASCII letters, with no consecutive or trailing periods", () => {
  for (const [before, after] of [
    ["A..BK", "A.BK"], ["A....BK.", "A.BK"], ["A.30.BK", "A30.BK"],
    ["A.1.!.é..b...Z.", "A1!é.b.Z"], ["A - .BK - AF", "A.BK.AF"], ["...", ""],
  ]) {
    const normalized = normalizeSynapsePriceInput(`${before}\t1\t$11.78`);
    assert.equal(normalized, `${after}\t1\t$11.78`);
    assert.doesNotMatch(normalized.split("\t")[0], /\.(?![A-Za-z])/);
    assert.equal(normalizeSynapsePriceInput(normalized), normalized);
  }
});

test("normalization preserves decimal quantities and prices, currency spacing, signs, and quoted cells", () => {
  const input = 'Item\tQuantity\tPrice\r\n"A..BK."\t-2.5\t"$ 11.78"\r\nB--AF\t0.25\t$0.00\r\nC.30\t1\t1,234.50';
  const normalized = normalizeSynapsePriceInput(input);
  assert.equal(normalized, 'Item\tQuantity\tPrice\r\n"A.BK"\t-2.5\t"$ 11.78"\r\nB.AF\t0.25\t$0.00\r\nC30\t1\t1,234.50');
  assert.deepEqual(parseSynapsePrices(normalized).rows, [
    { item: "A.BK", price: "11.78" },
    { item: "B.AF", price: "0" },
    { item: "C30", price: "1234.5" },
  ]);
});

test("selection offsets follow removed periods, including a caret just before the next letter", () => {
  assert.deepEqual(normalizeSynapsePriceEdit("A..B\t1\t$11.78", 3, 3), {
    value: "A.B\t1\t$11.78", selectionStart: 2, selectionEnd: 2,
  });
  assert.deepEqual(normalizeSynapsePriceEdit("A..B\t1\t$11.78", 1, 3), {
    value: "A.B\t1\t$11.78", selectionStart: 1, selectionEnd: 2,
  });
  const input = "A..BK.\t1\t$11.78\nB..AF.\t2\t$8.36";
  const normalized = normalizeSynapsePriceEdit(input);
  assert.equal(normalized.selectionStart, normalized.value.length);
  assert.equal(normalized.selectionEnd, normalized.value.length);
});

test("paste cleanup preserves earlier manual Item corrections and maps CRLF to a textarea caret", () => {
  const input = "MANUAL BK-AF\t2.5\t$11.78";
  const result = normalizeSynapsePricePaste(input, "\r\nNEW --BK..\t-1.25\t$8.36\r\n", input.length, input.length);
  assert.equal(result.value, "MANUAL BK-AF\t2.5\t$11.78\nNEW.BK\t-1.25\t$8.36\n");
  assert.equal(result.selectionStart, result.value.length);
  assert.equal(result.selectionEnd, result.value.length);
});

test("partial pastes clean Item text in context without moving suffixes or changing other cells", () => {
  const input = "A-BK\t1\t$8.36";
  assert.deepEqual(normalizeSynapsePricePaste(input, "..", 1, 2), {
    value: "A.BK\t1\t$8.36", selectionStart: 2, selectionEnd: 2,
  });
  assert.deepEqual(normalizeSynapsePricePaste("A.BK\t1\t$8.36", ".", 2, 2), {
    value: "A.BK\t1\t$8.36", selectionStart: 2, selectionEnd: 2,
  });
  const manuallyEdited = "A BK-AF\t1\t$8.36";
  const quantityStart = manuallyEdited.indexOf("\t") + 1;
  const quantity = normalizeSynapsePricePaste(manuallyEdited, "-2.5", quantityStart, quantityStart + 1);
  assert.equal(quantity.value, "A BK-AF\t-2.5\t$8.36");
  assert.equal(quantity.selectionStart, quantityStart + 4);
  const priceStart = manuallyEdited.lastIndexOf("\t") + 1;
  const price = normalizeSynapsePricePaste(manuallyEdited, "$ 11.78", priceStart, manuallyEdited.length);
  assert.equal(price.value, "A BK-AF\t1\t$ 11.78");
  assert.equal(price.selectionStart, price.value.length);
});

test("price grid accepts Item/Price and legacy three-column ranges with optional headers", () => {
  for (const text of ["00123\t$11.78\r\nA.BK\t0", "Item\tPrice\n00123\t$11.78\nA.BK\t0",
    "Item\tQuantity\tPrice\n00123\t2\t$11.78\nA.BK\t3\t0"]) {
    assert.deepEqual(readSynapsePricePaste(text), [["00123", "$11.78"], ["A.BK", "0"]]);
    assert.deepEqual(parseSynapsePrices(text).rows, [{ item: "00123", price: "11.78" }, { item: "A.BK", price: "0" }]);
  }
  assert.deepEqual(readSynapsePricePaste("22701\n21219\n165B05.BK\n"), [["22701"], ["21219"], ["165B05.BK"]]);
  assert.deepEqual(readSynapsePricePaste("Item\n00123\nA.BK"), [["00123"], ["A.BK"]]);
  assert.deepEqual(readSynapsePricePaste("Price\n11.78\n0.25", 1), [["11.78"], ["0.25"]]);
});

test("grid paste preserves blanks, quotes, and decimals without shifting independently pasted prices", () => {
  assert.deepEqual(readSynapsePricePaste('\uFEFF"$1,234.50"\r\n\r\n-0.25\r\n', 1), [["$1,234.50"], [""], ["-0.25"]]);
  assert.deepEqual(readSynapsePricePaste("A\t\n\t$2.00\nB\t$3.00"), [["A", ""], ["", "$2.00"], ["B", "$3.00"]]);
  assert.deepEqual(readSynapsePricePaste('"A""B"\t"$ 1.25"'), [['A"B', "$ 1.25"]]);
  assert.throws(() => readSynapsePricePaste("A\t$1", 1), /Item column/);
  assert.throws(() => readSynapsePricePaste("A\t1\t$2\textra"), /Item and Price/);
  assert.throws(() => readSynapsePricePaste('"A\nB"\t$1'), /one cell/);
  assert.throws(() => readSynapsePricePaste("A\n".repeat(501)), /no more than 500/);
  assert.throws(() => readSynapsePricePaste(" ".repeat(2_000_001)), /2 MB/);
});
