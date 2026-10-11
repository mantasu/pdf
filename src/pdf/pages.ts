import { PDFDocument, degrees } from "pdf-lib";

/** Page operations run in the host with pdf-lib: take the full PDF, return modified bytes (undefined = no-op). */
export type PageAction = "rotate" | "delete" | "move-up" | "move-down" | "insert-before" | "insert-after";

export const ACTION_LABELS: Readonly<Record<PageAction, string>> = {
  rotate: "Rotate Page",
  delete: "Delete Page",
  "move-up": "Move Page Up",
  "move-down": "Move Page Down",
  "insert-before": "Insert Blank Page",
  "insert-after": "Insert Blank Page",
};

const open = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });

function inRange(page: number, count: number): void {
  if (!Number.isInteger(page) || page < 1 || page > count) {
    throw new Error(`Page ${page} is out of range (document has ${count} page(s)).`);
  }
}

export async function rotatePage(bytes: Uint8Array, page: number, clockwise = true): Promise<Uint8Array> {
  const doc = await open(bytes);
  inRange(page, doc.getPageCount());
  const target = doc.getPage(page - 1);
  target.setRotation(degrees((target.getRotation().angle + (clockwise ? 90 : 270)) % 360));
  return doc.save();
}

export async function deletePage(bytes: Uint8Array, page: number): Promise<Uint8Array> {
  const doc = await open(bytes);
  inRange(page, doc.getPageCount());
  if (doc.getPageCount() === 1) {
    throw new Error("Cannot delete the only page of a PDF.");
  }
  doc.removePage(page - 1);
  return doc.save();
}

/** Shift a page by `offset`; the page object (and its annotations) is kept as is. */
export async function shiftPage(bytes: Uint8Array, page: number, offset: number): Promise<Uint8Array | undefined> {
  const doc = await open(bytes);
  const count = doc.getPageCount();
  inRange(page, count);
  const to = page - 1 + offset;
  if (offset === 0 || to < 0 || to >= count) {
    return undefined;
  }
  const moved = doc.getPage(page - 1);
  doc.removePage(page - 1);
  doc.insertPage(to, moved);
  return doc.save();
}

export async function blankPage(bytes: Uint8Array, page: number, position: "before" | "after"): Promise<Uint8Array> {
  const doc = await open(bytes);
  inRange(page, doc.getPageCount());
  const { width, height } = doc.getPage(page - 1).getSize();
  doc.insertPage(position === "before" ? page - 1 : page, [width, height]);
  return doc.save();
}

export function perform(action: PageAction, bytes: Uint8Array, page: number): Promise<Uint8Array | undefined> {
  switch (action) {
    case "rotate":
      return rotatePage(bytes, page);
    case "delete":
      return deletePage(bytes, page);
    case "move-up":
      return shiftPage(bytes, page, -1);
    case "move-down":
      return shiftPage(bytes, page, 1);
    case "insert-before":
      return blankPage(bytes, page, "before");
    case "insert-after":
      return blankPage(bytes, page, "after");
  }
}

/** The page to show after an operation on `page` (1-based). */
export function pageAfter(action: PageAction, page: number): number {
  switch (action) {
    case "move-up":
      return Math.max(1, page - 1);
    case "move-down":
    case "insert-after":
      return page + 1;
    default:
      return page;
  }
}
