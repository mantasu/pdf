import { PDFDocument, PDFName, PDFString, StandardFonts, rgb, degrees } from "pdf-lib";
import { writeFileSync } from "node:fs";

const doc = await PDFDocument.create();
doc.setTitle("df extension example document");
doc.setAuthor("df");
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

// Page 1 — feature overview
const page0 = doc.addPage([595, 842]); // A4
let page = page0;
page.drawText("df — PDF editing inside VS Code", { x: 50, y: 780, size: 24, font: bold });
page.drawText("This is an example document. Try the tools in the toolbar:", { x: 50, y: 745, size: 12, font });
const lines = [
  "1. Highlight this sentence with the highlighter tool.",
  "2. Underline or strike out these words.",
  "3. Draw freehand over this paragraph.",
  "4. Add a text box anywhere on the page.",
  "5. Insert an image from your disk.",
  "6. Add your signature (draw, type, or upload).",
  "7. Use the eraser on your own marks, or undo.",
  "8. Save with Ctrl+S / Cmd+S and reopen the file.",
];
lines.forEach((text, i) => page.drawText(text, { x: 70, y: 705 - i * 28, size: 13, font }));
page.drawRectangle({ x: 50, y: 430, width: 495, height: 90, color: rgb(0.95, 0.95, 0.85), borderColor: rgb(0.6, 0.6, 0.6) });
page.drawText("Page operations (Command Palette):", { x: 60, y: 495, size: 12, font: bold });
page.drawText("df: Rotate Page  |  df: Delete Current Page  |  df: Move Page Up/Down  |  df: Insert Blank Page", { x: 60, y: 470, size: 10, font });
page.drawText("External changes to this file reload the viewer automatically.", { x: 50, y: 400, size: 10, font, color: rgb(0.4, 0.4, 0.4) });

// Sample annotations on page 1, so the Comments panel has content to explore:
// a sticky note, a text highlight with a comment, and a threaded reply.
{
  const ctx = doc.context;
  const date = "D:20261001120000";

  // Highlight over "1. Highlight this sentence..." (line y = 705, x 70..345).
  const hlQuads = [70, 710, 345, 710, 70, 697, 345, 697];
  const hl = doc.context.obj({
    Type: "Annot",
    Subtype: "Highlight",
    Rect: [70, 697, 345, 710],
    QuadPoints: hlQuads,
    C: [1, 0.949, 0],
    CA: 1,
    F: 4,
    T: PDFString.of("df"),
    Contents: PDFString.of("Try clicking me: a single click selects this highlight."),
    CreationDate: PDFString.of(date),
  });
  const hlRef = ctx.register(hl);
  const hlPopup = doc.context.obj({
    Type: "Annot",
    Subtype: "Popup",
    Open: false,
    Rect: [346, 610, 526, 710],
    Parent: hlRef,
  });
  const hlPopupRef = ctx.register(hlPopup);
  hl.set(PDFName.of("Popup"), hlPopupRef);

  // A reply to the highlight comment (threaded in the Comments panel via /IRT).
  const reply = doc.context.obj({
    Type: "Annot",
    Subtype: "Text",
    Name: "Note",
    Rect: [70, 697, 90, 710],
    Contents: PDFString.of("Right-click any text to highlight + comment like Acrobat."),
    T: PDFString.of("df"),
    IRT: hlRef,
    RT: "R",
    F: 34, // hidden: sidebar only
    CreationDate: PDFString.of(date),
  });
  const replyRef = ctx.register(reply);

  // A standalone sticky note near the page-operations box.
  const note = doc.context.obj({
    Type: "Annot",
    Subtype: "Text",
    Name: "Note",
    Rect: [505, 500, 525, 520],
    Contents: PDFString.of("Sticky notes save as subtype Text and open in Acrobat too."),
    T: PDFString.of("df"),
    F: 4,
    CreationDate: PDFString.of(date),
  });
  const noteRef = ctx.register(note);
  const notePopup = doc.context.obj({
    Type: "Annot",
    Subtype: "Popup",
    Open: false,
    Rect: [529, 400, 709, 500],
    Parent: noteRef,
  });
  const notePopupRef = ctx.register(notePopup);
  note.set(PDFName.of("Popup"), notePopupRef);

  const annots = doc.context.obj([hlRef, hlPopupRef, replyRef, noteRef, notePopupRef]);
  page0.node.set(PDFName.of("Annots"), annots);
}

// Page 2 — rotated, to show rotation ops
page = doc.addPage([595, 842]);
page.setRotation(degrees(90));
page.drawText("Page 2 — I am rotated 90 degrees", { x: 50, y: 780, size: 20, font: bold });
page.drawText("Select me, then run 'df: Rotate Page' to spin me back.", { x: 50, y: 745, size: 12, font });

// Page 3 — landscape form fields
page = doc.addPage([842, 595]);
page.drawText("Page 3 — fillable form", { x: 50, y: 540, size: 20, font: bold });
const form = doc.getForm();
const nameField = form.createTextField("form.name");
nameField.setText("Jane Doe");
nameField.addToPage(page, { x: 160, y: 480, width: 300, height: 24 });
form.createTextField("form.email").addToPage(page, { x: 160, y: 440, width: 300, height: 24 });
form.createCheckBox("form.agree").addToPage(page, { x: 160, y: 400, width: 20, height: 20 });
const roleField = form.createDropdown("form.role");
roleField.setOptions(["Editor", "Reviewer", "Viewer"]);
roleField.addToPage(page, { x: 160, y: 360, width: 200, height: 24 });
page.drawText("Name:", { x: 60, y: 486, size: 12, font });
page.drawText("Email:", { x: 60, y: 446, size: 12, font });
page.drawText("I agree:", { x: 60, y: 404, size: 12, font });
page.drawText("Role:", { x: 60, y: 366, size: 12, font });

writeFileSync("examples/example.pdf", await doc.save({ useObjectStreams: false }));
console.log("examples/example.pdf written");
