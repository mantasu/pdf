import type { ExtensionContext } from "vscode";
import { PdfProvider } from "./editor/provider";

export function activate(context: ExtensionContext): void {
  PdfProvider.register(context);
}

export function deactivate(): void {}
