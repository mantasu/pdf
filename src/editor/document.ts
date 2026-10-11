import { basename } from "node:path";
import { CustomDocument, Disposable, EventEmitter, RelativePattern, Uri, workspace } from "vscode";
import type { Annot } from "../pdf/model";
import { parsePdf } from "../pdf/read";
import { mergeAnnotations } from "../pdf/write";
import type { ViewerState } from "../protocol";

/**
 * One immutable point in the edit history: the PDF the comment model refers to
 * (`working`), the model, and pdf.js's form output when there is any. Undo and
 * redo swap whole states; states compare by identity.
 */
export interface DocState {
  readonly working: Uint8Array;
  readonly annotations: readonly Annot[];
  /** pdf.js `saveDocument()` output (view bytes plus form values). */
  readonly formData?: Uint8Array;
}

interface Read {
  viewBytes: Uint8Array;
  annotations: Annot[];
  readOnly?: string;
}

/**
 * Read a file as a plain Uint8Array. `workspace.fs.readFile` may return a Node
 * Buffer, which VS Code posts to webviews as `{type: "Buffer", data}`.
 */
export async function loadPdf(uri: Uri): Promise<Uint8Array> {
  return new Uint8Array(await workspace.fs.readFile(uri));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Whether two states render as the same PDF. */
export function sameRender(a: DocState, b: DocState): boolean {
  return a.working === b.working && a.formData === b.formData;
}

/**
 * A PDF opened in the editor; the file is written only on save. `build()`
 * merges the comment model into the working PDF (or pdf.js's form output), so
 * saving is a pure function of the current state.
 */
export class PdfFile implements CustomDocument {
  private readonly parsed = new WeakMap<Uint8Array, Read>();
  private readonly disposables: Disposable[] = [];
  private lastWritten: Uint8Array | undefined;
  private _state: DocState = { working: new Uint8Array(), annotations: [] };
  private savedState: DocState = this._state;

  private readonly _onExternalChange = new EventEmitter<Uint8Array>();
  /** The file changed on disk, not because we saved it. */
  readonly onExternalChange = this._onExternalChange.event;

  /** `fromBackup`: the bytes are unsaved work restored after a restart, so the document starts dirty. */
  static async open(uri: Uri, bytes: Uint8Array, fromBackup = false): Promise<PdfFile> {
    const file = new PdfFile(uri);
    const state = await file.parse(bytes);
    file._state = state;
    if (!fromBackup) {
      file.savedState = state;
    }
    return file;
  }

  private constructor(readonly uri: Uri) {
    const watcher = workspace.createFileSystemWatcher(
      new RelativePattern(Uri.joinPath(uri, ".."), basename(uri.path)),
    );
    this.disposables.push(watcher, this._onExternalChange);
    watcher.onDidChange(() => void this.pollDisk(), undefined, this.disposables);
    watcher.onDidCreate(() => void this.pollDisk(), undefined, this.disposables);
  }

  get state(): DocState {
    return this._state;
  }

  /** True when the state differs from the one last loaded from or saved to disk. */
  get dirty(): boolean {
    return this._state !== this.savedState;
  }

  get readOnly(): string | undefined {
    return this.parsed.get(this._state.working)?.readOnly;
  }

  /** What the viewer needs to display a state. */
  view(state: DocState = this._state): { data: Uint8Array; annotations: Annot[]; readOnly?: string } {
    const read = this.parsed.get(state.working);
    return {
      data: state.formData ?? read?.viewBytes ?? state.working,
      annotations: [...state.annotations],
      ...(read?.readOnly ? { readOnly: read.readOnly } : {}),
    };
  }

  /** Parse a PDF into a fresh state (cached per byte array). */
  async parse(working: Uint8Array): Promise<DocState> {
    let read = this.parsed.get(working);
    if (!read) {
      read = await parsePdf(working);
      this.parsed.set(working, read);
    }
    return { working, annotations: read.annotations };
  }

  /** Adopt a state that matches the file on disk (open, revert, reload). */
  replace(state: DocState): void {
    this._state = state;
    this.savedState = state;
  }

  /** Move to another history state (edit, undo, redo). */
  setState(state: DocState): void {
    this._state = state;
  }

  /** The bytes to write to disk for the viewer's current state. */
  async build(snapshot: ViewerState): Promise<Uint8Array> {
    const base = snapshot.formData ?? this._state.formData ?? this._state.working;
    return this.readOnly ? base : mergeAnnotations(base, snapshot.annotations);
  }

  /** Call before writing our own bytes so the file event is not seen as external. */
  expectWrite(bytes: Uint8Array): void {
    this.lastWritten = bytes;
  }

  /** Call after a successful save of `state`. */
  markSaved(state: DocState): void {
    this.savedState = state;
  }

  private async pollDisk(): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await loadPdf(this.uri);
    } catch {
      return;
    }
    if ((this.lastWritten && equalBytes(bytes, this.lastWritten)) || equalBytes(bytes, this._state.working)) {
      return;
    }
    this._onExternalChange.fire(bytes);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
