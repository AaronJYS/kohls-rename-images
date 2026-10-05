import { MAX_SYNAPSE_ROWS, parseSynapseClipboard, parseSynapsePrices, matchSynapsePrices,
  formatSynapsePrice, getSynapseExportRows, createSynapseTSV, createSynapseHTML } from "./synapse-parser.js";
import { createSynapsePriceGrid } from "./synapse-price-grid.js";

const $ = (id) => document.getElementById(id);
let result = null, copying = false;
const priceGrid = createSynapsePriceGrid($("synapse-price-body"), {
  onChange: update,
  onError(error) {
    $("synapse-price-message").textContent = error.message;
    $("synapse-price-message").hidden = false;
    $("synapse-price-grid").setAttribute("aria-invalid", "true");
  },
});

function update() {
  result = null;
  let order = null, prices = null;
  // The generated price-list header is not counted in the visible grid rows.
  for (const [inputId, clearId, messageId, parse] of [
    ["synapse-input", "synapse-clear", "synapse-message", parseSynapseClipboard],
    ["synapse-price-grid", "synapse-price-clear", "synapse-price-message", (input) => parseSynapsePrices(input, { rowOffset: -1 })],
  ]) {
    const input = inputId === "synapse-price-grid" ? priceGrid.getText() : $(inputId).value;
    $(clearId).disabled = !input;
    $(messageId).hidden = true;
    $(messageId).textContent = "";
    $(inputId).removeAttribute("aria-invalid");
    try {
      const parsed = input.trim() ? parse(input) : null;
      if (inputId === "synapse-input") order = parsed;
      else prices = parsed ?? { rows: [] };
    } catch (error) {
      $(messageId).textContent = error.message;
      $(messageId).hidden = false;
      $(inputId).setAttribute("aria-invalid", "true");
    }
  }
  if (order && prices) result = matchSynapsePrices(order, prices);
  $("synapse-copy-fallback").hidden = true;
  $("synapse-copy-text").value = "";
  $("synapse-copy-status").textContent = "";
  $("synapse-preview").hidden = !result;
  const canCopy = result && getSynapseExportRows(result).length;
  $("synapse-copy").disabled = !canCopy || copying;
  $("synapse-preview-body").replaceChildren();
  $("synapse-total-ship").textContent = result?.totals.ship ?? "—";
  $("synapse-total-picked").textContent = result?.totals.picked ?? "—";
  $("synapse-total-price").textContent = result?.totals.price != null ? `$${formatSynapsePrice(result.totals.price)}` : "—";
  $("synapse-row-count").textContent = "";
  $("synapse-review-message").textContent = "";
  $("synapse-review-message").hidden = true;
  if (!result) return;
  let incomplete = 0;
  const rows = result.rows.map(({ item, ship, picked, price, issues }, rowIndex) => {
    const tr = document.createElement("tr");
    if (issues.length) {
      incomplete++;
      tr.className = "synapse-row-incomplete";
      tr.title = issues.join(" ");
    }
    for (const [index, value] of [item, ship, picked, price === null ? null : `$${formatSynapsePrice(price)}`].entries()) {
      const td = document.createElement("td");
      td.textContent = value === null || value === "" ? "—" : value;
      if (index) td.className = "numeric";
      if (!index && issues.length) {
        const description = document.createElement("span");
        description.id = `synapse-row-issues-${rowIndex}`;
        description.hidden = true;
        description.textContent = tr.title;
        td.setAttribute("aria-describedby", description.id);
        td.append(description);
      }
      tr.append(td);
    }
    return tr;
  });
  $("synapse-preview-body").replaceChildren(...rows);
  $("synapse-table-scroll").scrollTop = 0;
  $("synapse-table-scroll").scrollLeft = 0;
  const count = result.rows.length;
  $("synapse-row-count").textContent = `${count} of ${MAX_SYNAPSE_ROWS} rows`;
  $("synapse-review-message").hidden = !incomplete;
  if (incomplete) $("synapse-review-message").textContent =
    `${incomplete} ${incomplete === 1 ? "row needs" : "rows need"} attention. Red rows have missing values or no unique price match. Totals include available values only; missing cells stay blank when copied.`;
  $("synapse-copy-status").textContent = canCopy
    ? "Copies Item, Quantity Ship, and Wholesale Unit Price only. Rows with both quantities at zero are skipped."
    : "No rows to copy. Quantity Ship and Quantity Picked are zero for every row.";
}

async function writeClipboard(table) {
  const text = createSynapseTSV(table);
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([createSynapseHTML(table)], { type: "text/html" }),
      })]);
      return;
    } catch { /* Some browsers allow plain text but reject rich clipboard data. */ }
  }
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
  await navigator.clipboard.writeText(text);
}

async function copy() {
  if (!result || copying) return;
  const table = result;
  const count = getSynapseExportRows(table).length;
  if (!count) return;
  copying = true;
  $("synapse-copy").disabled = true;
  $("synapse-copy").querySelector("span").textContent = "Copying…";
  $("synapse-copy-fallback").hidden = true;
  try {
    await writeClipboard(table);
    if (result === table) $("synapse-copy-status").textContent =
      `Copied ${count} ${count === 1 ? "row" : "rows"}. Paste into Excel.`;
  } catch {
    if (result === table) {
      $("synapse-copy-status").textContent = "Clipboard access was blocked. Copy the selected text below.";
      $("synapse-copy-fallback").hidden = false;
      $("synapse-copy-text").value = createSynapseTSV(table);
      $("synapse-copy-text").focus();
      $("synapse-copy-text").select();
    }
  } finally {
    copying = false;
    $("synapse-copy").disabled = !result || !getSynapseExportRows(result).length;
    $("synapse-copy").querySelector("span").textContent = "Copy for Excel";
  }
}

$("synapse-input").addEventListener("input", (event) => {
  update();
  if (event.inputType === "insertFromPaste" || event.data?.length > 1) {
    // Start a wide pasted grid at its header and item column, not the trailing blanks.
    requestAnimationFrame(() => { $("synapse-input").scrollTop = 0; $("synapse-input").scrollLeft = 0; });
  }
});
$("synapse-clear").addEventListener("click", () => {
  $("synapse-input").value = "";
  update();
  $("synapse-input").focus();
});
$("synapse-price-clear").addEventListener("click", () => priceGrid.clear());
$("synapse-copy").addEventListener("click", copy);
// Leave native copy events alone so selected text copies exactly as displayed.
update();
