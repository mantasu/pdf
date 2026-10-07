import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("./__mocks__/vscode"));
vi.mock("node:child_process", () => ({ exec: vi.fn() }));

import { workspace } from "vscode";
import { exec } from "node:child_process";
import { printPdf } from "../src/print";
import { openedExternally, shownErrors, statusMessages, writtenFiles } from "./__mocks__/vscode";

function setPrintCommand(command: string): void {
  vi.spyOn(workspace, "getConfiguration").mockReturnValue({
    get: (_key: string, _default?: unknown) => command,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  writtenFiles.clear();
  openedExternally.length = 0;
  shownErrors.length = 0;
  statusMessages.length = 0;
  setPrintCommand("");
});

describe("printPdf", () => {
  test("opens the temp file externally when no command is configured", async () => {
    await printPdf(new Uint8Array([1, 2, 3]), "doc.pdf");
    expect(openedExternally).toHaveLength(1);
    expect(String(openedExternally[0].path)).toMatch(/df-print-\d+\.pdf$/u);
    expect(statusMessages.some((m) => m.includes("doc.pdf"))).toBe(true);
    // The temp file is removed afterwards.
    expect(writtenFiles.size).toBe(0);
  });

  test("runs the configured command with the file path", async () => {
    setPrintCommand("lpr");
    (exec as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, cb: (error: Error | null) => void) => {
        cb(null);
        return { stdin: { end: () => undefined } };
      },
    );
    await printPdf(new Uint8Array([9]), "doc.pdf");
    expect(exec).toHaveBeenCalledWith(
      expect.stringMatching(/^lpr "\/.*\.pdf"$/u),
      expect.any(Function),
    );
    expect(openedExternally).toHaveLength(0);
  });

  test("works when the child process has no stdin", async () => {
    setPrintCommand("lpr");
    (exec as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, cb: (error: Error | null) => void) => {
        cb(null);
        return {};
      },
    );
    await printPdf(new Uint8Array([9]), "doc.pdf");
    expect(openedExternally).toHaveLength(0);
    expect(shownErrors).toHaveLength(0);
  });

  test("reports command failures", async () => {
    setPrintCommand("lpr");
    (exec as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, cb: (error: Error | null) => void) => {
        cb(new Error("printer offline"));
        return { stdin: { end: () => undefined } };
      },
    );
    await printPdf(new Uint8Array([9]), "doc.pdf");
    expect(shownErrors.join()).toContain("printer offline");
  });

  test("stringifies non-Error failures", async () => {
    setPrintCommand("lpr");
    (exec as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, cb: (error: Error | null) => void) => {
        cb("boom" as never);
        return { stdin: { end: () => undefined } };
      },
    );
    await printPdf(new Uint8Array([9]), "doc.pdf");
    expect(shownErrors.join()).toContain("boom");
  });

  test("swallows temp-file cleanup failures", async () => {
    const delSpy = vi.spyOn(workspace.fs, "delete").mockRejectedValueOnce(new Error("busy"));
    await printPdf(new Uint8Array([1]), "doc.pdf");
    expect(delSpy).toHaveBeenCalled();
    expect(shownErrors).toHaveLength(0); // cleanup errors are ignored
    delSpy.mockRestore();
  });
});
