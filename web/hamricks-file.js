const readerError = () => new Error("The Excel reader could not start. Reload the page and try again.");

// The deadline and Stop cover both file I/O and parsing. A late file read must
// never start a worker or overwrite a subsequent upload after this job ends.
export function readHamricksFile(file, signal, {
  timeoutMs = 60000,
  createWorker = () => new Worker(new URL("./hamricks-worker.js", import.meta.url), { type: "module" }),
} = {}) {
  return new Promise((resolve, reject) => {
    let worker, timeout, settled = false;
    const finish = (error, workbook) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (worker) {
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
      }
      if (error) reject(error);
      else resolve(workbook);
    };
    const abort = () => finish(new DOMException("Stopped", "AbortError"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => finish(new Error("Reading took too long. Try a smaller workbook.")), timeoutMs);

    Promise.resolve().then(() => {
      if (!settled) return file.arrayBuffer();
    }).then((data) => {
      if (settled) return;
      try {
        worker = createWorker();
        worker.onmessage = ({ data: response }) => {
          if (response?.error) finish(new Error(response.error));
          else if (Array.isArray(response?.workbook?.sheets) && response.workbook.sheets.length &&
              response.workbook.sheets.every((sheet) => typeof sheet?.name === "string" &&
                (Array.isArray(sheet.result?.rows) || typeof sheet.error === "string")))
            finish(null, response.workbook);
          else finish(new Error("The Excel reader returned an incomplete result. Select the workbook again."));
        };
        worker.onerror = (event) => { event?.preventDefault(); finish(readerError()); };
        worker.onmessageerror = () => finish(readerError());
        worker.postMessage(data, [data]);
      } catch { finish(readerError()); }
    }).catch((error) => finish(error instanceof Error ? error : new Error("The workbook could not be read. Select it again.")));
  });
}
