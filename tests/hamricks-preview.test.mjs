import test from "node:test";
import assert from "node:assert/strict";
import { HEADERS_940 } from "../web/hamricks-converter.js";
import { createHamricksPreview } from "../web/hamricks-preview.js";

// A small DOM adapter lets the real renderer run in Node without a browser
// dependency. Layout measurements are supplied explicitly by each test.
function previewHarness() {
  const frames = new Map(), resizeListeners = new Set();
  let frameId = 0, measuredHeight = 44.5;
  const window = {
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(type, callback) { if (type === "resize") resizeListeners.add(callback); },
    removeEventListener(type, callback) { if (type === "resize") resizeListeners.delete(callback); },
    getComputedStyle: () => ({ fontSize: "13px", fontWeight: "400", fontFamily: "sans-serif", letterSpacing: "0px", paddingLeft: "16px", paddingRight: "16px" }),
  };
  const document = { defaultView: window, createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element("fragment") };
  class Element {
    constructor(tag) {
      this.tag = tag; this.ownerDocument = document; this.children = []; this.attributes = new Map();
      this.listeners = new Map(); this.className = ""; this.textContent = "";
      this.style = { removeProperty: (name) => { delete this.style[name === "table-layout" ? "tableLayout" : name]; } };
    }
    append(...elements) {
      for (const element of elements) {
        if (element.tag === "fragment") { this.append(...[...element.children]); continue; }
        element.remove(); element.parentElement = this; this.children.push(element);
      }
    }
    prepend(element) { element.remove(); element.parentElement = this; this.children.unshift(element); }
    replaceChildren(...elements) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...elements); }
    remove() {
      if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type) { this.listeners.delete(type); }
    closest(tag) { return this.tag === tag ? this : this.parentElement?.closest(tag); }
    querySelector(selector) { assert.equal(selector, "tr:not(.preview-spacer)"); return this.children.find(child => child.tag === "tr" && child.className !== "preview-spacer"); }
    getBoundingClientRect() { return { height: measuredHeight }; }
    getContext() { return null; }
    get firstElementChild() { return this.children[0]; }
    get cells() { return this.children; }
    get rows() { return this.children; }
  }
  const viewport = document.createElement("div"), table = document.createElement("table"), body = document.createElement("tbody");
  viewport.clientHeight = 440; viewport.scrollTop = viewport.scrollLeft = 0;
  const head = document.createElement("thead"), heading = document.createElement("tr");
  for (const title of HEADERS_940) { const th = document.createElement("th"); th.textContent = title; heading.append(th); }
  head.append(heading); table.tHead = head; table.append(head, body); viewport.append(table);
  const preview = createHamricksPreview(viewport, body);
  return {
    preview, body, table, viewport,
    dataRows: () => body.children.filter(row => row.getAttribute("aria-rowindex")),
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); },
    scroll(top) { viewport.scrollTop = top; viewport.listeners.get("scroll")?.(); },
    resize(height) { measuredHeight = height; for (const callback of resizeListeners) callback(); },
  };
}
const result = (count, prefix = "SKU") => ({ rows: [[...HEADERS_940], ...Array.from({ length: count }, (_, i) =>
  [i % 10 ? "L" : "H", `${prefix}-${i}`, i, "EA", ...Array(25).fill("")])] });

test("status-only renders preserve preview nodes, selection, and scroll position", () => {
  const h = previewHarness(), source = result(3);
  h.preview.setResult(source);
  const first = h.dataRows()[0];
  h.viewport.scrollTop = 50; h.viewport.scrollLeft = 200;
  h.preview.setResult(source);
  assert.equal(h.dataRows()[0], first);
  assert.equal(h.viewport.scrollTop, 50); assert.equal(h.viewport.scrollLeft, 200);
  assert.equal(h.dataRows().length, 3);
  assert.equal(first.className, "store-header");
  assert.equal(h.dataRows()[1].cells[2].className, "numeric");
  assert.equal(h.table.getAttribute("aria-rowcount"), "4");
});

test("large previews keep all rows reachable with bounded DOM and stable column widths", () => {
  const h = previewHarness(), source = result(38016);
  h.preview.setResult(source);
  const width = h.table.style.width;
  assert.ok(parseFloat(width) >= 29 * 130);
  for (const index of [0, 500, 19008, 38000, 38015, 10]) {
    h.scroll(index * 44.5); h.flush();
    const rows = h.dataRows();
    assert.ok(rows.length <= 30);
    assert.ok(rows.some(row => Number(row.getAttribute("aria-rowindex")) === index + 2));
    for (const row of rows) assert.deepEqual(row.cells.map(cell => cell.textContent), source.rows[Number(row.getAttribute("aria-rowindex")) - 1]);
    assert.equal(h.table.style.width, width);
    for (const row of h.body.children.filter(row => row.className === "preview-spacer")) {
      assert.equal(row.getAttribute("aria-hidden"), "true");
      assert.equal(row.cells[0].colSpan, 29);
    }
  }
  const first = h.dataRows()[0]; h.preview.setResult(source);
  assert.equal(h.dataRows()[0], first);
});

test("sheet changes and clear cancel pending paints and remove stale rows and column sizing", () => {
  const h = previewHarness(); h.preview.setResult(result(500)); h.scroll(10000);
  h.preview.setResult(result(2, "NEW")); h.flush();
  assert.equal(h.dataRows().length, 2);
  assert.equal(h.dataRows()[0].cells[1].textContent, "NEW-0");
  assert.equal(h.viewport.scrollTop, 0); assert.equal(h.viewport.scrollLeft, 0);
  assert.equal(h.table.style.width, undefined);
  assert.equal(h.table.children.some(child => child.tag === "colgroup"), false);
  h.preview.setResult(result(500)); h.scroll(10000);
  h.preview.setResult(undefined); h.flush();
  assert.equal(h.body.children.length, 0);
  assert.equal(h.table.getAttribute("aria-rowcount"), "1");
  h.preview.setResult(result(0)); assert.equal(h.body.children.length, 0);
});

test("missing canvas and ResizeObserver use fallbacks; text resizing preserves the source row", () => {
  const h = previewHarness(); h.preview.setResult(result(1000));
  h.scroll(500 * 44.5); h.flush(); h.resize(60);
  assert.equal(h.viewport.scrollTop, 500 * 60);
  assert.ok(h.dataRows().some(row => row.getAttribute("aria-rowindex") === "502"));
  assert.ok(Number.isFinite(parseFloat(h.table.style.width)));
  h.resize(0); assert.equal(h.viewport.scrollTop, 500 * 60);
  const first = h.dataRows()[0];
  h.scroll(100); h.preview.destroy(); h.flush(); h.resize(70);
  assert.equal(h.dataRows()[0], first);
});
