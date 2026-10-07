// Independent Acrobat-compatibility check: parses a saved PDF with pdf-lib
// (a different implementation from pdf.js) and verifies the comment
// annotations are spec-compliant and readable.
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray } from "pdf-lib";

const path = process.argv[2];
if (!path) {
  console.error("usage: node adobe-check.mjs <file.pdf>");
  process.exit(2);
}
const bytes = readFileSync(path);
const doc = await PDFDocument.load(bytes, { updateMetadata: false });
const failures = [];
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures.push(msg);
};

// Walk all annotations via the page /Annots arrays.
const annotsByPage = [];
const context = doc.context;
for (let i = 0; i < doc.getPageCount(); i++) {
  const page = doc.getPage(i);
  const annotsRef = page.node.get(PDFName.of("Annots"));
  const list = [];
  if (annotsRef) {
    const arr = context.lookup(annotsRef, PDFArray);
    if (arr) {
      for (let k = 0; k < arr.size(); k++) {
        const ref = arr.get(k);
        const dict = context.lookup(ref);
        if (dict instanceof PDFDict) {
          list.push({ ref, dict, page: i });
        }
      }
    }
  }
  annotsByPage.push(list);
}

const all = annotsByPage.flat();
console.log(`total annotations: ${all.length}`);

const notes = all.filter((a) => a.dict.get(PDFName.of("Subtype")) === PDFName.of("Text"));
const popups = all.filter((a) => a.dict.get(PDFName.of("Subtype")) === PDFName.of("Popup"));
const highlights = all.filter((a) => a.dict.get(PDFName.of("Subtype")) === PDFName.of("Highlight"));

console.log(`text notes: ${notes.length}, popups: ${popups.length}, highlights: ${highlights.length}`);

const decodeStr = (s) => {
  // PDF string object -> JS string (handles literal, hex, UTF-16BE BOM).
  const encoded = s.decodeText ? s.decodeText() : "";
  return encoded;
};

// 1. every sticky note has the required keys for Acrobat
for (const { dict } of notes) {
  const contents = dict.lookup(PDFName.of("Contents"));
  const author = dict.lookup(PDFName.of("T"));
  const name = dict.get(PDFName.of("Name"));
  const rect = dict.lookup(PDFName.of("Rect"), PDFArray);
  const irt = dict.get(PDFName.of("IRT"));
  ok(contents !== undefined, `note has /Contents: "${contents ? decodeStr(contents) : ""}"`);
  ok(author !== undefined, `note has /T author: "${author ? decodeStr(author) : ""}"`);
  ok(name === PDFName.of("Note"), "note has /Name /Note");
  ok(rect && rect.size() === 4, "note has a 4-number /Rect");
  if (irt) {
    ok(dict.get(PDFName.of("RT")) === PDFName.of("R"), "reply has /RT /R");
    const target = context.lookup(irt);
    ok(target instanceof PDFDict, "reply /IRT resolves to a real annotation dict");
  }
}

// 2. popup dicts point back at their parent annotation
const PARENTABLE = new Set([
  "Text", "Highlight", "Underline", "StrikeOut", "Squiggly", "Ink",
  "FreeText", "Square", "Circle", "Polygon", "PolyLine", "Stamp", "Caret", "FileAttachment",
]);
for (const { dict } of popups) {
  const parent = dict.lookup(PDFName.of("Parent"), PDFDict);
  ok(!!parent, "popup has /Parent");
  if (parent) {
    const parentSubtype = parent.get(PDFName.of("Subtype"));
    ok(
      parentSubtype !== undefined && PARENTABLE.has(parentSubtype.toString().replace(/^\//u, "")),
      "popup parent is an annotation that can own a popup",
    );
    // the note must reference this popup back
    const popupRefFound = all.some(
      ({ dict: noteDict }) =>
        noteDict.get(PDFName.of("Popup")) instanceof PDFRef &&
        context.lookup(noteDict.get(PDFName.of("Popup"))) === dict,
    );
    ok(popupRefFound, "note /Popup back-reference matches");
  }
}

// 3. resolved threads use the spec Reviewer state model
for (const { dict } of notes) {
  const state = dict.get(PDFName.of("State"));
  if (state === PDFName.of("Closed")) {
    ok(
      dict.get(PDFName.of("StateModel")) === PDFName.of("Review"),
      "resolved note uses /StateModel /Review",
    );
  }
}

// 4. highlights carry author + contents
for (const { dict } of highlights) {
  const author = dict.lookup(PDFName.of("T"));
  ok(author !== undefined, `highlight has /T author: "${author ? decodeStr(author) : ""}"`);
}

// 5. round-trip: re-save with pdf-lib and confirm annotations survive another parser
const resaved = await doc.save({ useObjectStreams: false });
const doc2 = await PDFDocument.load(resaved);
let notes2 = 0;
for (let i = 0; i < doc2.getPageCount(); i++) {
  const arr = doc2.context.lookup(doc2.getPage(i).node.get(PDFName.of("Annots")), PDFArray);
  if (arr) {
    for (let k = 0; k < arr.size(); k++) {
      const d = doc2.context.lookup(arr.get(k));
      if (d instanceof PDFDict && d.get(PDFName.of("Subtype")) === PDFName.of("Text")) notes2++;
    }
  }
}
ok(notes2 === notes.length, `annotations survive pdf-lib re-save (${notes.length} -> ${notes2})`);

console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} FAILURES`);
process.exit(failures.length === 0 ? 0 : 1);
