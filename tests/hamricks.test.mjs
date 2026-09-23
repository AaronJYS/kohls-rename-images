import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "../web/vendor/sheetjs/xlsx.mjs";
import { convertHamricksSheet, create940CSV, create940Template, parseHamricksSheet,
  HEADERS_940, validateHamricksFile, MAX_WORKBOOK_BYTES, output940Name } from "../web/hamricks-converter.js";
import { readHamricksWorkbook } from "../web/hamricks-reader.js";
import { create940Workbook } from "../web/hamricks-export.js";
import "../web/vendor/jszip/jszip.min.js";

// Entirely synthetic input. Private customer workbooks are never test fixtures.
const withDetails = (table, { po = "001234", contact = "Example department", ship = "2027-04-05", cancel = "04/09/2027",
  labelRow = 0, labelColumn = 0, valueColumn = 2 } = {}) => {
  const rows = Array.from({ length: labelRow + 7 }, () => []);
  for (const [offset, label, value] of [[0, "PO#  >", po], [1, "Department Number >", contact],
    [4, "Start Ship Date >", ship], [5, "Cancel Date >", cancel]]) {
    rows[labelRow + offset][labelColumn] = label;
    rows[labelRow + offset][valueColumn] = value;
  }
  return [...rows, ...table];
};
const convertTable = (table, details) => convertHamricksSheet(withDetails(table, details));
const splitSheet = () => withDetails([
  ["Synthetic purchase order"],
  ["Department", "Style", "CORRECTED STYLE#", "Store", "Total Units", "Store", "Store"],
  ["", "Number", "", 5, "", 12, 103],
  [],
  [700, "OLD-0012.BK", "0012.BK", 3, 999, "0", null],
  [700, "OLD-B02.RD", "B02.RD", "", 888, 2, 0],
  [700, "OLD-C03.NV", "C03.NV", 5, 777, 7, ""],
  ["Total", "", "", 8, 2664, 9, 0],
]);
const fullRow = (cells) => [...cells, ...Array(29 - cells.length).fill("")];
const workbookBytes = (sheets, bookType = "xlsx", date1904 = false) => {
  const workbook = XLSX.utils.book_new();
  workbook.Workbook = { WBProps: { date1904 } };
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(workbook, { type: "array", bookType });
};

test("split headings map corrected styles into compact nonempty store blocks", () => {
  const result = convertHamricksSheet(splitSheet());
  assert.equal(result.styleColumn, 2);
  assert.equal(result.styleCount, 3);
  assert.equal(result.lineCount, 4);
  assert.equal(result.totalQuantity, 17);
  assert.equal(result.rows.length, 7);
  assert.equal(result.rows.every((row) => row.length === 29), true);
  assert.deepEqual(result.stores.map((s) => [s.number, s.column, s.startRow, s.endRow, s.lineCount, s.units]),
    [[5, 3, 1, 3, 2, 8], [12, 5, 4, 6, 2, 9]]);
  assert.deepEqual(result.rows.slice(2, 4), [fullRow(["L", "0012.BK", 3, "EA"]), fullRow(["L", "C03.NV", 5, "EA"])]);
  assert.deepEqual(result.rows.slice(5), [fullRow(["L", "B02.RD", 2, "EA"]), fullRow(["L", "C03.NV", 7, "EA"])]);
  assert.deepEqual(result.rows.filter((r) => r[0] === "H").map((r) => r[4]), ["001234-05", "001234-12"]);
  assert.deepEqual(result.rows.filter((r) => r[0] === "H").map((r) => r.slice(7, 10)), [
    ["742 Peachoid Road", "Store 05 Gaffney", "Gaffney"],
    ["742 Peachoid Road", "Store 12 Gaffney", "Gaffney"],
  ]);
});

test("corrected style, store, and PO header searches ignore capitalization without changing identifiers", () => {
  const table = [["Style Number", "CORRECTED STYLE#", "Store 5", "Store 12"], ["Old-Style", "Mixed-001.bK", 2, 3]];
  const expected = convertTable(table);
  for (const changeCase of [s => s.toLowerCase(), s => s.toUpperCase(),
    s => [...s].map((letter, i) => i % 2 ? letter.toUpperCase() : letter.toLowerCase()).join("")]) {
    const input = withDetails([table[0].map(changeCase), table[1]]);
    input[0][0] = changeCase(input[0][0]);
    const result = convertHamricksSheet(input);
    assert.deepEqual(result.rows, expected.rows);
    assert.deepEqual(result.rows.filter(row => row[0] === "L").map(row => row[1]), ["Mixed-001.bK", "Mixed-001.bK"]);
  }
});

test("split and repeated corrected-style headers accept mixed case and wrapped labels", () => {
  for (const heading of [
    [["cOrReCtEd", "sToRe"], ["sTyLe #", 5]],
    [["cOrReCtEd StYlE", "StOrE 05"], ["#", ""]],
    [[" CoRrEcTeD\nStYlE# ", "StOrE"], ["", 5]],
    [[" cOrReCt ", "sToRe"], ["sTyLe#", " 05 "]],
    [["CoRrEcTsTyLe", "sToRe05"], [" # ", ""]],
  ]) {
    const result = convertTable([...heading, ["First.bK", 2], ...heading, ["Second.rD", 3]]);
    assert.equal(result.styleCount, 2);
    assert.deepEqual(result.rows.slice(2).map(row => row.slice(0, 4)), [["L", "First.bK", 2, "EA"], ["L", "Second.rD", 3, "EA"]]);
  }
});

test("style headings accept optional spaces and both correct-style aliases without changing source values", () => {
  const product = ["MiXeD-001.bK", 3];
  const expected = convertTable([["Style Number", "Store 12"], product]);
  for (const heading of ["StyleNumber", "Style Number", "CorrectStyle#", "Correct Style#", "CorrectStyle #",
    "Correct Style #", "CorrectedStyle#", "Corrected Style#", "CorrectedStyle #", "Corrected Style #"]) {
    for (const name of [heading, heading.toLowerCase(), heading.toUpperCase()]) {
      for (const before of ["", " "]) for (const after of ["", " "]) {
        const result = convertTable([[before + name + after, "Store 12"], product]);
        assert.deepEqual(result.rows, expected.rows, JSON.stringify(before + name + after));
      }
    }
  }
});

test("store headings accept optional spaces inline and around numbers directly below Store", () => {
  const expected = convertTable([["Style Number", "Store 12"], ["Mixed.bK", 3]]);
  for (const heading of ["Store12", "Store 12", "store012", "STORE 012", "sToRe12", "sToRe 012"]) {
    for (const before of ["", " "]) for (const after of ["", " "]) {
      const result = convertTable([["Style Number", before + heading + after], ["Mixed.bK", 3]]);
      assert.deepEqual(result.rows, expected.rows, JSON.stringify(before + heading + after));
    }
  }
  for (const heading of ["Store", " store ", " STORE ", " sToRe "]) {
    for (const number of [12, "12", " 12", "12 ", " 012 "]) {
      const result = convertTable([["StyleNumber", heading], ["", number], ["Mixed.bK", 3]]);
      assert.deepEqual(result.rows, expected.rows);
    }
  }
});

test("new aliases preserve corrected-style precedence, fallback, and repeated heading detection", () => {
  const result = convertTable([
    ["StyleNumber", "CorrectStyle#", "Store12"],
    ["Original-1", "Corrected.bK", 2], ["Fallback-002.rD", "", 3],
    [" STYLE NUMBER ", "corrected STYLE #", " Store 12 "],
    ["Original-3", "Updated.nV", 4],
  ]);
  assert.equal(result.styleColumn, 1);
  assert.equal(result.styleCount, 3);
  assert.deepEqual(result.rows.slice(2).map(row => row.slice(0, 4)), [
    ["L", "Corrected.bK", 2, "EA"], ["L", "Fallback-002.rD", 3, "EA"], ["L", "Updated.nV", 4, "EA"],
  ]);
  for (const headers of [
    ["CorrectStyle#", "Corrected Style#", "Store12"],
    ["StyleNumber", "Style Number", "Store12"],
    ["CorrectStyle#", "Store12", "Store 012"],
  ]) assert.throws(() => convertTable([headers, ["A", "B", 2]]), /more than one/);
  assert.throws(() => convertTable([
    ["CorrectStyle#", "Store12"], ["A", 2], ["Corrected Style#", "Store13"], ["B", 3],
  ]), /layout changes/);
});

test("optional heading spaces do not allow extra words, punctuation, or nonpositive store numbers", () => {
  for (const heading of ["OldStyleNumber", "StyleNumber notes", "Style_Number", "Style-Number", "Style Number#",
    "CorrectStyle", "CorrectedStyle", "IncorrectStyle#", "Correct_Style#", "CorrectStyle-#", "CorrectStyle##", "CorrectedStyle# notes"]) {
    assert.throws(() => convertTable([[heading, "Store12"], ["A", 2]]), /Could not find/, heading);
  }
  for (const heading of ["OldStore12", "Store12 notes", "Store_12", "Store #12", "Store-12", "Store+12",
    "Store1.2", "Store1e2", "Store1,000", "Store1 2", "Store0", "Store 000", "Store9007199254740992"]) {
    assert.throws(() => convertTable([["StyleNumber", heading], ["A", 2]]), /Could not find/, heading);
  }
  for (const number of ["Number 12", "12 notes", "1 2", "-12", "+12", "1.2", 0]) {
    assert.throws(() => convertTable([["StyleNumber", "Store"], ["", number], ["A", 2]]), /Could not find/);
  }
  for (const table of [
    [["StyleNumber", "Store", 12], ["A", "", 2]],
    [["StyleNumber", "Store"], [], ["", 12], ["A", 2]],
  ]) assert.throws(() => convertTable(table), /Could not find/);
});

test("corrected styles take precedence and blank corrected cells fall back to the same row's Style Number", () => {
  const table = [
    ["Style Number", "CORRECTED STYLE#", "Store 1", "Store 5"],
    ["Original-1", "Corrected.bK", 3, 0],
    ["Original-only", "", 7, 0],
    ["Whitespace", " \t ", 0, 4],
    ["Null-value", null, 0, 2],
    ["Missing-value", undefined, 1, 0],
    ["Formula-empty", { t: "str", f: '""', v: "" }, 0, 5],
    ["Should-not-replace", 0, 1, 0],
    ["", "", 999, 999],
  ];
  for (const input of [table, table.map(([original, corrected, ...stores]) => [corrected, original, ...stores])]) {
    const result = convertTable(input);
    assert.equal(result.styleCount, 7);
    assert.equal(result.lineCount, 7);
    assert.equal(result.totalQuantity, 23);
    const expected = [["Corrected.bK", 3], ["Original-only", 7], ["Missing-value", 1], ["0", 1],
      ["Whitespace", 4], ["Null-value", 2], ["Formula-empty", 5]];
    assert.deepEqual(result.rows.filter(row => row[0] === "L").map(row => row.slice(1, 3)), expected);
    const csvWorkbook = XLSX.read(create940CSV(result), { type: "string", raw: true });
    const csvRows = XLSX.utils.sheet_to_json(csvWorkbook.Sheets.Sheet1, { header: 1 });
    assert.deepEqual(csvRows.filter(row => row[0] === "L").map(row => row.slice(1, 3)),
      expected.map(([style, quantity]) => [style, String(quantity)]));
  }
});

test("no and change substrings in corrected values fall back without changing original identifiers", () => {
  const values = ["no", "NO", "nO", "nO ChAnGe", "change", "CHANGE", "cHaNgE", "unchanged", "SNOW-001", "Another.nV",
    "EXCHANGE-2", "", " \t ", null, undefined, { t: "str", f: '"NO"', v: "No" }];
  const originals = values.map((_, i) => i ? `NO-Change-${i}.bK` : { t: "n", v: 7, w: "000007" });
  const expected = originals.map((value, i) => [i ? value : "000007", i + 1]);
  for (const heading of ["CorrectStyle#", "CORRECTED STYLE#"]) {
    const table = [["StyleNumber", heading, "Store1"], ...values.map((value, i) => [originals[i], value, i + 1])];
    for (const input of [table, table.map(([original, corrected, quantity]) => [corrected, original, quantity])]) {
      const result = convertTable(input);
      assert.equal(result.styleCount, values.length);
      assert.deepEqual(result.rows.slice(2).map(row => row.slice(1, 3)), expected);
      const workbook = XLSX.read(create940CSV(result), { type: "string", raw: true });
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets.Sheet1, { header: 1 });
      assert.deepEqual(rows.slice(2).map(row => row.slice(1, 3)), expected.map(([style, quantity]) => [style, String(quantity)]));
    }
  }
  const originalOnly = convertTable([["StyleNumber", "Store1"], ["NO-CHANGE.bK", 2]]);
  assert.deepEqual(originalOnly.rows[2].slice(0, 4), ["L", "NO-CHANGE.bK", 2, "EA"]);
});

test("corrected placeholders with no usable fallback are skipped instead of exported as styles", () => {
  for (const table of [
    [["CorrectStyle#", "Store1"], ["NO", 900], ["change", 800], ["", 700], ["Kept.bK", 2]],
    [["StyleNumber", "CorrectedStyle#", "Store1"], ["", "NO", 900], [null, "change", 800],
      [undefined, "", 700], ["Kept.bK", "nO ChAnGe", 2]],
  ]) {
    const result = convertTable(table);
    assert.equal(result.styleCount, 1);
    assert.equal(result.totalQuantity, 2);
    assert.deepEqual(result.rows.slice(2).map(row => row.slice(0, 4)), [["L", "Kept.bK", 2, "EA"]]);
  }
  for (const value of ["NO", "cHaNgE", ""]) {
    assert.throws(() => convertTable([["CorrectStyle#", "Store1"], [value, 2]]), /no product rows/);
  }
});

test("a missing corrected-style column falls back to case-insensitive, split, and repeated Style Number headings", () => {
  for (const heading of [
    [["STYLE NUMBER", "STORE 01"]],
    [[" sTyLe\n NuMbEr ", "sToRe 1"]],
    [["sTyLe", "StOrE"], ["NuMbEr", 1]],
  ]) {
    const result = convertTable([...heading, ["First.bK", 2], ...heading, ["Second.rD", 3]]);
    assert.equal(result.styleColumn, 0);
    assert.equal(result.styleCount, 2);
    assert.deepEqual(result.rows.slice(2).map(row => row.slice(0, 4)), [["L", "First.bK", 2, "EA"], ["L", "Second.rD", 3, "EA"]]);
  }
});

test("style fallback does not hide errors or uncached formulas in the selected source", () => {
  const heading = ["Style Number", "CORRECTED STYLE#", "Store 1"];
  for (const cell of [{ t: "e", v: 23, w: "#REF!" }, { t: "str", f: "A1" },
    { t: "e", v: 23, w: "NO" }, { t: "str", f: "A1", w: "No Change" }]) {
    assert.throws(() => convertTable([heading, ["Original", cell, 2]]), /Cell B9/);
    for (const value of ["", "NO", "Change"]) {
      assert.throws(() => convertTable([heading, [cell, value, 2]]), /Cell A9/);
    }
    const result = convertTable([heading, [cell, "Corrected.bK", 2]]);
    assert.deepEqual(result.rows[2].slice(0, 4), ["L", "Corrected.bK", 2, "EA"]);
  }
});

test("940 template has the requested order details, shipping constants, and empty third-party/billing range", () => {
  const template = create940Template(parseHamricksSheet(splitSheet()));
  assert.deepEqual(template[0], [
    "Line Type", "Facility", "Customer PO", "Priority", "Reference", "Ship to Company Name",
    "Ship to Contact name", "Ship to Address 1", "Ship to Address2", "Ship to City", "Ship to State",
    "Ship to Postal Code", "Ship to Country", "Shipment Type (S-Small, L-LTL)", "Carrier", "Shipment Terms",
    "Third Party Account #", "Packlist Code", "Delivery Service", "Bill to Company Name", "Bill to Contact name",
    "Bill to Address 1", "Bill to Address2", "Bill to City", "Bill to State", "Bill to Postal Code",
    "Bill to Country", "Ship Date", "Cancel Date",
  ]);
  assert.deepEqual(template[1], ["H", "RED", "001234", "A", "001234-05", "HAMRICK'S",
    "Example department", "742 Peachoid Road", "Store 05 Gaffney", "Gaffney", "SC", "29341", "USA", "L", "CITY", "COL",
    "", "", "", "", "", "", "", "", "", "", "", "20270405", "20270409"]);
  assert.deepEqual(template[2], fullRow([]));
  assert.deepEqual(template[3], fullRow([]));
  assert.equal(template.length, 7);
});

test("PO lookup follows shifted labels and spacer columns, preserving formatted PO numbers in every store", () => {
  for (const gap of [1, 2, 5]) {
    const input = withDetails([["CORRECTED STYLE#", "Store 5", "Store 12"], ["A", 1, 2]], {
      labelRow: 2, labelColumn: 1, valueColumn: 1 + gap,
      po: { t: "n", v: 9001, w: "009001", f: "9000+1" }, contact: "Receiving department",
      ship: "29-Feb-28", cancel: "20280307",
    });
    input[2][1] = "  po #   >  ";
    input[2][gap + 4] = "Unrelated information";
    const result = convertHamricksSheet(input);
    assert.deepEqual(result.rows.filter(row => row[0] === "H").map(row => [row[2], row[3], row[4], row[6], row[27], row[28]]), [
      ["009001", "A", "009001-05", "Receiving department", "20280229", "20280307"],
      ["009001", "A", "009001-12", "Receiving department", "20280229", "20280307"],
    ]);
    assert.deepEqual(result.rows.filter(row => row[0] === "L").map(row => row[3]), ["EA", "EA"]);
  }
});

test("PO labels match a case-insensitive substring anywhere in the cell", () => {
  for (const label of ["PO", "po", "Po", "pO", "Customer po number:", "(Po#)", "Report"]) {
    const input = withDetails([["CORRECTED STYLE#", "Store 1"], ["A", 2]], { po: "004321" });
    input[0][0] = label;
    const result = convertHamricksSheet(input);
    assert.deepEqual([result.rows[1][2], result.rows[1][4]], ["004321", "004321-01"]);
  }
});

test("PO lookup selects the topmost match and then the leftmost, ignoring later matches", () => {
  const input = withDetails([["CORRECTED STYLE#", "Store 1"], ["A", 2]], {
    labelRow: 2, labelColumn: 2, valueColumn: 4, po: "004321", contact: "First department",
  });
  input[0] = ["Workbook title", 42];
  input[2][2] = "Customer pO number";
  input[2][7] = "PO# >";
  input[2][8] = "LATER-SAME-ROW";
  input[3][0] = "po";
  input[3][1] = "LATER-ROW-FURTHER-LEFT";
  const result = convertHamricksSheet(input);
  const header = result.rows[1];
  assert.deepEqual([header[2], header[4], header[6], header[27], header[28]],
    ["004321", "004321-01", "First department", "20270405", "20270409"]);
});

test("shipping dates support Excel serials and explicit text formats without rolling invalid days forward", () => {
  for (const [ship, expected] of [
    [1, "19000101"], [59, "19000228"], [61, "19000301"],
    [{ t: "n", v: 61.75, w: "Display text is not the date", f: "61+0.75" }, "19000301"],
    [{ t: "d", v: new Date("2028-02-29T00:00:00Z") }, "20280229"],
    ["2028-02-29", "20280229"], ["2028/2/29", "20280229"], ["20280229", "20280229"],
    ["2/29/2028", "20280229"], ["02/29/28", "20280229"], ["29-Feb-28", "20280229"],
  ]) {
    const result = convertTable([["CORRECTED STYLE#", "Store 1"], ["A", 2]], { ship, cancel: ship });
    assert.deepEqual(result.rows[1].slice(27), [expected, expected]);
  }
  for (const ship of ["", null, false, NaN, Infinity, -1, 0, 60, 60.5, 9999999, "2027-02-29", "2028-02-30", "13/01/2028", "soon"]) {
    assert.throws(() => convertTable([["CORRECTED STYLE#", "Store 1"], ["A", 2]], { ship }), /Cell C5.*valid ship date/);
  }
  assert.throws(() => convertTable([["CORRECTED STYLE#", "Store 1"], ["A", 2]], { cancel: "2028-04-31" }), /Cell C6.*valid cancel date/);
});

test("XLS, XLSX, and XLSM preserve merged PO labels, formatted PO identifiers, and both Excel date systems", () => {
  for (const bookType of ["biff8", "xlsx", "xlsm"]) {
    for (const date1904 of [false, true]) {
      const input = withDetails([["CORRECTED STYLE#", "Store 5"], ["A", 2]], {
        valueColumn: 5, po: { t: "n", v: 42, z: "000000" },
        ship: { t: "n", v: date1904 ? 0 : 1462, z: "d-mmm-yy" },
        cancel: { t: "n", v: date1904 ? 59 : 1521, z: "m/d/yyyy" },
      });
      const sheet = XLSX.utils.aoa_to_sheet(input);
      sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
      const workbook = XLSX.utils.book_new();
      workbook.Workbook = { WBProps: { date1904 } };
      XLSX.utils.book_append_sheet(workbook, sheet, "PO");
      const parsed = readHamricksWorkbook(XLSX.write(workbook, { type: "array", bookType }));
      assert.equal(parsed.sheets[0].error, undefined);
      const header = parsed.sheets[0].result.rows[1];
      assert.deepEqual([header[2], header[4], ...header.slice(27)], ["000042", "000042-05", "19040101", "19040229"]);
    }
  }
});

test("missing PO labels or values and uncached metadata formulas fail with source cell details", () => {
  const table = [["CORRECTED STYLE#", "Store 1"], ["A", 2]];
  assert.throws(() => convertHamricksSheet(table), /Could not find a cell containing "PO"/);
  assert.throws(() => convertTable(table, { po: " " }), /row 1 has no value to its right/);
  const missingValue = withDetails(table, { po: " " });
  missingValue[2] = ["PO# >", "", "OTHER-PO"];
  assert.throws(() => convertHamricksSheet(missingValue), /row 1 has no value to its right/);
  for (const [field, address] of [["po", "C1"], ["contact", "C2"], ["ship", "C5"], ["cancel", "C6"]]) {
    assert.throws(() => convertTable(table, { [field]: { t: "n", f: "A1+1" } }), new RegExp(`Cell ${address}.*saved result`));
    assert.throws(() => convertTable(table, { [field]: { t: "e", v: 23, w: "#REF!" } }), new RegExp(`Cell ${address}.*Excel error`));
  }
});

test("CSV applies existing formula protection to PO numbers and contact names", () => {
  const table = [["CORRECTED STYLE#", "Store 1"], ["A", 2]];
  for (const details of [{ po: "=1+2" }, { contact: "+1+2" }]) {
    assert.throws(() => create940CSV(convertTable(table, details)), /Review the source value/);
  }
});

test("single-row headings preserve column order, repeated styles, numeric text, and legitimate signed quantities", () => {
  const result = convertTable([
    [" cOrReCtEd\nStYlE # ", "Store 12", "Units", " store   01 ", "Store 0"],
    ["SAME", "1,200", 8000, -2, 88], ["SAME", 0.5, 9000, " 0 ", 99],
    [0, null, 10000, 1, 77],
  ]);
  assert.deepEqual(result.stores.map((s) => s.number), [12, 1]);
  assert.deepEqual(result.rows.filter((r) => r[0] === "L").map((r) => r.slice(1, 3)),
    [["SAME", 1200], ["SAME", 0.5], ["SAME", -2], ["0", 1]]);
});

test("repeated headings are skipped, but changed or duplicate column mappings fail explicitly", () => {
  const rows = [["CORRECTED STYLE#", "Store 1"], ["A", 2], ["CORRECTED STYLE#", "Store 1"], ["B", 3]];
  assert.equal(convertTable(rows).styleCount, 2);
  assert.throws(() => convertHamricksSheet([...rows, ["CORRECTED STYLE#", "Store 2"], ["C", 4]]), /layout changes at row 5/);
  assert.throws(() => convertHamricksSheet([["CORRECTED STYLE#", "Store 1", "Store 01"], ["A", 1, 2]]), /more than one column/);
  assert.throws(() => convertHamricksSheet([["CORRECTED STYLE#", "corrected style#", "Store 1"], ["A", "B", 2]]), /more than one corrected-style column/);
  assert.throws(() => convertHamricksSheet([["Style Number", "style number", "Store 1"], ["A", "B", 2]]), /more than one Style Number/);
  assert.throws(() => convertTable([
    ["CORRECTED STYLE#", "Style Number", "", "Store 1"], ["A", "Old-A", "", 2],
    ["CORRECTED STYLE#", "", "Style Number", "Store 1"], ["", "", "B", 3],
  ]), /layout changes/);
});

test("all-zero worksheets contain only column headings, and rows without a style are excluded", () => {
  const result = convertTable([["CORRECTED STYLE#", "Store 7"], ["A", 0], ["B", ""], ["", 999]]);
  assert.equal(result.styleCount, 2);
  assert.equal(result.lineCount, 0);
  assert.equal(result.totalQuantity, 0);
  assert.deepEqual(result.stores, []);
  assert.deepEqual(result.rows, [[...HEADERS_940]]);
  const csv = create940CSV(result);
  assert.equal(csv.split("\r\n").length, 2);
  const csvWorkbook = XLSX.read(csv, { type: "string", raw: true });
  assert.deepEqual(XLSX.utils.sheet_to_json(csvWorkbook.Sheets.Sheet1, { header: 1, defval: "", blankrows: true }), [[...HEADERS_940]]);
  const workbook = XLSX.read(create940Workbook(result), { type: "array" });
  assert.equal(workbook.Sheets["940"]["!ref"], "A1:AC1");
});

test("omitting leading, middle, and trailing empty stores preserves allocations, including offsetting signed entries", () => {
  const result = convertTable([
    ["CORRECTED STYLE#", "Store 1", "Store 5", "Store 12", "Store 103", "Store 9"],
    ["A", 0, 2, "", 0, 0], ["B", null, 0, 0, 3, "0"], ["C", 0, -2, 0, 4, ""],
  ]);
  assert.deepEqual(result.stores.map(s => [s.number, s.startRow, s.endRow, s.units]), [[5, 1, 3, 0], [103, 4, 6, 7]]);
  assert.deepEqual(result.rows.filter(row => row[0] === "H").map(row => [row[4], row[8]]),
    [["001234-05", "Store 05 Gaffney"], ["001234-103", "Store 103 Gaffney"]]);
  assert.deepEqual(result.rows.slice(2, 4).map(row => row.slice(0, 4)), [["L", "A", 2, "EA"], ["L", "C", -2, "EA"]]);
  assert.deepEqual(result.rows.slice(5).map(row => row.slice(0, 4)), [["L", "B", 3, "EA"], ["L", "C", 4, "EA"]]);
  assert.equal(result.lineCount, 4);
  assert.equal(result.totalQuantity, 7);
  assert.ok(result.rows.every(row => row.some(value => value !== "")));
});

test("invalid quantities and Excel errors cannot silently become zero or disappear", () => {
  for (const cell of ["six", "1,2", false, Infinity, { t: "e", v: 7, w: "#DIV/0!" }, { t: "n", f: "SUM(C1:D1)" }]) {
    assert.throws(() => convertHamricksSheet([["CORRECTED STYLE#", "Store 1"], ["A", cell]]), /Cell B2/);
  }
  assert.throws(() => convertHamricksSheet([["CORRECTED STYLE#", "Store 1"], [{ t: "e", v: 23 }, 4]]), /Cell A2/);
  const result = convertTable([["CORRECTED STYLE#", "Store 1"], ["A", { t: "n", f: "1+2", v: 3, w: "3" }]]);
  assert.equal(result.rows[2][2], 3);
  for (const bookType of ["xlsx", "xlsm"]) {
    const uncached = workbookBytes([["PO", [["CORRECTED STYLE#", "Store 1"], ["A", { t: "n", f: "1+2" }]]]], bookType);
    assert.match(readHamricksWorkbook(uncached).sheets[0].error, /Cell B2.*Recalculate/);
  }
});

test("XLS, XLSX, and XLSM readers handle split headings and preserve formatted identifiers", () => {
  for (const bookType of ["biff8", "xlsx", "xlsm"]) {
    const bytes = workbookBytes([["PO", splitSheet()]], bookType);
    const parsed = readHamricksWorkbook(bytes);
    assert.equal(parsed.sheets[0].result.totalQuantity, 17);
    assert.equal(parsed.sheets[0].result.rows[2][1], "0012.BK");
    for (const table of [
      [["Style Number", "CORRECTED STYLE#", "Store 1"], [{ t: "n", v: 7, z: "000000" }, "", 2]],
      [["Style Number", "Store 1"], [{ t: "n", v: 7, z: "000000" }, 2]],
      [[" stylenumber ", "cOrReCtStYlE #", "sToRe01"], [{ t: "n", v: 7, z: "000000" }, "", 2]],
      [["CorrectedStyle#", "Store"], ["", " 01 "], [{ t: "n", v: 7, z: "000000" }, 2]],
      [["StyleNumber", "CorrectStyle#", "Store1"], [{ t: "n", v: 7, z: "000000" }, "nO cHaNgE", 2]],
    ]) {
      const fallback = readHamricksWorkbook(workbookBytes([["PO", withDetails(table)]], bookType));
      assert.equal(fallback.sheets[0].error, undefined);
      assert.deepEqual(fallback.sheets[0].result.rows[2].slice(0, 4), ["L", "000007", 2, "EA"]);
    }
  }
  const bytes = workbookBytes([["PO", withDetails([["CORRECTED STYLE#", "Store 1"], [{ t: "n", v: 7, z: "000000" }, 2]])]]);
  assert.equal(readHamricksWorkbook(bytes).sheets[0].result.rows[2][1], "000007");
});

test("XLSM conversion uses saved formula values and leaves embedded VBA out of exports", async () => {
  const input = withDetails([["Style Number", "Store 5"],
    [{ t: "n", v: 7, z: "000000" }, { t: "n", f: "MacroQuantity()", v: 3 }]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(input), "PO");
  // An inert marker exercises the VBA container path without shipping executable macros.
  const vba = new TextEncoder().encode("Synthetic inert VBA project marker");
  workbook.vbaraw = vba;
  const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsm", compression: true }));
  const original = bytes.slice();
  const sourceZip = await globalThis.JSZip.loadAsync(bytes);
  assert.match(await sourceZip.file("[Content_Types].xml").async("string"), /application\/vnd\.ms-excel\.sheet\.macroEnabled\.main\+xml/);
  assert.deepEqual(await sourceZip.file("xl/vbaProject.bin").async("uint8array"), vba);

  const parsed = readHamricksWorkbook(bytes);
  assert.equal(parsed.sheets[0].error, undefined);
  const result = parsed.sheets[0].result;
  assert.deepEqual(result.rows[2].slice(0, 4), ["L", "000007", 3, "EA"]);
  assert.equal(create940CSV(result), create940CSV(convertTable([["Style Number", "Store 5"], ["000007", 3]])));
  assert.deepEqual(bytes.slice(), original, "The source workbook bytes are preserved");

  const exported = await globalThis.JSZip.loadAsync(create940Workbook(result));
  assert.equal(exported.file("xl/vbaProject.bin"), null);
  const contentTypes = await exported.file("[Content_Types].xml").async("string");
  assert.match(contentTypes, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\.main\+xml/);
  assert.doesNotMatch(contentTypes, /vbaProject/);
  assert.doesNotMatch(await exported.file("xl/worksheets/sheet1.xml").async("string"), /<f[ >]/);
});

test("worksheets stay separate and invalid layouts remain visible without blocking usable sheets", () => {
  const parsed = readHamricksWorkbook(workbookBytes([
    ["Notes", [["No table here"]]], ["First", withDetails([["CORRECTED STYLE#", "Store 5"], ["ALPHA", 2]], { po: "FIRST-900" })],
    ["Second", withDetails([["CORRECTED STYLE#", "Store 7"], ["BETA", 9]], { po: "SECOND-800" })], ["Empty", []],
  ]));
  assert.match(parsed.sheets[0].error, /Could not find/);
  assert.equal(parsed.sheets[1].result.totalQuantity, 2);
  assert.equal(parsed.sheets[2].result.totalQuantity, 9);
  assert.equal(parsed.sheets[1].result.rows[1][4], "FIRST-900-05");
  assert.equal(parsed.sheets[2].result.rows[1][4], "SECOND-800-07");
  assert.match(parsed.sheets[3].error, /empty/);
});

test("CSV preserves 29 columns, quoted text, and CRLF endings without empty rows", () => {
  const result = convertTable([["CORRECTED STYLE#", "Store 5"], ['A,"B', 4], ["ZERO", 0]], { contact: 'Receiving, Door "A"' });
  const csv = create940CSV(result);
  assert.ok(csv.includes('L,"A,""B",4,EA,'));
  assert.equal(result.rows.length, 3);
  assert.ok(csv.endsWith("\r\n"));
  assert.ok(!csv.split("\r\n").includes(",".repeat(28)));
  assert.equal(csv.split("\r\n").length, result.rows.length + 1);
  const back = XLSX.read(csv, { type: "string", raw: true });
  const rows = XLSX.utils.sheet_to_json(back.Sheets.Sheet1, { header: 1, raw: true, defval: "", blankrows: true });
  assert.deepEqual(rows[0], HEADERS_940);
  assert.deepEqual(rows[1].slice(2, 8), ["001234", "A", "001234-05", "HAMRICK'S", 'Receiving, Door "A"', "742 Peachoid Road"]);
  assert.deepEqual(rows[1].slice(27), ["20270405", "20270409"]);
  assert.deepEqual(rows[2].slice(0, 4), ["L", 'A,"B', "4", "EA"]);
});

test("Excel output uses text identifiers and numeric quantities without empty stores or blank rows", async () => {
  const bytes = create940Workbook(convertHamricksSheet(splitSheet()));
  const zip = await globalThis.JSZip.loadAsync(bytes);
  const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(sheet, /<dimension ref="A1:AC7"/);
  assert.match(sheet, /<c r="B3" t="str"><v>0012.BK<\/v><\/c>/);
  assert.match(sheet, /<c r="C3"><v>3<\/v><\/c>/);
  assert.ok(!sheet.includes("<f>"));
  const back = XLSX.read(bytes, { type: "array" });
  assert.deepEqual(back.SheetNames, ["940"]);
  assert.equal(back.Sheets["940"]["!ref"], "A1:AC7");
  const rows = XLSX.utils.sheet_to_json(back.Sheets["940"], { header: 1, defval: "", blankrows: true });
  assert.ok(rows.every(row => row.some(value => value !== "")));
  assert.deepEqual(rows.filter(row => row[0] === "H").map(row => row[4]), ["001234-05", "001234-12"]);
});

test("formula-looking styles stay literal in XLSX and cannot be emitted as active CSV formulas", async () => {
  for (const style of ['=HYPERLINK("https://example.invalid","x")', "+123", "@SUM(A1)", "-SKU"]) {
    const result = convertTable([["CORRECTED STYLE#", "Store 1"], [style, 1]]);
    assert.throws(() => create940CSV(result), /Review the source value/);
    const workbook = XLSX.read(create940Workbook(result), { type: "array" });
    assert.equal(workbook.Sheets["940"].B3.v, style);
    assert.equal(workbook.Sheets["940"].B3.t, "s");
    assert.equal(workbook.Sheets["940"].B3.f, undefined);
  }
});

test("bad files, missing layouts, and oversized output fail with useful messages", () => {
  assert.throws(() => validateHamricksFile({ name: "test.csv", size: 20 }), /xls/);
  assert.throws(() => validateHamricksFile({ name: "test.xls", size: 0 }), /empty/);
  assert.throws(() => validateHamricksFile({ name: "test.xlsx", size: MAX_WORKBOOK_BYTES + 1 }), /25 MB/);
  assert.throws(() => readHamricksWorkbook(new TextEncoder().encode("not an excel file")), /not an Excel/);
  assert.throws(() => readHamricksWorkbook(new Uint8Array([0x50, 0x4B, 0x03, 0x04])), /could not be read/);
  assert.throws(() => convertHamricksSheet([["Style Description", "Store 1"], ["A", 2]]), /CORRECTED STYLE#/);
  assert.throws(() => convertHamricksSheet([["CORRECTED STYLE#", "Store 1"], ["", 2]]), /no product rows/);
  const many = [["CORRECTED STYLE#", "Store 1", "Store 2"], ...Array.from({ length: 50000 }, () => ["A", 1, 1])];
  assert.throws(() => convertHamricksSheet(many), /exceed 100,000/);
  const sparse = withDetails([["CORRECTED STYLE#", "Store 1", "Store 2"], ["FIRST", 1, 0],
    ...Array.from({ length: 50000 }, () => ["ZERO", 0, 0])]);
  assert.equal(convertHamricksSheet(sparse).rows.length, 3);
  assert.equal(output940Name("order.XLS", "csv"), "order_940.csv");
});

test("supported workbook extensions accept either case and produce clean output names", () => {
  for (const extension of ["xls", "xlsx", "xlsm", "XLS", "XLSX", "XLSM", "Xlsm"]) {
    const name = `purchase.order.${extension}`;
    assert.doesNotThrow(() => validateHamricksFile({ name, size: 20 }));
    assert.equal(output940Name(name, "csv"), "purchase.order_940.csv");
    assert.equal(output940Name(name, "xlsx"), "purchase.order_940.xlsx");
    assert.throws(() => validateHamricksFile({ name, size: 0 }), /empty/);
    assert.throws(() => validateHamricksFile({ name, size: MAX_WORKBOOK_BYTES + 1 }), /25 MB/);
  }
  for (const name of ["order.xlsb", "order.xlam", "order.xlsm.csv", "orderxlsm"]) {
    assert.throws(() => validateHamricksFile({ name, size: 20 }), /Select an Excel.*\.xlsm/);
  }
});
