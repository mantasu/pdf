import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode"));

import { Uri, files, resetMock, watchers } from "../__mocks__/vscode";
import { PdfFile, equalBytes } from "../../src/editor/document";
import type { Annot } from "../../src/pdf/model";

const uri = Uri.file("/docs/draft.pdf");

async function blankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return doc.save();
}

const sticky: Annot = {
  id: "n1",
  kind: "note",
  subtype: "Text",
  page: 0,
  rect: [10, 10, 34, 34],
  opacity: 1,
  contents: "hello",
  author: "me",
};

beforeEach(() => {
  resetMock();
});

describe("equalBytes", () => {
  test("compares content", () => {
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(equalBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe("PdfFile", () => {
  test("opens, watches its file and exposes the view", async () => {
    const bytes = await blankPdf();
    const document = await PdfFile.open(uri as never, bytes);
    expect(document.uri).toBe(uri);
    expect(document.state.working).toBe(bytes);
    expect(document.view()).toEqual({ data: bytes, annotations: [] });
    expect(document.dirty).toBe(false);
    expect(document.readOnly).toBeUndefined();
    expect(watchers).toHaveLength(1);
  });

  test("view falls back to the working bytes for unparsed states", async () => {
    const document = await PdfFile.open(uri as never, await blankPdf());
    const other = new Uint8Array([1]);
    expect(document.view({ working: other, annotations: [sticky] })).toEqual({ data: other, annotations: [sticky] });
  });

  test("dirty means 'not the state on disk', across undo branches and saves", async () => {
    const document = await PdfFile.open(uri as never, await blankPdf());
    const original = document.state;
    const edited = { ...original, annotations: [sticky] };
    document.setState(edited);
    expect(document.dirty).toBe(true);
    document.markSaved(edited);
    expect(document.dirty).toBe(false);
    document.setState(original); // undo past the save
    expect(document.dirty).toBe(true);
    document.setState({ ...original, annotations: [{ ...sticky, id: "other" }] }); // a different branch
    expect(document.dirty).toBe(true);
    document.setState(edited); // back to what was saved
    expect(document.dirty).toBe(false);
    document.replace(await document.parse(await blankPdf()));
    expect(document.dirty).toBe(false);
  });

  test("documents restored from a backup start dirty", async () => {
    const document = await PdfFile.open(uri as never, await blankPdf(), true);
    expect(document.dirty).toBe(true);
  });

  test("form data is shown and used as the base for saving", async () => {
    const document = await PdfFile.open(uri as never, await blankPdf());
    const formData = await blankPdf();
    document.setState({ ...document.state, formData });
    expect(document.view().data).toBe(formData);
    const built = await document.build({ annotations: [sticky] });
    expect((await document.parse(built)).annotations.map((a) => a.id)).toEqual(["n1"]);
  });

  test("parse caches per byte array", async () => {
    const document = await PdfFile.open(uri as never, await blankPdf());
    const bytes = await blankPdf();
    const first = await document.parse(bytes);
    const second = await document.parse(bytes);
    expect(second.annotations).toBe(first.annotations);
  });

  test("build merges comments into the working PDF or the form data", async () => {
    const document = await PdfFile.open(uri as never, await blankPdf());
    const built = await document.build({ annotations: [sticky] });
    const reread = await document.parse(built);
    expect(reread.annotations.map((a) => a.contents)).toEqual(["hello"]);
    const withForms = await document.build({ annotations: [], formData: await blankPdf() });
    expect((await document.parse(withForms)).annotations).toEqual([]);
  });

  test("read-only documents save pdf.js output or the original bytes", async () => {
    const broken = new TextEncoder().encode("not a pdf");
    const document = await PdfFile.open(uri as never, broken);
    expect(document.readOnly).toMatch(/could not be parsed/u);
    expect(document.view().readOnly).toBe(document.readOnly);
    expect(await document.build({ annotations: [sticky] })).toBe(broken);
    const formData = new Uint8Array([5]);
    expect(await document.build({ annotations: [], formData })).toBe(formData);
  });

  test("reports external changes but not its own writes", async () => {
    const original = await blankPdf();
    const document = await PdfFile.open(uri as never, original);
    const listener = vi.fn();
    document.onExternalChange(listener);
    const [watcher] = watchers;

    // Missing file: ignored.
    watcher!.fireChange(uri);
    await vi.waitFor(() => expect(files.size).toBe(0));

    // Same bytes as the working copy: ignored.
    files.set(uri.toString(), original);
    watcher!.fireChange(uri);

    // Our own save: ignored.
    const saved = new Uint8Array([1, 2, 3]);
    document.expectWrite(saved);
    files.set(uri.toString(), saved);
    watcher!.fireCreate(uri);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listener).not.toHaveBeenCalled();

    const external = new Uint8Array([9, 9]);
    files.set(uri.toString(), external);
    watcher!.fireChange(uri);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(external));
  });

  test("dispose releases the watcher", async () => {
    const document = await PdfFile.open(uri as never, await blankPdf());
    document.dispose();
    expect(watchers[0]!.dispose).toHaveBeenCalled();
  });
});
