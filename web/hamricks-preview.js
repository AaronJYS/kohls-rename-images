const FULL_PREVIEW_LIMIT = 200;

// Offsets refer to data rows; the sticky column heading stays visible separately.
export function previewWindow(rowCount, scrollTop, viewportHeight, rowHeight, overscan = 10) {
  const height = rowHeight > 0 && Number.isFinite(rowHeight) ? rowHeight : 44.5;
  const visible = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / height));
  const first = Math.min(Math.max(0, rowCount - visible), Math.max(0, Math.floor(scrollTop / height)));
  const start = Math.max(0, first - overscan), end = Math.min(rowCount, first + visible + overscan);
  return { start, end, top: start * height, bottom: (rowCount - end) * height };
}

export function createHamricksPreview(viewport, body) {
  const document = body.ownerDocument, window = document.defaultView;
  const table = body.closest("table"), head = table.tHead;
  let result, rows = [], rowHeight = 44.5, frame = 0, range, columns, destroyed = false;
  const virtual = () => rows.length > FULL_PREVIEW_LIMIT;

  function rowElement(row, index) {
    const tr = document.createElement("tr");
    tr.setAttribute("aria-rowindex", String(index + 2));
    if (row[0] === "H") tr.className = "store-header";
    for (const [column, value] of row.entries()) {
      const td = document.createElement("td");
      td.textContent = value;
      if (row[0] === "L" && column === 2) td.className = "numeric";
      tr.append(td);
    }
    return tr;
  }

  function spacer(height) {
    const tr = document.createElement("tr"), td = document.createElement("td");
    tr.className = "preview-spacer";
    tr.setAttribute("aria-hidden", "true");
    td.colSpan = head.rows[0].cells.length;
    td.style.height = `${height}px`;
    tr.append(td);
    return tr;
  }

  function paint(force = false, scrollTop = viewport.scrollTop) {
    const next = previewWindow(rows.length, scrollTop, viewport.clientHeight, rowHeight);
    if (!force && range?.start === next.start && range?.end === next.end) return;
    range = next;
    const fragment = document.createDocumentFragment();
    if (next.top) fragment.append(spacer(next.top));
    for (let i = next.start; i < next.end; i++) fragment.append(rowElement(rows[i], i));
    if (next.bottom) fragment.append(spacer(next.bottom));
    body.replaceChildren(fragment);
  }

  function measure() {
    const sample = body.querySelector("tr:not(.preview-spacer)");
    rowHeight = sample?.getBoundingClientRect().height || rowHeight;
    const cell = sample?.firstElementChild;
    if (!cell) return;
    const style = window.getComputedStyle(cell), headingStyle = window.getComputedStyle(head.rows[0].cells[0]);
    const context = document.createElement("canvas").getContext("2d");
    const textWidth = (value, font) => {
      const text = String(value).replace(/\s+/g, " ");
      if (!context) return text.length * parseFloat(font.fontSize);
      context.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
      return context.measureText(text).width;
    };
    // Fix widths from the complete worksheet, so scrolling never shifts columns.
    const widths = [...head.rows[0].cells].map((th) => textWidth(th.textContent.toUpperCase(), headingStyle) +
      th.textContent.length * (parseFloat(headingStyle.letterSpacing) || 0));
    const cache = new Map();
    for (const row of rows) for (let i = 0; i < row.length; i++) {
      const value = String(row[i]);
      if (!value) continue;
      if (!cache.has(value)) cache.set(value, textWidth(value, style));
      widths[i] = Math.max(widths[i], cache.get(value));
    }
    const group = document.createElement("colgroup");
    let total = 0;
    for (let i = 0; i < widths.length; i++) {
      const padding = window.getComputedStyle(sample.cells[i]);
      const width = Math.max(130, Math.ceil(widths[i] + parseFloat(padding.paddingLeft) + parseFloat(padding.paddingRight) + 2));
      const col = document.createElement("col");
      col.style.width = `${width}px`; group.append(col); total += width;
    }
    columns?.remove(); columns = group;
    table.prepend(group);
    table.style.width = `${total}px`;
    table.style.tableLayout = "fixed";
  }

  function refresh() {
    if (destroyed || !virtual()) return;
    const position = viewport.scrollTop / rowHeight;
    measure();
    // Keep the same source row in view when text size or viewport size changes.
    // Resize the scrollable space first, so the browser cannot clamp the offset
    // to the old, shorter table when the font gets larger near the bottom.
    paint(true, position * rowHeight);
    viewport.scrollTop = position * rowHeight;
  }
  function schedule() {
    if (frame || destroyed || !virtual()) return;
    frame = window.requestAnimationFrame(() => { frame = 0; paint(); });
  }
  const observer = window.ResizeObserver ? new window.ResizeObserver(refresh) : null;
  observer?.observe(viewport);
  observer?.observe(head);
  viewport.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", refresh);
  document.fonts?.ready.then(refresh);

  return {
    setResult(next) {
      if (next === result) return;
      result = next;
      rows = next?.rows.slice(1) ?? [];
      window.cancelAnimationFrame(frame); frame = 0; range = null;
      columns?.remove(); columns = null;
      table.style.removeProperty("width"); table.style.removeProperty("table-layout");
      table.setAttribute("aria-rowcount", String(rows.length + 1));
      viewport.scrollTop = 0; viewport.scrollLeft = 0;
      if (virtual()) { paint(true); measure(); paint(true); }
      else {
        const fragment = document.createDocumentFragment();
        rows.forEach((row, index) => fragment.append(rowElement(row, index)));
        body.replaceChildren(fragment);
      }
    },
    destroy() {
      destroyed = true;
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", refresh);
    },
  };
}
