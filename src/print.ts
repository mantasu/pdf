import { exec } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Uri, env, window, workspace } from "vscode";

/**
 * Printing from a webview is not possible (`window.print()` is a no-op), so
 * the viewer asks the host to print. We write the current bytes to a temp
 * file and either pipe them to a user-configured command or hand the file to
 * the OS default handler.
 */
export async function printPdf(data: Uint8Array, name: string): Promise<void> {
  const command = workspace.getConfiguration("df").get<string>("printCommand", "").trim();
  const file = join(tmpdir(), `df-print-${Date.now()}.pdf`);
  const uri = Uri.file(file);
  await workspace.fs.writeFile(uri, data);
  try {
    if (command) {
      await runCommand(command, file);
    } else {
      await env.openExternal(uri);
      window.setStatusBarMessage(`df: opened ${name} for printing`, 5000);
    }
  } catch (error) {
    await window.showErrorMessage(
      `df: printing failed — ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    workspace.fs.delete(uri).then(undefined, () => undefined);
  }
}

function runCommand(command: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // The file path is ours (random name in tmpdir); the command is user config.
    const child = exec(`${command} "${file}"`, (error) => (error ? reject(error) : resolve()));
    child.stdin?.end();
  });
}
