import { COLUMNS, exceedsExcelCellLimits } from "./aafes-parser.js";
import { outputName } from "./pdf-reader.js";
import "./vendor/jszip/jszip.min.js";

export { outputName };

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function escapeXML(value) {
  return String(value).replace(/_x([\da-f]{4})_/gi, "_x005F_x$1_")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function excelDate(iso) {
  const days = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 31)) / 86400000);
  // Excel includes the fictional date 1900-02-29 in its serial-date system.
  return days >= 60 ? days + 1 : days;
}

const textCell = (ref, value, style = 1) =>
  `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXML(value)}</t></is></c>`;

function columnName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}

function worksheetXML(records, columns) {
  const last = `${columnName(columns.length - 1)}${records.length + 1}`;
  const widths = columns.map(([key, label]) => {
    let width = Math.max(10, label.length + 3);
    for (const row of records.slice(0, 1000)) {
      for (const line of String(row[key] ?? "").split("\n")) width = Math.max(width, Math.min(45, line.length + 3));
    }
    return Math.min(45, width);
  });
  const header = `<row r="1">${columns.map(([, label], i) => textCell(`${columnName(i)}1`, label, 4)).join("")}</row>`;
  const rows = records.map((row, index) => {
    return `<row r="${index + 2}">${columns.map(([key, , type], col) => {
      const ref = `${columnName(col)}${index + 2}`;
      const value = row[key];
      if (value === null || value === undefined || value === "") return `<c r="${ref}" s="1"/>`;
      if ((type === "number" || type === "money") && typeof value === "number" && Number.isFinite(value))
        return `<c r="${ref}" s="${type === "number" ? 2 : 3}"><v>${value}</v></c>`;
      if (type === "date") {
        const date = excelDate(value);
        if (Number.isFinite(date)) return `<c r="${ref}" s="6"><v>${date}</v></c>`;
      }
      if (exceedsExcelCellLimits(value))
        throw new Error(`A value for PO ${row.po} exceeds Excel's cell limits. Shorten that individual value before exporting.`);
      // Inline strings preserve leading zeros and prevent formula injection.
      return textCell(ref, value);
    }).join("")}</row>`;
  }).join("");
  return `${XML}<worksheet xmlns="${NS}"><dimension ref="A1:${last}"/><sheetViews><sheetView showGridLines="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join("")}</cols><sheetData>${header}${rows}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`;
}

export function workbookParts(records) {
  if (!records.length) throw new Error("There are no extracted purchase orders to export.");
  if (records.length > 100000)
    throw new Error("Export is limited to 100,000 source line items per PDF.");
  const sheets = [{ name: "Purchase Orders", rows: records, columns: COLUMNS }];
  const parts = {
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    "_rels/.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView/></bookViews><sheets>${sheets.map((sheet, i) => `<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `${XML}<styleSheet xmlns="${NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy/mm/dd"/><numFmt numFmtId="165" formatCode="yyyy/mm/dd"/></numFmts><fonts count="1"><font><sz val="11"/><color auto="1"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  };
  sheets.forEach((sheet, i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = worksheetXML(sheet.rows, sheet.columns); });
  return parts;
}

export async function createWorkbook(records) {
  const zip = new globalThis.JSZip();
  for (const [path, xml] of Object.entries(workbookParts(records))) zip.file(path, xml);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: MIME });
}

export async function createWorkbookArchive(results) {
  const zip = new globalThis.JSZip();
  const used = new Set();
  for (const result of results) {
    const base = outputName(result.name);
    let name = base, suffix = 2;
    while (used.has(name.toLowerCase())) name = base.replace(/\.xlsx$/, `_${suffix++}.xlsx`);
    used.add(name.toLowerCase());
    zip.file(name, await createWorkbook(result.records));
  }
  return zip.generateAsync({ type: "uint8array", compression: "STORE" });
}

export function downloadFile(data, name) {
  const blob = new Blob([data], { type: name.endsWith(".zip") ? "application/zip" : MIME });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
