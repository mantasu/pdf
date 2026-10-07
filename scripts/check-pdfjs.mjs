// Asserts the invariants our extension relies on in the vendored pdf.js.
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dirname);
const read = (path) => readFileSync(join(root, path), "utf8");

const required = [
  "resources/pdf.js/build/pdf.mjs",
  "resources/pdf.js/build/pdf.sandbox.mjs",
  "resources/pdf.js/build/pdf.worker.mjs",
  "resources/pdf.js/web/viewer.html",
  "resources/pdf.js/web/viewer.mjs",
  "resources/pdf.js/web/viewer.css",
  "resources/pdf.js/web/cmaps/LICENSE",
  "resources/pdf.js/web/iccs/LICENSE",
  "resources/pdf.js/web/standard_fonts/LICENSE_FOXIT",
  "resources/pdf.js/web/wasm/LICENSE_PDFJS_JBIG2",
  "resources/pdf.js/web/locale/locale.json",
];
for (const file of required) {
  assert.ok(existsSync(join(root, file)), `Missing ${file}. Run 'make pdfjs'.`);
}

const viewerHtml = read("resources/pdf.js/web/viewer.html");
const viewerJs = read("resources/pdf.js/web/viewer.mjs");

// The download script must have stripped the upstream CSP.
assert.equal(viewerHtml.match(/Content-Security-Policy/giu)?.length ?? 0, 0);

// Our bootstrap imports these from the viewer module.
assert.ok(
  viewerJs.includes("export { PDFViewerApplication"),
  "viewer.mjs must export PDFViewerApplication",
);
assert.ok(
  viewerJs.includes("AppOptions as PDFViewerApplicationOptions"),
  "viewer.mjs must export PDFViewerApplicationOptions",
);
assert.ok(
  viewerJs.includes("window.PDFViewerApplication = PDFViewerApplication"),
  "viewer.mjs must expose window.PDFViewerApplication",
);

// Editing UI (highlight, ink, free text, signature, stamp, undo bar).
for (const id of [
  "editorHighlightButton",
  "editorInkButton",
  "editorFreeTextButton",
  "editorSignatureButton",
  "editorStampButton",
  "editorUndoBar",
]) {
  assert.ok(viewerHtml.includes(`id="${id}"`), `Missing editor UI element: ${id}`);
}

// The save hook we override relies on pdfDocument.saveDocument existing.
assert.ok(existsSync(join(root, "resources/pdf.js/build/pdf.mjs")));
assert.ok(read("resources/pdf.js/build/pdf.mjs").includes("saveDocument()"));

// The df patches (scripts/patch-pdfjs.mjs) must be applied: author (/T),
// sidebar author names, sticky notes and /IRT replies rely on them.
const patched = [
  ["resources/pdf.js/build/pdf.mjs", "async dfShowComments()"],
  ["resources/pdf.js/build/pdf.mjs", "dfId: this.id"],
  ["resources/pdf.js/build/pdf.mjs", "FREETEXT_FONT_FAMILY: 14"],
  ["resources/pdf.js/web/viewer.mjs", "dfCommentAuthor"],
  ["resources/pdf.js/web/viewer.mjs", "dfCommentReplies"],
  ["resources/pdf.js/web/viewer.mjs", "editorFreeTextFontFamily"],
  ["resources/pdf.js/web/viewer.html", "editorFreeTextFontFamily"],
  ["resources/pdf.js/build/pdf.worker.mjs", "static createNewDict(annotation, xref, params)"],
  ["resources/pdf.js/build/pdf.worker.mjs", "case 1001:"],
  ["resources/pdf.js/build/pdf.worker.mjs", "dfFontKey"],
];
for (const [file, marker] of patched) {
  assert.ok(read(file).includes(marker), `pdf.js patch missing in ${file}: ${marker}. Run 'node scripts/patch-pdfjs.mjs'.`);
}

console.log("pdf.js invariants OK");
