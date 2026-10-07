import type { Disposable } from "vscode";

export function disposeAll(disposables: Iterable<Disposable>): void {
  for (const d of disposables) {
    d.dispose();
  }
}

/** JSON-encode a value so it can be embedded in an HTML attribute. */
export function escapeAttribute(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
