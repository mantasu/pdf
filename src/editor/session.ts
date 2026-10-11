import { CancellationTokenSource, Disposable, WebviewPanel } from "vscode";
import type { Annot } from "../pdf/model";
import type { DocContext, ToHost, ToWebview, ViewerState } from "../protocol";
import { isToHost } from "../protocol";

const REPLY_TIMEOUT_MS = 15_000;

/** Typed arrays may arrive as plain ArrayBuffers depending on the transport. */
export function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  return value instanceof ArrayBuffer ? new Uint8Array(value) : undefined;
}

/** The @pdf context reported by the viewer, when well-formed. */
export function readDocContext(raw: unknown): DocContext | undefined {
  const value = raw as Partial<DocContext> | undefined;
  if (!value || !Array.isArray(value.pages) || !value.pages.every((p) => typeof p === "string") || typeof value.page !== "number") {
    return undefined;
  }
  const selection = value.selection && typeof value.selection.text === "string" && typeof value.selection.page === "number" ? value.selection : undefined;
  const marks = Object.fromEntries(Object.entries(value.marks ?? {}).filter(([, text]) => typeof text === "string"));
  return { pages: value.pages, page: value.page, ...(selection && { selection }), marks };
}

function readViewerState(raw: unknown): ViewerState | undefined {
  const value = raw as { annotations?: unknown; formData?: unknown } | undefined;
  if (!value || !Array.isArray(value.annotations)) {
    return undefined;
  }
  const formData = asBytes(value.formData);
  return { annotations: value.annotations as Annot[], ...(formData ? { formData } : {}) };
}

/** The connection to one viewer webview. */
export class ViewLink implements Disposable {
  private nextId = 1;
  private readonly waiting = new Map<number, (value: unknown) => void>();
  private readonly disposables: Disposable[] = [];
  /** Copilot requests in flight, keyed by the viewer's request id. */
  readonly pendingChat = new Map<number, CancellationTokenSource>();

  constructor(
    readonly panel: WebviewPanel,
    onMessage: (message: ToHost) => void,
  ) {
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!isToHost(message)) {
          return;
        }
        if (message.type === "snapshot" || message.type === "context") {
          this.settle(message.requestId, message.type === "snapshot" ? message.snapshot : message.context);
        } else {
          onMessage(message);
        }
      }),
    );
  }

  post(message: ToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  /** Ask the viewer something and wait for a valid answer. */
  private ask<T>(message: (requestId: number) => ToWebview, parse: (raw: unknown) => T | undefined): Promise<T> {
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("The PDF viewer did not respond."));
      }, REPLY_TIMEOUT_MS);
      this.waiting.set(requestId, (raw) => {
        clearTimeout(timer);
        const value = raw === undefined ? undefined : parse(raw);
        if (value) {
          resolve(value);
        } else {
          reject(new Error("The PDF viewer sent an invalid response."));
        }
      });
      this.post(message(requestId));
    });
  }

  /** The viewer's annotations and form data; `flush` commits text being typed first. */
  fetchState(flush = true): Promise<ViewerState> {
    return this.ask((requestId) => ({ type: "request-snapshot", requestId, flush }), readViewerState);
  }

  /** The text, page in view, selection and marked text, for @pdf. */
  fetchContext(): Promise<DocContext> {
    return this.ask((requestId) => ({ type: "request-context", requestId }), readDocContext);
  }

  private settle(requestId: number, raw: unknown): void {
    const callback = this.waiting.get(requestId);
    this.waiting.delete(requestId);
    callback?.(raw ?? null);
  }

  dispose(): void {
    for (const callback of this.waiting.values()) {
      callback(undefined);
    }
    this.waiting.clear();
    for (const source of this.pendingChat.values()) {
      source.cancel();
    }
    this.pendingChat.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
