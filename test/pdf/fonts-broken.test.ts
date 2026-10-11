import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { expect, test, vi } from "vitest";

// As if fontkit choked on every bundled font: text boxes fall back instead of failing the save.
vi.mock("../../src/pdf/fonts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/pdf/fonts")>()), faceWorks: async () => false }));

const { mergeAnnotations } = await import("../../src/pdf/write");
const { parsePdf } = await import("../../src/pdf/read");

test("a text box whose font fontkit cannot handle is drawn in the standard font of its kind, keeping its family", async () => {
  const blank = await PDFDocument.create();
  blank.addPage([300, 300]);
  const box = { id: "t", kind: "freetext", subtype: "FreeText", page: 0, rect: [10, 10, 200, 40], opacity: 1, contents: "Serif text", author: "", font: { family: "Lora", size: 12 } } as const;
  const bytes = await mergeAnnotations(await blank.save(), [box]);
  const doc = await PDFDocument.load(bytes);
  const fonts = doc.context.enumerateIndirectObjects().flatMap(([, o]) => (o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("Font") ? [o.lookup(PDFName.of("BaseFont"))!.toString()] : []));
  expect(fonts).toEqual(["/Times-Roman"]);
  expect((await parsePdf(bytes)).annotations[0]!.font).toEqual({ family: "Lora", size: 12 });
});
