import { buildPlan, parseColorCSV } from "./renamer.js";
import { scanFolder, nextOutputName, exportPlan } from "./folder-io.js";

const $ = (id) => document.getElementById(id);
const supported =
  window.isSecureContext && typeof window.showDirectoryPicker === "function";
const PAGE_SIZE = 75;
let source = null,
  snapshot = null,
  plan = null,
  colors = {},
  busy = false,
  copying = false;
let page = 0,
  completed = false,
  abortController = null;

function message(text, type = "") {
  $("message").textContent = text;
  $("message").className = `notice ${type}`;
  $("message").hidden = !text;
}

function setBusy(value) {
  busy = value;
  $("select-folder").disabled = value || !supported;
  $("color-file").disabled = value;
  $("reset-colors").disabled = value;
  $("strict-colors").disabled = value;
  refreshAction();
}

function refreshAction() {
  const blocked = $("strict-colors").checked && plan?.unknownColors.length > 0;
  $("create-folder").disabled =
    busy ||
    !plan ||
    completed ||
    blocked ||
    (!plan.files.length && !plan.directories.length);
  if (completed || copying) return;
  $("action-title").textContent = blocked
    ? "Resolve the unrecognized colors first."
    : plan && !plan.files.length && !plan.directories.length
      ? "This folder is empty."
      : "Ready to create your copy?";
  $("action-description").textContent = blocked
    ? "Add a color CSV, or turn off the color requirement in Naming options."
    : "The new folder includes a CSV log of the filenames.";
}

function bytes(value) {
  if (value < 1024) return `${value} B`;
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** unit).toFixed(unit === 1 ? 0 : 1)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}

function displayWarnings() {
  const warnings = [...plan.notes];
  if (plan.unknownColors.length)
    warnings.push(
      `Unrecognized colors will keep their original spelling: ${plan.unknownColors.join(", ")}.`,
    );
  if (plan.collisions)
    warnings.push(
      `${plan.collisions} filename collision(s) resolved with _DUP2, _DUP3, etc. Review those output names.`,
    );
  if (plan.skipped.length)
    warnings.push(
      `${plan.skipped.length} image(s) do not match the naming pattern and will be copied unchanged: ${plan.skipped
        .slice(0, 10)
        .map((file) => file.relativePath)
        .join(", ")}${plan.skipped.length > 10 ? ", …" : ""}.`,
    );
  if (snapshot.excluded.length)
    warnings.push(
      `Earlier output folders excluded: ${snapshot.excluded.join(", ")}.`,
    );
  $("warnings").hidden = !warnings.length;
  $("warnings-summary").textContent =
    `${warnings.length} ${warnings.length === 1 ? "item" : "items"} to review`;
  $("warnings-list").replaceChildren(
    ...warnings.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }),
  );
}

function renderTable() {
  const totalPages = Math.max(1, Math.ceil(plan.files.length / PAGE_SIZE));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const first = page * PAGE_SIZE;
  const rows = plan.files.slice(first, first + PAGE_SIZE).map((file) => {
    const row = document.createElement("tr");
    for (const name of [file.name, file.outputName]) {
      const cell = document.createElement("td");
      if (file.folder) {
        const path = document.createElement("span");
        path.className = "subpath";
        path.textContent = `${file.folder}/`;
        cell.append(path);
      }
      cell.append(document.createTextNode(name));
      row.append(cell);
    }
    const roleCell = document.createElement("td");
    const role = document.createElement("span");
    role.className = file.role ? "role" : "role unchanged";
    role.textContent = file.role
      ? `${file.genai && file.role !== "DIMS" ? "GENAI " : ""}${file.role}`
      : "As is";
    roleCell.append(role);
    row.append(roleCell);
    return row;
  });
  $("preview-body").replaceChildren(...rows);
  $("page-label").textContent = plan.files.length
    ? `${first + 1}–${Math.min(first + PAGE_SIZE, plan.files.length)} of ${plan.files.length} files`
    : "No files to preview.";
  $("previous-page").disabled = page === 0;
  $("next-page").disabled = page >= totalPages - 1;
  document.querySelector(".pagination").hidden = totalPages === 1;
}

function renderPlan() {
  plan = buildPlan(snapshot.entries, { colors });
  completed = false;
  $("progress-area").hidden = true;
  $("preview").hidden = false;
  $("summary").textContent =
    `${plan.groupCount} style/color ${plan.groupCount === 1 ? "group" : "groups"} · ${bytes(plan.totalBytes)}`;
  const stats = [
    [plan.matched, "images matched"],
    [plan.unchanged, "files copied as is"],
    [plan.directories.length, "subfolders"],
  ];
  $("stats").replaceChildren(
    ...stats.map(([value, label]) => {
      const stat = document.createElement("div");
      stat.className = "stat";
      const number = document.createElement("strong");
      number.textContent = value;
      stat.append(number, document.createTextNode(label));
      return stat;
    }),
  );
  displayWarnings();
  renderTable();
  refreshAction();
}

function explainError(error) {
  if (error.name === "NotAllowedError")
    return "Folder access was not granted. Select the folder again and allow this site to make changes.";
  if (error.name === "SecurityError")
    return "The browser blocked folder access. Open this page directly in desktop Chrome or Edge, then press Select folder.";
  if (error.name === "NotFoundError")
    return "A file or folder is no longer available. Check the source location and select it again.";
  if (error.name === "NotReadableError")
    return "A file could not be read. Check that the files are available locally and not locked by another app.";
  if (error.name === "QuotaExceededError")
    return "There is not enough space to finish the copy. Free up disk space and try again.";
  return (
    error.message ||
    "The operation could not finish. Select the folder again to retry."
  );
}

$("select-folder").addEventListener("click", async () => {
  if (busy) return;
  // Call the picker directly in the click gesture, before any await.
  const picking = window.showDirectoryPicker({
    id: "kohls-image-source",
    mode: "readwrite",
  });
  setBusy(true);
  let selected = false;
  try {
    const handle = await picking;
    selected = true;
    source = handle;
    snapshot = null;
    plan = null;
    completed = false;
    page = 0;
    message("");
    $("preview").hidden = true;
    $("progress-area").hidden = true;
    $("folder-title").textContent = handle.name;
    $("folder-description").textContent = "Reading the folder…";
    $("source-status").textContent = "Scanning";
    snapshot = await scanFolder(handle, {
      onProgress: (count) => {
        $("folder-description").textContent =
          `Reading the folder… ${count} items found`;
      },
    });
    $("output-path").textContent =
      `${handle.name} / ${await nextOutputName(handle)}`;
    renderPlan();
    $("folder-description").textContent =
      `${plan.files.length} files found. Review the names below.`;
    $("source-status").textContent = "Ready to preview";
    $("select-folder").querySelector("span").textContent = "Change folder";
  } catch (error) {
    if (selected) {
      source = null;
      snapshot = null;
      plan = null;
      completed = false;
      $("preview").hidden = true;
      $("folder-title").textContent = "Choose a product image folder";
      $("folder-description").textContent =
        "Subfolders and other files come along, too.";
      $("source-status").textContent = "Select a folder";
      $("output-path").textContent = "Your folder / Your folder_Kohl";
    }
    if (error.name !== "AbortError") message(explainError(error), "error");
  } finally {
    setBusy(false);
  }
});

$("color-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  setBusy(true);
  const previousColors = colors;
  try {
    if (file.size > 1024 * 1024)
      throw new Error("Choose a color CSV smaller than 1 MB.");
    const parsed = parseColorCSV(await file.text());
    if (snapshot) buildPlan(snapshot.entries, { colors: parsed });
    colors = parsed;
    if (snapshot) renderPlan();
    $("color-status").textContent =
      `${file.name} · ${Object.keys(colors).length} custom color entries`;
    $("reset-colors").hidden = false;
    message("");
  } catch (error) {
    colors = previousColors;
    message(explainError(error), "error");
    event.target.value = "";
  } finally {
    setBusy(false);
  }
});
$("reset-colors").addEventListener("click", () => {
  colors = {};
  $("color-file").value = "";
  $("color-status").textContent = "Using the built-in color map.";
  $("reset-colors").hidden = true;
  if (snapshot) renderPlan();
  message("");
});
$("strict-colors").addEventListener("change", refreshAction);
$("previous-page").addEventListener("click", () => {
  page--;
  renderTable();
});
$("next-page").addEventListener("click", () => {
  page++;
  renderTable();
});
$("cancel-copy").addEventListener("click", () => {
  abortController?.abort();
  $("cancel-copy").disabled = true;
});

$("create-folder").addEventListener("click", async () => {
  if (
    busy ||
    !source ||
    !plan ||
    completed ||
    ($("strict-colors").checked && plan.unknownColors.length)
  )
    return;
  const permission = source.requestPermission({ mode: "readwrite" });
  copying = true;
  setBusy(true);
  message("");
  abortController = new AbortController();
  $("progress-area").hidden = false;
  $("progress").value = 0;
  $("cancel-copy").disabled = false;
  $("progress-label").textContent = "Preparing your copy…";
  $("progress-file").textContent = "";
  $("action-title").textContent = "Creating your renamed folder…";
  $("action-description").textContent =
    "Keep this tab open until the copy is complete.";
  $("source-status").textContent = "Copying";
  let lastUpdate = 0;
  try {
    if ((await permission) !== "granted")
      throw new DOMException("Write permission was denied.", "NotAllowedError");
    const run = () =>
      exportPlan(source, plan, {
        signal: abortController.signal,
        onProgress: (progress) => {
          if (
            performance.now() - lastUpdate < 100 &&
            progress.completedFiles !== progress.totalFiles
          )
            return;
          lastUpdate = performance.now();
          $("progress").value = progress.totalBytes
            ? Math.min(99, (progress.copiedBytes / progress.totalBytes) * 100)
            : (progress.completedFiles / Math.max(1, progress.totalFiles)) *
              100;
          $("progress-label").textContent =
            `${progress.completedFiles} of ${progress.totalFiles} files copied · ${bytes(progress.copiedBytes)}`;
          $("progress-file").textContent = progress.path;
          $("output-path").textContent =
            `${source.name} / ${progress.outputName}`;
        },
      });
    const result = navigator.locks
      ? await navigator.locks.request(
          "kohls-image-export",
          { ifAvailable: true },
          (lock) => {
            if (!lock)
              throw new Error(
                "Another tab is already creating a renamed folder. Let it finish, then try again.",
              );
            return run();
          },
        )
      : await run();
    completed = true;
    $("progress").value = 100;
    $("progress-label").textContent =
      `${result.completedFiles} files copied successfully`;
    $("progress-file").textContent = `Log saved as ${result.logName}`;
    $("output-path").textContent = `${source.name} / ${result.outputName}`;
    $("source-status").textContent = "Complete";
    $("action-title").textContent = "Your renamed folder is ready.";
    $("action-description").textContent =
      `Open ${result.outputName} inside ${source.name} in File Explorer or Finder.`;
    message(
      `Created ${source.name}/${result.outputName}. ${result.completedFiles} files copied; original files preserved.`,
    );
  } catch (error) {
    const stopped = error.name === "AbortError";
    const partial = error.outputName
      ? ` An incomplete folder may remain at ${source.name}/${error.outputName}; ${error.completedFiles} files finished copying. Select the source again before retrying.`
      : "";
    message(
      (stopped ? "Copy stopped." : explainError(error)) + partial,
      stopped ? "warning" : "error",
    );
    $("progress-label").textContent = stopped
      ? "Copy stopped"
      : "Copy did not finish";
    $("source-status").textContent = "Needs attention";
  } finally {
    $("cancel-copy").disabled = true;
    copying = false;
    abortController = null;
    setBusy(false);
  }
});

window.addEventListener("beforeunload", (event) => {
  if (copying) {
    event.preventDefault();
    event.returnValue = "";
  }
});
if (!supported) {
  $("compatibility").textContent =
    "Open this page in desktop Chrome or Edge over HTTPS (or localhost) to select and save a folder.";
  $("compatibility").hidden = false;
  $("select-folder").disabled = true;
}
