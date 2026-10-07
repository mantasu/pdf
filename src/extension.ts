import { ExtensionContext, commands } from "vscode";
import { PdfEditProvider } from "./provider";

export function activate(context: ExtensionContext): void {
  PdfEditProvider.register(context);
  // Handy alias so users can save from the command palette while focused in the viewer.
  context.subscriptions.push(
    commands.registerCommand("df.save", () =>
      commands.executeCommand("workbench.action.files.save"),
    ),
  );
}

export function deactivate(): void {
  // All disposables are registered on the extension context.
}
