import { describe, expect, test, vi } from "vitest";
import { disposeAll, escapeAttribute, withTrailingSlash } from "../src/utils";

describe("escapeAttribute", () => {
  test("JSON-encodes and escapes HTML-sensitive characters", () => {
    expect(escapeAttribute({ a: 1 })).toBe("{&quot;a&quot;:1}");
  });

  test("escapes angle brackets and ampersands", () => {
    const json = JSON.stringify({ url: "a&b<c>d" });
    expect(escapeAttribute({ url: "a&b<c>d" })).toBe(
      json.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    );
  });

  test("handles non-object values", () => {
    expect(escapeAttribute("x")).toBe("&quot;x&quot;");
    expect(escapeAttribute(42)).toBe("42");
  });
});

describe("withTrailingSlash", () => {
  test("appends a slash when missing", () => {
    expect(withTrailingSlash("a/b")).toBe("a/b/");
  });

  test("keeps an existing slash", () => {
    expect(withTrailingSlash("a/b/")).toBe("a/b/");
  });
});

describe("disposeAll", () => {
  test("disposes every disposable", () => {
    const a = { dispose: vi.fn() };
    const b = { dispose: vi.fn() };
    disposeAll([a, b]);
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(b.dispose).toHaveBeenCalledOnce();
    disposeAll([]);
  });
});
