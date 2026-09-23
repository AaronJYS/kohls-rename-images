import { HEADERS_940, create940CSV, output940Name, validateHamricksFile } from "./hamricks-converter.js";
import { readHamricksFile } from "./hamricks-file.js";
import { createHamricksPreview } from "./hamricks-preview.js";

const $ = (id) => document.getElementById(id);
let workbook = null, fileName = "", selectedSheet = 0;
let busy = false, exporting = false, controller = null;
const current = () => workbook?.sheets[selectedSheet];
const preview = createHamricksPreview($("hamricks-table-scroll"), $("hamricks-preview-body"));

function message(value, type = "") {
  $("hamricks-message").textContent = value;
  $("hamricks-message").className = `notice ${type}`;
  $("hamricks-message").hidden = !value;
}

function render() {
  $("select-hamricks").disabled = busy || exporting;
  $("select-hamricks").querySelector("span").textContent = fileName ? "Change workbook" : "Select workbook";
  $("hamricks-progress").hidden = !busy;
  $("hamricks-drop-zone").setAttribute("aria-busy", String(busy));
  $("hamricks-selection").hidden = !fileName;
  $("hamricks-filename").textContent = fileName;
  $("hamricks-clear").setAttribute("aria-label", `Remove ${fileName}`);
  $("hamricks-sheet-control").hidden = !workbook || workbook.sheets.length < 2;
  $("hamricks-sheet").disabled = busy || exporting;
  $("hamricks-sheet").title = current()?.name ?? "";
  $("hamricks-clear").disabled = busy || exporting;
  const result = current()?.result;
  // Keep the worksheet selector available when a sheet cannot be converted.
  $("hamricks-preview").hidden = !workbook;
  $("hamricks-preview-content").hidden = !result;
  $("hamricks-sheet-error").textContent = current()?.error ?? "";
  $("hamricks-sheet-error").hidden = !current()?.error;
  $("download-940-csv").disabled = busy || exporting || !result;
  $("hamricks-download-status").textContent = "";
  preview.setResult(result);
}

function selectSheet(index) {
  selectedSheet = index;
  $("hamricks-sheet").value = String(index);
  message("");
  render();
}

async function selectFile(files) {
  if (busy || exporting || !files.length) return;
  if (files.length !== 1) { message("Select one workbook at a time. You can select a worksheet after it opens.", "error"); return; }
  const file = files[0];
  try { validateHamricksFile(file); }
  catch (error) { message(error.message, "error"); return; }
  busy = true; workbook = null; fileName = file.name;
  controller = new AbortController();
  $("stop-hamricks").disabled = false;
  message(""); render();
  try {
    workbook = await readHamricksFile(file, controller.signal);
    $("hamricks-sheet").replaceChildren(...workbook.sheets.map((sheet, index) => new Option(sheet.name, String(index))));
    selectSheet(Math.max(0, workbook.sheets.findIndex((sheet) => sheet.result)));
  } catch (error) {
    message(error.name === "AbortError" ? "Reading stopped. Select a workbook to try again." : error.message, error.name === "AbortError" ? "warning" : "error");
  } finally { busy = false; controller = null; render(); }
}

function download() {
  const result = current()?.result;
  if (!result || busy || exporting) return;
  exporting = true; message(""); render();
  $("hamricks-download-status").textContent = "Preparing…";
  let successMessage = "";
  try {
    const data = create940CSV(result);
    const url = URL.createObjectURL(new Blob([data], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    const name = workbook.sheets.length > 1 ? `${fileName.replace(/\.xls[xm]?$/i, "")}_${current().name}` : fileName;
    link.download = output940Name(name, "csv");
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    successMessage = "Check your downloads folder.";
  } catch (error) { message(`The download could not be prepared. ${error.message}`, "error"); }
  finally { exporting = false; render(); }
  if (successMessage) $("hamricks-download-status").textContent = successMessage;
}

$("select-hamricks").addEventListener("click", () => $("hamricks-file").click());
$("hamricks-file").addEventListener("change", (event) => {
  const files = [...event.target.files]; event.target.value = ""; void selectFile(files);
});
$("stop-hamricks").addEventListener("click", () => { controller?.abort(); $("stop-hamricks").disabled = true; });
$("hamricks-clear").addEventListener("click", () => { workbook = null; fileName = ""; message(""); render(); });
$("hamricks-sheet").addEventListener("change", (event) => selectSheet(Number(event.target.value)));
$("download-940-csv").addEventListener("click", download);
const zone = $("hamricks-drop-zone");
let dragDepth = 0;
zone.addEventListener("dragenter", (event) => { event.preventDefault(); dragDepth++; if (!busy && !exporting) zone.classList.add("drag-over"); });
zone.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = busy || exporting ? "none" : "copy"; });
zone.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; zone.classList.remove("drag-over"); } });
zone.addEventListener("drop", (event) => {
  event.preventDefault(); dragDepth = 0; zone.classList.remove("drag-over"); void selectFile(event.dataTransfer.files);
});
$("hamricks-table-head").replaceChildren(...HEADERS_940.map((title) => {
  const th = document.createElement("th"); th.scope = "col"; th.textContent = title; return th;
}));
render();
