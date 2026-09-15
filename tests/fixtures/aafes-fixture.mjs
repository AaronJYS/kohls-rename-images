// Synthetic purchase orders only; no customer or production data.
// Rebuild the PDF with PDF_LIB pointing to the official pdf-lib package folder.
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const { PDFDocument, StandardFonts } = await import(pathToFileURL(process.env.PDF_LIB + "/cjs/index.js"));
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const pages = [];
const columns = [28, 80, 175, 300, 410, 447, 490, 550];
const headers = ["Line", "UPC", "SKU", "Description", "Qty", "UOM", "Price", "Amount"];

function page({ po = "0069749254", dates = true, table = true, ack = "7/17/2026", vendor = "00045678" } = {}) {
  const canvas = pdf.addPage([612, 792]);
  const words = [];
  pages.push({ width: 612, words });
  const text = (value, x, top, size = 8) => {
    canvas.drawText(value, { x, y: 792 - top - size * 0.718, size, font });
    let offset = 0;
    for (const part of value.split(/(\s+)/)) {
      const width = font.widthOfTextAtSize(part, size);
      if (part.trim()) words.push({ text: part, x0: x + offset, x1: x + offset + width, top });
      offset += width;
    }
  };
  text("AAFES", 268, 20, 12);
  if (po) {
    text("Stand-alone Order", 455, 42);
    text(po, 455, 58, 10);
    text(ack, 455, 78);
    text("Vendor #", 82, 145);
    text(vendor, 23, 160);
    text("Customer #", 230, 145);
    text("00000999", 205, 160);
  }
  text("Store #: 000123", 28, 70);
  if (dates) {
    text("Requested Ship", 28, 100);
    text("9/1/2026", 28, 117);
    text("Requested Delivery", 180, 100);
    text("9/9/2026", 180, 117);
  }
  if (table) headers.forEach((label, i) => text(label, columns[i], 185));
  text("03-Sep-2026", 480, 755);
  text(`Page ${pages.length} of 4`, 28, 755);
  const item = (line, top, { qty = "2", amount = "34.50", sku = "003278934", style = "BX06772.BK", inline = false } = {}) => {
    [line, "000123456789", sku, "BUXTON ZIP", qty, "EA", "17.25", amount].forEach((value, i) => text(value, columns[i], top));
    text(inline ? `Vendor's Style #: ${style}` : "Vendor's Style #:", 175, top + 16, inline ? 6 : 8);
    if (!inline) text(style, 175, top + 29);
  };
  const total = (amount) => {
    text("Package Description", 250, 400);
    text("Deliver to receiving dock", 28, 430);
    text(amount, 540, 510);
  };
  return { text, item, total };
}

const first = page();
first.item("00001", 215);
first.item("00002", 265, { qty: "3", amount: "51.75", sku: "000765432", style: "22003.NV", inline: true });
const second = page({ po: null, dates: false, table: false });
second.item("00003", 210, { qty: "1,000", amount: "1,234.56", sku: "009999999", style: "70000.CG" });
second.total("1,320.81");
const duplicate = page({ dates: false });
duplicate.item("00001", 215);
const another = page({ po: "0069749253", ack: "7/18/2026", vendor: "00087654" });
another.item("00001", 215, { qty: "-1", amount: "-17.25", style: "RETURN.BK" });
another.total("-17.25");

await writeFile(new URL("aafes-orders.pdf", import.meta.url), await pdf.save());
await writeFile(new URL("aafes-words.json", import.meta.url), JSON.stringify(pages, null, 2) + "\n");
const blank = await PDFDocument.create();
blank.addPage();
await writeFile(new URL("no-text.pdf", import.meta.url), await blank.save());
await writeFile(new URL("invalid.pdf", import.meta.url), "This is not a PDF.\n");
