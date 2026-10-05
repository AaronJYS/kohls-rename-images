# Shared interface conventions

All tabs use the component rules and tokens in `web/styles.css`.
Tool-specific selectors should describe data or layout differences, not duplicate
shared typography, spacing, or controls.

## Typography and color

- Use the system sans-serif font for the interface and spreadsheet data.
  Monospace is reserved for filenames and code, where individual characters matter.
- Page titles use 32 px type (28 px on mobile). Section and picker headings use
  18 px at the same weight and line height, with 16 px page introductions. Controls
  and supporting instructions use 14 px. Tables and action status use 13 px.
  Secondary metadata uses 12 px, with 11 px table labels and badges.
  Font tokens use rem units to respect the browser's default text size.
- Normal text uses `--text`; supporting text uses `--muted`. Accent colors identify
  the active tool. Error, warning, and success colors retain their semantic meaning.
- Use the shared weight and corner-radius tokens. Example column labels follow
  the same typography as preview table headings. Body and table line heights scale
  with the user's text size.

## Spacing and controls

- Use the shared 4 px spacing scale. Panels share horizontal gutters of 24 px on
  desktop and 20 px on smaller screens.
- Pickers share padding, icon spacing, centered content, and 192 × 48 px minimum
  selection buttons. Main actions have the same 48 px minimum height. Selects and
  text buttons have a 44 px minimum height.
- Text buttons use the shared control radius, including their keyboard-focus
  outline. Controls and table scroll regions share the 3 px focus-width token;
  editable grid cells keep that outline inset and their corners square.
- Keep compact heading actions beside their heading as text wraps. The action
  retains its touch-target width instead of dropping into a separate header row.
- Optional CSV selection uses a compact 44 px secondary button with the same
  `Select CSV` / `Change CSV` wording as the other pickers.
- Table cells share 12 px vertical and 16 px horizontal padding. Outer columns
  align with panel gutters. Numeric columns align right.
- When a table meets an action bar directly, the action bar supplies the single
  divider. Do not stack a final-row border against it, including for empty tables.
- Selected files use `file-selection`, `file-row`, `file-name`, and `file-status`.
  PDF queues may contain several rows; a selected workbook uses one row.
- Preview selectors belong in the review heading. Use `preview-control`, a visible
  `field-label`, and `select-field` for both PDF and worksheet selection. Dropdowns
  use a 15 rem width on desktop; labels stack above full-width controls on mobile.
  Keep full names available in the dropdown and its title when selected text is clipped.
- Keep the worksheet selector visible when a worksheet has an error. Place that
  error in a `panel-notice` within the review panel and hide unavailable results
  and downloads until a valid worksheet is selected.
- Action bars use `action-copy` and `download-actions`. Empty status containers
  do not reserve vertical space. Buttons align right on desktop and fill the
  available width on mobile.
- Clipboard input uses `text-area` with the shared font, control radius, and focus
  outline. Synapse reuses the preview table and action bar; its totals use the tool
  accent background and the same right-aligned numeric columns as the other tables.
  Incomplete review rows reuse the shared error colors, with missing-cell dashes
  and accessible issue descriptions so color is not the only indication.
- Input stacks use one 8 px gap between labels, helper text, and fields. Textareas
  do not add their own margin on top of the container gap.
- The Synapse price grid uses the shared table headings, numeric alignment, and
  control tokens. Its editable cells have inset focus outlines, a row-number
  gutter, and an expanding body within the standard scroll height.
- Preserve purposeful layout differences: the image tool has naming examples and
  options, PDF has a multi-file queue, and Hamrick’s previews all populated rows.
  Table widths reflect their contents. Do not add removed Hamrick’s controls or notes.

## Wording

- Use sentence case for visible labels and headings. Navigation, eyebrow labels,
  and table headings may appear uppercase through CSS.
- Headings, buttons, and compact count labels have no final period. Instructions,
  success messages, and error messages end with a period.
- Field labels use sentence case and medium weight without a colon. Button labels
  use `Select` for an initial choice, `Change` to replace it, and `Add` for a queue.
- Use `Select` consistently for file, folder, and worksheet choices. Use a single
  ellipsis character for in-progress actions, such as `Preparing…`.
- Download completion reads `Check your downloads folder.` The image tool reads
  `Check your original folder.` because its output is created within that folder.
- Match singular and plural count labels to the value.
- Source identifiers and export column headings retain their required spelling,
  casing, and punctuation. Visual consistency must not alter conversion data.

## Review

Check initial, selected, preview, options, error, and completion states in all tabs.
Verify desktop and narrow layouts, wrapping filenames, keyboard focus, and horizontal
table scrolling. Local screenshots and customer samples stay outside the repository.
