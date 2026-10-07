import { PDFDocument as PdfLibDocument, degrees } from "pdf-lib";

/**
 * Page-level operations performed in the extension host with pdf-lib.
 * Each function takes the current file bytes and returns modified bytes;
 * writing to disk and refreshing the viewer is the caller's job.
 */

async function load(bytes: Uint8Array): Promise<PdfLibDocument> {
  return PdfLibDocument.load(bytes, { ignoreEncryption: true });
}

export async function rotatePage(
  bytes: Uint8Array,
  page: number,
  clockwise = true,
): Promise<Uint8Array> {
  const doc = await load(bytes);
  const count = doc.getPageCount();
  assertPage(page, count);
  const target = doc.getPage(page - 1);
  const current = target.getRotation().angle;
  target.setRotation(degrees((current + (clockwise ? 90 : -90) + 360) % 360));
  return doc.save();
}

export async function deletePage(bytes: Uint8Array, page: number): Promise<Uint8Array> {
  const doc = await load(bytes);
  assertPage(page, doc.getPageCount());
  if (doc.getPageCount() === 1) {
    throw new Error("Cannot delete the only page of a PDF.");
  }
  doc.removePage(page - 1);
  return doc.save();
}

/** Move the given page by `offset` (negative = earlier). Returns undefined for no-ops. */
export async function movePage(
  bytes: Uint8Array,
  page: number,
  offset: number,
): Promise<Uint8Array | undefined> {
  const doc = await load(bytes);
  const count = doc.getPageCount();
  assertPage(page, count);
  const target = page - 1 + offset;
  if (target < 0 || target >= count || offset === 0) {
    return undefined;
  }
  const [copied] = await doc.copyPages(doc, [page - 1]);
  doc.removePage(page - 1);
  doc.insertPage(target, copied);
  return doc.save();
}

export async function insertBlankPage(
  bytes: Uint8Array,
  page: number,
  position: "before" | "after",
): Promise<Uint8Array> {
  const doc = await load(bytes);
  assertPage(page, doc.getPageCount());
  const reference = doc.getPage(page - 1);
  const { width, height } = reference.getSize();
  doc.insertPage(position === "before" ? page - 1 : page, [width, height]);
  return doc.save();
}

function assertPage(page: number, count: number): void {
  if (!Number.isInteger(page) || page < 1 || page > count) {
    throw new Error(`Page ${page} is out of range (document has ${count} page(s)).`);
  }
}
