import { describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("./__mocks__/vscode"));
vi.mock("../src/provider", () => ({
  PdfEditProvider: { register: vi.fn() },
}));

import { commands } from "vscode";
import { activate, deactivate } from "../src/extension";
import { PdfEditProvider } from "../src/provider";

describe("extension", () => {
  test("activate registers the provider and save alias", () => {
    const context = { subscriptions: [] as unknown[] } as never;
    activate(context);
    expect(PdfEditProvider.register).toHaveBeenCalledWith(context);
    const registered = (commands.registerCommand as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0],
    );
    expect(registered).toContain("df.save");
  });

  test("df.save delegates to the workbench save command", async () => {
    activate({ subscriptions: [] } as never);
    const handler = (commands.registerCommand as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === "df.save",
    )![1] as () => Promise<unknown>;
    const { executedCommands } = await import("./__mocks__/vscode");
    await handler();
    expect(executedCommands.some((e) => e.command === "workbench.action.files.save")).toBe(true);
  });

  test("deactivate does not throw", () => {
    expect(() => deactivate()).not.toThrow();
  });
});
