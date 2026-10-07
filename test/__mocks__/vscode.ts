import { vi } from "vitest";

export class Uri {
  scheme: string;
  path: string;
  fragment = "";

  private constructor(scheme: string, path: string) {
    this.scheme = scheme;
    this.path = path;
  }

  static file(path: string): Uri {
    return new Uri("file", path);
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, `${base.path.replace(/\/$/u, "")}/${parts.join("/")}`);
  }

  with(change: { scheme?: string; path?: string; fragment?: string }): Uri {
    const next = new Uri(change.scheme ?? this.scheme, change.path ?? this.path);
    next.fragment = change.fragment ?? this.fragment;
    return next;
  }

  toString(): string {
    const base = `${this.scheme}://${this.path}`;
    return this.fragment ? `${base}#${this.fragment}` : base;
  }

  get fsPath(): string {
    return this.path;
  }
}

export class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose(): void {}
}

export class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string,
  ) {}
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => unknown> = [];

  event = (listener: (e: T) => unknown) => {
    this.listeners.push(listener);
    return { dispose: () => void this.listeners.splice(this.listeners.indexOf(listener), 1) };
  };

  fire = (data: T) => {
    for (const listener of [...this.listeners]) {
      listener(data);
    }
  };

  dispose = () => {
    this.listeners = [];
  };

  /** Test helper. */
  get listenerCount(): number {
    return this.listeners.length;
  }
}

export const disposables: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];

function makeDisposable() {
  const d = { dispose: vi.fn() };
  disposables.push(d);
  return d;
}

export const fileWrites: Array<{ uri: Uri; content: Uint8Array }> = [];
export const writtenFiles = new Map<string, Uint8Array>();

export interface FakeWatcher {
  onDidChange: (listener: (uri: Uri) => unknown) => { dispose: () => void };
  onDidDelete: (listener: (uri: Uri) => unknown) => { dispose: () => void };
  fireChange: (uri: Uri) => void;
  fireDelete: (uri: Uri) => void;
  dispose: ReturnType<typeof vi.fn>;
}

export const watchers: FakeWatcher[] = [];

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
  })),
  createFileSystemWatcher: vi.fn((): FakeWatcher => {
    const changeListeners: Array<(uri: Uri) => unknown> = [];
    const deleteListeners: Array<(uri: Uri) => unknown> = [];
    const watcher: FakeWatcher = {
      onDidChange: (listener) => {
        changeListeners.push(listener);
        return { dispose: vi.fn() };
      },
      onDidDelete: (listener) => {
        deleteListeners.push(listener);
        return { dispose: vi.fn() };
      },
      fireChange: (uri) => changeListeners.forEach((l) => l(uri)),
      fireDelete: (uri) => deleteListeners.forEach((l) => l(uri)),
      dispose: vi.fn(),
    };
    watchers.push(watcher);
    return watcher;
  }),
  fs: {
    readFile: vi.fn(async (uri: Uri) => writtenFiles.get(uri.toString()) ?? new Uint8Array()),
    writeFile: vi.fn(async (uri: Uri, content: Uint8Array) => {
      fileWrites.push({ uri, content });
      writtenFiles.set(uri.toString(), content);
    }),
    delete: vi.fn(async (uri: Uri) => {
      writtenFiles.delete(uri.toString());
    }),
  },
};

export const shownMessages: string[] = [];
export const shownErrors: string[] = [];

export const statusMessages: string[] = [];

export const window = {
  registerCustomEditorProvider: vi.fn(() => makeDisposable()),
  setStatusBarMessage: vi.fn((message: string) => {
    statusMessages.push(message);
    return { dispose: vi.fn() };
  }),
  showErrorMessage: vi.fn((message: string) => {
    shownErrors.push(message);
    return Promise.resolve(undefined);
  }),
  showWarningMessage: vi.fn((message: string) => {
    shownMessages.push(message);
    return Promise.resolve(undefined);
  }),
};

export const openedExternally: Uri[] = [];

export const env = {
  openExternal: vi.fn(async (uri: Uri) => {
    openedExternally.push(uri);
    return true;
  }),
};

export const executedCommands: Array<{ command: string; args: unknown[] }> = [];

export const commands = {
  registerCommand: vi.fn((command: string, callback: (...args: unknown[]) => unknown) => {
    (commands as Record<string, unknown>)[`__handler_${command}`] = callback;
    return makeDisposable();
  }),
  executeCommand: vi.fn(async (command: string, ...args: unknown[]) => {
    executedCommands.push({ command, args });
    return undefined;
  }),
};

export enum ViewColumn {
  Active = -1,
}
