import * as XLSX from "./vendor/sheetjs/xlsx.mjs";
import * as codepages from "./vendor/sheetjs/cpexcel.full.mjs";
import { convertHamricksSheet, MAX_OUTPUT_ROWS, MAX_WORKBOOK_BYTES } from "./hamricks-converter.js";
import { prepareWorkbookZip } from "./hamricks-zip.js";

XLSX.set_cptable(codepages);

export function readHamricksWorkbook(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (!bytes.length || bytes.length > MAX_WORKBOOK_BYTES) throw new Error("The workbook must be nonempty and no larger than 25 MB.");
  const ole = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1].every((byte, index) => bytes[index] === byte);
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!ole && !zip) throw new Error("This file is not an Excel .xls, .xlsx, or .xlsm workbook. Open it in Excel and save it in one of those formats.");
  let workbook;
  try {
    // Read saved cell values without retaining VBA projects. No macros or formulas are executed.
    workbook = XLSX.read(zip ? prepareWorkbookZip(bytes) : bytes, { type: "array", cellFormula: true, cellHTML: false, cellText: true, bookVBA: false });
  } catch {
    throw new Error("The workbook could not be read. Check that it is not damaged or password protected, then save it again in Excel.");
  }
  if (!workbook.SheetNames.length) throw new Error("The workbook has no worksheets.");
  if (workbook.SheetNames.length > 30) throw new Error("Select a workbook with at most 30 worksheets.");
  let totalRows = 0;
  return { sheets: workbook.SheetNames.map((name) => {
    try {
      const sheet = workbook.Sheets[name];
      if (!sheet?.["!ref"]) throw new Error("This worksheet is empty.");
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      if (range.e.r >= 300 || range.e.c >= 300)
        throw new Error("This worksheet is too large. Use at most 300 rows and 300 columns.");
      // Retain saved formula results and formatted identifiers, including zeros.
      const rows = Array.from({ length: range.e.r + 1 }, (_, r) =>
        Array.from({ length: range.e.c + 1 }, (_, c) => sheet[XLSX.utils.encode_cell({ r, c })]));
      const result = convertHamricksSheet(rows, { date1904: !!workbook.Workbook?.WBProps?.date1904 });
      if (totalRows + result.rows.length > MAX_OUTPUT_ROWS)
        throw new Error("The workbook's combined 940 templates exceed 100,000 rows. Convert this worksheet in a separate workbook.");
      totalRows += result.rows.length;
      return { name, result };
    } catch (error) { return { name, error: error.message }; }
  }) };
}
