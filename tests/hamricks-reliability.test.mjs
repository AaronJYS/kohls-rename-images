import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as XLSX from "../web/vendor/sheetjs/xlsx.mjs";
import "../web/vendor/jszip/jszip.min.js";
import { readHamricksWorkbook } from "../web/hamricks-reader.js";
import { prepareWorkbookZip } from "../web/hamricks-zip.js";
import { readHamricksFile } from "../web/hamricks-file.js";
import { previewWindow } from "../web/hamricks-preview.js";

// Synthetic workbooks and corrupt variants stay in memory; no binary fixtures.
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
  ["PO#", "001234"], ["Department", "Receiving"], [], [],
  ["Ship", "2027-04-05"], ["Cancel", "2027-04-09"], [],
  ["Style Number", "Store 5"], ["000007", 2],
]), "Order");
const zipBytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx", compression: true }));
const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

test("every truncated prefix is rejected by ZIP preflight", () => {
  for (let length = 0; length < zipBytes.length; length++) {
    assert.throws(() => prepareWorkbookZip(zipBytes.subarray(0, length)), undefined, `prefix ${length}`);
  }
  assert.doesNotThrow(() => prepareWorkbookZip(zipBytes));
});

test("the actual reader rejects a ten-byte XLSX without hanging", () => {
  // A subprocess deadline also protects the test runner if the parser regresses.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { readHamricksWorkbook } from ${JSON.stringify(new URL("../web/hamricks-reader.js", import.meta.url).href)};
    assert.throws(() => readHamricksWorkbook(new Uint8Array(${JSON.stringify([...zipBytes.slice(0, 10)])})), /could not be read/);
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});

test("bad directory sizes, entry counts, and local offsets fail before parsing", () => {
  const end = zipBytes.length - 22, directory = viewOf(zipBytes).getUint32(end + 16, true);
  for (const change of [
    (v) => v.setUint32(end + 16, 0xFFFFFF00, true),
    (v) => v.setUint32(end + 12, 0xFFFFFF00, true),
    (v) => v.setUint16(end + 10, 65535, true),
    (v) => v.setUint16(end + 8, 0, true),
    (v) => v.setUint16(end + 20, 5, true),
    (v) => v.setUint32(directory, 0, true),
    (v) => v.setUint32(directory + 42, end, true),
    (v) => v.setUint32(directory + 20, 0xFFFFFF00, true),
    (v) => v.setUint16(directory + 28, 65535, true),
    (v) => v.setUint16(directory + 30, 65535, true),
    (v) => v.setUint16(28, 65535, true),
    (v) => v.setUint32(18, 0xFFFFFF00, true),
  ]) {
    const changed = zipBytes.slice(); change(viewOf(changed));
    assert.throws(() => prepareWorkbookZip(changed));
    assert.throws(() => readHamricksWorkbook(changed), /could not be read/);
  }
  assert.equal(readHamricksWorkbook(zipBytes).sheets[0].result.rows[2][1], "000007");
});

test("valid stored, deflated, streamed, commented, and offset-buffer ZIPs still convert", async () => {
  const zip = await globalThis.JSZip.loadAsync(zipBytes);
  const expected = readHamricksWorkbook(zipBytes);
  for (const compression of ["STORE", "DEFLATE"]) for (const streamFiles of [false, true]) {
    const data = await zip.generateAsync({ type: "uint8array", compression, streamFiles, comment: "Synthetic PK\x05\x06 workbook" });
    const original = data.slice();
    assert.deepEqual(readHamricksWorkbook(data), expected);
    const padded = new Uint8Array(data.length + 19); padded.set(data, 7);
    assert.deepEqual(readHamricksWorkbook(padded.subarray(7, 7 + data.length)), expected);
    const buffer = Buffer.from(padded).subarray(7, 7 + data.length);
    assert.deepEqual(readHamricksWorkbook(buffer), expected);
    assert.deepEqual([...buffer], [...original]);
    assert.deepEqual(data, original, "ZIP preparation must not modify the input");
  }
  assert.deepEqual(readHamricksWorkbook(XLSX.write(book, { type: "array", bookType: "biff8" })), expected);
});

test("small ZIP64 entries retain compatibility and invalid extended lengths are rejected", () => {
  const source = viewOf(zipBytes), end = zipBytes.length - 22, directory = source.getUint32(end + 16, true);
  const extraSize = source.getUint16(directory + 30, true);
  const extra = directory + 46 + source.getUint16(directory + 28, true) + extraSize;
  const data = new Uint8Array(zipBytes.length + 20);
  data.set(zipBytes.subarray(0, extra)); data.set(zipBytes.subarray(extra), extra + 20);
  const view = viewOf(data);
  view.setUint16(extra, 1, true); view.setUint16(extra + 2, 16, true);
  view.setBigUint64(extra + 4, BigInt(source.getUint32(directory + 24, true)), true);
  view.setBigUint64(extra + 12, BigInt(source.getUint32(directory + 20, true)), true);
  view.setUint32(directory + 20, 0xFFFFFFFF, true); view.setUint32(directory + 24, 0xFFFFFFFF, true);
  view.setUint16(directory + 30, extraSize + 20, true);
  view.setUint32(end + 20 + 12, source.getUint32(end + 12, true) + 20, true);
  assert.deepEqual(readHamricksWorkbook(data), readHamricksWorkbook(zipBytes));
  for (const change of [
    (v) => v.setUint16(extra + 2, 4, true),
    (v) => v.setUint16(extra, 99, true),
    (v) => v.setBigUint64(extra + 12, 2n ** 60n, true),
  ]) {
    const invalid = data.slice(); change(viewOf(invalid));
    assert.throws(() => prepareWorkbookZip(invalid));
    assert.throws(() => readHamricksWorkbook(invalid), /could not be read/);
  }
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function jobHarness(file = { arrayBuffer: async () => new ArrayBuffer(10) }) {
  const started = deferred(), controller = new AbortController();
  const worker = {
    terminated: 0,
    postMessage(data, transfer) { assert.equal(transfer[0], data); started.resolve(); },
    terminate() { this.terminated++; },
  };
  let creations = 0;
  const promise = readHamricksFile(file, controller.signal, { createWorker: () => { creations++; return worker; } });
  return { promise, worker, controller, started: started.promise, creations: () => creations };
}
const workbook = { sheets: [{ name: "Order", result: { rows: [["Line Type"], ["L"]] } }] };

test("successful reads transfer the buffer and clean up the worker and abort listener", async () => {
  const job = jobHarness(); await job.started;
  job.worker.onmessage({ data: { workbook } });
  assert.equal(await job.promise, workbook);
  job.controller.abort();
  assert.equal(job.worker.terminated, 1);
  assert.equal(job.worker.onmessage, null);
  assert.equal(job.worker.onerror, null);
  assert.equal(job.worker.onmessageerror, null);
});

test("an already stopped job never reads the file or starts a worker", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readHamricksFile({ arrayBuffer() { assert.fail("Must not read"); } }, controller.signal,
    { createWorker() { assert.fail("Must not create a worker"); } }), { name: "AbortError" });
});

test("Stop releases a pending read and ignores both late resolution and late rejection", async () => {
  for (const complete of ["resolve", "reject"]) {
    const read = deferred(), entered = deferred();
    const job = jobHarness({ arrayBuffer() { entered.resolve(); return read.promise; } });
    await entered.promise;
    const rejection = assert.rejects(job.promise, { name: "AbortError" });
    job.controller.abort(); await rejection;
    // A replacement job can finish while the original I/O is still pending.
    const replacement = jobHarness(); await replacement.started;
    replacement.worker.onmessage({ data: { workbook } });
    assert.equal(await replacement.promise, workbook);
    read[complete](complete === "resolve" ? new ArrayBuffer(10) : new Error("Late read failure"));
    await new Promise(setImmediate);
    assert.equal(job.creations(), 0);
    assert.equal(job.worker.terminated, 0);
  }
});

test("Stop terminates parsing and stale worker events cannot change the result", async () => {
  const job = jobHarness(); await job.started;
  const lateMessage = job.worker.onmessage, lateError = job.worker.onerror;
  const rejection = assert.rejects(job.promise, { name: "AbortError" });
  job.controller.abort(); await rejection;
  lateMessage({ data: { workbook } }); lateError({ preventDefault() {} });
  assert.equal(job.worker.terminated, 1);
});

test("the same deadline covers pending file I/O and worker parsing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const phase of ["file", "worker"]) {
    const read = deferred();
    const job = phase === "file" ? jobHarness({ arrayBuffer: () => read.promise }) : jobHarness();
    if (phase === "worker") await job.started;
    else await Promise.resolve();
    const rejection = assert.rejects(job.promise, /Reading took too long/);
    t.mock.timers.tick(60001); await rejection;
    read.resolve(new ArrayBuffer(10)); await new Promise(setImmediate);
    assert.equal(job.creations(), phase === "worker" ? 1 : 0);
    assert.equal(job.worker.terminated, phase === "worker" ? 1 : 0);
  }
});

test("file read failures, worker startup failures, and transfer failures reject cleanly", async () => {
  for (const file of [
    { arrayBuffer() { throw new Error("Cannot read file"); } },
    { arrayBuffer: () => Promise.reject(new Error("Cannot read file")) },
    { arrayBuffer: () => Promise.reject(null) },
  ]) {
    const job = jobHarness(file);
    await assert.rejects(job.promise, /Cannot read file|workbook could not be read/);
    assert.equal(job.creations(), 0);
  }
  for (const phase of ["constructor", "transfer"]) {
    let terminated = 0;
    await assert.rejects(readHamricksFile({ arrayBuffer: async () => new ArrayBuffer(8) }, new AbortController().signal, {
      createWorker() {
        if (phase === "constructor") throw new Error("Worker unavailable");
        return { postMessage() { throw new Error("Transfer failed"); }, terminate() { terminated++; } };
      },
    }), /reader could not start/);
    assert.equal(terminated, phase === "transfer" ? 1 : 0);
  }
});

test("reader errors, module errors, message errors, and incomplete responses have recoverable fallbacks", async () => {
  for (const [event, data, message] of [
    ["onmessage", { error: "Damaged workbook." }, /Damaged workbook/],
    ["onerror", undefined, /reader could not start/],
    ["onmessageerror", undefined, /reader could not start/],
    ["onmessage", null, /incomplete result/],
    ["onmessage", {}, /incomplete result/],
    ["onmessage", { workbook: { sheets: [] } }, /incomplete result/],
    ["onmessage", { workbook: { sheets: [null] } }, /incomplete result/],
    ["onmessage", { workbook: { sheets: [{ name: "Order", result: {} }] } }, /incomplete result/],
  ]) {
    const job = jobHarness(); await job.started;
    const rejection = assert.rejects(job.promise, message);
    job.worker[event]({ data, preventDefault() {} }); await rejection;
    assert.equal(job.worker.terminated, 1);
    const retry = jobHarness(); await retry.started;
    retry.worker.onmessage({ data: { workbook } });
    assert.equal(await retry.promise, workbook);
  }
});

test("preview windows cover every visible row without mounting the entire worksheet", () => {
  for (const count of [0, 1, 199, 200, 201, 38016, 99999]) {
    for (const height of [30, 44.5, 65]) for (const viewport of [0, 100, 440, 1000]) {
      for (const offset of [-100, 0, 200, count * height / 2, count * height, count * height + 10000]) {
        const range = previewWindow(count, offset, viewport, height);
        const capacity = Math.max(1, Math.ceil(viewport / height));
        assert.ok(range.start >= 0 && range.end <= count && range.start <= range.end);
        assert.ok(range.end - range.start <= capacity + 20);
        assert.equal(range.top + (range.end - range.start) * height + range.bottom, count * height);
        if (offset >= 0 && offset < count * height) {
          assert.ok(range.start <= Math.floor(offset / height));
          assert.ok(range.end >= Math.min(count, Math.ceil((offset + viewport) / height)));
        }
      }
    }
  }
});

test("preview windows handle hidden-layout measurement fallbacks and reach the final row", () => {
  for (const height of [0, NaN, Infinity, -1]) {
    assert.deepEqual(previewWindow(38016, 1000, 440, height), previewWindow(38016, 1000, 440, 44.5));
  }
  assert.deepEqual(previewWindow(0, 0, 440, 44.5), { start: 0, end: 0, top: 0, bottom: 0 });
  assert.equal(previewWindow(38016, 38016 * 44.5, 440, 44.5).end, 38016);
});
