import {
  CancellationToken,
  CustomDocument,
  Disposable,
  Event,
  EventEmitter,
  FileSystemWatcher,
  RelativePattern,
  Uri,
  workspace,
} from "vscode";

/** Dirty-state change for a {@link PdfDocument}. */
export interface PdfDocumentEditEvent {
  readonly document: PdfDocument;
  readonly dirty: boolean;
}

/**
 * A PDF opened in a custom editor. Tracks unsaved annotation edits (dirty
 * flag) and reload events caused by changes to the file on disk.
 */
export class PdfDocument implements CustomDocument {
  private _dirty = false;
  private _lastSelfSave = 0;

  private readonly _onDidChange = new EventEmitter<PdfDocumentEditEvent>();
  /** External change on disk (not caused by our own save). */
  private readonly _onDidReload = new EventEmitter<Uri>();
  private readonly _onDidDelete = new EventEmitter<Uri>();

  readonly onDidChange: Event<PdfDocumentEditEvent> = this._onDidChange.event;
  readonly onDidReload: Event<Uri> = this._onDidReload.event;
  readonly onDidDelete: Event<Uri> = this._onDidDelete.event;

  private readonly watcher: FileSystemWatcher;

  constructor(readonly uri: Uri) {
    const folder = uri.with({ path: uri.path.replace(/[^/]+$/u, "") });
    this.watcher = workspace.createFileSystemWatcher(
      new RelativePattern(folder, uri.path.replace(/^.*\//u, "")),
    );
    this.watcher.onDidChange((changed) => {
      if (changed.toString() !== this.uri.toString()) {
        return;
      }
      // Ignore the change event caused by our own saves.
      if (Date.now() - this._lastSelfSave < 2000) {
        return;
      }
      this._onDidReload.fire(this.uri);
    });
    this.watcher.onDidDelete((deleted) => {
      if (deleted.toString() === this.uri.toString()) {
        this._onDidDelete.fire(this.uri);
      }
    });
  }

  get dirty(): boolean {
    return this._dirty;
  }

  /** Called by the provider when the webview reports annotation changes. */
  setDirty(dirty: boolean): void {
    if (dirty === this._dirty) {
      return;
    }
    this._dirty = dirty;
    this._onDidChange.fire({ document: this, dirty });
  }

  /** Called after bytes were written by us; resets dirty and mutes the watcher. */
  markSaved(): void {
    this._lastSelfSave = Date.now();
    this.setDirty(false);
  }

  /** Called when a page-ops command rewrote the file underneath the viewer. */
  markExternalRewrite(): void {
    this._lastSelfSave = Date.now();
    this.setDirty(false);
    this._onDidReload.fire(this.uri);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  revert(_token: CancellationToken): Promise<void> {
    this.setDirty(false);
    this._onDidReload.fire(this.uri);
    return Promise.resolve();
  }

  dispose(): void {
    this.watcher.dispose();
    this._onDidChange.dispose();
    this._onDidReload.dispose();
    this._onDidDelete.dispose();
  }
}
