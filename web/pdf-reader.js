import { createExtractor } from "./aafes-parser.js";

export const MAX_PDF_BYTES = 50 * 1024 * 1024;
let pdfLibrary;

export function outputName(name) {
  return `${name.replace(/\.pdf$/i, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "orders"}_extracted.xlsx`;
}

export function validatePDF(file) {
  if (!/\.pdf$/i.test(file.name)) throw new Error("Select a PDF file (.pdf).");
  if (!file.size) throw new Error("This PDF is empty. Select a file with content.");
  if (file.size > MAX_PDF_BYTES) throw new Error("This PDF exceeds 50 MB. Split it into smaller PDFs and try again.");
}

// PDF.js may emit several words in one text item. Use measured glyph advances
// scaled to the actual PDF width instead of splitting the width equally.
export function textItemsToWords(content, viewport, util, measure) {
  const words = [];
  for (const item of content.items) {
    if (!item.str?.trim()) continue;
    const transform = util.transform(viewport.transform, item.transform);
    const height = Math.hypot(transform[2], transform[3]);
    const style = content.styles[item.fontName] ?? {};
    const top = transform[5] - (style.ascent ?? 0.8) * height;
    const width = item.width * viewport.scale;
    const total = measure(item.str, height, style.fontFamily) || 1;
    for (const match of item.str.matchAll(/\S+/gu)) {
      const prefix = item.str.slice(0, match.index);
      const x0 = transform[4] + width * measure(prefix, height, style.fontFamily) / total;
      const x1 = transform[4] + width * measure(prefix + match[0], height, style.fontFamily) / total;
      words.push({ text: match[0], x0, x1, top });
    }
  }
  // Some PDFs emit a word as adjacent styled fragments. pdfplumber's default
  // word extraction joins those fragments when the gap is at most 3 points.
  words.sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const merged = [];
  for (const word of words) {
    const previous = merged.at(-1);
    if (previous && Math.abs(previous.top - word.top) <= 1 &&
        word.x0 - previous.x1 >= -0.2 && word.x0 - previous.x1 < 0.6) {
      previous.text += word.text;
      previous.x1 = word.x1;
    } else merged.push(word);
  }
  return merged;
}

export async function readPurchaseOrders(file, { signal, onProgress = () => {}, processedDate } = {}) {
  validatePDF(file);
  signal?.throwIfAborted();
  pdfLibrary ??= import("./vendor/pdfjs/pdf.min.mjs").catch((error) => { pdfLibrary = null; throw error; });
  const pdfjs = await pdfLibrary;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
  const data = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  const loading = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    standardFontDataUrl: new URL("./vendor/pdfjs/standard_fonts/", import.meta.url).href,
  });
  const cancel = () => { void loading.destroy(); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const document = await loading.promise;
    if (document.numPages > 2000) throw new Error("This PDF has more than 2,000 pages. Split it into smaller PDFs and try again.");
    const extractor = createExtractor({ processedDate });
    const canvas = globalThis.document.createElement("canvas");
    const context = canvas.getContext("2d");
    const measure = (text, height, family) => {
      context.font = `${height}px ${family || "sans-serif"}`;
      return context.measureText(text).width;
    };
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      signal?.throwIfAborted();
      const page = await document.getPage(pageNumber);
      // /Rotate changes viewing orientation, not the order's text coordinates.
      // Normalize page width to the parser's 612-point reference so uniformly
      // scaled PDFs keep the same header distances and row tolerances.
      const unrotated = page.getViewport({ scale: 1, rotation: 0 });
      const viewport = page.getViewport({ scale: 612 / unrotated.width, rotation: 0 });
      const content = await page.getTextContent();
      const words = textItemsToWords(content, viewport, pdfjs.Util, measure);
      extractor.addPage({ words, width: viewport.width, pageNumber });
      page.cleanup();
      onProgress({ page: pageNumber, pages: document.numPages });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    signal?.throwIfAborted();
    return { ...extractor.finish(), pageCount: document.numPages };
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Extraction stopped.", "AbortError");
    if (error.name === "PasswordException") throw new Error("This PDF is password protected. Save an unlocked copy and select it again.");
    if (error.name === "InvalidPDFException") throw new Error("This file could not be read as a PDF. It may be damaged or incomplete.");
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await loading.destroy();
  }
}
