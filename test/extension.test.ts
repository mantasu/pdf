import { describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("./__mocks__/vscode"));
vi.mock("../src/editor/provider", () => ({ PdfProvider: { register: vi.fn() } }));

import { PdfProvider } from "../src/editor/provider";
import { activate, deactivate } from "../src/extension";

describe("extension lifecycle", () => {
  test("activate registers the PDF editor provider", () => {
    const host = { subscriptions: [] } as never;
    activate(host);
    expect(PdfProvider.register).toHaveBeenCalledWith(host);
  });

  test("deactivate is harmless", () => {
    expect(() => deactivate()).not.toThrow();
  });
});
