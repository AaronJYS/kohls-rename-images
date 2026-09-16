// Browser port of JYS-Enterprise-Inc/AAfes_Pdf_to_Excel at 56ef7bc.
// Coordinates are PDF points, measured from the top-left of the page.
export const COLUMNS = [
  ["po", "PO", "text"],
  ["vendor_style", "Vendor's Style", "text"],
  ["qty", "Qty", "number"],
  ["price", "Unit Price", "money"],
  ["total_price", "Total Price", "money"],
  ["requested_ship", "Requested Ship Date", "date"],
  ["requested_del", "Requested Delivery Date", "date"],
];

const HEADERS = ["Line", "UPC", "SKU", "Description", "Qty", "UOM", "Price", "Amount"];
const ROW_TOLERANCE = 2.5;
const LINE_NUMBER = /^\d{4,6}$/;
export const MAX_EXCEL_CELL_TEXT = 32767;
const MAX_EXCEL_CELL_LINE_BREAKS = 253;

export function exceedsExcelCellLimits(value) {
  const text = String(value ?? "");
  return text.length > MAX_EXCEL_CELL_TEXT || (text.match(/\n/g)?.length ?? 0) > MAX_EXCEL_CELL_LINE_BREAKS;
}

// Order summaries support counts and reconciliation. Preview and export use the
// individual records so every item's style, quantity, and price stay together.
export function groupOrders(records) {
  const groups = new Map(), warnings = [];
  const orderFields = [
    ["store", "Store Num"], ["order_total", "Printed PO Total"],
    ["requested_ship", "Requested Ship Date"], ["requested_del", "Requested Delivery Date"],
  ];
  for (const row of records) {
    let order = groups.get(row.po);
    if (!order) {
      order = { ...row, line_items: [], line_count: 0, conflicting_fields: new Set() };
      groups.set(row.po, order);
    }
    for (const [key, label] of orderFields) {
      const value = row[key];
      if (value === null || value === undefined || value === "") continue;
      if (order[key] === null || order[key] === undefined || order[key] === "") order[key] = value;
      else if (order[key] !== value) order.conflicting_fields.add(label);
    }
    order.line_items.push(row);
    order.line_count++;
  }
  for (const order of groups.values()) {
    for (const key of ["sku", "upc"]) {
      order[key] = order.line_items.some((row) => row[key])
        ? order.line_items.map((row) => row[key] || "").join("\n") : "";
    }
    if (order.conflicting_fields.size)
      warnings.push(`PO ${order.po}: conflicting ${[...order.conflicting_fields].join(", ")} values across line items. Check the source PDF; each item keeps its own values.`);
    delete order.conflicting_fields;
  }
  return { orders: [...groups.values()], warnings };
}

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function toNumber(text) {
  let cleaned = String(text ?? "").trim();
  const accounting = cleaned.startsWith("(") && cleaned.endsWith(")");
  if (accounting) cleaned = cleaned.slice(1, -1).trim();
  const match = /^([+-]?)\s*(?:[$€£]\s*)?([+-]?)\s*([\d.,]+)$/.exec(cleaned);
  if (!match || (match[1] && match[2]) || (accounting && (match[1] || match[2]))) return text;
  let number = match[3];
  if (/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?$/.test(number) || /^\.\d+$/.test(number)) {
    // AAFES thousands grouping (1,234) and dot decimals, including unit prices.
    number = number.replaceAll(",", "");
  } else if (/^(?:\d+|[1-9]\d{0,2}(?:\.\d{3})+),\d+$/.test(number) || /^,\d+$/.test(number)) {
    // Comma decimals (12,50) and dot-grouped thousands (1.234,50).
    number = number.replaceAll(".", "").replace(",", ".");
  } else return text;
  const value = Number(number) * (accounting || (match[1] || match[2]) === "-" ? -1 : 1);
  return Number.isFinite(value) ? value : text;
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
  if (!bounds) return { value: null, extraValues: false };
  const heading = words.find((word) => word.text === "Package" &&
    sameBand(words, word).some((other) => other.text === "Description" && other.x0 > word.x1));
  if (!heading) return { value: null, extraValues: false };
  const amountColumn = bounds.find((column) => column.name === "Amount");
  const candidates = [];
  for (const word of words) {
    if (word.top <= heading.top + ROW_TOLERANCE || (word.x0 + word.x1) / 2 < amountColumn.low ||
        candidates.some((candidate) => Math.abs(candidate.top - word.top) <= ROW_TOLERANCE)) continue;
    const value = toNumber(sameBand(words, word).map((item) => item.text).join(" "));
    if (Number.isFinite(value)) candidates.push({ top: word.top, value });
  }
  // The first standalone amount closes the Package Description/notes block.
  // Later standalone numbers belong below that total and must not replace it,
  // even if one happens to match the line sum. Surface that ambiguity for review.
  return { value: candidates[0]?.value ?? null, extraValues: candidates.length > 1 };
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

function lineTotal(qty, price) {
  // Multiply decimal coefficients before rounding to cents. Binary floating
  // point can otherwise turn 3 × 9.995 into 29.984999... and round a cent low.
  const decimal = (value) => {
    const [digits, exponent = "0"] = String(value).split("e");
    return [BigInt(digits.replace(".", "")), Number(exponent) - (digits.split(".")[1]?.length ?? 0)];
  };
  const [quantity, quantityExponent] = decimal(qty);
  const [unitPrice, priceExponent] = decimal(price);
  const product = quantity * unitPrice;
  const exponent = quantityExponent + priceExponent + 2;
  let cents;
  if (exponent >= 0) cents = product * 10n ** BigInt(exponent);
  else {
    const divisor = 10n ** BigInt(-exponent);
    const sign = product < 0n ? -1n : 1n;
    cents = sign * ((product * sign + divisor / 2n) / divisor);
  }
  return Number(`${cents}e-2`);
}

export function addOrderTotals(records) {
  const totals = new Map();
  for (const row of records) {
    totals.set(row.po, (totals.get(row.po) ?? 0) + (Number.isFinite(row.amount) ? row.amount : row.total_price));
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
      if (order && printedTotal.value !== null) {
        if (printedTotal.extraValues)
          warn(pageNumber, `PO ${currentPO}: extra numeric values below the printed total were ignored. Check the source PDF.`);
        if (order.printed_total !== undefined && order.printed_total !== printedTotal.value)
          warn(pageNumber, `PO ${currentPO} has conflicting printed totals. The first total was kept.`);
        else order.printed_total = printedTotal.value;
      }
      if (!bounds) {
        warn(pageNumber, "No AAFES line-item table was recognized. Check this page in the source PDF.");
        return;
      }
      const rows = groupRows(words, bounds, band ? band[0].top : 0);
      for (const [index, cells] of rows.entries()) {
        if (!LINE_NUMBER.test(cells.Line ?? "")) continue;
        const qty = toNumber(cells.Qty), price = toNumber(cells.Price ?? ""), amount = toNumber(cells.Amount ?? "");
        if (!Number.isFinite(qty) || !Number.isFinite(price) || !Number.isFinite(qty * price)) {
          warn(pageNumber, `Line ${cells.Line} has an unreadable quantity or unit price and was skipped.`);
          continue;
        }
        if (!currentPO) { warn(pageNumber, `Line ${cells.Line} has no identifiable PO number and was skipped.`); continue; }
        const row = {
          po: currentPO, line_no: cells.Line, upc: cells.UPC ?? "", sku: cells.SKU ?? "",
          vendor_style: vendorStyle(rows, index), description: cells.Description ?? "",
          qty, uom: cells.UOM ?? "", price, total_price: lineTotal(qty, price),
          amount: Number.isFinite(amount) ? amount : null, requested_ship: ship, requested_del: delivery,
          store, source_page: pageNumber,
        };
        const key = `${currentPO}:${row.line_no}`;
        if (seen.has(key)) {
          duplicateCount++;
          const first = seen.get(key);
          if (["sku", "upc", "qty", "price", "amount", "vendor_style", "requested_ship", "requested_del"].some((field) => first[field] !== row[field]))
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
          warnings.push(`PO ${po}: printed total ${order.printed_total.toFixed(2)} differs from the extracted line-item sum ${calculated.toFixed(2)}. Check for missing lines or adjustments. Total Price is calculated as Unit Price × Qty for each item.`);
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
          ["vendor_style", "Vendor's Style"],
          ["requested_ship", "Requested Ship Date"], ["requested_del", "Requested Delivery Date"],
        ];
        const missing = required.filter(([key]) => lines.some((row) => !row[key])).map(([, label]) => label);
        if (missing.length) warnings.push(`PO ${po}: missing ${missing.join(", ")} on one or more source lines. Check the source PDF.`);
      }
      if (emptyPages) warnings.push(`${emptyPages} page(s) had no readable text. Check for scanned pages or blank separators.`);
      if (duplicateCount) warnings.push(`${duplicateCount} repeated PO line(s) were omitted. Each PO and line number is included once.`);
      const grouped = groupOrders(records);
      return { records, orders: grouped.orders, warnings: [...warnings, ...grouped.warnings], orderCount: grouped.orders.length };
    },
  };
}

export function extractPages(pages, options) {
  const extractor = createExtractor(options);
  pages.forEach((page, index) => extractor.addPage({ ...page, pageNumber: index + 1 }));
  return extractor.finish();
}
