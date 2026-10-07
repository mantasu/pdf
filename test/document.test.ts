import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("./__mocks__/vscode"));

import { Uri } from "vscode";
import { PdfDocument } from "../src/document";
import { watchers } from "./__mocks__/vscode";

beforeEach(() => {
  vi.clearAllMocks();
  watchers.length = 0;
});

function doc(): PdfDocument {
  return new PdfDocument(Uri.file("/tmp/doc.pdf"));
}

describe("PdfDocument", () => {
  test("fires dirty change events only on transitions", () => {
    const document = doc();
    const events: Array<{ dirty: boolean }> = [];
    document.onDidChange((e) => events.push({ dirty: e.dirty }));

    document.setDirty(false); // no transition
    expect(events).toHaveLength(0);

    document.setDirty(true);
    expect(document.dirty).toBe(true);
    expect(events).toEqual([{ dirty: true }]);

    document.setDirty(true); // no transition
    expect(events).toHaveLength(1);

    document.setDirty(false);
    expect(events).toEqual([{ dirty: true }, { dirty: false }]);
    document.dispose();
  });

  test("markSaved resets dirty and mutes the watcher briefly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const document = doc();
    document.setDirty(true);
    document.markSaved();
    expect(document.dirty).toBe(false);

    const reloads: string[] = [];
    document.onDidReload((uri) => reloads.push(uri.toString()));
    watchers[0].fireChange(Uri.file("/tmp/doc.pdf"));
    expect(reloads).toHaveLength(0); // muted: our own save
    vi.useRealTimers();
    document.dispose();
  });

  test("external disk change fires reload", () => {
    const document = doc();
    const reloads: string[] = [];
    document.onDidReload((uri) => reloads.push(uri.toString()));

    watchers[0].fireChange(Uri.file("/tmp/doc.pdf"));
    expect(reloads).toEqual(["file:///tmp/doc.pdf"]);

    // Changes to other files are ignored.
    watchers[0].fireChange(Uri.file("/tmp/other.pdf"));
    expect(reloads).toHaveLength(1);
    document.dispose();
  });

  test("deletion fires onDidDelete", () => {
    const document = doc();
    const deleted: string[] = [];
    document.onDidDelete((uri) => deleted.push(uri.toString()));

    watchers[0].fireDelete(Uri.file("/tmp/other.pdf"));
    expect(deleted).toHaveLength(0);
    watchers[0].fireDelete(Uri.file("/tmp/doc.pdf"));
    expect(deleted).toEqual(["file:///tmp/doc.pdf"]);
    document.dispose();
  });

  test("markExternalRewrite resets dirty and reloads", () => {
    const document = doc();
    document.setDirty(true);
    const reloads: string[] = [];
    document.onDidReload(() => reloads.push("x"));
    document.markExternalRewrite();
    expect(document.dirty).toBe(false);
    expect(reloads).toEqual(["x"]);
    document.dispose();
  });

  test("revert clears dirty and fires reload", async () => {
    const document = doc();
    document.setDirty(true);
    const reloads: string[] = [];
    document.onDidReload(() => reloads.push("x"));
    await document.revert({} as never);
    expect(document.dirty).toBe(false);
    expect(reloads).toEqual(["x"]);
    document.dispose();
  });

  test("dispose releases the watcher and emitters", () => {
    const document = doc();
    document.dispose();
    expect(watchers[0].dispose).toHaveBeenCalled();
    expect(() => document.dispose()).not.toThrow();
  });
});
