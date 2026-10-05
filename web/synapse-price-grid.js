import { MAX_SYNAPSE_PRICES, normalizeSynapsePriceInput, normalizeSynapsePricePaste,
  readSynapsePricePaste } from "./synapse-parser.js";

const blankRow = () => ["", ""];
const hasValue = (row) => row.some((value) => value.length);
const quoteCell = (value) => /["\t\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export function createSynapsePriceGrid(body, { onChange, onError }) {
  let rows = [blankRow()];
  const inputs = [];

  function focus(row, column) {
    const input = inputs[row]?.[column];
    if (!input) return;
    input.focus();
    input.select();
  }

  function render() {
    if (rows.length < MAX_SYNAPSE_PRICES && hasValue(rows.at(-1))) rows.push(blankRow());
    while (inputs.length > rows.length) {
      body.lastElementChild.remove();
      inputs.pop();
    }
    while (inputs.length < rows.length) {
      const row = inputs.length;
      const tr = document.createElement("tr");
      const number = document.createElement("th");
      number.scope = "row";
      number.textContent = String(row + 1);
      tr.append(number);
      const cells = [0, 1].map((column) => {
        const td = document.createElement("td");
        const input = document.createElement("input");
        input.type = "text";
        input.className = "synapse-price-cell";
        input.autocomplete = "off";
        input.autocapitalize = "off";
        input.spellcheck = false;
        if (column === 1) input.inputMode = "decimal";
        input.setAttribute("aria-label", `${column ? "Price" : "Item"}, row ${row + 1}`);
        input.setAttribute("aria-describedby", "synapse-price-message");
        input.addEventListener("focus", () => input.select());
        input.addEventListener("input", () => {
          rows[row][column] = input.value;
          if (row === rows.length - 1) render();
          onChange();
        });
        input.addEventListener("paste", (event) => paste(event, row, column, input));
        input.addEventListener("keydown", (event) => {
          if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
          const direction = event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1
            : event.key === "ArrowDown" || event.key === "Enter" ? 1 : 0;
          if (!direction) return;
          event.preventDefault();
          focus(row + direction, column);
        });
        td.append(input);
        tr.append(td);
        return input;
      });
      inputs.push(cells);
      body.append(tr);
    }
    rows.forEach((row, index) => row.forEach((value, column) => {
      // Keep the active input and its selection intact during manual edits.
      if (inputs[index][column].value !== value) inputs[index][column].value = value;
    }));
  }

  function paste(event, row, column, input) {
    const text = event.clipboardData?.getData("text/plain");
    if (text == null) return;
    event.preventDefault();
    try {
      const cells = readSynapsePricePaste(text, column);
      if (!cells.length) return;
      if (row + cells.length > MAX_SYNAPSE_PRICES)
        throw new Error(`The price list can hold up to ${MAX_SYNAPSE_PRICES} rows. Paste into an earlier row or clear some entries.`);
      // A single plain cell also supports pasting into a text selection. Ranges
      // from Excel replace cells, starting at the cell where the paste occurs.
      const editCell = cells.length === 1 && cells[0].length === 1 && !/[\t\r\n]/.test(text);
      let caret;
      if (editCell) {
        if (column === 0) {
          const normalized = normalizeSynapsePricePaste(input.value, cells[0][0], input.selectionStart, input.selectionEnd);
          rows[row][column] = normalized.value;
          caret = normalized.selectionStart;
        } else {
          rows[row][column] = input.value.slice(0, input.selectionStart) + cells[0][0] + input.value.slice(input.selectionEnd);
          caret = input.selectionStart + cells[0][0].length;
        }
      } else {
        while (rows.length < row + cells.length) rows.push(blankRow());
        cells.forEach((values, offset) => values.forEach((value, index) => {
          rows[row + offset][column + index] = column + index === 0 ? normalizeSynapsePriceInput(value) : value;
        }));
      }
      render();
      if (editCell) input.setSelectionRange(caret, caret);
      else focus(row, column);
      onChange();
    } catch (error) {
      onError(error);
    }
  }

  render();
  return {
    getText() {
      if (!rows.some(hasValue)) return "";
      return "Item\tPrice\n" + rows.map((row) => row.map(quoteCell).join("\t")).join("\n");
    },
    clear() {
      rows = [blankRow()];
      render();
      onChange();
      focus(0, 0);
    },
  };
}
