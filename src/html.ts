import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { Uri, Webview, workspace } from "vscode";
import { escapeAttribute, withTrailingSlash } from "./utils";
import type { ViewerConfig } from "./protocol";

/** Tags in the stock viewer.html that must be replaced with webview URIs. */
const STRIPPED_PATTERNS: RegExp[] = [
  /<link\b[^>]*href=["']locale\/locale\.json["'][^>]*\/?>\s*/giu,
  /<script\b[^>]*src=["'][^"']*pdf\.mjs["'][^>]*><\/script>\s*/giu,
  /<script\b[^>]*src=["']viewer\.mjs["'][^>]*><\/script>\s*/giu,
  /<link\b[^>]*href=["']viewer\.css["'][^>]*\/?>\s*/giu,
];

const PLACEHOLDER_TITLE = "<title>PDF.js viewer</title>";

export interface HtmlOptions {
  extensionPath: string;
  documentUri: Uri;
  resourceRoot: Uri;
}

/**
 * Builds webview HTML from the (unpatched) stock pdf.js viewer.html plus a
 * small snippet template kept in `resources/`. The viewer's own script,
 * style and l10n tags are stripped and re-injected as webview URIs.
 */
export class ViewerHtml {
  constructor(
    private readonly template: string,
    private readonly snippet: string,
  ) {}

  static load(extensionPath: string): ViewerHtml {
    const template = readFileSync(
      join(extensionPath, "resources", "pdf.js", "web", "viewer.html"),
      "utf8",
    );
    const snippet = readFileSync(join(extensionPath, "resources", "webview-snippet.html"), "utf8");
    return new ViewerHtml(template, snippet);
  }

  render(webview: Webview, options: HtmlOptions): string {
    const uri = (...paths: string[]) =>
      webview.asWebviewUri(Uri.file(join(options.extensionPath, ...paths))).toString(true);

    const injected = this.snippet
      .replaceAll("{{csp}}", contentSecurityPolicy(webview.cspSource))
      .replaceAll("{{config}}", escapeAttribute(this.configFor(webview, options)))
      .replaceAll("{{viewerCss}}", uri("resources", "pdf.js", "web", "viewer.css"))
      .replaceAll("{{editorCss}}", uri("resources", "viewer.css"))
      .replaceAll("{{pdfLib}}", uri("resources", "pdf.js", "build", "pdf.mjs"))
      .replaceAll("{{pdfJs}}", uri("resources", "pdf.js", "web", "viewer.mjs"))
      .replaceAll("{{bootstrap}}", uri("resources", "bootstrap.mjs"))
      .replaceAll("{{l10n}}", uri("resources", "pdf.js", "web", "locale", "locale.json"));

    let html = this.template;
    for (const pattern of STRIPPED_PATTERNS) {
      html = html.replace(pattern, "");
    }
    return html.replace(PLACEHOLDER_TITLE, `${injected}\n<title>df</title>`);
  }

  private configFor(webview: Webview, options: HtmlOptions): ViewerConfig {
    const config = workspace.getConfiguration("df", options.documentUri);
    const modes: Record<string, number> = { none: 0, freetext: 3, highlight: 9, ink: 15 };
    return {
      url: webview.asWebviewUri(options.documentUri).toString(true),
      resourceRoot: withTrailingSlash(webview.asWebviewUri(options.resourceRoot).toString(true)),
      pdfJsBuild: withTrailingSlash(uri(webview, options, "resources", "pdf.js", "build")),
      pdfJsWeb: withTrailingSlash(uri(webview, options, "resources", "pdf.js", "web")),
      defaultZoomValue: config.get<string>("defaultZoomValue", "auto"),
      sidebarViewOnLoad: config.get<number>("sidebarViewOnLoad", 0),
      annotationEditorMode: modes[config.get<string>("annotationEditorMode", "none")] as number,
      highlightColors: config
        .get<string[]>("highlightColors", [])
        .filter((entry) => /^[^=]+=#[0-9a-fA-F]{6}$/u.test(entry))
        .join(","),
      freeTextColor: config.get<string>("freeTextColor", "#000000"),
      freeTextFontSize: config.get<number>("freeTextFontSize", 12),
      freeTextFontFamily: fontName(config.get<string>("freeTextFontFamily", "Helvetica")),
      inkColor: config.get<string>("inkColor", "#e52222"),
      authorName:
        config.get<string>("authorName", "").trim() || userInfoName(),
    };
  }
}

/**
 * Map the user-facing font name onto the PDF base font used for free text.
 * Only the base-14 families (regular/bold/italic/bold-italic variants) can be
 * embedded without a program, so they are readable in every PDF viewer.
 */
function fontName(value: string): string {
  const v = value.trim().toLowerCase();
  const style = v.includes("bold") ? "bold" : v.includes("italic") || v.includes("oblique") ? "italic" : "";
  const base = v.startsWith("times")
    ? "Times"
    : v.startsWith("courier")
      ? "Courier"
      : "Helvetica";
  if (base === "Times") {
    return style === "bold"
      ? "Times-Bold"
      : style === "italic"
        ? "Times-Italic"
        : "Times-Roman";
  }
  if (style === "bold") {
    return `${base}-Bold${v.includes("italic") || v.includes("oblique") ? "Oblique" : ""}`;
  }
  return style === "italic" ? `${base}-Oblique` : base === "Courier" ? "Courier" : "Helv";
}

/**
 * The operating-system user name, which matches the home-directory name on
 * Windows (`C:\Users\<name>`), macOS (`/Users/<name>`) and Linux (`/home/<name>`).
 * Used as the default annotation author, like Acrobat does.
 */
function userInfoName(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

function uri(webview: Webview, options: HtmlOptions, ...paths: string[]): string {
  return webview.asWebviewUri(Uri.file(join(options.extensionPath, ...paths))).toString(true);
}

export function contentSecurityPolicy(cspSource: string): string {
  return [
    "default-src 'none'",
    `connect-src ${cspSource} blob: data:`,
    `script-src ${cspSource} 'wasm-unsafe-eval'`,
    `worker-src ${cspSource} blob:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `img-src ${cspSource} blob: data:`,
    `font-src ${cspSource} data:`,
    "media-src blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
