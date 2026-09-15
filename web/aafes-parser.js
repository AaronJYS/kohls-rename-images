// Browser port of JYS-Enterprise-Inc/AAfes_Pdf_to_Excel at 56ef7bc.
// Coordinates are PDF points, measured from the top-left of the page.
export const COLUMNS = [
  ["trading_partner", "Trading Partner", "text"],
  ["document_type", "Document Type", "text"],
  ["po", "Document Num", "text"],
  ["alt_document", "Alt Document", "text"],
  ["store", "Store Num", "text"],
  ["currency_code", "Currency Code", "text"],
  ["order_total", "Amount", "money"],
  ["date_processed", "Date Processed", "date"],
  ["date_ack", "Date Ack", "date"],
  ["business_system_code", "Business System Code", "number"],
  ["integration_status", "Integration Status", "number"],
  ["sku", "User Defined Field #1", "text"],
  ["upc", "User Defined Field #2", "text"],
  ["requested_ship", "User Defined Field #3", "date-short"],
];

const HEADERS = ["Line", "UPC", "SKU", "Description", "Qty", "UOM", "Price", "Amount"];
const ROW_TOLERANCE = 2.5;
const LINE_NUMBER = /^\d{4,6}$/;
const NUMBER = /^-?[\d,]*\.?\d+$/;

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function toNumber(text) {
  const cleaned = String(text ?? "").replace(/[$,]/g, "").trim();
  return NUMBER.test(cleaned) && Number.isFinite(Number(cleaned))
    ? Number(cleaned)
    : text;
}

// ISO strings avoid timezone shifts between parsing, preview, and Excel export.
export function toDate(text) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const [, month, day, year] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function sameBand(words, anchor) {
  return words.filter((word) => Math.abs(word.top - anchor.top) <= ROW_TOLERANCE)
    .sort((a, b) => a.x0 - b.x0);
}

function orderHeader(words, width) {
  const topRight = words.filter((word) => word.top <= 145 && word.x1 > width * 0.7);
  const po = topRight.find((word) => /^\d{8,12}$/.test(word.text));
  const type = topRight.find((word) => /^Stand[-‐‑–]alone$/i.test(word.text) &&
    sameBand(topRight, word).some((other) => other.text === "Order" && other.x0 >= word.x1 && other.x0 - word.x1 < 30));
  const date = po && words.filter((word) => word.top > po.top && word.top - po.top <= 45 &&
    Math.abs(word.x1 - po.x1) <= 45 && toDate(word.text))
    .sort((a, b) => a.top - b.top)[0];
  const partner = words.find((word) => word.top < 85 && word.x0 > width * 0.25 &&
    word.x1 < width * 0.75 && word.text.toUpperCase() === "AAFES");
  return { po: po?.text, document_type: type ? "Stand-alone Order" : "", date_ack: toDate(date?.text), trading_partner: partner ? "AAFES" : "" };
}

function vendorNumber(words) {
  for (const label of words) {
    // The Vendor # label is centered in a table cell. Its value is left-aligned
    // at the cell edge, NOT directly beneath the label's left edge.
    if (label.text !== "Vendor") continue;
    const band = sameBand(words, label);
    const hash = band.find((word) => /^#[:.]?$/.test(word.text) && word.x0 >= label.x1 && word.x0 - label.x1 < 25);
    if (!hash) continue;
    const inline = band.find((word) => /^\d+$/.test(word.text) && word.x0 > hash.x1 && word.x0 - hash.x1 < 45);
    if (inline) return inline.text;
    const nextLabel = band.find((word) => word.x0 > hash.x1 && !/^#/.test(word.text));
    const previousLabel = band.filter((word) => word.x1 < label.x0 && !/^#/.test(word.text)).at(-1);
    const centre = (label.x0 + hash.x1) / 2;
    const low = previousLabel ? (previousLabel.x1 + centre) / 2 : 0;
    const high = nextLabel ? (centre + (nextLabel.x0 + nextLabel.x1) / 2) / 2 : hash.x1 + 45;
    const found = words.filter((word) => word.top > label.top + ROW_TOLERANCE && word.top - label.top <= 40 &&
      word.x0 >= low && (word.x0 + word.x1) / 2 < high && /^\d+$/.test(word.text))
      .sort((a, b) => a.top - b.top || a.x0 - b.x0)[0];
    if (found) return found.text;
  }
  return "";
}

function printedOrderTotal(words, bounds) {
  if (!bounds) return null;
  const heading = words.find((word) => word.text === "Package" &&
    sameBand(words, word).some((other) => other.text === "Description" && other.x0 > word.x1));
  if (!heading) return null;
  const amountColumn = bounds.find((column) => column.name === "Amount");
  const candidates = words.filter((word) => word.top > heading.top + ROW_TOLERANCE &&
    (word.x0 + word.x1) / 2 >= amountColumn.low && Number.isFinite(toNumber(word.text)) &&
    sameBand(words, word).every((other) => other === word || other.text === "$"));
  // The final numeric cell below the notes is the printed document total.
  // Footer dates/page counts are excluded by the single-cell row requirement.
  return candidates.length ? toNumber(candidates.at(-1).text) : null;
}

function labelledDate(words, second) {
  const anchor = words.find((word) => word.text === "Requested" && words.some((other) =>
    other.text === second && Math.abs(other.top - word.top) <= ROW_TOLERANCE &&
    other.x0 - word.x1 >= 0 && other.x0 - word.x1 < 30));
  if (!anchor) return null;
  return words.filter((word) => word.top > anchor.top && word.top - anchor.top <= 70 &&
    Math.abs(word.x0 - anchor.x0) <= 45 && toDate(word.text))
    .sort((a, b) => Math.abs(a.x0 - anchor.x0) - Math.abs(b.x0 - anchor.x0) || a.top - b.top)
    .map((word) => toDate(word.text))[0] ?? null;
}

function headerBand(words) {
  for (const word of words) {
    if (word.text !== "Amount") continue;
    const band = words.filter((other) => Math.abs(other.top - word.top) <= ROW_TOLERANCE);
    if (["Qty", "UOM", "Price"].every((label) => band.some((item) => item.text === label))) return band;
  }
  return null;
}

function columnBounds(band) {
  const centres = HEADERS.map((name) => {
    const word = band.find((item) => item.text === name);
    return word ? (word.x0 + word.x1) / 2 : null;
  });
  if (centres.some((centre, i) => centre === null || (i && centre <= centres[i - 1]))) return null;
  return HEADERS.map((name, i) => ({
    name,
    low: i ? (centres[i - 1] + centres[i]) / 2 : -Infinity,
    high: i < HEADERS.length - 1 ? (centres[i] + centres[i + 1]) / 2 : Infinity,
  }));
}

function groupRows(words, bounds, minTop) {
  const rows = [];
  for (const word of words) {
    if (word.top <= minTop + ROW_TOLERANCE) continue;
    const centre = (word.x0 + word.x1) / 2;
    const column = bounds.find(({ low, high }) => low <= centre && centre < high)?.name;
    if (!column) continue;
    let row = rows.at(-1);
    if (!row || Math.abs(row.top - word.top) > ROW_TOLERANCE) {
      row = { top: word.top, cells: {} };
      rows.push(row);
    }
    (row.cells[column] ??= []).push(word);
  }
  return rows.map(({ cells }) => Object.fromEntries(Object.entries(cells).map(([name, items]) =>
    [name, items.sort((a, b) => a.x0 - b.x0).map((word) => word.text).join(" ")])));
}

function vendorStyle(rows, index) {
  for (let i = index + 1; i < rows.length; i++) {
    if (LINE_NUMBER.test(rows[i].Line ?? "")) break;
    const match = /^Vendor['’]s\s+Style\s*#?\s*:?\s*(.*)$/i.exec(rows[i].SKU ?? "");
    if (!match) continue;
    if (match[1]) return match[1].replace(/\s/g, "");
    if (!LINE_NUMBER.test(rows[i + 1]?.Line ?? "")) return (rows[i + 1]?.SKU ?? "").replace(/\s/g, "");
    break;
  }
  return "";
}

export function addOrderTotals(records) {
  const totals = new Map();
  for (const row of records) {
    totals.set(row.po, (totals.get(row.po) ?? 0) + row.amount);
  }
  for (const row of records) row.order_total = Number(totals.get(row.po).toFixed(2));
}

export function createExtractor({ processedDate = localDate() } = {}) {
  const records = [], warnings = [], seen = new Map();
  const orders = new Map();
  let bounds = null, currentPO = "", store = "", ship = null, delivery = null;
  let duplicateCount = 0, emptyPages = 0;
  const warn = (page, text) => warnings.push(`Page ${page}: ${text}`);

  return {
    addPage({ words, width, pageNumber }) {
      words = [...words].sort((a, b) => a.top - b.top || a.x0 - b.x0);
      if (!words.length) { emptyPages++; return; }
      const header = orderHeader(words, width);
      const po = header.po;
      if (po && po !== currentPO) {
        // Do not leak a previous order's dates or layout into a new order.
        currentPO = po;
        store = "";
        ship = delivery = null;
        bounds = null;
      }
      if (currentPO && !orders.has(currentPO)) orders.set(currentPO, {});
      const order = orders.get(currentPO);
      if (order) {
        const metadata = { ...header, vendor_number: vendorNumber(words) };
        for (const field of ["trading_partner", "document_type", "date_ack", "vendor_number"]) {
          if (!metadata[field]) continue;
          if (order[field] && order[field] !== metadata[field]) {
            warn(pageNumber, `PO ${currentPO} has conflicting ${field.replaceAll("_", " ")} values. The first value was kept.`);
          } else order[field] = metadata[field];
        }
      }
      store = /Store\s*#\s*:?\s*(\d+)/i.exec(words.map((word) => word.text).join(" "))?.[1] ?? store;
      ship = labelledDate(words, "Ship") ?? ship;
      delivery = labelledDate(words, "Delivery") ?? delivery;
      const band = headerBand(words);
      if (band) {
        bounds = columnBounds(band);
        if (!bounds) { warn(pageNumber, "The table columns could not be recognized. This page was skipped."); return; }
      }
      const printedTotal = printedOrderTotal(words, bounds);
      if (order && printedTotal !== null) {
        if (order.printed_total !== undefined && order.printed_total !== printedTotal)
          warn(pageNumber, `PO ${currentPO} has conflicting printed totals. The first total was kept.`);
        else order.printed_total = printedTotal;
      }
      if (!bounds) {
        warn(pageNumber, "No AAFES line-item table was recognized. Check this page in the source PDF.");
        return;
      }
      const rows = groupRows(words, bounds, band ? band[0].top : 0);
      for (const [index, cells] of rows.entries()) {
        if (!LINE_NUMBER.test(cells.Line ?? "")) continue;
        if (!NUMBER.test((cells.Qty ?? "").replace(/,/g, "")) ||
            !NUMBER.test((cells.Amount ?? "").replace(/,/g, "")) ||
            !Number.isFinite(toNumber(cells.Qty)) || !Number.isFinite(toNumber(cells.Amount))) {
          warn(pageNumber, `Line ${cells.Line} has an unreadable quantity or amount and was skipped.`);
          continue;
        }
        if (!currentPO) { warn(pageNumber, `Line ${cells.Line} has no identifiable PO number and was skipped.`); continue; }
        const row = {
          po: currentPO, line_no: cells.Line, upc: cells.UPC ?? "", sku: cells.SKU ?? "",
          vendor_style: vendorStyle(rows, index), description: cells.Description ?? "",
          qty: toNumber(cells.Qty), uom: cells.UOM ?? "", price: toNumber(cells.Price ?? ""),
          amount: toNumber(cells.Amount), requested_ship: ship, requested_del: delivery,
          store, source_page: pageNumber,
        };
        const key = `${currentPO}:${row.line_no}`;
        if (seen.has(key)) {
          duplicateCount++;
          const first = seen.get(key);
          if (["sku", "upc", "qty", "amount", "vendor_style"].some((field) => first[field] !== row[field]))
            warn(pageNumber, `PO ${currentPO}, line ${row.line_no} differs from an earlier copy. The first value was kept.`);
          continue;
        }
        seen.set(key, row);
        records.push(row);
        if (records.length > 100000) throw new Error("This PDF has more than 100,000 line items. Split it into smaller PDFs and try again.");
      }
    },
    finish() {
      if (!records.length) throw new Error("No purchase order line items were found. Choose a text-based AAFES Stand-alone Order PDF. Scans and photographs need OCR first.");
      addOrderTotals(records);
      const linesByOrder = new Map();
      for (const row of records) {
        if (!linesByOrder.has(row.po)) linesByOrder.set(row.po, []);
        linesByOrder.get(row.po).push(row);
      }
      for (const [po, order] of orders) {
        const lines = linesByOrder.get(po);
        if (!lines?.length) continue;
        const calculated = lines[0].order_total;
        if (order.printed_total !== undefined && Math.abs(order.printed_total - calculated) > 0.005)
          warnings.push(`PO ${po}: printed total ${order.printed_total.toFixed(2)} differs from the extracted line-item sum ${calculated.toFixed(2)}. Amount uses the printed total; check for missing lines or adjustments.`);
        if (order.printed_total === undefined)
          warnings.push(`PO ${po}: no printed total was found. Amount was calculated from the extracted line items.`);
        for (const row of lines) {
          Object.assign(row, {
            trading_partner: order.trading_partner || "",
            document_type: order.document_type || "",
            alt_document: order.vendor_number ? `Vendor ${order.vendor_number} MF` : "",
            currency_code: "",
            date_processed: processedDate,
            date_ack: order.date_ack || null,
            business_system_code: 211,
            integration_status: 0,
            order_total: order.printed_total ?? calculated,
          });
        }
        const required = [
          ["trading_partner", "Trading Partner"], ["document_type", "Document Type"],
          ["alt_document", "Vendor #"], ["store", "Store Num"],
          ["date_ack", "Date Ack"], ["requested_ship", "Requested Ship"],
        ];
        const missing = required.filter(([key]) => lines.some((row) => !row[key])).map(([, label]) => label);
        if (missing.length) warnings.push(`PO ${po}: missing ${missing.join(", ")}. These fields are left blank; check the source PDF.`);
      }
      if (emptyPages) warnings.push(`${emptyPages} page(s) had no readable text. Check for scanned pages or blank separators.`);
      if (duplicateCount) warnings.push(`${duplicateCount} repeated PO line(s) were omitted. Each PO and line number is included once.`);
      const missing = records.filter((row) => !row.sku || !row.upc);
      if (missing.length) warnings.push(`${missing.length} line item(s) have a missing SKU or UPC. User Defined Fields #1 and #2 are left blank where missing; check the source PDF.`);
      return { records, warnings, orderCount: new Set(records.map((row) => row.po)).size };
    },
  };
}

export function extractPages(pages, options) {
  const extractor = createExtractor(options);
  pages.forEach((page, index) => extractor.addPage({ ...page, pageNumber: index + 1 }));
  return extractor.finish();
}
