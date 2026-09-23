// Business rules are kept separate from Excel parsing and the browser UI.
export const HEADERS_940 = Object.freeze([
  "Line Type", "Facility", "Customer PO", "Priority", "Reference",
  "Ship to Company Name", "Ship to Contact name", "Ship to Address 1",
  "Ship to Address2", "Ship to City", "Ship to State", "Ship to Postal Code",
  "Ship to Country", "Shipment Type (S-Small, L-LTL)", "Carrier", "Shipment Terms",
  "Third Party Account #", "Packlist Code", "Delivery Service", "Bill to Company Name",
  "Bill to Contact name", "Bill to Address 1", "Bill to Address2", "Bill to City",
  "Bill to State", "Bill to Postal Code", "Bill to Country", "Ship Date", "Cancel Date",
]);

export const MAX_OUTPUT_ROWS = 100000;
export const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024;
const blankRow = () => Array(HEADERS_940.length).fill("");
const raw = (cell) => cell && typeof cell === "object" ? cell.v : cell;
const text = (cell) => String(cell && typeof cell === "object" ? cell.w ?? cell.v ?? "" : cell ?? "").trim();
// Normalize only lookup labels; source identifiers keep their original casing.
const label = (cell) => text(cell).replace(/\s+/g, " ").toLowerCase();
const styleHeader = (name) => /^corrected style\s*#$/.test(name) ? "corrected" : name === "style number" ? "original" : null;

export function validateHamricksFile(file) {
  if (!/\.xls[xm]?$/i.test(file.name)) throw new Error("Select an Excel .xls, .xlsx, or .xlsm workbook.");
  if (!file.size) throw new Error("The selected workbook is empty.");
  if (file.size > MAX_WORKBOOK_BYTES) throw new Error("Select a workbook no larger than 25 MB.");
}

export function columnName(column) {
  let name = "";
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
  return name;
}

function checkedValue(cell, row, column) {
  if (cell?.f && (cell.v === undefined || cell.v === null))
    throw new Error(`Cell ${columnName(column)}${row + 1} has a formula without a saved result. Recalculate and save it in Excel first.`);
  if (cell?.t === "e") throw new Error(`Cell ${columnName(column)}${row + 1} contains an Excel error. Correct it and save the workbook again.`);
  return raw(cell);
}

function quantity(cell, row, column) {
  const value = checkedValue(cell, row, column);
  if (value === undefined || value === null) return 0;
  const token = String(value).trim();
  if (!token) return 0;
  const numeric = typeof value === "number" || /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(token);
  const result = numeric ? Number(token.replaceAll(",", "")) : NaN;
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER)
    throw new Error(`Cell ${columnName(column)}${row + 1} must contain a numeric quantity, zero, or a blank.`);
  return result;
}

function date940(cell, row, column, name, date1904) {
  const value = checkedValue(cell, row, column);
  let year, month, day;
  if (typeof value === "number" && Number.isFinite(value)) {
    const serial = Math.floor(value);
    // Work in UTC so the browser's time zone cannot shift the shipping day.
    // Serial 60 in the 1900 system is Excel's fictional February 29.
    if (serial >= (date1904 ? 0 : 1) && (date1904 || serial !== 60)) {
      const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
      const date = new Date(epoch + (serial - (!date1904 && serial > 60 ? 1 : 0)) * 86400000);
      [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    }
  } else if (value instanceof Date) {
    [year, month, day] = [value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()];
  } else if (typeof value === "string") {
    const token = value.trim();
    const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(token) || /^(\d{4})(\d{2})(\d{2})$/.exec(token);
    const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4}|\d{2})$/.exec(token);
    const named = /^(\d{1,2})[- ]([a-z]{3})[- ](\d{4}|\d{2})$/i.exec(token);
    if (iso) [year, month, day] = iso.slice(1).map(Number);
    else if (us) [month, day, year] = us.slice(1).map(Number);
    else if (named) {
      day = Number(named[1]);
      month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(named[2].toLowerCase()) + 1;
      year = Number(named[3]);
    }
    if ((us?.[3] ?? named?.[3])?.length === 2) year += year < 30 ? 2000 : 1900;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!(year >= 1900 && year <= 9999) || date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    throw new Error(`Cell ${columnName(column)}${row + 1} must contain a valid ${name}. Use an Excel date or text such as YYYY-MM-DD or MM/DD/YYYY.`);
  return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

function orderDetails(rows, date1904) {
  let marker;
  // Topmost row wins; within that row, use the leftmost substring match.
  for (let row = 0; row < rows.length && !marker; row++) {
    for (let column = 0; column < (rows[row]?.length ?? 0); column++) {
      if (label(rows[row][column]).includes("po")) {
        marker = { row, column };
        break;
      }
    }
  }
  if (!marker) throw new Error('Could not find a cell containing "PO" in this worksheet.');
  const { row, column: labelColumn } = marker;
  let column = labelColumn + 1;
  // Merged labels and blank spacer columns mean the value is not always two cells away.
  for (; column < rows[row].length; column++) {
    checkedValue(rows[row][column], row, column);
    if (text(rows[row][column])) break;
  }
  if (column === rows[row].length) throw new Error(`The PO field in row ${row + 1} has no value to its right.`);
  const contactCell = rows[row + 1]?.[column];
  checkedValue(contactCell, row + 1, column);
  return {
    customerPO: text(rows[row][column]),
    contactName: text(contactCell),
    shipDate: date940(rows[row + 4]?.[column], row + 4, column, "ship date", date1904),
    cancelDate: date940(rows[row + 5]?.[column], row + 5, column, "cancel date", date1904),
  };
}

function headerAt(rows, row) {
  const current = rows[row] ?? [], next = rows[row + 1] ?? [];
  const styles = { corrected: [], original: [] }, stores = [];
  let depth = 1;
  for (let column = 0; column < current.length; column++) {
    const name = label(current[column]);
    const singleStyle = styleHeader(name);
    const splitStyle = !singleStyle && name && styleHeader(`${name} ${label(next[column])}`);
    if (singleStyle || splitStyle) {
      styles[singleStyle || splitStyle].push(column);
      if (splitStyle) depth = 2;
    }
    const inline = /^store\s+(\d+)$/.exec(name);
    const split = name === "store" && /^\d+$/.test(text(next[column]));
    if (!inline && !split) continue;
    const number = Number(inline ? inline[1] : text(next[column]));
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    stores.push({ number, column });
    if (split) depth = 2;
  }
  if (!(styles.corrected.length || styles.original.length) || !stores.length) return null;
  if (styles.corrected.length > 1) throw new Error(`Row ${row + 1} contains more than one CORRECTED STYLE# column.`);
  if (styles.original.length > 1) throw new Error(`Row ${row + 1} contains more than one Style Number column.`);
  const numbers = new Set();
  for (const store of stores) {
    if (numbers.has(store.number)) throw new Error(`Store ${store.number} appears in more than one column in row ${row + 1}.`);
    numbers.add(store.number);
  }
  return {
    styleColumn: styles.corrected[0] ?? styles.original[0],
    correctedStyleColumn: styles.corrected[0], styleNumberColumn: styles.original[0],
    stores, depth, row,
  };
}

export function parseHamricksSheet(rows, { date1904 = false } = {}) {
  let header;
  for (let row = 0; row < rows.length && !header; row++) header = headerAt(rows, row);
  if (!header) throw new Error("Could not find CORRECTED STYLE# or Style Number together with Store i columns. Headings may occupy one row or two adjacent rows.");
  const styleColumns = [header.correctedStyleColumn, header.styleNumberColumn].filter(column => column !== undefined);
  const styles = [];
  for (let row = header.row + header.depth; row < rows.length; row++) {
    // Repeated printed headings are not product rows. A changed layout is ambiguous.
    const repeated = headerAt(rows, row);
    if (repeated) {
      if (repeated.correctedStyleColumn !== header.correctedStyleColumn || repeated.styleNumberColumn !== header.styleNumberColumn ||
          JSON.stringify(repeated.stores) !== JSON.stringify(header.stores))
        throw new Error(`The store layout changes at row ${row + 1}. Put each layout on its own worksheet.`);
      row += repeated.depth - 1;
      continue;
    }
    let style = "";
    for (const column of styleColumns) {
      const cell = rows[row]?.[column];
      checkedValue(cell, row, column);
      style = text(cell);
      if (style) break;
    }
    if (!style) continue;
    if (style.length > 32767) throw new Error(`Style at row ${row + 1} is too long for Excel.`);
    styles.push({ row, style, quantities: header.stores.map(({ column }) => quantity(rows[row]?.[column], row, column)) });
  }
  if (!styles.length) throw new Error("The worksheet contains no product rows with a CORRECTED STYLE# or Style Number below the headings.");
  const stores = header.stores.map((store, index) => ({
    ...store, lineCount: styles.filter(item => item.quantities[index] !== 0).length,
  }));
  if (1 + stores.reduce((count, store) => count + (store.lineCount ? store.lineCount + 1 : 0), 0) > MAX_OUTPUT_ROWS)
    throw new Error("The 940 template would exceed 100,000 rows. Split the purchase order into smaller worksheets.");
  return { ...header, stores, styles, ...orderDetails(rows, date1904) };
}

export function create940Template(order) {
  const rows = [[...HEADERS_940]];
  for (const store of order.stores) {
    if (!store.lineCount) continue;
    const header = blankRow();
    const storeNumber = String(store.number).padStart(2, "0");
    header.splice(0, 16, "H", "RED", order.customerPO, "A",
      `${order.customerPO}-${storeNumber}`, "HAMRICK'S",
      order.contactName, "742 Peachoid Road", `Store ${storeNumber} Gaffney`, "Gaffney", "SC", "29341", "USA", "L", "CITY", "COL");
    // Third Party Account # through Bill to Country (inclusive) stay empty.
    header[27] = order.shipDate;
    header[28] = order.cancelDate;
    rows.push(header);
    for (let i = 0; i < store.lineCount; i++) rows.push(blankRow());
  }
  return rows;
}

export function convertHamricksSheet(input, options) {
  const order = parseHamricksSheet(input, options);
  const rows = create940Template(order);
  let lineCount = 0, totalQuantity = 0, cursor = 1;
  const stores = order.stores.flatMap((store, index) => {
    if (!store.lineCount) return [];
    const startRow = cursor;
    let nextRow = startRow + 1, units = 0;
    for (const item of order.styles) {
      const qty = item.quantities[index];
      if (qty === 0) continue;
      rows[nextRow++].splice(0, 4, "L", item.style, qty, "EA");
      units += qty;
      lineCount++;
    }
    totalQuantity += units;
    cursor = nextRow;
    return [{ ...store, startRow, endRow: nextRow - 1, units }];
  });
  return { rows, stores, styleCount: order.styles.length, styleColumn: order.styleColumn, lineCount, totalQuantity };
}

export function create940CSV(result) {
  return result.rows.map((row, r) => row.map((value) => {
    // CSV has no text cell type. Do not silently change a source value to
    // neutralize a formula. Ask the user to review the source value.
    if (typeof value === "string" && /^\s*[=+@-]/.test(value))
      throw new Error(`Row ${r + 1} contains text that Excel could treat as a formula. Review the source value before exporting CSV.`);
    const string = String(value ?? "");
    return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
  }).join(",")).join("\r\n") + "\r\n";
}

export function output940Name(name, extension) {
  return `${name.replace(/\.xls[xm]?$/i, "").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")}_940.${extension}`;
}
