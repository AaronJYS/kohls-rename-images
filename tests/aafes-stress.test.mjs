import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractPages, toNumber } from "../web/aafes-parser.js";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/aafes-words.json", import.meta.url), "utf8"));
const copy = () => structuredClone(fixtures);

test("amount parsing preserves accounting signs, currency, decimals and thousands grouping", () => {
  for (const [text, expected] of [
    ["(12.50)", -12.5], ["($ 1,234.50)", -1234.5], ["$ -17.25", -17.25],
    ["-$17.25", -17.25], ["£12.50", 12.5], ["€1.234,50", 1234.5],
    ["12,50", 12.5], ["25,00", 25], ["37,50", 37.5], ["(12,50)", -12.5],
    ["1.234.567,89", 1234567.89], ["1,234,567.89", 1234567.89],
    ["1,000", 1000], ["1,234", 1234], ["0,105", 0.105], ["0.105", 0.105],
    [".50", 0.5], [",50", 0.5], ["0", 0], ["0,00", 0], ["0.00", 0],
  ]) assert.equal(toNumber(text), expected, text);
});

test("malformed numeric strings cannot become plausible amounts by stripping punctuation", () => {
  for (const text of ["", " ", "$", "--12.50", "-+12.50", "-$-12.50", "(-12.50)",
    "(12.50", "12.50)", "1,,234", "1,23,456", "12,34,56", "1.23,45", "1.234.56",
    "12.50 USD", "1 2.50", "1/2", "Infinity", "NaN", "123abc", "1e3"])
    assert.equal(toNumber(text), text, text);
});

test("accounting negatives keep their SKU/UPC pair and reconcile with the printed total", () => {
  const pages = copy();
  pages[3].words.filter((word) => word.text === "-17.25").forEach((word) => { word.text = "(17.25)"; });
  const result = extractPages(pages);
  assert.equal(result.records.length, 4);
  assert.equal(result.records[3].amount, -17.25);
  assert.equal(result.orders[1].order_total, -17.25);
  assert.equal(result.orders[1].sku, "003278934");
  assert.equal(result.orders[1].upc, "000123456789");
  assert.ok(!result.warnings.some((warning) => /unreadable|differs from the extracted/.test(warning)));
});

test("currency symbols use the same numeric parser during row validation and extraction", () => {
  const pages = copy();
  for (const page of pages) {
    for (const word of page.words) {
      if (word.x0 >= 470 && /^-?[\d,]+\.\d+$/.test(word.text)) word.text = `$ ${word.text}`;
    }
  }
  const result = extractPages(pages);
  assert.deepEqual(result.records.map(({ qty, amount, order_total }) => [qty, amount, order_total]), [
    [2, 34.5, 1320.81], [3, 51.75, 1320.81], [1000, 1234.56, 1320.81], [-1, -17.25, -17.25],
  ]);
  assert.ok(!result.warnings.some((warning) => /unreadable|no printed total|differs from the extracted/.test(warning)));
});

test("comma decimals reconcile every internal amount, including grouped thousands", () => {
  const pages = copy();
  for (const page of pages) {
    for (const word of page.words) {
      if (word.x0 >= 470 && /^-?[\d,]+\.\d+$/.test(word.text))
        word.text = word.text.replaceAll(",", "_").replace(".", ",").replaceAll("_", ".");
    }
  }
  const expected = extractPages(fixtures);
  const result = extractPages(pages);
  assert.deepEqual(result.records, expected.records);
  assert.deepEqual(result.warnings, expected.warnings);
});

test("comma decimals produce the correct fallback total when no printed total exists", () => {
  const pages = [copy()[0]];
  for (const word of pages[0].words) {
    if (["34.50", "51.75"].includes(word.text)) word.text = word.text.replace(".", ",");
  }
  const result = extractPages(pages);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((row) => row.amount), [34.5, 51.75]);
  assert.equal(result.orders[0].order_total, 86.25);
  assert.match(result.warnings.join(" "), /no printed total/);
});

test("trailing numeric footers cannot replace a printed total", () => {
  const pages = copy();
  const total = pages[1].words.find((word) => word.text === "1,320.81");
  pages[1].words.push({ ...total, text: "999.99", top: total.top + 20 });
  const result = extractPages(pages);
  assert.equal(result.orders[0].order_total, 1320.81);
  assert.match(result.warnings.join(" "), /extra numeric values below the printed total were ignored/);
  assert.ok(!result.warnings.some((warning) => /differs from the extracted/.test(warning)));
});

test("a footer matching the line sum cannot override a genuine mismatching printed total", () => {
  const pages = copy();
  const total = pages[1].words.find((word) => word.text === "1,320.81");
  total.text = "1,300.00";
  pages[1].words.push({ ...total, text: "1,320.81", top: total.top + 20 });
  const result = extractPages(pages);
  assert.equal(result.orders[0].order_total, 1300);
  assert.match(result.warnings.join(" "), /printed total 1300.00 differs.*1320.81/);
  assert.match(result.warnings.join(" "), /extra numeric values/);
});

test("zero and negative printed totals survive trailing numeric footers", () => {
  for (const value of ["0.00", "(17.25)"]) {
    const pages = [copy()[3]];
    const total = pages[0].words.find((word) => word.top === 510 && word.text === "-17.25");
    total.text = value;
    pages[0].words.push({ ...total, text: "999.99", top: total.top + 20 });
    assert.equal(extractPages(pages).orders[0].order_total, value === "0.00" ? 0 : -17.25);
  }
});

test("split currency tokens in printed totals are read as one amount", () => {
  const pages = copy();
  const total = pages[1].words.find((word) => word.text === "1,320.81");
  pages[1].words.push({ ...total, text: "$", x0: total.x0 - 10, x1: total.x0 - 3 });
  const result = extractPages(pages);
  assert.equal(result.orders[0].order_total, 1320.81);
  assert.ok(!result.warnings.some((warning) => /extra numeric|no printed total/.test(warning)));
});
