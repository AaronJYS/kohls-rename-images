import { buildPlan, parseColorCSV } from "./renamer.js";
import { scanFolder, exportPlan } from "./folder-io.js";

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
  $("select-colors").disabled = value;
  $("reset-colors").disabled = value;
  $("strict-colors").disabled = value;
  refreshAction();
}

function refreshAction() {
  const blocked = $("strict-colors").checked && plan?.unknownColors.length > 0;
  $("create-folder").disabled =
    busy ||
    !plan ||
    blocked ||
    (!plan.files.length && !plan.directories.length);
  if (completed || copying) return;
  $("action-description").hidden = !blocked;
  $("action-title").textContent = blocked
    ? "Resolve the unrecognized colors first."
    : plan && !plan.files.length && !plan.directories.length
      ? "This folder is empty."
      : "";
  $("action-description").textContent = blocked
    ? "Add a color CSV, or turn off the color requirement in Naming options."
    : "";
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
    ? `${first + 1}–${Math.min(first + PAGE_SIZE, plan.files.length)} of ${plan.files.length} ${plan.files.length === 1 ? "file" : "files"}`
    : "No files to preview.";
  $("previous-page").disabled = page === 0;
  $("next-page").disabled = page >= totalPages - 1;
  document.querySelector(".pagination").hidden = totalPages === 1;
}

function renderPlan(nextColors = colors) {
  plan = buildPlan(snapshot.entries, { colors: nextColors });
  completed = false;
  $("preview").hidden = false;
  const stats = [
    [plan.matched, `${plan.matched === 1 ? "image" : "images"} matched`],
    [plan.unchanged, `${plan.unchanged === 1 ? "file" : "files"} copied as is`],
    [plan.groupCount, `style/color ${plan.groupCount === 1 ? "group" : "groups"}`],
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
    $("folder-title").textContent = handle.name;
    $("folder-description").textContent = "Reading folder…";
    $("source-status").textContent = "Scanning…";
    snapshot = await scanFolder(handle, {
      onProgress: (count) => {
        $("folder-description").textContent =
          `Reading folder… ${count} ${count === 1 ? "item" : "items"} found`;
      },
    });
    renderPlan();
    $("folder-description").textContent =
      `${plan.files.length} ${plan.files.length === 1 ? "file" : "files"} selected`;
    $("source-status").textContent = "";
    $("select-folder").querySelector("span").textContent = "Change folder";
    requestAnimationFrame(() => {
      if (!$("image-tool").hidden) {
        window.scrollTo({
          top: document.documentElement.scrollHeight,
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
        });
      }
    });
  } catch (error) {
    if (selected) {
      source = null;
      snapshot = null;
      plan = null;
      completed = false;
      $("preview").hidden = true;
      $("folder-title").textContent = "Select a product image folder";
      $("folder-description").textContent =
        "Subfolders and other files are included.";
      $("source-status").textContent = "Select a folder";
    }
    if (error.name !== "AbortError") message(explainError(error), "error");
  } finally {
    setBusy(false);
  }
});

$("select-colors").addEventListener("click", () => $("color-file").click());
$("color-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  setBusy(true);
  try {
    if (file.size > 1024 * 1024)
      throw new Error("Select a color CSV smaller than 1 MB.");
    const parsed = parseColorCSV(await file.text());
    if (snapshot) renderPlan(parsed);
    const count = Object.keys(parsed).length;
    $("color-status").textContent =
      `Using ${file.name} with ${count} color ${count === 1 ? "entry" : "entries"}.`;
    $("select-colors").textContent = "Change CSV";
    $("reset-colors").hidden = false;
    message("");
    colors = parsed;
  } catch (error) {
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
  $("select-colors").textContent = "Select CSV";
  $("reset-colors").hidden = true;
  if (snapshot) renderPlan();
  message("");
});
$("strict-colors").addEventListener("change", () => {
  completed = false;
  refreshAction();
});
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
    ($("strict-colors").checked && plan.unknownColors.length)
  )
    return;
  const permission = source.requestPermission({ mode: "readwrite" });
  completed = false;
  copying = true;
  setBusy(true);
  message("");
  abortController = new AbortController();
  $("cancel-copy").hidden = false;
  $("cancel-copy").disabled = false;
  $("action-title").textContent = "Preparing…";
  $("action-description").hidden = true;
  $("source-status").textContent = "";
  try {
    if ((await permission) !== "granted")
      throw new DOMException("Write permission was denied.", "NotAllowedError");
    const run = () =>
      exportPlan(source, plan, {
        signal: abortController.signal,
      });
    await (navigator.locks
      ? navigator.locks.request(
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
      : run());
    completed = true;
    $("action-title").textContent = "Check your original folder.";
  } catch (error) {
    const stopped = error.name === "AbortError";
    const partial = error.outputName
      ? ` An incomplete folder may remain at ${source.name}/${error.outputName}; ${error.completedFiles} ${error.completedFiles === 1 ? "file" : "files"} finished copying. Select the source again before retrying.`
      : "";
    message(
      (stopped ? "Copy stopped." : explainError(error)) + partial,
      stopped ? "warning" : "error",
    );
    $("source-status").textContent = "Needs attention";
  } finally {
    $("cancel-copy").hidden = true;
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
