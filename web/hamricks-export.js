import * as XLSX from "./vendor/sheetjs/xlsx.mjs";
import { HEADERS_940 } from "./hamricks-converter.js";

export function create940Workbook(result) {
  const sheet = XLSX.utils.aoa_to_sheet(result.rows);
  // Preserve the complete 29-column output, including empty billing fields.
  sheet["!ref"] = `A1:AC${result.rows.length}`;
  sheet["!cols"] = HEADERS_940.map((header) => ({ wch: Math.min(38, Math.max(16, header.length + 2)) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "940");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true });
}
