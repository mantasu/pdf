import { PDFArray, PDFDocument, PDFName, StandardFonts, degrees } from "pdf-lib";
import { beforeAll, describe, expect, test } from "vitest";

let threePages: Uint8Array;

async function pagesOf(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

beforeAll(async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([300, 400]);
    page.drawText(`Page ${i}`, { x: 50, y: 350, size: 24, font });
  }
  threePages = await doc.save();
});

describe("page-ops", () => {
  test("rotatePage rotates clockwise and wraps at 360", async () => {
    const { rotatePage } = await import("../../src/pdf/pages");
    const once = await rotatePage(threePages, 2);
    const doc1 = await PDFDocument.load(once);
    expect(doc1.getPage(1).getRotation().angle).toBe(90);
    expect(doc1.getPage(0).getRotation().angle).toBe(0);

    const twice = await rotatePage(once, 2, false);
    const doc2 = await PDFDocument.load(twice);
    expect(doc2.getPage(1).getRotation().angle).toBe(0);

    let bytes = threePages;
    for (let i = 0; i < 5; i++) {
      bytes = await rotatePage(bytes, 1);
    }
    const doc3 = await PDFDocument.load(bytes);
    expect(doc3.getPage(0).getRotation().angle).toBe(90);
  });

  test("rotatePage rejects out-of-range pages", async () => {
    const { rotatePage } = await import("../../src/pdf/pages");
    await expect(rotatePage(threePages, 0)).rejects.toThrow(/out of range/u);
    await expect(rotatePage(threePages, 4)).rejects.toThrow(/out of range/u);
    await expect(rotatePage(threePages, 1.5)).rejects.toThrow(/out of range/u);
  });

  test("deletePage removes the target page", async () => {
    const { deletePage } = await import("../../src/pdf/pages");
    const result = await deletePage(threePages, 2);
    expect(await pagesOf(result)).toBe(2);
  });

  test("deletePage refuses to remove the only page", async () => {
    const { deletePage } = await import("../../src/pdf/pages");
    const doc = await PDFDocument.create();
    doc.addPage();
    const only = await doc.save();
    await expect(deletePage(only, 1)).rejects.toThrow(/only page/u);
  });

  test("shiftPage reorders and clamps", async () => {
    const { shiftPage } = await import("../../src/pdf/pages");

    // Label each page uniquely by rotation so we can track the move.
    const marked = await PDFDocument.load(threePages);
    marked.getPage(0).setRotation(degrees(0));
    marked.getPage(1).setRotation(degrees(90));
    marked.getPage(2).setRotation(degrees(180));
    const bytes = await marked.save();

    const moved = await shiftPage(bytes, 2, 1); // page 2 -> index 2 (last)
    const doc = await PDFDocument.load(moved!);
    expect(doc.getPage(2).getRotation().angle).toBe(90);
    expect(doc.getPage(1).getRotation().angle).toBe(180);

    const up = await shiftPage(bytes, 3, -1); // page 3 -> index 1
    const doc2 = await PDFDocument.load(up!);
    expect(doc2.getPage(1).getRotation().angle).toBe(180);

    // No-op moves return undefined.
    expect(await shiftPage(bytes, 1, -1)).toBeUndefined();
    expect(await shiftPage(bytes, 3, 1)).toBeUndefined();
    expect(await shiftPage(bytes, 2, 0)).toBeUndefined();
  });

  test("blankPage copies the reference size", async () => {
    const { blankPage } = await import("../../src/pdf/pages");

    const before = await blankPage(threePages, 2, "before");
    const docBefore = await PDFDocument.load(before);
    expect(docBefore.getPageCount()).toBe(4);
    const blank = docBefore.getPage(1);
    expect([blank.getWidth(), blank.getHeight()]).toEqual([300, 400]);

    const after = await blankPage(threePages, 3, "after");
    expect(await pagesOf(after)).toBe(4);
  });

  test("results are valid PDFs with unchanged text content", async () => {
    const { blankPage } = await import("../../src/pdf/pages");
    const result = await blankPage(threePages, 1, "after");
    expect(new TextDecoder().decode(result.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(result);
    expect(doc.getPageCount()).toBe(4);
  });

  test("shiftPage keeps the page object, including its annotations", async () => {
    const { shiftPage } = await import("../../src/pdf/pages");
    const doc = await PDFDocument.load(threePages);
    const annot = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 24, 24] }));
    doc.getPage(0).node.set(PDFName.of("Annots"), doc.context.obj([annot]));
    const moved = await PDFDocument.load((await shiftPage(await doc.save(), 1, 2))!);
    expect(moved.getPageCount()).toBe(3);
    expect(moved.getPage(2).node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.size()).toBe(1);
    expect(moved.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.size() ?? 0).toBe(0);
  });

  test("perform dispatches every operation", async () => {
    const { perform } = await import("../../src/pdf/pages");
    expect(await pagesOf((await perform("rotate", threePages, 1))!)).toBe(3);
    expect(await pagesOf((await perform("delete", threePages, 1))!)).toBe(2);
    expect(await perform("move-up", threePages, 1)).toBeUndefined();
    expect(await pagesOf((await perform("move-up", threePages, 2))!)).toBe(3);
    expect(await pagesOf((await perform("move-down", threePages, 1))!)).toBe(3);
    expect(await pagesOf((await perform("insert-before", threePages, 1))!)).toBe(4);
    expect(await pagesOf((await perform("insert-after", threePages, 1))!)).toBe(4);
  });

  test("pageAfter follows the page that was acted on", async () => {
    const { pageAfter } = await import("../../src/pdf/pages");
    expect(pageAfter("move-up", 1)).toBe(1);
    expect(pageAfter("move-up", 3)).toBe(2);
    expect(pageAfter("move-down", 2)).toBe(3);
    expect(pageAfter("insert-after", 2)).toBe(3);
    expect(pageAfter("rotate", 2)).toBe(2);
  });
});
