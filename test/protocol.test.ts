import { describe, expect, test } from "vitest";
import { isWebviewToHostMessage, WEBVIEW_COMMANDS } from "../src/protocol";

describe("isWebviewToHostMessage", () => {
  test("accepts objects with a string type", () => {
    expect(isWebviewToHostMessage({ type: "dirty", dirty: true })).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isWebviewToHostMessage(null)).toBe(false);
    expect(isWebviewToHostMessage("dirty")).toBe(false);
    expect(isWebviewToHostMessage({})).toBe(false);
    expect(isWebviewToHostMessage({ type: 1 })).toBe(false);
  });
});

describe("WEBVIEW_COMMANDS", () => {
  test("allowlists only df commands", () => {
    for (const command of WEBVIEW_COMMANDS) {
      expect(command.startsWith("df.")).toBe(true);
    }
    expect(WEBVIEW_COMMANDS.has("workbench.action.files.save")).toBe(false);
    expect(WEBVIEW_COMMANDS.has("df.save")).toBe(true);
    expect(WEBVIEW_COMMANDS.has("df.print")).toBe(true);
    expect(WEBVIEW_COMMANDS.has("df.rotatePage")).toBe(true);
  });
});
