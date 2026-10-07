/**
 * Shared plumbing for the df webview modules: the VS Code bridge, viewer
 * accessors and the configuration injected by the extension host.
 */

const vscode = acquireVsCodeApi();

/** Configuration sent by the host (see src/protocol.ts ViewerConfig). */
export const config = JSON.parse(
  document.querySelector("#df-config")?.dataset.config ?? "{}",
);

/** Send a message to the extension host. */
export function post(message) {
  vscode.postMessage(message);
}

/** Report an error to the host, which surfaces it as a notification. */
export function postError(error) {
  post({
    type: "error",
    error: error instanceof Error ? error.message : String(error),
  });
}

export const app = () => globalThis.PDFViewerApplication;
export const bus = () => app().eventBus;
/** The annotation editor UI manager, once a document is loaded. */
export const ui = () => app().pdfViewer?._layerProperties?.annotationEditorUIManager;

/** `D:YYYYMMDDHHmmSS` — the PDF date format, in UTC. */
export function pdfDate(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

/** Convert a client (viewport) point on a page view to PDF coordinates. */
export function toPdfPoint(view, clientX, clientY) {
  const rect = view.div.getBoundingClientRect();
  return view.viewport.convertToPdfPoint(clientX - rect.left, clientY - rect.top);
}

/** The page view under a client point, if any. */
export function pageViewFromPoint(clientX, clientY) {
  for (const view of app().pdfViewer?._pages ?? []) {
    const rect = view?.div?.getBoundingClientRect?.();
    if (rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return view;
    }
  }
  return undefined;
}
