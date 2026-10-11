import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode"));
vi.mock("node:child_process", () => ({ exec: vi.fn() }));

import { exec } from "node:child_process";
import { printDocument } from "../../src/editor/print";
import { configuration, files, openedExternally, resetMock, shownErrors, statusMessages } from "../__mocks__/vscode";

type ExecCallback = (error: unknown) => void;
const execMock = exec as unknown as ReturnType<typeof vi.fn>;

function stubExec(error: unknown, stdin = true) {
  execMock.mockImplementation((_command: string, callback: ExecCallback) => {
    callback(error);
    return stdin ? { stdin: { end: vi.fn() } } : {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMock();
});

describe("printDocument", () => {
  test("opens a named temp copy with the OS handler and keeps it for that app", async () => {
    await printDocument(new Uint8Array([1, 2, 3]), "draft.pdf");
    expect(openedExternally).toHaveLength(1);
    expect(openedExternally[0]!.path).toMatch(/pdf-print-[^/]+\/draft\.pdf$/u);
    expect(files.get(openedExternally[0]!.toString())).toEqual(new Uint8Array([1, 2, 3]));
    expect(statusMessages.join()).toContain("draft.pdf");
  });

  test("adds a .pdf extension when the name lacks one", async () => {
    await printDocument(new Uint8Array([1]), "scan");
    expect(openedExternally[0]!.path).toMatch(/\/scan\.pdf$/u);
  });

  test("runs the configured command with the quoted path, then deletes the copy", async () => {
    configuration.set("printCommand", "lpr -P office");
    stubExec(null);
    await printDocument(new Uint8Array([9]), "draft.pdf");
    expect(execMock).toHaveBeenCalledWith(expect.stringMatching(/^lpr -P office "\/.*\/draft\.pdf"$/u), expect.any(Function));
    expect(openedExternally).toHaveLength(0);
    await vi.waitFor(() => expect(files.size).toBe(0));
  });

  test("works when the child process has no stdin", async () => {
    configuration.set("printCommand", "lpr");
    stubExec(null, false);
    await printDocument(new Uint8Array([9]), "draft.pdf");
    expect(shownErrors).toHaveLength(0);
  });

  test("reports command failures, including non-Error values", async () => {
    configuration.set("printCommand", "lpr");
    stubExec(new Error("printer offline"));
    await printDocument(new Uint8Array([9]), "draft.pdf");
    stubExec("boom");
    await printDocument(new Uint8Array([9]), "draft.pdf");
    expect(shownErrors.join()).toContain("printer offline");
    expect(shownErrors.join()).toContain("boom");
  });

  test("ignores temp-file cleanup failures", async () => {
    configuration.set("printCommand", "lpr");
    stubExec(null);
    const { workspace } = await import("../__mocks__/vscode");
    workspace.fs.delete.mockRejectedValueOnce(new Error("busy"));
    await printDocument(new Uint8Array([1]), "draft.pdf");
    expect(shownErrors).toHaveLength(0);
  });
});
