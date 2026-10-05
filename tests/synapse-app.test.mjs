import test from "node:test";
import assert from "node:assert/strict";

// Run the app's event wiring without adding a browser dependency to Node tests.
class Element extends EventTarget {
  value = "";
  textContent = "";
  children = [];
  attributes = new Map();
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection = "none";
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { children.forEach((child) => { child.parent = this; }); this.children.push(...children); }
  get lastElementChild() { return this.children.at(-1); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  replaceChildren(...children) { this.children = children; }
  querySelector() { return this.label ??= new Element(); }
  focus() { this.dispatchEvent(new Event("focus")); }
  select() { this.setSelectionRange(0, this.value.length, "none"); }
  setSelectionRange(start, end, direction) {
    this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction;
  }
}

let instance = 0;
async function loadApp(t) {
  const elements = new Map(), writes = [];
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  for (const [name, value] of Object.entries({
    document: { getElementById: get, createElement: () => new Element() },
    navigator: { clipboard: { async writeText(text) { writes.push(text); } } },
    requestAnimationFrame: (callback) => callback(),
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  await import(`../web/synapse-app.js?test=${instance++}`);
  const cell = (row, column = 0) => get("synapse-price-body").children[row].children[column + 1].children[0];
  return { get, writes, cell };
}

function paste(input, text) {
  const event = new Event("paste", { cancelable: true });
  event.clipboardData = { getData: (type) => type === "text/plain" ? text : "" };
  input.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
}

test("selecting table text uses native copy while Copy for Excel exports the three data columns", async (t) => {
  const { get, writes, cell } = await loadApp(t);
  const source = "Item\tQuantity Ship\tQuantity Picked\nITEM.A\t2\t3\nITEM.B\t5\t6";
  get("synapse-input").value = source;
  paste(cell(0), "ITEM ..A.\t2\t$11.78\nITEM--B\t5\t$8.36");
  assert.deepEqual([cell(0).value, cell(0, 1).value, cell(1).value, cell(1, 1).value], ["ITEM.A", "$11.78", "ITEM.B", "$8.36"]);
  assert.equal(get("synapse-input").value, source);
  assert.equal(get("synapse-preview").hidden, false);

  const clipboard = new Map();
  const copyEvent = new Event("copy", { cancelable: true });
  copyEvent.clipboardData = { setData: (type, text) => clipboard.set(type, text) };
  get("synapse-table-scroll").dispatchEvent(copyEvent);
  assert.equal(copyEvent.defaultPrevented, false, "The browser must copy the user's selection normally.");
  assert.equal(clipboard.size, 0, "Selecting one item must not inject a full-table export.");
  assert.equal(writes.length, 0);

  get("synapse-copy").dispatchEvent(new Event("click"));
  await new Promise(setImmediate);
  assert.deepEqual(writes, ["ITEM.A\t2\t11.78\r\nITEM.B\t5\t8.36"]);
  assert.equal(get("synapse-copy").disabled, false);
  assert.equal(get("synapse-copy-status").textContent, "Copied 2 rows. Paste into Excel.");
});

test("manual spaces and hyphens remain editable and match exactly, including after another paste", async (t) => {
  const { get, writes, cell } = await loadApp(t);
  const input = cell(0);
  get("synapse-input").value = "Item\tQuantity Ship\tQuantity Picked\nITEM A-B\t2.5\t2.5\nNEW.BK\t1\t1";
  paste(input, "ITEM A-B\t2.5\t$11.78");
  assert.equal(input.value, "ITEM.A.B");

  // Typing a correction must preserve its punctuation and selection on any update.
  input.value = "ITEM A-B";
  input.setSelectionRange(5, 7, "backward");
  input.dispatchEvent(new Event("input"));
  get("synapse-input").dispatchEvent(new Event("input"));
  assert.equal(input.value, "ITEM A-B");
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [5, 7, "backward"]);
  assert.equal(get("synapse-preview-body").children[0].children[3].textContent, "$11.78");

  paste(cell(1), "NEW --BK.\t$8.36");
  assert.equal(input.value, "ITEM A-B");
  assert.equal(cell(1).value, "NEW.BK");
  get("synapse-copy").dispatchEvent(new Event("click"));
  await new Promise(setImmediate);
  assert.deepEqual(writes, ["ITEM A-B\t2.5\t11.78\r\nNEW.BK\t1\t8.36"]);
});

test("copy counts and fallback exclude zero/zero rows while the review retains them", async (t) => {
  const { get, writes, cell } = await loadApp(t);
  const input = get("synapse-input");
  input.value = "Item\tQuantity Ship\tQuantity Picked\nZERO\t-0.00\t0\nKEEP\t0\t2";
  paste(cell(0), "ZERO\t0\t$1\nKEEP\t2\t$2");
  assert.equal(get("synapse-preview-body").children.length, 2);
  assert.equal(get("synapse-row-count").textContent, "2 of 100 rows");
  assert.equal(get("synapse-copy").disabled, false);
  get("synapse-copy").dispatchEvent(new Event("click"));
  await new Promise(setImmediate);
  assert.deepEqual(writes, ["KEEP\t0\t2.00"]);
  assert.equal(get("synapse-copy-status").textContent, "Copied 1 row. Paste into Excel.");

  navigator.clipboard.writeText = async () => { throw new Error("Blocked"); };
  get("synapse-copy").dispatchEvent(new Event("click"));
  await new Promise(setImmediate);
  assert.equal(get("synapse-copy-fallback").hidden, false);
  assert.equal(get("synapse-copy-text").value, "KEEP\t0\t2.00");

  input.value = "Item\tQuantity Ship\tQuantity Picked\nZERO\t-0.00\t0";
  input.dispatchEvent(new Event("input"));
  assert.equal(get("synapse-preview-body").children.length, 1);
  assert.equal(get("synapse-preview").hidden, false);
  assert.equal(get("synapse-copy").disabled, true);
  assert.match(get("synapse-copy-status").textContent, /No rows to copy/);
  assert.equal(get("synapse-copy-fallback").hidden, true);
  assert.equal(get("synapse-copy-text").value, "");
});

test("independent column pastes preserve blanks and existing cells, then copy the matched prices", async (t) => {
  const { get, cell, writes } = await loadApp(t);
  get("synapse-input").value = "Item\tQuantity Ship\tQuantity Picked\n00123\t1\t1\nB.BK\t2\t2\nC.BK\t3\t3";
  paste(cell(0), "00123\nB BK\nC-BK\n");
  assert.equal(get("synapse-price-body").children.length, 4);
  assert.equal(cell(0).value, "00123");
  assert.equal(cell(1).value, "B.BK");
  assert.equal(cell(2).value, "C.BK");
  paste(cell(0, 1), "$11.78\n\n$0.25\n");
  assert.equal(cell(1, 1).value, "");
  assert.equal(cell(2, 1).value, "$0.25");
  assert.equal(cell(2).value, "C.BK");
  assert.equal(get("synapse-preview-body").children[1].className, "synapse-row-incomplete");
  cell(1, 1).value = "$8.36";
  cell(1, 1).dispatchEvent(new Event("input"));
  assert.equal(get("synapse-preview-body").children[1].children[3].textContent, "$8.36");
  assert.equal(cell(0, 1).value, "$11.78");
  get("synapse-copy").dispatchEvent(new Event("click"));
  await new Promise(setImmediate);
  assert.deepEqual(writes, ["'00123\t1\t11.78\r\nB.BK\t2\t8.36\r\nC.BK\t3\t0.25"]);

  cell(3).value = "MANUAL BK-AF";
  cell(3).dispatchEvent(new Event("input"));
  assert.equal(get("synapse-price-body").children.length, 5);
  assert.equal(cell(3).value, "MANUAL BK-AF");
  get("synapse-price-clear").dispatchEvent(new Event("click"));
  assert.equal(get("synapse-price-body").children.length, 1);
  assert.equal(cell(0).value, "");
  assert.equal(get("synapse-price-clear").disabled, true);
  assert.match(get("synapse-input").value, /00123/);
});

test("500 rows fit, and pastes that exceed the row or column limits leave existing cells intact", async (t) => {
  const { get, cell } = await loadApp(t);
  paste(cell(0), Array.from({ length: 500 }, (_, index) => `ITEM${index}\t$1.25`).join("\n"));
  assert.equal(get("synapse-price-body").children.length, 500);
  assert.equal(cell(499).value, "ITEM499");
  paste(cell(499), "REPLACE\nEXTRA");
  assert.match(get("synapse-price-message").textContent, /up to 500/);
  assert.equal(cell(499).value, "ITEM499");
  paste(cell(0, 1), "WRONG\t$99");
  assert.match(get("synapse-price-message").textContent, /Item column/);
  assert.equal(cell(0, 1).value, "$1.25");
  paste(cell(0), "A\n".repeat(501));
  assert.match(get("synapse-price-message").textContent, /no more than 500/);
  assert.equal(cell(0).value, "ITEM0");
});
