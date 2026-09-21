# AAFES test fixtures

These are synthetic purchase orders created for testing; they contain no real
customer data. They are not deployed by the Pages workflow.

- `aafes-orders.pdf`: four pages, two orders, a continuation page without column
  headers, a repeated line, inline and next-row vendor styles, leading-zero
  identifiers, comma-separated values, and a negative amount. It includes the
  AAFES heading, acknowledgment dates, centered Vendor # labels with left-aligned
  values, neighboring Customer # cells, and printed totals below Package Description.
- `aafes-words.json`: the generator's positioned words in PDF points, for pure
  parser tests without a browser dependency.
- `aafes-expected.json`: all fields returned by the original Python converter
  at commit `56ef7bc2412249e4188d6196bae56cb80b845b83` when run against the PDF
  with pdfplumber. Dates are serialized to ISO strings.
- `no-text.pdf` and `invalid.pdf`: empty text extraction and corrupt-input cases.

Rebuild the synthetic PDFs with the official `pdf-lib` package installed
outside the application, passing its absolute directory:

```sh
PDF_LIB=/path/to/node_modules/pdf-lib node tests/fixtures/aafes-fixture.mjs
```

Expected output must be independently rechecked against the original Python
converter when changing the fixture. The browser acceptance check selects the
actual PDFs, compares the preview with the expected data, and exercises Excel
and ZIP downloads, partial batch failures, navigation, and responsive layout.
The two-sheet layout, printed-total reconciliation, one-row-per-item output,
unique SKU summaries, per-file PO/SKU totals, and requested dates are asserted
separately in `aafes.test.mjs`; the original expected JSON preserves raw line
extraction parity for the source converter's fields.
