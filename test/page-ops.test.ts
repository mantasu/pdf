import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
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
    const { rotatePage } = await import("../src/page-ops");
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
    const { rotatePage } = await import("../src/page-ops");
    await expect(rotatePage(threePages, 0)).rejects.toThrow(/out of range/u);
    await expect(rotatePage(threePages, 4)).rejects.toThrow(/out of range/u);
    await expect(rotatePage(threePages, 1.5)).rejects.toThrow(/out of range/u);
  });

  test("deletePage removes the target page", async () => {
    const { deletePage } = await import("../src/page-ops");
    const result = await deletePage(threePages, 2);
    expect(await pagesOf(result)).toBe(2);
  });

  test("deletePage refuses to remove the only page", async () => {
    const { deletePage } = await import("../src/page-ops");
    const doc = await PDFDocument.create();
    doc.addPage();
    const only = await doc.save();
    await expect(deletePage(only, 1)).rejects.toThrow(/only page/u);
  });

  test("movePage reorders and clamps", async () => {
    const { movePage } = await import("../src/page-ops");

    // Label each page uniquely by rotation so we can track the move.
    const marked = await PDFDocument.load(threePages);
    marked.getPage(0).setRotation(degrees(0));
    marked.getPage(1).setRotation(degrees(90));
    marked.getPage(2).setRotation(degrees(180));
    const bytes = await marked.save();

    const moved = await movePage(bytes, 2, 1); // page 2 -> index 2 (last)
    const doc = await PDFDocument.load(moved!);
    expect(doc.getPage(2).getRotation().angle).toBe(90);
    expect(doc.getPage(1).getRotation().angle).toBe(180);

    const up = await movePage(bytes, 3, -1); // page 3 -> index 1
    const doc2 = await PDFDocument.load(up!);
    expect(doc2.getPage(1).getRotation().angle).toBe(180);

    // No-op moves return undefined.
    expect(await movePage(bytes, 1, -1)).toBeUndefined();
    expect(await movePage(bytes, 3, 1)).toBeUndefined();
    expect(await movePage(bytes, 2, 0)).toBeUndefined();
  });

  test("insertBlankPage copies the reference size", async () => {
    const { insertBlankPage } = await import("../src/page-ops");

    const before = await insertBlankPage(threePages, 2, "before");
    const docBefore = await PDFDocument.load(before);
    expect(docBefore.getPageCount()).toBe(4);
    const blank = docBefore.getPage(1);
    expect([blank.getWidth(), blank.getHeight()]).toEqual([300, 400]);

    const after = await insertBlankPage(threePages, 3, "after");
    expect(await pagesOf(after)).toBe(4);
  });

  test("results are valid PDFs with unchanged text content", async () => {
    const { insertBlankPage } = await import("../src/page-ops");
    const result = await insertBlankPage(threePages, 1, "after");
    expect(new TextDecoder().decode(result.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(result);
    expect(doc.getPageCount()).toBe(4);
  });
});
