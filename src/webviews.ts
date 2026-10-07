import { Uri, WebviewPanel } from "vscode";

/** Index of open webview panels keyed by document URI. */
export class WebviewCollection {
  private readonly byUri = new Map<string, Set<WebviewPanel>>();

  add(resource: Uri, panel: WebviewPanel): void {
    const key = resource.toString();
    let set = this.byUri.get(key);
    if (!set) {
      set = new Set();
      this.byUri.set(key, set);
    }
    set.add(panel);
    panel.onDidDispose(() => {
      set.delete(panel);
      if (set.size === 0) {
        this.byUri.delete(key);
      }
    });
  }

  get(resource: Uri): Iterable<WebviewPanel> {
    return this.byUri.get(resource.toString()) ?? [];
  }

  postMessage(resource: Uri, message: unknown): void {
    for (const panel of this.get(resource)) {
      void panel.webview.postMessage(message);
    }
  }
}
