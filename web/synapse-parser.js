export const SYNAPSE_HEADERS = Object.freeze(["Item", "Quantity Ship", "Quantity Picked"]);
export const MAX_SYNAPSE_ROWS = 100;
export const MAX_SYNAPSE_PRICES = 500;
const MAX_INPUT_LENGTH = 2_000_000;

// Clipboard grids use tabs, including for empty cells. Quoted cells can contain
// tabs, newlines, and escaped quotes, so splitting on whitespace loses columns.
function readClipboardRows(input, maxRows, limitMessage, preserveBlankRows = false) {
  if (input.length > MAX_INPUT_LENGTH) throw new Error("Paste no more than 2 MB of text at a time.");
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const rows = [];
  let cells = [], field = "", quoted = false, closed = false, sourceRow = 1;
  const pushCell = () => { cells.push(field); field = ""; closed = false; };
  const pushRow = () => {
    pushCell();
    if (preserveBlankRows || cells.some((cell) => cell.trim())) rows.push({ cells, sourceRow });
    if (rows.length > maxRows) throw new Error(limitMessage);
    cells = []; sourceRow++;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === "\t") pushCell();
    else if (char === "\n") pushRow();
    else if (closed) {
      throw new Error(`Row ${sourceRow} has text after a closing quote. Copy the grid from Synapse again.`);
    } else if (char === '"' && !field) quoted = true;
    else field += char;
  }
  if (quoted) throw new Error(`Row ${sourceRow} has an unclosed quoted cell. Copy the grid from Synapse again.`);
  // A final line break terminates the last row; it is not another pasted cell.
  if (!preserveBlankRows || cells.length || field || closed || !text.endsWith("\n")) pushRow();
  return rows;
}

function decimal(value, row, header) {
  const token = value.trim();
  if (!/^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?|\.\d+)$/.test(token))
    throw new Error(`Row ${row}: ${header} must contain a number. Enter 0 for a zero value.`);
  const [whole, fraction = ""] = token.replaceAll(",", "").replace(/^[+-]/, "").split(".");
  return { units: BigInt(`${token.startsWith("-") ? "-" : ""}${whole || "0"}${fraction}`), scale: fraction.length };
}

function optionalDecimal(value, row, header) {
  return value?.trim() ? decimal(value, row, header) : null;
}

const optionalValue = (value) => value ? formatDecimal(value) : null;

function formatDecimal({ units, scale }) {
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, "0");
  const whole = scale ? digits.slice(0, -scale) : digits;
  const fraction = scale ? digits.slice(-scale).replace(/0+$/, "") : "";
  return `${units < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function sum(values) {
  if (!values.length) return null;
  const scale = Math.max(...values.map((value) => value.scale));
  // Sum decimal units as integers so values such as 0.1 + 0.2 copy as 0.3.
  const units = values.reduce((total, value) => total + value.units * 10n ** BigInt(scale - value.scale), 0n);
  return formatDecimal({ units, scale });
}

export function parseSynapseClipboard(input) {
  const records = readClipboardRows(input, MAX_SYNAPSE_ROWS + 1,
    `Paste no more than ${MAX_SYNAPSE_ROWS} entries at a time, plus the header row.`);
  if (!records.length) throw new Error("Paste Synapse rows with their header row to create a table.");
  const [header, ...entries] = records;
  const labels = header.cells.map((cell) => cell.trim().replace(/\s+/g, " ").toLowerCase());
  const columns = SYNAPSE_HEADERS.map((name) => {
    const label = name.toLowerCase(), index = labels.indexOf(label);
    if (index < 0) throw new Error(`Missing header: ${name}. Include the header row when copying from Synapse.`);
    if (labels.indexOf(label, index + 1) !== -1) throw new Error(`The header ${name} appears more than once. Copy one grid with a single header row.`);
    return index;
  });
  if (!entries.length) throw new Error("The header is present, but there are no entries. Include at least one order row.");
  const shipValues = [], pickedValues = [];
  const rows = entries.map(({ cells, sourceRow }) => {
    if (cells.slice(header.cells.length).some((cell) => cell.trim()))
      throw new Error(`Row ${sourceRow} has more columns than the header. Copy the grid from Synapse again.`);
    const item = cells[columns[0]]?.trim() || "";
    if (/[\u0000-\u001f\u007f]/.test(item)) throw new Error(`Row ${sourceRow}: Item must be on one line without tabs.`);
    const ship = optionalDecimal(cells[columns[1]], sourceRow, SYNAPSE_HEADERS[1]);
    const picked = optionalDecimal(cells[columns[2]], sourceRow, SYNAPSE_HEADERS[2]);
    if (ship) shipValues.push(ship);
    if (picked) pickedValues.push(picked);
    return { item, ship: optionalValue(ship), picked: optionalValue(picked) };
  });
  return { rows, totals: { ship: sum(shipValues), picked: sum(pickedValues) } };
}

export function normalizeSynapsePriceInput(input) {
  return normalizeSynapsePriceEdit(input).value;
}

export function normalizeSynapsePriceEdit(input, selectionStart = input.length, selectionEnd = selectionStart,
  range = { start: 0, end: input.length }) {
  let start = selectionStart, end = selectionEnd;
  // Clean only the first (Item) cell of each row. Numeric columns must retain
  // their decimal points and signs. Delimiters and quoted cell boundaries stay intact.
  const value = input.replace(/^[^\t\r\n]*/gm, (item, offset) => {
    const from = Math.max(0, range.start - offset), to = Math.min(item.length, range.end - offset);
    if (from >= to) return item;
    let cleaned = item.slice(0, from);
    for (let index = from; index < to; index++) {
      const char = item[index] === " " || item[index] === "-" ? "." : item[index];
      if (char === "." && (!/[A-Za-z]/.test(item[index + 1] ?? "") || cleaned.endsWith("."))) {
        if (offset + index < selectionStart) start--;
        if (offset + index < selectionEnd) end--;
      } else cleaned += char;
    }
    return cleaned + item.slice(to);
  });
  return { value, selectionStart: start, selectionEnd: end };
}

export function normalizeSynapsePricePaste(input, pasted, selectionStart, selectionEnd) {
  // Textareas use LF line endings. Normalize before mapping the insertion caret.
  const text = pasted.replace(/\r\n?/g, "\n");
  const value = input.slice(0, selectionStart) + text + input.slice(selectionEnd);
  const end = selectionStart + text.length;
  // Only the new paste is cleaned. Earlier manual edits remain verbatim, and
  // pasting into a Quantity or Price cell does not alter numeric punctuation.
  return normalizeSynapsePriceEdit(value, end, end, { start: selectionStart, end });
}

export function parseSynapsePrices(input, { rowOffset = 0 } = {}) {
  const limitMessage = `Paste no more than ${MAX_SYNAPSE_PRICES} price entries at a time.`;
  const records = readClipboardRows(input, MAX_SYNAPSE_PRICES + 1, limitMessage);
  const header = priceHeader(records[0]?.cells ?? []);
  if (header) records.shift();
  const width = header || Math.max(2, ...records.map(({ cells }) => cells.length));
  if (records.length > MAX_SYNAPSE_PRICES) throw new Error(limitMessage);
  return { rows: records.map(({ cells, sourceRow }) => {
    const row = sourceRow + rowOffset;
    if (cells.slice(header || 3).some((cell) => cell.trim()))
      throw new Error(`Price-list row ${row} has extra columns. Paste Item and Price, or Item, Quantity, and Price.`);
    const item = cells[0]?.trim() || "";
    if (/[\u0000-\u001f\u007f]/.test(item)) throw new Error(`Price-list row ${row}: Item must be on one line without tabs.`);
    const rawPrice = cells[width >= 3 ? 2 : 1]?.trim() || "";
    const price = rawPrice ? decimal(rawPrice.replace(/^\$\s*/, ""), row, "Price") : null;
    return { item, price: optionalValue(price) };
  }) };
}

const priceLabel = (label) => ["price", "wholesale unit price"].includes(label);
function priceHeader(cells) {
  const labels = cells.map((cell) => cell.trim().toLowerCase());
  if (labels[0] !== "item") return 0;
  if (labels.length === 2 && priceLabel(labels[1])) return 2;
  if (labels.length === 3 && labels[1] === "quantity" && priceLabel(labels[2])) return 3;
  return 0;
}

// Preserve empty cells and interior blank rows so independently pasted columns
// stay aligned. The old Item / Quantity / Price format maps to Item / Price.
export function readSynapsePricePaste(input, column = 0) {
  const limitMessage = `Paste no more than ${MAX_SYNAPSE_PRICES} price entries at a time.`;
  const records = readClipboardRows(input, MAX_SYNAPSE_PRICES + 1, limitMessage, true);
  const first = records[0]?.cells ?? [];
  const header = priceHeader(first);
  const singleHeader = first.length === 1 && (column === 0
    ? first[0].trim().toLowerCase() === "item" : priceLabel(first[0].trim().toLowerCase()));
  if (header || singleHeader) records.shift();
  if (records.length > MAX_SYNAPSE_PRICES) throw new Error(limitMessage);
  const width = header || Math.max(1, ...records.map(({ cells }) => cells.length));
  if (width > 3 || records.some(({ cells }) => cells.slice(width).some((cell) => cell.trim())))
    throw new Error("Paste Item and Price columns, or Item, Quantity, and Price.");
  if (column === 1 && width > 1) throw new Error("Start a multi-column paste in the Item column.");
  return records.map(({ cells }) => {
    const row = width === 3 ? [cells[0] ?? "", cells[2] ?? ""]
      : Array.from({ length: width }, (_, index) => cells[index] ?? "");
    if (row.some((cell) => /[\u0000-\u001f\u007f]/.test(cell)))
      throw new Error("Each Item and Price must fit in one cell without line breaks or tabs.");
    return row;
  });
}

export function matchSynapsePrices(order, priceList) {
  const byItem = new Map();
  for (const entry of priceList.rows) {
    if (!entry.item) continue;
    byItem.set(entry.item, byItem.has(entry.item) ? null : entry);
  }
  const prices = [];
  const rows = order.rows.map((row) => {
    // A duplicate remains ambiguous even if both entries have the same price.
    const match = byItem.get(row.item);
    const price = match?.price ?? null;
    const issues = [];
    if (!row.item) issues.push("Item is missing.");
    if (row.ship === null) issues.push("Quantity Ship is missing.");
    if (row.picked === null) issues.push("Quantity Picked is missing.");
    if (price === null) issues.push(match === null ? "Multiple price-list entries match this Item." :
      match ? "The matching entry has no price." : "No matching Item was found in the price list.");
    if (price !== null) prices.push(decimal(price, 0, "Price"));
    return { ...row, price, issues };
  });
  return { rows, totals: { ...order.totals, price: sum(prices) } };
}

export function formatSynapsePrice(value) {
  if (value == null) return "";
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

// Keep identifiers that Excel could interpret as numbers or formulas as text in
// the plain-text fallback. The HTML clipboard also marks every item as text.
const excelItem = (item) => /^[=+\-@']/.test(item) || /^[\d.]+$/.test(item) ? `'${item}` : item;
const tsvCell = (value) => /["\t\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value ?? "";

export function getSynapseExportRows(result) {
  // Parsed quantities use canonical decimal strings: signed/decimal zeros are
  // "0", while missing values remain null and must not be treated as zero.
  return result.rows.filter(({ ship, picked }) => ship !== "0" || picked !== "0");
}

export function createSynapseTSV(result) {
  return getSynapseExportRows(result).map(({ item, ship, price }) =>
    [excelItem(item), ship, formatSynapsePrice(price)].map(tsvCell).join("\t")).join("\r\n");
}

const escapeHTML = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function createSynapseHTML(result) {
  const rows = getSynapseExportRows(result).map(({ item, ship, price }) =>
    `<tr><td style='mso-number-format:"\\@"'>${escapeHTML(item)}</td><td>${ship ?? ""}</td><td>${formatSynapsePrice(price)}</td></tr>`).join("");
  return `<table><tbody>${rows}</tbody></table>`;
}
