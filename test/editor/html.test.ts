import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode"));

import * as os from "node:os";
import { Uri, configuration, resetMock } from "../__mocks__/vscode";
import {
  BASE_SWATCHES,
  HtmlBuilder,
  csp,
  osUser,
  escAttr,
  parseSwatches,
} from "../../src/editor/html";
import type { ViewerConfig } from "../../src/protocol";

vi.mock("node:os", async (original) => ({ ...(await original<typeof import("node:os")>()), userInfo: vi.fn(() => ({ username: "reader" })) }));

const EXTENSION = "/ext";
const TEMPLATE = `<!doctype html>
<html><head>
<title>PDF.js viewer</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'" />
<link rel="resource" type="application/l10n" href="locale/locale.json" />
<script src="../build/pdf.mjs" type="module"></script>
<link rel="stylesheet" href="viewer.css" />
<script src="viewer.mjs" type="module"></script>
</head><body><div id="outerContainer"></div></body></html>`;

const webview = {
  cspSource: "vscode-resource:",
  asWebviewUri: (uri: Uri) => Uri.parse(`https://webview${uri.path}`),
};

function render(documentPath = "/docs/paper one.pdf", preferences?: Record<string, unknown>): { html: string; config: ViewerConfig } {
  const html = new HtmlBuilder(EXTENSION, TEMPLATE).render(webview as never, Uri.file(documentPath) as never, preferences);
  const raw = /data-config="([^"]*)"/u.exec(html)![1]!;
  const config = JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
  return { html, config };
}

beforeEach(() => {
  resetMock();
  vi.mocked(os.userInfo).mockReturnValue({ username: "reader" } as never);
});

describe("HtmlBuilder", () => {
  test("replaces the stock tags with webview URIs and the viewer entry point", () => {
    const { html } = render();
    expect(html).not.toContain("default-src 'self'");
    expect(html).not.toContain('src="viewer.mjs"');
    expect(html).not.toContain('href="viewer.css"');
    expect(html).toContain(`Content-Security-Policy" content="${csp("vscode-resource:")}"`);
    expect(html).toContain('href="https://webview/ext/resources/pdf.js/web/viewer.css"');
    expect(html).toContain('href="https://webview/ext/resources/viewer/viewer.css"');
    expect(html).toContain('src="https://webview/ext/resources/pdf.js/build/pdf.mjs"');
    expect(html).toContain('src="https://webview/ext/resources/viewer/main.mjs"');
    expect(html).toContain('href="https://webview/ext/resources/pdf.js/web/locale/locale.json"');
    expect(html).toContain("<title>PDF</title>");
    expect(html.indexOf("pdf.mjs")).toBeLessThan(html.indexOf("main.mjs"));
  });

  test("injects the viewer configuration", () => {
    const { config } = render();
    expect(config).toEqual({
      pdfJsBuild: "https://webview/ext/resources/pdf.js/build/",
      pdfJsWeb: "https://webview/ext/resources/pdf.js/web/",
      mathJax: "https://webview/ext/node_modules/mathjax-full/es5/tex-svg-full.js",
      fonts: "https://webview/ext/resources/fonts/",
      documentUrl: "https://webview/docs/paper one.pdf",
      resourceRoot: "https://webview/docs/",
      fileName: "paper one.pdf",
      defaultZoomValue: "auto",
      sidebarViewOnLoad: 0,
      presetColors: parseSwatches(BASE_SWATCHES),
      authorName: "reader",
      preferences: {},
    });
  });

  test("honours settings and falls back to default colors when none are valid", () => {
    configuration.set("defaultZoomValue", "page-width");
    configuration.set("sidebarViewOnLoad", 1);
    configuration.set("authorName", "  Dr. Who  ");
    configuration.set("presetColors", ["Mint=#aaffcc", "broken", 7]);
    let { config } = render();
    expect(config).toMatchObject({ defaultZoomValue: "page-width", sidebarViewOnLoad: 1, authorName: "Dr. Who" });
    expect(config.presetColors).toEqual([{ name: "Mint", color: "#AAFFCC" }]);
    configuration.set("presetColors", ["nope"]);
    ({ config } = render());
    expect(config.presetColors).toHaveLength(BASE_SWATCHES.length);
  });

  test("passes the stored preferences", () => {
    const { config } = render("/a.pdf", { styles: { ink: { width: 3 } } });
    expect(config.preferences).toEqual({ styles: { ink: { width: 3 } } });
  });

  test("escapes the configuration attribute", () => {
    configuration.set("authorName", '<a href="x">&</a>');
    const { html, config } = render();
    expect(html).not.toContain('<a href="x">');
    expect(config.authorName).toBe('<a href="x">&</a>');
  });

  test("load reads the vendored viewer.html", () => {
    const html = HtmlBuilder.load(process.cwd()).render(webview as never, Uri.file("/a.pdf") as never);
    expect(html).toContain('id="outerContainer"');
    expect(html).toContain("main.mjs");
  });
});

describe("helpers", () => {
  test("parseSwatches accepts Name=#RRGGBB entries only", () => {
    expect(parseSwatches([" Sky blue = #12abEF ", "Red=#F00", "=#123456", null])).toEqual([
      { name: "Sky blue", color: "#12ABEF" },
    ]);
  });

  test("escAttr escapes HTML-significant characters", () => {
    expect(escAttr(`"<&>"`)).toBe("&quot;&lt;&amp;&gt;&quot;");
  });

  test("osUser falls back to empty when the user is unknown", () => {
    expect(osUser()).toBe("reader");
    vi.mocked(os.userInfo).mockImplementation(() => {
      throw new Error("no user");
    });
    expect(osUser()).toBe("");
  });
});
