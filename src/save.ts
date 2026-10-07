import { Uri, workspace } from "vscode";
import type { WebviewCollection } from "./webviews";
import type { PdfDocument } from "./document";

const SAVE_TIMEOUT_MS = 15_000;

/** Serialized bytes from a webview, normalized to Uint8Array. */
export function toBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return undefined;
}

/**
 * Round-trips save requests: asks the webview to serialize the edited PDF
 * and waits for the bytes (with a timeout guard).
 */
export class SaveQueue {
  private readonly pending = new Map<string, (data: Uint8Array | undefined) => void>();

  constructor(private readonly webviews: WebviewCollection) {}

  /** True when a save round-trip is in flight (a toolbar `saved` belongs to it). */
  isPending(resource: Uri): boolean {
    return this.pending.has(resource.toString());
  }

  resolve(resource: Uri, data: Uint8Array | undefined): void {
    const key = resource.toString();
    const resolve = this.pending.get(key);
    this.pending.delete(key);
    resolve?.(data);
  }

  request(document: PdfDocument): Promise<Uint8Array | undefined> {
    const key = document.uri.toString();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve(undefined);
      }, SAVE_TIMEOUT_MS);
      this.pending.set(key, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.webviews.postMessage(document.uri, { type: "request-save" });
    });
  }

  /** Request bytes and write them to disk, clearing the document's dirty flag. */
  async save(document: PdfDocument, destination?: Uri): Promise<void> {
    const data = await this.request(document);
    if (!data) {
      throw new Error("Timed out while saving the PDF.");
    }
    await workspace.fs.writeFile(destination ?? document.uri, data);
    document.markSaved();
  }
}
