import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("./__mocks__/vscode"));

import { Uri } from "vscode";
import { SaveQueue, toBytes } from "../src/save";
import { writtenFiles } from "./__mocks__/vscode";
import type { WebviewCollection } from "../src/webviews";
import type { PdfDocument } from "../src/document";

function fakeCollection(): { webviews: WebviewCollection; posted: unknown[] } {
  const posted: unknown[] = [];
  const webviews = {
    postMessage: (_uri: Uri, message: unknown) => posted.push(message),
  } as unknown as WebviewCollection;
  return { webviews, posted };
}

function fakeDocument(path = "/data/doc.pdf"): PdfDocument {
  const document = { uri: Uri.file(path), markSaved: vi.fn() } as unknown as PdfDocument;
  return document;
}

beforeEach(() => {
  vi.clearAllMocks();
  writtenFiles.clear();
});

describe("toBytes", () => {
  test("normalizes Uint8Array, ArrayBuffer and junk", () => {
    const bytes = new Uint8Array([1, 2]);
    expect(toBytes(bytes)).toBe(bytes);
    expect(toBytes(bytes.buffer.slice(0))).toEqual(bytes);
    expect(toBytes("nope")).toBeUndefined();
    expect(toBytes(undefined)).toBeUndefined();
  });
});

describe("SaveQueue", () => {
  test("request posts request-save and resolves with bytes", async () => {
    const { webviews, posted } = fakeCollection();
    const queue = new SaveQueue(webviews);
    const document = fakeDocument();
    const pending = queue.request(document);
    expect(posted).toContainEqual({ type: "request-save" });
    expect(queue.isPending(document.uri)).toBe(true);
    queue.resolve(document.uri, new Uint8Array([7]));
    expect(await pending).toEqual(new Uint8Array([7]));
    expect(queue.isPending(document.uri)).toBe(false);
  });

  test("resolve without a pending request is a no-op", () => {
    const { webviews } = fakeCollection();
    const queue = new SaveQueue(webviews);
    expect(() => queue.resolve(Uri.file("/x.pdf"), new Uint8Array())).not.toThrow();
  });

  test("save writes the returned bytes and marks the document saved", async () => {
    const { webviews } = fakeCollection();
    const queue = new SaveQueue(webviews);
    const document = fakeDocument();
    const saving = queue.save(document);
    queue.resolve(document.uri, new Uint8Array([3, 4]));
    await saving;
    expect(writtenFiles.get("file:///data/doc.pdf")).toEqual(new Uint8Array([3, 4]));
    expect(document.markSaved).toHaveBeenCalled();
  });

  test("save with a destination writes there", async () => {
    const { webviews } = fakeCollection();
    const queue = new SaveQueue(webviews);
    const document = fakeDocument();
    const saving = queue.save(document, Uri.file("/data/other.pdf"));
    queue.resolve(document.uri, new Uint8Array([5]));
    await saving;
    expect(writtenFiles.get("file:///data/other.pdf")).toEqual(new Uint8Array([5]));
  });

  test("save rejects when the webview never responds", async () => {
    vi.useFakeTimers();
    try {
      const { webviews } = fakeCollection();
      const queue = new SaveQueue(webviews);
      const document = fakeDocument();
      const settled = queue.save(document).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await settled;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("Timed out while saving");
    } finally {
      vi.useRealTimers();
    }
  });
});
