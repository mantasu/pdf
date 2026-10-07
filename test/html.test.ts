import { describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("./__mocks__/vscode"));

const osMock = vi.hoisted(() => ({ userInfoThrows: false }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: (...args: Parameters<typeof actual.userInfo>) => {
      if (osMock.userInfoThrows) {
        throw new Error("no user info");
      }
      return actual.userInfo(...args);
    },
  };
});

import { Uri, workspace } from "vscode";
import { ViewerHtml, contentSecurityPolicy } from "../src/html";

const TEMPLATE = [
  "<html>",
  '<head><meta charset="utf-8">',
  '<link rel="resource" type="application/l10n" href="locale/locale.json" />',
  '<script src="../build/pdf.mjs" type="module"></script>',
  '<link rel="stylesheet" href="viewer.css" />',
  '<script src="viewer.mjs" type="module"></script>',
  "<title>PDF.js viewer</title>",
  "</head>",
  "<body></body>",
  "</html>",
].join("\n");

const SNIPPET = [
  '<meta http-equiv="Content-Security-Policy" content="{{csp}}">',
  '<meta id="df-config" data-config="{{config}}">',
  '<link rel="stylesheet" href="{{viewerCss}}">',
  '<link rel="stylesheet" href="{{editorCss}}">',
  '<script src="{{pdfLib}}" type="module"></script>',
  '<script src="{{pdfJs}}" type="module"></script>',
  '<script src="{{bootstrap}}" type="module"></script>',
  '<link rel="resource" type="application/l10n" href="{{l10n}}">',
].join("\n");

const webview = {
  cspSource: "vscode-webview://test",
  asWebviewUri: (uri: Uri) => ({
    toString: () => `vscode-webview://test${uri.path}`,
  }),
};

function render(): string {
  return new ViewerHtml(TEMPLATE, SNIPPET).render(webview as never, {
    extensionPath: "/ext",
    documentUri: Uri.file("/data/doc.pdf"),
    resourceRoot: Uri.file("/data/"),
  });
}

describe("contentSecurityPolicy", () => {
  test("contains the directives required by pdf.js", () => {
    const csp = contentSecurityPolicy("vscode-webview://x");
    for (const directive of [
      "default-src 'none'",
      "'wasm-unsafe-eval'",
      "worker-src vscode-webview://x blob:",
      "connect-src vscode-webview://x blob: data:",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
  });
});

describe("ViewerHtml.render", () => {
  test("strips stock viewer tags and injects webview URIs", () => {
    const html = render();
    expect(html).not.toContain('href="viewer.css"');
    expect(html).not.toContain('src="viewer.mjs"');
    expect(html).not.toContain('href="locale/locale.json"');
    expect(html).toContain("vscode-webview://test/ext/resources/pdf.js/build/pdf.mjs");
    expect(html).toContain("vscode-webview://test/ext/resources/pdf.js/web/viewer.mjs");
    expect(html).toContain("vscode-webview://test/ext/resources/bootstrap.mjs");
    expect(html).toContain("vscode-webview://test/ext/resources/viewer.css");
    expect(html).toContain("vscode-webview://test/ext/resources/pdf.js/web/viewer.css");
    expect(html).toContain(
      "vscode-webview://test/ext/resources/pdf.js/web/locale/locale.json",
    );
    expect(html).toContain("<title>df</title>");
  });

  test("embeds escaped viewer config", () => {
    const html = render();
    const match = html.match(/data-config="([^"]*)"/u);
    expect(match).not.toBeNull();
    const config = JSON.parse(match![1].replaceAll("&quot;", '"'));
    expect(config.url).toBe("vscode-webview://test/data/doc.pdf");
    expect(config.resourceRoot).toBe("vscode-webview://test/data/");
    expect(config.pdfJsBuild).toBe("vscode-webview://test/ext/resources/pdf.js/build/");
    expect(config.defaultZoomValue).toBe("auto");
    expect(config.annotationEditorMode).toBe(0);
  });

  test("injects the CSP meta tag once", () => {
    expect(render().match(/Content-Security-Policy/gu)).toHaveLength(1);
  });

  test("filters invalid highlight color presets", () => {
    const spy = vi.spyOn(workspace, "getConfiguration").mockReturnValue({
      get: (_key: string, defaultValue?: unknown) =>
        _key === "highlightColors"
          ? ["Green=#00FF00", "broken", "NoHash=FF0000", "Red=#FF0000"]
          : defaultValue,
    } as never);
    try {
      const config = JSON.parse(
        render()
          .match(/data-config="([^"]*)"/u)![1]
          .replaceAll("&quot;", '"'),
      );
      expect(config.highlightColors).toBe("Green=#00FF00,Red=#FF0000");
      expect(config.freeTextColor).toBe("#000000");
      expect(config.freeTextFontSize).toBe(12);
      expect(config.inkColor).toBe("#e52222");
    } finally {
      spy.mockRestore();
    }
  });

  test("authorName defaults to the OS user name and honors the setting", async () => {
    const { userInfo } = await import("node:os");
    // Empty setting -> OS user name (the home-directory name).
    expect(configOf(render()).authorName).toBe(userInfo().username);

    const spy = vi.spyOn(workspace, "getConfiguration").mockReturnValue({
      get: (key: string, defaultValue?: unknown) =>
        key === "authorName" ? "  Jane Doe  " : defaultValue,
    } as never);
    try {
      expect(configOf(render()).authorName).toBe("Jane Doe");
    } finally {
      spy.mockRestore();
    }
  });

  test("falls back to an empty author when the OS user name is unavailable", () => {
    osMock.userInfoThrows = true;
    try {
      expect(configOf(render()).authorName).toBe("");
    } finally {
      osMock.userInfoThrows = false;
    }
  });

  test("load reads the vendored viewer.html and the snippet template", () => {
    const loaded = ViewerHtml.load(process.cwd());
    const html = loaded.render(webview as never, {
      extensionPath: process.cwd(),
      documentUri: Uri.file("/data/doc.pdf"),
      resourceRoot: Uri.file("/data/"),
    });
    expect(html).toContain("<title>df</title>");
    expect(html).toContain('id="outerContainer"');
    expect(html).toContain("resources/bootstrap.mjs");
  });
});

function configOf(html: string): Record<string, unknown> {
  return JSON.parse(html.match(/data-config="([^"]*)"/u)![1].replaceAll("&quot;", '"'));
}
