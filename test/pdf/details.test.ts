import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from "pdf-lib";
import { describe, expect, test, vi } from "vitest";
import type { Annot } from "../../src/pdf/model";
import { toPdfDate, fromPdfDate } from "../../src/pdf/date";
import { readColor, readLists, readNumbers, readBox, readText, refOfId, stringObject } from "../../src/pdf/objects";
import { ownershipOf, parsePdf, stateOf } from "../../src/pdf/read";
import { popupRectFor, mergeAnnotations } from "../../src/pdf/write";

const QUAD = [10, 30, 110, 30, 10, 18, 110, 18];

async function dictWith(entries: Record<string, unknown>): Promise<PDFDict> {
  const doc = await PDFDocument.create();
  return doc.context.obj(entries as never) as PDFDict;
}

async function onePage(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  return doc;
}

describe("PDF dates", () => {
  test("parses full, partial, offset and malformed dates", () => {
    expect(fromPdfDate("D:20190413223625+02'00'")).toBe("2019-04-13T20:36:25.000Z");
    expect(fromPdfDate("D:20190413223625-05'30")).toBe("2019-04-14T04:06:25.000Z");
    expect(fromPdfDate("D:20190413223625Z")).toBe("2019-04-13T22:36:25.000Z");
    expect(fromPdfDate("2019")).toBe("2019-01-01T00:00:00.000Z");
    expect(fromPdfDate("yesterday")).toBeUndefined();
    expect(fromPdfDate(undefined)).toBeUndefined();
  });

  test("formats east, west and UTC offsets", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const spy = vi.spyOn(Date.prototype, "getTimezoneOffset");
    spy.mockReturnValue(-330);
    expect(toPdfDate(date)).toMatch(/\+05'30'$/u);
    spy.mockReturnValue(300);
    expect(toPdfDate(date)).toMatch(/-05'00'$/u);
    spy.mockReturnValue(0);
    expect(toPdfDate(date)).toMatch(/Z$/u);
    spy.mockRestore();
  });

  test("formats local time with the UTC offset and round-trips", () => {
    const date = new Date("2026-10-07T12:34:56Z");
    const formatted = toPdfDate(date);
    expect(formatted).toMatch(/^D:\d{14}(Z|[+-]\d{2}'\d{2}')$/u);
    expect(fromPdfDate(formatted)).toBe(date.toISOString());
  });
});

describe("PDF object helpers", () => {
  test("colors: gray, RGB, CMYK and transparent", async () => {
    expect(readColor(await dictWith({ C: [0.5] }))).toEqual([0.5, 0.5, 0.5]);
    expect(readColor(await dictWith({ C: [2, -1, 0.5] }))).toEqual([1, 0, 0.5]);
    expect(readColor(await dictWith({ C: [0, 1, 1, 0] }))).toEqual([1, 0, 0]);
    expect(readColor(await dictWith({ C: [] }))).toBeUndefined();
    expect(readColor(await dictWith({}))).toBeUndefined();
  });

  test("number lists accept only arrays of number arrays", async () => {
    expect(readLists(await dictWith({ L: [[1, 2], [3]] }), "L")).toEqual([[1, 2], [3]]);
    expect(readLists(await dictWith({ L: 5 }), "L")).toBeUndefined();
    expect(readLists(await dictWith({ L: [5] }), "L")).toBeUndefined();
    expect(readLists(await dictWith({ L: [["x"]] }), "L")).toBeUndefined();
  });

  test("numbers, rects and text accept only well-formed values", async () => {
    expect(readNumbers(await dictWith({ X: [1, "Name"] }), "X")).toBeUndefined();
    expect(readNumbers(await dictWith({ X: 5 }), "X")).toBeUndefined();
    expect(readBox(await dictWith({ Rect: [1, 2, 3] }))).toBeUndefined();
    expect(readBox(await dictWith({ Rect: [30, 40, 10, 20] }))).toEqual([10, 20, 30, 40]);
    expect(readText(await dictWith({ State: "Accepted" }), "State")).toBe("Accepted");
    expect(readText(await dictWith({ State: 3 }), "State")).toBeUndefined();
  });

  test("text strings: ASCII literals with escapes, Unicode as UTF-16", () => {
    expect(stringObject("a(b)\\c\r\n\t")).toBeInstanceOf(PDFString);
    expect((stringObject("a(b)\\c") as PDFString).asString()).toBe("a\\(b\\)\\\\c");
    expect(stringObject("Grüße ✓")).toBeInstanceOf(PDFHexString);
    expect((stringObject("Grüße ✓") as PDFHexString).decodeText()).toBe("Grüße ✓");
  });

  test("references", () => {
    expect(refOfId("12 0")).toEqual(PDFRef.of(12, 0));
    expect(refOfId("x")).toBeUndefined();
    expect(refOfId(undefined)).toBeUndefined();
  });

  test("classification", async () => {
    expect(ownershipOf(await dictWith({ Subtype: "Popup" })).role).toBe("popup");
    expect(ownershipOf(await dictWith({})).role).toBe("ignored");
    expect(ownershipOf(await dictWith({ Subtype: "Highlight", RT: "Group" })).role).toBe("ignored");
    expect(ownershipOf(await dictWith({ Subtype: "Text", F: 2 })).role).toBe("ignored");
    expect(ownershipOf(await dictWith({ Subtype: "Polygon" })).role).toBe("other");
    expect(ownershipOf(await dictWith({ Subtype: "Link" })).role).toBe("ignored");
    expect(ownershipOf(await dictWith({ Subtype: "Underline" }))).toEqual({ role: "managed", kind: "underline", subtype: "Underline" });
  });
});

describe("reading edge cases", () => {
  test("review and marked states", async () => {
    expect(stateOf(await dictWith({}))).toBeUndefined();
    expect(stateOf(await dictWith({ State: PDFString.of("Marked") }))).toEqual({ model: "Marked", value: "Marked" });
    expect(stateOf(await dictWith({ State: PDFString.of("Rejected") }))).toEqual({ model: "Review", value: "Rejected" });
    expect(stateOf(await dictWith({ State: PDFString.of("Bogus"), StateModel: PDFString.of("Review") }))).toBeUndefined();
    expect(stateOf(await dictWith({ State: PDFString.of("Accepted"), StateModel: PDFString.of("Marked") }))).toBeUndefined();
  });

  test("direct dictionaries, missing quads, bad rects, orphan states and duplicate names", async () => {
    const doc = await onePage();
    const ctx = doc.context;
    const direct = ctx.obj({ Type: "Annot", Subtype: "Underline", Rect: [10, 10, 60, 20], NM: PDFString.of("dup") });
    const broken = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [1, 2] }));
    const twin = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 24, 24], NM: PDFString.of("dup") }));
    const orphanState = ctx.register(
      ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 24, 24], F: 30, State: PDFString.of("Accepted"), IRT: broken }),
    );
    doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([direct, broken, twin, orphanState, PDFNumber.of(3)]));
    const generated = ["g1", "g2", "g3"];
    const { annotations, viewBytes } = await parsePdf(await doc.save(), () => generated.shift()!);
    expect(annotations.map((a) => [a.id, a.kind, a.ref === undefined, a.replyTo])).toEqual([
      ["dup", "underline", true, undefined],
      ["g1", "note", false, undefined],
      ["g2", "note", false, undefined],
    ]);
    expect(annotations[0]!.quads).toEqual([10, 20, 60, 20, 10, 10, 60, 10]);
    const view = await PDFDocument.load(viewBytes);
    expect(view.getPage(0).node.lookup(PDFName.of("Annots"))?.toString()).toBe("[ 3 ]");
  });

  test("encrypted files are read-only", async () => {
    const doc = await onePage();
    doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: "Standard", V: 1, R: 2 });
    const bytes = await doc.save();
    const result = await parsePdf(bytes);
    expect(result.readOnly).toMatch(/encrypted/u);
    expect(result.viewBytes).toBe(bytes);
  });
});

describe("writing edge cases", () => {
  const base: Omit<Annot, "id" | "kind" | "subtype"> = {
    page: 0,
    rect: [10, 18, 110, 30],
    opacity: 1,
    contents: "",
    author: "",
  };

  test("matches stored annotations by /NM when the reference is stale", async () => {
    const doc = await onePage();
    const ctx = doc.context;
    const highlight = ctx.register(
      ctx.obj({ Type: "Annot", Subtype: "Highlight", Rect: base.rect, QuadPoints: QUAD, NM: PDFString.of("h1"), C: [1, 1, 0] }),
    );
    doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([highlight]));
    const source = await doc.save();
    const model: Annot[] = [
      { ...base, id: "h1", ref: "999 0", kind: "highlight", subtype: "Highlight", quads: QUAD, color: [0, 1, 0], contents: "green" },
    ];
    const out = await PDFDocument.load(await mergeAnnotations(source, model));
    // Same object, now with an Acrobat-style pop-up.
    const annots = out.getPage(0).node.lookup(PDFName.of("Annots"))!.toString();
    expect(annots).toMatch(new RegExp(`^\\[ ${highlight.toString()} \\d+ 0 R \\]$`, "u"));
    const dict = out.context.lookup(highlight) as PDFDict;
    expect(dict.lookup(PDFName.of("C"))?.toString()).toBe("[ 0 1 0 ]");
  });

  test("a changed kind replaces the stored annotation", async () => {
    const doc = await onePage();
    const ctx = doc.context;
    const highlight = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Highlight", Rect: base.rect, QuadPoints: QUAD }));
    doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([highlight]));
    const model: Annot[] = [
      { ...base, id: "x", ref: `${highlight.objectNumber} 0`, kind: "strikeout", subtype: "StrikeOut", quads: QUAD },
    ];
    const { annotations } = await parsePdf(await mergeAnnotations(await doc.save(), model));
    expect(annotations.map((a) => a.kind)).toEqual(["strikeout"]);
  });

  test("updates moved notes, their pop-up, state removal and authorless text", async () => {
    const doc = await onePage();
    const ctx = doc.context;
    const note = ctx.register(
      ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [10, 10, 34, 34], T: PDFString.of("x"), State: PDFString.of("None"), Open: true }),
    );
    const popup = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Popup", Rect: [100, 100, 304, 214], Parent: note }));
    (ctx.lookup(note) as PDFDict).set(PDFName.of("Popup"), popup);
    doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([note, popup]));
    const source = await doc.save();
    const [read] = (await parsePdf(source)).annotations;
    // A visible note keeps its odd /State instead of being dropped.
    expect(read!.state).toEqual({ model: "Review", value: "None" });
    const moved: Annot = {
      ...read!,
      rect: [50, 50, 74, 74],
      author: "",
      state: undefined,
      popup: { rect: [0, 0, 204, 114], open: true },
    };
    const out = await PDFDocument.load(await mergeAnnotations(source, [moved]));
    const dict = out.context.lookup(note) as PDFDict;
    expect(dict.has(PDFName.of("T"))).toBe(false);
    expect(dict.has(PDFName.of("State"))).toBe(false);
    expect(dict.lookup(PDFName.of("Open"))?.toString()).toBe("true");
    const popupDict = out.context.lookup(popup) as PDFDict;
    expect(popupDict.lookup(PDFName.of("Rect"))?.toString()).toBe("[ 0 0 204 114 ]");
    expect(popupDict.lookup(PDFName.of("Open"))?.toString()).toBe("true");
  });

  test("other annotations keep everything but their text, and stay untouched when unchanged", async () => {
    const doc = await onePage();
    const ctx = doc.context;
    const ink = ctx.register(
      ctx.obj({ Type: "Annot", Subtype: "Polygon", Rect: [0, 0, 50, 50], Contents: PDFString.of("a\rb"), RC: PDFString.of("<p/>") }),
    );
    doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([ink]));
    const source = await doc.save();
    const { annotations } = await parsePdf(source);
    let out = await PDFDocument.load(await mergeAnnotations(source, annotations));
    expect((out.context.lookup(ink) as PDFDict).has(PDFName.of("RC"))).toBe(true);
    out = await PDFDocument.load(await mergeAnnotations(source, [{ ...annotations[0]!, author: "new author" }]));
    const dict = out.context.lookup(ink) as PDFDict;
    expect(dict.has(PDFName.of("RC"))).toBe(true);
    expect(readText(dict, "T")).toBe("new author");
  });

  test("default pop-up sits at the page's right edge", async () => {
    const doc = await onePage();
    expect(popupRectFor(doc.getPage(0), [10, 300, 34, 324])).toEqual([96, 210, 300, 324]);
    expect(popupRectFor(doc.getPage(0), [10, 10, 34, 34])).toEqual([96, 0, 300, 114]);
  });

  test("tolerates malformed entries: non-dicts, foreign refs, missing rects/AP, direct others", async () => {
    const doc = await onePage();
    const ctx = doc.context;
    // A dangling reference, as found in damaged files.
    const link = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 5, 5], P: PDFRef.of(9999, 0) }));
    const noRect = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", NM: PDFString.of("norect") }));
    const directInk = ctx.obj({ Type: "Annot", Subtype: "Polygon", Rect: [0, 0, 9, 9] });
    // Unlinked managed annotation without an appearance: garbage-collected.
    const orphan = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Highlight", Rect: [0, 0, 1, 1], AP: { N: ctx.obj({}) } }));
    const orphanStream = ctx.register(ctx.stream("0 0 m", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1] }));
    const orphanWithAp = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 1, 1], AP: { N: orphanStream } }));
    const unlinkedLink = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 1, 1] }));
    const noteWithBadPopup = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [10, 10, 34, 34] }));
    const badPopup = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Popup", Parent: noteWithBadPopup }));
    (ctx.lookup(noteWithBadPopup) as PDFDict).set(PDFName.of("Popup"), badPopup);
    doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([PDFNumber.of(1), link, directInk, noteWithBadPopup, badPopup]));
    const source = await doc.save();
    const model: Annot[] = [
      { ...base, id: "on-link", ref: `${link.objectNumber} 0`, kind: "note", subtype: "Text", rect: [0, 0, 24, 24] },
      { ...base, id: "norect", ref: `${noRect.objectNumber} 0`, kind: "note", subtype: "Text", rect: [40, 40, 64, 64] },
      { ...base, id: "ink", kind: "other", subtype: "Polygon", rect: [0, 0, 9, 9], contents: "no ref" },
      { ...base, id: "noquads", kind: "underline", subtype: "Underline" },
      { ...base, id: "bad-popup", ref: `${noteWithBadPopup.objectNumber} 0`, kind: "note", subtype: "Text", rect: [12, 12, 36, 36] },
    ];
    const out = await mergeAnnotations(source, model);
    const written = await PDFDocument.load(out);
    expect(written.context.lookup(orphan)).toBeUndefined();
    expect(written.context.lookup(orphanWithAp)).toBeUndefined();
    expect(written.context.lookup(orphanStream)).toBeUndefined();
    expect(written.context.lookup(unlinkedLink)).toBeUndefined(); // unreachable objects are garbage
    expect(written.context.lookup(PDFRef.of(link.objectNumber, 0))).toBeDefined();
    const popupRect = (written.context.lookup(badPopup) as PDFDict).lookup(PDFName.of("Rect"))?.toString();
    expect(popupRect).toBe("[ 96 0 300 114 ]");
    const reread = await parsePdf(out);
    expect(reread.annotations.filter((a) => a.kind === "note").map((a) => a.id).sort()).toEqual(["bad-popup", "norect", "on-link"]);
    expect(reread.annotations.find((a) => a.kind === "underline")!.quads).toEqual([10, 30, 110, 30, 10, 18, 110, 18]);
  });

  test("broken appearance streams are regenerated", async () => {
    const doc = await onePage();
    const ctx = doc.context;
    const empty = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 24, 24], NM: PDFString.of("e"), AP: {} }));
    const dangling = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 24, 24], NM: PDFString.of("d"), AP: { N: PDFRef.of(9999, 0) } }));
    doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([empty, dangling]));
    const source = await doc.save();
    const out = await PDFDocument.load(await mergeAnnotations(source, (await parsePdf(source)).annotations));
    for (const ref of [empty, dangling]) {
      const normal = (out.context.lookup(ref) as PDFDict).lookup(PDFName.of("AP"), PDFDict).get(PDFName.of("N"));
      expect(out.context.lookup(normal as PDFRef)).toBeDefined();
    }
  });

  test("garbage collection keeps appearance streams that are still shared", async () => {
    const doc = await onePage();
    const ctx = doc.context;
    const shared = ctx.register(ctx.stream("0 0 m", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 24, 24] }));
    const kept = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 24, 24], NM: PDFString.of("kept"), AP: { N: shared } }));
    const removed = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 24, 24], NM: PDFString.of("gone"), AP: { N: shared } }));
    doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([kept, removed]));
    const source = await doc.save();
    const { annotations } = await parsePdf(source);
    const out = await PDFDocument.load(await mergeAnnotations(source, annotations.filter((a) => a.id === "kept")));
    expect(out.context.lookup(removed)).toBeUndefined();
    expect(out.context.lookup(shared)).toBeDefined();
  });

  test("replies whose parent cannot be referenced are not written as notes", async () => {
    const doc = await onePage();
    const source = await doc.save();
    const out = await mergeAnnotations(source, [
      { ...base, id: "direct", kind: "other", subtype: "Polygon", rect: [0, 0, 9, 9] },
      { ...base, id: "reply", kind: "note", subtype: "Text", rect: [0, 0, 24, 24], replyTo: "direct", contents: "hi" },
    ]);
    expect((await parsePdf(out)).annotations).toEqual([]);
  });

  test("other annotations: text without contents, explicit modification dates", async () => {
    const doc = await onePage();
    const ctx = doc.context;
    const ink = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Polygon", Rect: [0, 0, 50, 50] }));
    doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([ink]));
    const source = await doc.save();
    const [read] = (await parsePdf(source)).annotations;
    const out = await PDFDocument.load(
      await mergeAnnotations(source, [{ ...read!, contents: "added", modified: "2026-01-02T03:04:05.000Z" }]),
    );
    const dict = out.context.lookup(ink) as PDFDict;
    expect(readText(dict, "Contents")).toBe("added");
    expect(readText(dict, "M")).toMatch(/^D:2026010/u);
  });
});
