import {
  CancellationToken,
  CustomDocumentBackup,
  CustomDocumentBackupContext,
  CustomDocumentEditEvent,
  CustomEditorProvider,
  Disposable,
  Event,
  ExtensionContext,
  EventEmitter,
  Uri,
  WebviewPanel,
  commands,
  window,
  workspace,
} from "vscode";

import { PdfDocument } from "./document";
import { ViewerHtml } from "./html";
import { deletePage, insertBlankPage, movePage, rotatePage } from "./page-ops";
import { isWebviewToHostMessage, WEBVIEW_COMMANDS } from "./protocol";
import { printPdf } from "./print";
import { SaveQueue, toBytes } from "./save";
import { disposeAll } from "./utils";
import { WebviewCollection } from "./webviews";

export type PageOp = "rotate" | "delete" | "move-up" | "move-down" | "insert-before" | "insert-after";

const PAGE_COMMANDS: ReadonlyArray<[string, PageOp]> = [
  ["df.rotatePage", "rotate"],
  ["df.deletePage", "delete"],
  ["df.movePageUp", "move-up"],
  ["df.movePageDown", "move-down"],
  ["df.insertBlankPageBefore", "insert-before"],
  ["df.insertBlankPageAfter", "insert-after"],
];

/** Returns undefined when the operation would not change anything. */
export async function runPageOp(
  op: PageOp,
  bytes: Uint8Array,
  page: number,
): Promise<Uint8Array | undefined> {
  switch (op) {
    case "rotate":
      return rotatePage(bytes, page);
    case "delete":
      return deletePage(bytes, page);
    case "move-up":
      return movePage(bytes, page, -1);
    case "move-down":
      return movePage(bytes, page, 1);
    case "insert-before":
      return insertBlankPage(bytes, page, "before");
    case "insert-after":
      return insertBlankPage(bytes, page, "after");
  }
}

async function showHostError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await window.showErrorMessage(`df: ${message}`);
}

export class PdfEditProvider implements CustomEditorProvider<PdfDocument> {
  static readonly viewType = "df.viewer";

  static register(context: ExtensionContext): void {
    const provider = new PdfEditProvider(context);
    context.subscriptions.push(
      window.registerCustomEditorProvider(PdfEditProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }),
    );
    for (const [command, op] of PAGE_COMMANDS) {
      context.subscriptions.push(
        commands.registerCommand(command, (page?: number) => provider.applyPageOp(op, page)),
      );
    }
    context.subscriptions.push(
      commands.registerCommand("df.print", () => provider.printActiveDocument()),
    );
  }

  private readonly webviews = new WebviewCollection();
  private readonly saves = new SaveQueue(this.webviews);
  private readonly html: ViewerHtml;
  /** Last page reported per document, used by page-ops commands. */
  private readonly currentPage = new Map<string, number>();
  private activeDocument: PdfDocument | undefined;
  private readonly _onDidChangeCustomDocument =
    new EventEmitter<CustomDocumentEditEvent<PdfDocument>>();

  /** Edit (dirty) events surfaced to the editor tabs. */
  get onDidChangeCustomDocument(): Event<CustomDocumentEditEvent<PdfDocument>> {
    // All PdfDocument edit events are routed through this provider's documents,
    // which are created by openCustomDocument; we re-emit them here.
    return this._onDidChangeCustomDocument.event;
  }

  constructor(
    private readonly context: ExtensionContext,
    html?: ViewerHtml,
  ) {
    this.html = html ?? ViewerHtml.load(context.extensionPath);
  }

  openCustomDocument(uri: Uri): PdfDocument {
    const document = new PdfDocument(uri);
    const listeners: Disposable[] = [];
    listeners.push(
      document.onDidChange((event) =>
        this._onDidChangeCustomDocument.fire({
          document: event.document,
          label: event.dirty ? "Edit" : "Revert",
          undo: async () => undefined,
          redo: async () => undefined,
        }),
      ),
      document.onDidReload(() => this.webviews.postMessage(uri, { type: "reload" })),
      document.onDidDelete(() => disposeAll(listeners)),
    );
    return document;
  }

  async resolveCustomEditor(
    document: PdfDocument,
    panel: WebviewPanel,
    _token: CancellationToken,
  ): Promise<void> {
    this.activeDocument = document;
    this.webviews.add(document.uri, panel);
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.activeDocument = document;
      }
    });

    const resourceRoot = document.uri.with({ path: document.uri.path.replace(/\/[^/]+$/u, "/") });
    const webviewRoot = `${panel.webview.asWebviewUri(resourceRoot).toString(true).replace(/\/$/u, "")}/`;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [resourceRoot, Uri.file(this.context.extensionPath)],
    };
    panel.webview.html = this.html.render(panel.webview, {
      extensionPath: this.context.extensionPath,
      documentUri: document.uri,
      resourceRoot,
    });

    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(document, resourceRoot, webviewRoot, message);
    });
  }

  private async handleMessage(
    document: PdfDocument,
    resourceRoot: Uri,
    webviewRoot: string,
    message: unknown,
  ): Promise<void> {
    if (!isWebviewToHostMessage(message)) {
      return;
    }
    switch (message.type) {
      case "dirty":
        document.setDirty(message.dirty);
        break;
      case "page":
        this.currentPage.set(document.uri.toString(), message.page);
        break;
      case "saved": {
        const data = toBytes(message.data);
        if (!data) {
          break;
        }
        if (this.saves.isPending(document.uri)) {
          this.saves.resolve(document.uri, data);
          break;
        }
        try {
          await workspace.fs.writeFile(document.uri, data);
          document.markSaved();
        } catch (error) {
          await showHostError(error);
        }
        break;
      }
      case "print": {
        const data = toBytes(message.data);
        if (data) {
          await printPdf(data, document.uri.path.replace(/^.*\//u, ""));
        }
        break;
      }
      case "command":
        if (WEBVIEW_COMMANDS.has(message.command)) {
          await commands.executeCommand(message.command, ...(message.args ?? []));
        }
        break;
      case "error":
        await showHostError(message.error);
        break;
      case "open":
        await this.openRelativeLink(resourceRoot, webviewRoot, message.url);
        break;
    }
  }

  /** Open links that point at files next to the PDF using the normal editors. */
  private async openRelativeLink(
    resourceRoot: Uri,
    webviewRoot: string,
    url: string,
  ): Promise<void> {
    try {
      if (!url.startsWith(webviewRoot)) {
        return;
      }
      const rest = url.slice(webviewRoot.length);
      const [pathPart = "", hashPart = ""] = rest.split(/#(.*)/su);
      const relative = decodeURIComponent(pathPart);
      if (!relative) {
        return;
      }
      const target = Uri.joinPath(resourceRoot, relative).with({
        fragment: decodeURIComponent(hashPart),
      });
      await commands.executeCommand("vscode.open", target);
    } catch {
      // Ignore malformed links coming from the webview.
    }
  }

  async saveCustomDocument(document: PdfDocument, _cancellation: CancellationToken): Promise<void> {
    await this.saves.save(document);
  }

  async saveCustomDocumentAs(
    document: PdfDocument,
    destination: Uri,
    _cancellation: CancellationToken,
  ): Promise<void> {
    await this.saves.save(document, destination);
  }

  async revertCustomDocument(
    document: PdfDocument,
    cancellation: CancellationToken,
  ): Promise<void> {
    await document.revert(cancellation);
  }

  /** Persist unsaved annotation edits for hot exit. */
  async backupCustomDocument(
    document: PdfDocument,
    context: CustomDocumentBackupContext,
    _cancellation: CancellationToken,
  ): Promise<CustomDocumentBackup> {
    const data = await this.saves.request(document);
    if (data) {
      await workspace.fs.writeFile(context.destination, data);
    }
    return {
      id: context.destination.toString(),
      delete: () => {
        workspace.fs.delete(context.destination).then(undefined, () => undefined);
      },
    };
  }

  // --- Page operations -------------------------------------------------------

  async applyPageOp(op: PageOp, pageArg?: number): Promise<void> {
    const document = this.activeDocument;
    if (!document) {
      await window.showWarningMessage("df: open a PDF first.");
      return;
    }
    // Page-ops commands can be invoked with an explicit page (the right-click
    // context menu passes the page under the cursor); otherwise the last page
    // reported by the viewer is used.
    const page =
      typeof pageArg === "number" && Number.isInteger(pageArg) && pageArg > 0
        ? pageArg
        : (this.currentPage.get(document.uri.toString()) ?? 1);
    try {
      const source = new Uint8Array(await workspace.fs.readFile(document.uri));
      const result = await runPageOp(op, source, page);
      if (!result) {
        return; // no-op, e.g. moving the first page up
      }
      await workspace.fs.writeFile(document.uri, result);
      document.markExternalRewrite();
    } catch (error) {
      await showHostError(error);
    }
  }

  /** Ask the webview to serialize and send back the PDF for printing. */
  async printActiveDocument(): Promise<void> {
    const document = this.activeDocument;
    if (!document || ![...this.webviews.get(document.uri)][0]) {
      await window.showWarningMessage("df: open a PDF first.");
      return;
    }
    this.webviews.postMessage(document.uri, { type: "request-print" });
  }
}
