# Bundled browser dependencies

All dependencies are served from this site; no CDN, analytics, or external
processing service is used. Preserve the license files when updating.

- **PDF.js 5.6.205**, Mozilla, Apache-2.0. `pdf.min.mjs`, its matching worker,
  and standard fonts copied unmodified from the official `pdfjs-dist` package.
  https://github.com/mozilla/pdf.js
- **JSZip 3.10.1**, MIT (selected license). `jszip.min.js` copied unmodified
  from the official `jszip` package. https://github.com/Stuk/jszip

PDF.js is loaded only after selecting a PDF. The worker and main library must
always have matching versions. For an update, replace both builds, the fonts,
and licenses from the same official package, then run the PDF extraction and
workbook tests and verify the browser workflow.
