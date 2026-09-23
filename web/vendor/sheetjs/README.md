# SheetJS Community Edition 0.20.3

Vendored from the official SheetJS CDN to keep workbook processing local and
avoid runtime CDN requests. Licensed under Apache-2.0; see `LICENSE`.

- `xlsx.mjs`: https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs
- `cpexcel.full.mjs`: https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/cpexcel.full.mjs
- `LICENSE`: https://cdn.sheetjs.com/xlsx-0.20.3/package/LICENSE

The codepage module supports legacy Excel encodings. The reader loads both
modules in a worker only when a workbook is selected. No customer workbooks are
bundled with the application.

Upstream installation guidance:
https://docs.sheetjs.com/docs/getting-started/installation/standalone/
