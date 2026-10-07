# df

View and edit PDFs directly inside VS Code. Annotations, highlights, drawing, signatures, form filling and page manipulation — all in the editor, saved straight back to the file.

## Features

**Annotation (Adobe-style, right in the viewer toolbar):**

- 🔦 Highlight, underline and strikethrough text
- ✏️ Freehand drawing with color/thickness/opacity options
- 🅰️ Add text boxes (free text)
- 🖼️ Insert images
- ✍️ Sign — draw, type, or upload your signature
- 🧽 Eraser for your own marks, with undo/redo
- 📝 Fill in interactive PDF forms

**Commenting (Adobe Reader-style):**

- 💬 Standalone sticky notes: click the _Add comment_ (💬) button in the toolbar, then click anywhere on a page — no text selection needed
- Author name shown on every comment and stored in the PDF (`/T`); defaults to your OS user name, override with `df.authorName`
- 🧵 Threaded replies in the comments sidebar (standard `/IRT` + `/RT /R` annotation relationships)
- ✅ Mark comment threads resolved/unresolved (standard `/State /Closed` + `/StateModel /Review`, shown struck-through and dimmed, just like Acrobat)
- ✏️ Edit or 🗑️ delete any comment — including ones already saved in the file; double-click a note icon on the page to edit it in place
- Single-click a note icon to highlight its row in the Comments sidebar (Acrobat-style page ↔ panel selection); row actions appear on hover
- Comments saved as standard PDF text annotations (`/Subtype /Text` + `/Popup`) and highlight/ink comments (`/Subtype /Highlight` etc. with `/Contents` + `/T`): Acrobat and other readers show, edit, and delete them natively, including the note pop-up
- Deleting a parent comment also removes its replies from the file

**Pages:**

- 🗂️ Manage pages inside the viewer: open the thumbnails sidebar and enter _Manage pages_ mode to select, rotate, delete, copy/paste, drag-reorder, and export pages — or right-click a page for one-click actions
- ➕ Add pages without leaving the viewer: right-click → _Insert Blank Page Before/After_, or the _Add File…_ button in manage-pages mode to merge another PDF/image
- `df: Rotate Page`, `df: Delete Current Page`, `df: Move Page Up/Down`, `df: Insert Blank Page Before/After` in the Command Palette act on the page you're viewing

**Print:**

- `Ctrl+P` / `Cmd+P` or the toolbar's Print button. VS Code webviews cannot print directly, so df hands the current PDF (annotations included) to your system: set `df.printCommand` to a command like `lpr` and it prints silently; otherwise the PDF opens with your OS default handler.

**Files:**

- Live dirty state: the editor tab shows the ● unsaved dot; `Ctrl+S`/`Cmd+S` writes annotations back into the `.pdf`
- Right-click anywhere for a context menu: highlight the selection, save, print, or run a page operation
- Automatic reload when the file changes on disk (e.g. git checkout, external editor)
- Relative links inside PDFs open sibling files with regular VS Code editors
- Dark/light theme integration

## How it works

The extension registers a custom editor (`df.viewer`) for `*.pdf` files. Rendering and annotation use [pdf.js](https://mozilla.github.io/pdf.js/) inside a webview; the vendored copy carries a small set of source patches (`scripts/patch-pdfjs.mjs`, applied by `make pdfjs`) that persist the annotation author (`/T`), write sticky-note/`/IRT`-reply annotation dictionaries on save, and add author/reply/edit/delete UI to the comments sidebar. On top of that, `resources/bootstrap.mjs` is a thin entry point that wires small ES modules under `resources/df/`:

| Module | Responsibility |
| --- | --- |
| `util.mjs` | VS Code host bridge, injected config, viewer accessors |
| `config.mjs` | pdf.js viewer options and tool-color/size defaults |
| `dialog.mjs` | the comment write / reply / edit dialog |
| `comments.mjs` | comment model: author `/T`, sticky notes, `/IRT` replies, delete cascade |
| `notes.mjs` | Note tool, on-page note icons, page ↔ sidebar selection |
| `sidebar.mjs` | comments-panel refresh and reply/edit/delete/resolve actions |
| `contextmenu.mjs` | the right-click menu |
| `document.mjs` | open / serialize / save / print / dirty-tracking lifecycle |

Page commands run in the extension host with [pdf-lib](https://github.com/Hopding/pdf-lib) and rewrite the file on disk.

## Known limitations

- **Editing text that is already in a PDF is not possible.** pdf.js overlays annotations on top of the original content; there is no reflowing of existing text like Acrobat's _Edit PDF_. Use the text-box tool to cover or annotate existing text.
- The text-box tool has color and size presets (`df.freeTextColor`, `df.freeTextFontSize`) but pdf.js offers no font-family picker.
- Comments created here save as standard `/Subtype /Text` annotations with a `/Popup` pop-up; the pop-up opens on click in Acrobat but the in-viewer editing UI is df's dialog instead of Acrobat's floating note.
- Deleting a comment that was already saved in the file hides its icon immediately; the underlying annotation is removed from the file when you save.
- Editing an existing free-text box cannot reflow its text; delete it and add a new one.

## Development

```sh
make setup    # install Node LTS + dependencies
make pdfjs    # download the pinned pdf.js distribution into resources/pdf.js
make test     # run unit tests with coverage
make check    # verify vendored pdf.js invariants
```

`node scripts/check-adobe-compat.mjs <file.pdf>` independently validates that a saved PDF's comment annotations (sticky notes, `/Popup`, `/IRT` replies, `/State` resolution) are spec-compliant and readable by other PDF implementations.

Press `F5` in VS Code to launch an Extension Development Host, then open any `.pdf`.

To bump the pdf.js version: edit `pdfjs.version` (`<version>@<sha1-of-zip>`) and run `make pdfjs && make check`.

> `context/` holds third-party reference repos for development and is git-ignored.

## How to use

1. Open any `.pdf` — it opens in the PDF editor (right-click → _Open With..._ to switch editors). Try [`examples/example.pdf`](examples/example.pdf) (`make example` regenerates it): page 1 lists the tools, page 2 is rotated for the rotate command, page 3 has fillable form fields.
2. Pick a tool in the toolbar (highlight, draw, add text, image, signature), apply it on the page.
3. `Ctrl+S` / `Cmd+S` to save, or use the toolbar's Save button.
4. For page operations, right-click a page, use _Manage pages_ in the thumbnails sidebar, or run `df: Rotate Page` etc. from the Command Palette.
5. `Ctrl+P` / `Cmd+P` to print.

## Settings

| Setting                        | Default   | Description                                                               |
| ------------------------------ | --------- | ------------------------------------------------------------------------- |
| `df.defaultZoomValue`     | `auto`    | Default zoom when opening a PDF                                           |
| `df.sidebarViewOnLoad`    | `0`       | Sidebar shown on open (none/thumbnails/outline)                           |
| `df.annotationEditorMode` | `none`    | Tool active on open (all tools always available)                          |
| `df.highlightColors`      | 5 presets | Highlighter palette as `Name=#RRGGBB` pairs                               |
| `df.authorName`           | *(empty)* | Author shown on annotations; empty uses your OS user name                 |
| `df.freeTextColor`        | `#000000` | Default text-box color                                                    |
| `df.freeTextFontSize`     | `12`      | Default text-box font size                                                |
| `df.inkColor`             | `#e52222` | Default pen color for drawing                                             |
| `df.printCommand`         | *(empty)* | Shell command that prints the PDF file passed as its argument, e.g. `lpr` |

## License

MIT (this extension). pdf.js is Apache-2.0 licensed by Mozilla and bundled from official releases.
