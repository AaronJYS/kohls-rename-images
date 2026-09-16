import { COLUMNS, localDate } from "./aafes-parser.js";
import { readPurchaseOrders, validatePDF, outputName } from "./pdf-reader.js";

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 50;
let files = [], selectedId = null, page = 0, busy = false, exporting = false, controller = null;
let nextId = 1;

function message(text, type = "") {
  $("pdf-message").textContent = text;
  $("pdf-message").className = `notice ${type}`;
  $("pdf-message").hidden = !text;
}

const readyFiles = () => files.filter((file) => file.result);
const currentFile = () => files.find((file) => file.id === selectedId && file.result);

function controls() {
  $("select-pdfs").disabled = busy || exporting;
  $("clear-pdfs").disabled = busy || exporting;
  $("download-excel").disabled = busy || exporting || !currentFile();
  $("download-pdf-zip").disabled = busy || exporting;
  $("download-pdf-zip").hidden = readyFiles().length < 2;
  $("pdf-preview-file").disabled = exporting;
  $("pdf-source-status").textContent = busy ? "Reading PDFs" : files.length ? `${readyFiles().length} ready` : "";
  $("select-pdfs").querySelector("span").textContent = files.length ? "Add PDFs" : "Select PDFs";
  $("pdf-drop-zone").setAttribute("aria-busy", String(busy));
}

function renderFiles() {
  $("pdf-queue").hidden = !files.length;
  $("pdf-file-count").textContent = `${files.length} ${files.length === 1 ? "FILE" : "FILES"} SELECTED`;
  $("pdf-file-list").replaceChildren(...files.map((file) => {
    const li = document.createElement("li");
    const info = document.createElement("div");
    const name = document.createElement("span");
    name.className = "pdf-file-name";
    name.textContent = file.file.name;
    const status = document.createElement("span");
    status.className = `pdf-file-status${file.error ? " file-error" : ""}`;
    status.textContent = file.error || (file.result
      ? `${file.result.orderCount} purchase orders · ${file.result.pageCount} pages${file.result.warnings.length ? " · Review notes" : " · Ready"}`
      : file.status);
    info.append(name, status);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${file.file.name}`);
    remove.disabled = busy || exporting;
    remove.addEventListener("click", () => {
      files = files.filter((item) => item.id !== file.id);
      render();
    });
    li.append(info, remove);
    return li;
  }));
}

function formatValue(key, type, value) {
  if (key === "currency_code") return "";
  if (value === null || value === undefined || value === "") return "—";
  if (type === "money") return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (type === "number") return String(value);
  if (type === "date" || type === "date-short") {
    const [year, month, day] = value.split("-");
    return type === "date" ? `${month}/${day}/${year}` : `${Number(month)}/${Number(day)}/${year}`;
  }
  return value;
}

function renderTable() {
  const file = currentFile();
  if (!file) return;
  const records = file.result.orders;
  const pageCount = Math.ceil(records.length / PAGE_SIZE);
  page = Math.max(0, Math.min(page, pageCount - 1));
  const first = page * PAGE_SIZE;
  $("pdf-preview-body").replaceChildren(...records.slice(first, first + PAGE_SIZE).map((record) => {
    const tr = document.createElement("tr");
    for (const [key, , type] of COLUMNS) {
      const td = document.createElement("td");
      td.textContent = formatValue(key, type, record[key]);
      if ((key === "sku" || key === "upc") && record.line_count > 1 && record[key]) {
        const details = document.createElement("details");
        details.className = "pdf-identifier-list";
        const summary = document.createElement("summary");
        summary.textContent = `${record.line_count} ${key === "sku" ? "SKUs" : "UPCs"}`;
        const values = document.createElement("div");
        values.className = "pdf-identifier-values";
        // Materialize long lists only when requested, keeping the preview small.
        details.addEventListener("toggle", () => {
          if (details.open && !values.textContent)
            values.textContent = record.line_items.map((row) => row[key] || "—").join("\n");
        });
        details.append(summary, values);
        td.replaceChildren(details);
      }
      if (type === "money" || type === "number") td.className = "numeric";
      tr.append(td);
    }
    return tr;
  }));
  $("pdf-page-label").textContent = `${first + 1}–${Math.min(first + PAGE_SIZE, records.length)} of ${records.length} purchase orders`;
  $("pdf-previous-page").disabled = page === 0;
  $("pdf-next-page").disabled = page === pageCount - 1;
  $("pdf-pagination").hidden = pageCount < 2;
}

function render() {
  const ready = readyFiles();
  if (!currentFile()) { selectedId = ready[0]?.id ?? null; page = 0; }
  renderFiles();
  controls();
  $("pdf-preview").hidden = !ready.length;
  $("pdf-output-name").textContent = currentFile() ? outputName(currentFile().file.name) : "Your file_extracted.xlsx";
  $("pdf-preview-file").replaceChildren(...ready.map((file) => {
    const option = document.createElement("option");
    option.value = String(file.id);
    option.textContent = file.file.name;
    return option;
  }));
  if (!currentFile()) return;
  $("pdf-preview-file").value = String(selectedId);
  const { records, orderCount, pageCount, warnings } = currentFile().result;
  $("pdf-stats").replaceChildren(...[[orderCount, "purchase orders"], [records.length, "source line items"], [pageCount, "PDF pages"]].map(([value, label]) => {
    const stat = document.createElement("div");
    stat.className = "stat";
    const strong = document.createElement("strong");
    strong.textContent = value;
    stat.append(strong, document.createTextNode(label));
    return stat;
  }));
  $("pdf-warnings").hidden = !warnings.length;
  $("pdf-warnings-summary").textContent = `${warnings.length} ${warnings.length === 1 ? "item" : "items"} to review`;
  $("pdf-warnings-list").replaceChildren(...warnings.map((warning) => {
    const li = document.createElement("li");
    li.textContent = warning;
    return li;
  }));
  $("pdf-action-title").textContent = warnings.length ? "Review the notes before downloading." : "Your workbook is ready.";
  renderTable();
}

async function addFiles(incoming) {
  if (busy || exporting || !incoming.length) return;
  // Capture the user's local calendar date once for this entire selection.
  const processedDate = localDate();
  const added = [], errors = [];
  let duplicates = 0;
  for (const file of incoming) {
    try {
      validatePDF(file);
      if (files.some((entry) => entry.file.name === file.name && entry.file.size === file.size && entry.file.lastModified === file.lastModified)) { duplicates++; continue; }
      if (files.length >= 50) throw new Error("Up to 50 PDFs can be selected at a time. Clear or remove files before adding more.");
      const entry = { id: nextId++, file, result: null, error: "", status: "Waiting" };
      files.push(entry);
      added.push(entry);
    } catch (error) { errors.push(`${file.name}: ${error.message}`); }
  }
  if (!added.length) {
    message(errors.join(" ") || "These PDFs are already selected.", "warning");
    return;
  }
  busy = true;
  controller = new AbortController();
  $("pdf-progress-area").hidden = false;
  $("stop-pdfs").disabled = false;
  message(errors.join(" "), "warning");
  render();
  for (const [index, entry] of added.entries()) {
    if (controller.signal.aborted) { entry.error = "Stopped before reading. Remove this file and add it again to retry."; continue; }
    entry.status = "Reading…";
    $("pdf-progress").value = index / added.length * 100;
    $("pdf-progress-label").textContent = `File ${index + 1} of ${added.length} · Opening PDF…`;
    renderFiles();
    try {
      entry.result = await readPurchaseOrders(entry.file, {
        signal: controller.signal,
        processedDate,
        onProgress: ({ page: current, pages }) => {
          $("pdf-progress").value = (index + current / pages) / added.length * 100;
          $("pdf-progress-label").textContent = `File ${index + 1} of ${added.length} · Page ${current} of ${pages}`;
        },
      });
    } catch (error) {
      entry.error = error.name === "AbortError" ? "Stopped. Remove this file and add it again to retry." : error.message || "The PDF could not be read.";
    }
    render();
  }
  const stopped = controller.signal.aborted;
  controller = null;
  busy = false;
  $("pdf-progress-area").hidden = true;
  const failed = added.filter((entry) => entry.error).length;
  const notes = [...errors];
  if (stopped) notes.push(readyFiles().length ? "Extraction stopped. Completed PDFs are still available below." : "Extraction stopped.");
  else if (failed) notes.push(`${failed} PDF(s) could not be converted. See the message beside each file.`);
  if (duplicates) notes.push(`${duplicates} already-selected PDF(s) were skipped.`);
  message(notes.join(" "), failed || errors.length || stopped ? "warning" : "");
  render();
}

$("select-pdfs").addEventListener("click", () => $("pdf-files").click());
$("pdf-files").addEventListener("change", (event) => {
  const chosen = [...event.target.files];
  event.target.value = "";
  void addFiles(chosen);
});
$("clear-pdfs").addEventListener("click", () => { files = []; selectedId = null; page = 0; message(""); render(); });
$("stop-pdfs").addEventListener("click", () => { controller?.abort(); $("stop-pdfs").disabled = true; });
$("pdf-preview-file").addEventListener("change", (event) => { selectedId = Number(event.target.value); page = 0; render(); });
$("pdf-previous-page").addEventListener("click", () => { page--; renderTable(); });
$("pdf-next-page").addEventListener("click", () => { page++; renderTable(); });

const dropZone = $("pdf-drop-zone");
let dragDepth = 0;
dropZone.addEventListener("dragenter", (event) => { event.preventDefault(); dragDepth++; if (!busy && !exporting) dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = busy || exporting ? "none" : "copy"; });
dropZone.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove("drag-over"); } });
dropZone.addEventListener("drop", (event) => {
  event.preventDefault(); dragDepth = 0; dropZone.classList.remove("drag-over");
  void addFiles([...event.dataTransfer.files]);
});
// Dropping outside the target must not navigate away from an in-progress copy.
window.addEventListener("dragover", (event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); });
window.addEventListener("drop", (event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); });

async function download(all) {
  if (busy || exporting || !currentFile()) return;
  exporting = true;
  render();
  message("");
  $("pdf-action-title").textContent = "Preparing your download…";
  let successMessage = "";
  try {
    const { createWorkbook, createWorkbookArchive, downloadFile } = await import("./excel-export.js");
    const file = currentFile();
    const data = all
      ? await createWorkbookArchive(readyFiles().map((entry) => ({ name: entry.file.name, records: entry.result.orders })))
      : await createWorkbook(file.result.orders);
    const name = all ? "AAFES_purchase_orders.zip" : outputName(file.file.name);
    const count = all ? readyFiles().length : 1;
    downloadFile(data, name);
    successMessage = `Created ${name}. ${count} ${count === 1 ? "workbook" : "workbooks"} exported`;
  } catch (error) { message(`The download could not be prepared. ${error.message}`, "error"); }
  finally { exporting = false; render(); }
  if (successMessage) {
    $("pdf-action-title").textContent = successMessage;
  }
}
$("download-excel").addEventListener("click", () => { void download(false); });
$("download-pdf-zip").addEventListener("click", () => { void download(true); });
window.addEventListener("beforeunload", (event) => {
  if (busy || exporting) { event.preventDefault(); event.returnValue = ""; }
});
$("pdf-table-head").replaceChildren(...COLUMNS.map(([, label, type]) => {
  const th = document.createElement("th");
  th.scope = "col";
  th.textContent = label;
  if (type === "money" || type === "number") th.className = "numeric";
  return th;
}));
render();
