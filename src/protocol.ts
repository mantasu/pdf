/** Message protocol between the extension host and the viewer webview. */

/** Webview -> extension. */
export type WebviewToHostMessage =
  | { type: "dirty"; dirty: boolean }
  | { type: "page"; page: number }
  | { type: "saved"; data: Uint8Array }
  | { type: "error"; error: string }
  | { type: "print"; data: Uint8Array }
  | { type: "command"; command: string; args?: unknown[] }
  | { type: "open"; url: string };

/** Extension -> webview. */
export type HostToWebviewMessage =
  | { type: "request-save" }
  | { type: "request-print" }
  | { type: "reload"; page?: number };

export interface ViewerConfig {
  /** Webview URI of the PDF file itself. */
  url: string;
  /** Webview URI of the directory containing the PDF (for relative links). */
  resourceRoot: string;
  /** Webview URI of the pdf.js build directory. */
  pdfJsBuild: string;
  /** Webview URI of the pdf.js web directory. */
  pdfJsWeb: string;
  defaultZoomValue: string;
  sidebarViewOnLoad: number;
  annotationEditorMode: number;
  /** Comma-separated `Name=#RRGGBB` highlight color presets. */
  highlightColors: string;
  freeTextColor: string;
  freeTextFontSize: number;
  /** Base font for new free-text boxes: Helv, Times-Roman or Courier. */
  freeTextFontFamily: string;
  inkColor: string;
  /** Author (`/T`) stamped onto new comments; defaults to the OS user name. */
  authorName: string;
}

export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** Commands the webview is allowed to request from the host (context menu). */
export const WEBVIEW_COMMANDS = new Set<string>([
  "df.rotatePage",
  "df.deletePage",
  "df.movePageUp",
  "df.movePageDown",
  "df.insertBlankPageBefore",
  "df.insertBlankPageAfter",
  "df.save",
  "df.print",
]);
