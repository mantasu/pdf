 import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("./__mocks__/vscode"));

import { Uri, workspace, window } from "vscode";
import { PdfEditProvider, runPageOp } from "../src/provider";
import type { ViewerHtml } from "../src/html";
import {
  commands,
  executedCommands,
  openedExternally,
  shownErrors,
  shownMessages,
  statusMessages,
  writtenFiles,
  watchers,
} from "./__mocks__/vscode";

interface FakeWebview {
  options: unknown;
  html: string;
  cspSource: string;
  messages: unknown[];
  posted: unknown[];
  onDidReceiveMessage: (listener: (m: unknown) => void) => { dispose: () => void };
  onDidDispose: (listener: () => void) => { dispose: () => void };
  postMessage: (m: unknown) => Promise<boolean>;
  asWebviewUri: (uri: Uri) => { toString: () => string };
  emit: (m: unknown) => void;
  dispose: () => void;
}

function fakeWebview(): FakeWebview {
  const listeners: Array<(m: unknown) => void> = [];
  const disposeListeners: Array<() => void> = [];
  const view: FakeWebview = {
    options: {},
    html: "",
    cspSource: "vscode-webview://test",
    messages: [],
    posted: [],
    onDidReceiveMessage: (listener) => {
      listeners.push(listener);
      return { dispose: vi.fn() };
    },
    onDidDispose: (listener) => {
      disposeListeners.push(listener);
      return { dispose: vi.fn() };
    },
    postMessage: async (m) => {
      view.posted.push(m);
      return true;
    },
    asWebviewUri: (uri: Uri) => ({ toString: () => `vscode-webview://t${uri.path}` }),
    emit: (m) => listeners.forEach((l) => l(m)),
    dispose: () => disposeListeners.forEach((l) => l()),
  };
  return view;
}

function fakePanel(): {
  webview: FakeWebview;
  onDidChangeViewState: ReturnType<typeof vi.fn>;
  onDidDispose: (listener: () => void) => { dispose: () => void };
  fireViewState: (active: boolean) => void;
  active: boolean;
} {
  const viewStateListeners: Array<(e: { webviewPanel: { active: boolean } }) => void> = [];
  const panel = {
    webview: fakeWebview(),
    onDidChangeViewState: vi.fn((listener: (e: { webviewPanel: { active: boolean } }) => void) => {
      viewStateListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onDidDispose: () => ({ dispose: vi.fn() }),
    fireViewState: (active: boolean) => {
      panel.active = active;
      for (const l of viewStateListeners) {
        l({ webviewPanel: panel as never });
      }
    },
    active: true,
  };
  return panel;
}

const htmlStub = { render: () => "<html>stub</html>" } as unknown as ViewerHtml;

function makeProvider(): PdfEditProvider {
  const context = { extensionPath: "/ext", subscriptions: [] } as never;
  return new PdfEditProvider(context, htmlStub);
}

async function resolve(provider: PdfEditProvider, path = "/data/doc.pdf") {
  const document = provider.openCustomDocument(Uri.file(path));
  const panel = fakePanel();
  await provider.resolveCustomEditor(document, panel as never, {} as never);
  return { document, panel };
}

beforeEach(() => {
  vi.clearAllMocks();
  watchers.length = 0;
  writtenFiles.clear();
  executedCommands.length = 0;
  shownErrors.length = 0;
  shownMessages.length = 0;
  openedExternally.length = 0;
  statusMessages.length = 0;
});

describe("PdfEditProvider.resolveCustomEditor", () => {
  test("sets webview options and HTML", async () => {
    const provider = makeProvider();
    const { panel } = await resolve(provider);
    expect(panel.webview.options).toMatchObject({ enableScripts: true });
    expect(panel.webview.html).toBe("<html>stub</html>");
  });

  test("routes dirty and page messages", async () => {
    const provider = makeProvider();
    const { document, panel } = await resolve(provider);

    panel.webview.emit({ type: "dirty", dirty: true });
    expect(document.dirty).toBe(true);

    panel.webview.emit({ type: "page", page: 7 });
    panel.webview.emit({ type: "not-a-message" });
    panel.webview.emit({ type: "dirty", dirty: false });
    expect(document.dirty).toBe(false);
  });

  test("writes unsolicited saved bytes directly", async () => {
    const provider = makeProvider();
    const { document, panel } = await resolve(provider);
    const data = new Uint8Array([1, 2, 3]);
    panel.webview.emit({ type: "saved", data });
    await vi.waitFor(() => {
      expect(Buffer.from(writtenFiles.get("file:///data/doc.pdf") ?? [])).toEqual(
        Buffer.from(data),
      );
    });
    expect(document.dirty).toBe(false);
  });

  test("shows errors from the webview", async () => {
    const provider = makeProvider();
    const { panel } = await resolve(provider);
    panel.webview.emit({ type: "error", error: "boom" });
    await vi.waitFor(() => expect(shownErrors).toEqual(["df: boom"]));
  });

  test("print messages hand bytes to the OS handler", async () => {
    const provider = makeProvider();
    const { panel } = await resolve(provider);
    panel.webview.emit({ type: "print", data: new Uint8Array([1, 2]) });
    await vi.waitFor(() => expect(openedExternally).toHaveLength(1));
    expect(String(openedExternally[0].path)).toMatch(/\.pdf$/u);
    expect(statusMessages.some((m) => m.includes("doc.pdf"))).toBe(true);
  });

  test("allowed commands are executed, unknown ones ignored", async () => {
    const provider = makeProvider();
    const { panel } = await resolve(provider);
    panel.webview.emit({ type: "command", command: "df.rotatePage" });
    panel.webview.emit({ type: "command", command: "evil.command" });
    await new Promise((r) => setImmediate(r));
    expect(executedCommands.map((c) => c.command)).toEqual(["df.rotatePage"]);
  });

  test("opens relative links with vscode.open", async () => {
    const provider = makeProvider();
    const { panel } = await resolve(provider);
    panel.webview.emit({ type: "open", url: "vscode-webview://t/data/notes.md#intro" });
    await vi.waitFor(() => expect(executedCommands).toHaveLength(1));
    expect(executedCommands[0].command).toBe("vscode.open");
    const uri = executedCommands[0].args[0] as Uri;
    expect(uri.path).toBe("/data/notes.md");
    expect(uri.fragment).toBe("intro");
  });

  test("ignores links outside the resource root", async () => {
    const provider = makeProvider();
    const { panel } = await resolve(provider);
    panel.webview.emit({ type: "open", url: "vscode-webview://t/elsewhere/x.md" });
    panel.webview.emit({ type: "open", url: "https://evil.example/x" });
    await new Promise((r) => setImmediate(r));
    expect(executedCommands).toHaveLength(0);
  });
});

describe("PdfEditProvider save pipeline", () => {
  test("saveCustomDocument requests bytes and writes them", async () => {
    const provider = makeProvider();
    const { document, panel } = await resolve(provider);
    document.setDirty(true);

    const data = new Uint8Array([9, 8, 7]);
    const saving = provider.saveCustomDocument(document, {} as never);
    await vi.waitFor(() =>
      expect(panel.webview.posted).toContainEqual({ type: "request-save" }),
    );
    panel.webview.emit({ type: "saved", data });
    await saving;

    expect(Buffer.from(writtenFiles.get("file:///data/doc.pdf") ?? [])).toEqual(
      Buffer.from(data),
    );
    expect(document.dirty).toBe(false);
  });

  test("saveCustomDocumentAs writes to the destination", async () => {
    const provider = makeProvider();
    const { document, panel } = await resolve(provider);
    const data = new Uint8Array([4, 5]);
    const target = Uri.file("/data/copy.pdf");
    const saving = provider.saveCustomDocumentAs(document, target, {} as never);
    await vi.waitFor(() =>
      expect(panel.webview.posted).toContainEqual({ type: "request-save" }),
    );
    panel.webview.emit({ type: "saved", data });
    await saving;
    expect(writtenFiles.get("file:///data/copy.pdf")).toEqual(data);
  });

  test("revert posts a reload to the webview", async () => {
    const provider = makeProvider();
    const { document, panel } = await resolve(provider);
    document.setDirty(true);
    await provider.revertCustomDocument(document, {} as never);
    expect(panel.webview.posted).toContainEqual({ type: "reload" });
    expect(document.dirty).toBe(false);
  });
});

describe("PdfEditProvider page ops", () => {
  test("warns when no document is open", async () => {
    const provider = makeProvider();
    await provider.applyPageOp("rotate");
    expect(shownMessages).toEqual(["df: open a PDF first."]);
  });

  test("rotate writes new bytes and reloads the viewer", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const source = await PDFDocument.create();
    source.addPage([100, 200]);
    source.addPage([100, 200]);
    const bytes = await source.save();
    writtenFiles.set("file:///data/doc.pdf", bytes);

    const provider = makeProvider();
    const { document, panel } = await resolve(provider);
    panel.webview.emit({ type: "page", page: 2 });

    await provider.applyPageOp("rotate");

    const saved = writtenFiles.get("file:///data/doc.pdf")!;
    const reloaded = await PDFDocument.load(saved);
    expect(reloaded.getPage(1).getRotation().angle).toBe(90);
    expect(panel.webview.posted).toContainEqual({ type: "reload" });
  });

  test("move-up on the first page is a no-op", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const source = await PDFDocument.create();
    source.addPage([100, 200]);
    source.addPage([100, 200]);
    writtenFiles.set("file:///data/doc.pdf", await source.save());

    const provider = makeProvider();
    const { panel } = await resolve(provider);
    panel.webview.emit({ type: "page", page: 1 });
    const writesBefore = (workspace.fs.writeFile as ReturnType<typeof vi.fn>).mock.calls.length;
    await provider.applyPageOp("move-up");
    expect((workspace.fs.writeFile as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      writesBefore,
    );
  });

  test("deleting the only page shows an error", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const source = await PDFDocument.create();
    source.addPage([100, 200]);
    writtenFiles.set("file:///data/doc.pdf", await source.save());

    const provider = makeProvider();
    await resolve(provider);
    await provider.applyPageOp("delete");
    expect(shownErrors).toEqual(["df: Cannot delete the only page of a PDF."]);
  });
});

describe("PdfEditProvider print", () => {
  test("warns when no document is open", async () => {
    const provider = makeProvider();
    await provider.printActiveDocument();
    expect(shownMessages).toEqual(["df: open a PDF first."]);
  });

  test("requests the bytes from the active webview", async () => {
    const provider = makeProvider();
    const { panel } = await resolve(provider);
    await provider.printActiveDocument();
    expect(panel.webview.posted).toContainEqual({ type: "request-print" });
  });
});

describe("runPageOp", () => {
  test("dispatches every operation", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const source = await PDFDocument.create();
    source.addPage([100, 200]);
    source.addPage([100, 200]);
    const bytes = await source.save();

    const rotate = await runPageOp("rotate", bytes, 1);
    expect((await PDFDocument.load(rotate!)).getPage(0).getRotation().angle).toBe(90);

    const del = await runPageOp("delete", bytes, 1);
    expect((await PDFDocument.load(del!)).getPageCount()).toBe(1);

    const up = await runPageOp("move-up", bytes, 1);
    expect(up).toBeUndefined();

    const down = await runPageOp("move-down", bytes, 1);
    expect((await PDFDocument.load(down!)).getPageCount()).toBe(2);

    const before = await runPageOp("insert-before", bytes, 2);
    expect((await PDFDocument.load(before!)).getPageCount()).toBe(3);

    const after = await runPageOp("insert-after", bytes, 1);
    expect((await PDFDocument.load(after!)).getPageCount()).toBe(3);
  });
});

describe("PdfEditProvider.register", () => {
  test("registers the custom editor and page-ops commands", async () => {
    const { commands, window: win } = await import("vscode");
    const context = { extensionPath: "/ext", subscriptions: [] as unknown[] } as never;
    // register() constructs the provider which loads real HTML from disk, so
    // stub ViewerHtml.load to keep this a pure unit test.
    const htmlModule = await import("../src/html");
    const loadSpy = vi.spyOn(htmlModule.ViewerHtml, "load").mockReturnValue(htmlStub);
    PdfEditProvider.register(context);
    loadSpy.mockRestore();

    expect(win.registerCustomEditorProvider).toHaveBeenCalledWith(
      "df.viewer",
      expect.any(PdfEditProvider),
      expect.objectContaining({
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );
    const registered = (commands.registerCommand as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0])
      .filter((name: string) => name.startsWith("df."));
    expect(registered).toEqual([
      "df.rotatePage",
      "df.deletePage",
      "df.movePageUp",
      "df.movePageDown",
      "df.insertBlankPageBefore",
      "df.insertBlankPageAfter",
      "df.print",
    ]);
  });

  test("registered page-op and print commands route to the provider", async () => {
    const htmlModule = await import("../src/html");
    const loadSpy = vi.spyOn(htmlModule.ViewerHtml, "load").mockReturnValue(htmlStub);
    const context = { extensionPath: "/ext", subscriptions: [] as unknown[] } as never;
    PdfEditProvider.register(context);
    loadSpy.mockRestore();

    // No document open yet: each command warns instead of touching a file.
    const handlers = commands as Record<string, () => Promise<void>>;
    await handlers["__handler_df.rotatePage"]();
    await handlers["__handler_df.print"]();
    expect(shownMessages).toEqual(["df: open a PDF first.", "df: open a PDF first."]);
  });
});

describe("PdfEditProvider edit events and lifecycle", () => {
  test("re-emits document dirty changes with undo/redo no-ops", async () => {
    const provider = makeProvider();
    const events: Array<{ label: string; undo?: () => Promise<undefined>; redo?: () => Promise<undefined> }> = [];
    provider.onDidChangeCustomDocument((e) => events.push(e as never));

    const document = provider.openCustomDocument(Uri.file("/data/doc.pdf"));
    document.setDirty(true);
    document.setDirty(false);
    expect(events.map((e) => e.label)).toEqual(["Edit", "Revert"]);
    await expect(events[0].undo!()).resolves.toBeUndefined();
    await expect(events[0].redo!()).resolves.toBeUndefined();
    document.dispose();
  });

  test("document deletion disposes the provider listeners", () => {
    const provider = makeProvider();
    const document = provider.openCustomDocument(Uri.file("/data/doc.pdf"));
    const events: unknown[] = [];
    provider.onDidChangeCustomDocument(() => events.push("x"));
    watchers[watchers.length - 1].fireDelete(Uri.file("/data/doc.pdf"));
    document.setDirty(true);
    expect(events).toHaveLength(0); // listener disposed on delete
    document.dispose();
  });

  test("an inactive panel does not steal the active document", async () => {
    const provider = makeProvider();
    const a = await resolve(provider, "/data/a.pdf");
    const b = await resolve(provider, "/data/b.pdf");
    // b resolved last so it is active; an inactive state event changes nothing.
    b.panel.fireViewState(false);
    await provider.printActiveDocument();
    expect(b.panel.webview.posted).toContainEqual({ type: "request-print" });
    // Re-activating a's panel makes a the print target again.
    a.panel.fireViewState(true);
    await provider.printActiveDocument();
    expect(a.panel.webview.posted).toContainEqual({ type: "request-print" });
  });

  test("ignores malformed saved/print payloads", async () => {
    const provider = makeProvider();
    const { panel } = await resolve(provider);
    panel.webview.emit("not-even-an-object");
    panel.webview.emit({ type: "saved", data: "not-bytes" });
    panel.webview.emit({ type: "print", data: "not-bytes" });
    await new Promise((r) => setImmediate(r));
    expect(writtenFiles.size).toBe(0);
    expect(openedExternally).toHaveLength(0);
  });

  test("shows an error when writing saved bytes fails", async () => {
    const provider = makeProvider();
    const { panel } = await resolve(provider);
    const spy = vi
      .spyOn(workspace.fs, "writeFile")
      .mockRejectedValueOnce(new Error("disk full"));
    panel.webview.emit({ type: "saved", data: new Uint8Array([1]) });
    await vi.waitFor(() => expect(shownErrors).toEqual(["df: disk full"]));
    spy.mockRestore();
  });

  test("ignores opening the resource root itself", async () => {
    const provider = makeProvider();
    const { panel } = await resolve(provider);
    panel.webview.emit({ type: "open", url: "vscode-webview://t/data/" });
    await new Promise((r) => setImmediate(r));
    expect(executedCommands).toHaveLength(0);
  });
});

describe("PdfEditProvider backup (hot exit)", () => {
  test("writes backup bytes and deletes them on demand", async () => {
    const provider = makeProvider();
    const { document, panel } = await resolve(provider);
    document.setDirty(true);
    const destination = Uri.file("/tmp/backup.pdf");

    const backup = provider.backupCustomDocument(document, { destination } as never, {} as never);
    await vi.waitFor(() =>
      expect(panel.webview.posted).toContainEqual({ type: "request-save" }),
    );
    panel.webview.emit({ type: "saved", data: new Uint8Array([4, 2]) });
    const result = await backup;

    expect(result.id).toBe(destination.toString());
    expect(writtenFiles.get(destination.toString())).toEqual(new Uint8Array([4, 2]));
    result.delete();
    expect(writtenFiles.has(destination.toString())).toBe(false);
  });

  test("backup delete swallows failures to remove the backup file", async () => {
    const provider = makeProvider();
    const { document, panel } = await resolve(provider);
    const destination = Uri.file("/tmp/backup3.pdf");
    const backup = provider.backupCustomDocument(document, { destination } as never, {} as never);
    await vi.waitFor(() =>
      expect(panel.webview.posted).toContainEqual({ type: "request-save" }),
    );
    panel.webview.emit({ type: "saved", data: new Uint8Array([1]) });
    const result = await backup;
    const spy = vi.spyOn(workspace.fs, "delete").mockRejectedValueOnce(new Error("busy"));
    result.delete();
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("skips writing when the webview never answers (timeout)", async () => {
    vi.useFakeTimers();
    const provider = makeProvider();
    const { document } = await resolve(provider);
    const destination = Uri.file("/tmp/backup2.pdf");
    const backup = provider.backupCustomDocument(document, { destination } as never, {} as never);
    await vi.advanceTimersByTimeAsync(16_000);
    const result = await backup;
    expect(result.id).toBe(destination.toString());
    expect(writtenFiles.has(destination.toString())).toBe(false);
    vi.useRealTimers();
  });
});
