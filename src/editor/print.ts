import { exec } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Uri, env, window, workspace } from "vscode";

/**
 * Webviews cannot print (`window.print()` is a no-op), so the host writes the
 * PDF to a temp file and runs the user's print command on it, or opens it with
 * the OS default PDF application.
 */
export async function printDocument(data: Uint8Array, name: string): Promise<void> {
  const command = workspace.getConfiguration("pdf-editor").get<string>("printCommand", "").trim();
  const file = join(await mkdtemp(join(tmpdir(), "pdf-print-")), name.endsWith(".pdf") ? name : `${name}.pdf`);
  const uri = Uri.file(file);
  await workspace.fs.writeFile(uri, data);
  try {
    if (command) {
      await spawn(command, file);
      workspace.fs.delete(uri).then(undefined, () => undefined);
    } else {
      // The external application reads the file later; the OS cleans tmp up.
      await env.openExternal(uri);
      window.setStatusBarMessage(`PDF Viewer: opened ${name} for printing`, 5000);
    }
  } catch (error) {
    await window.showErrorMessage(`PDF Viewer: printing failed — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function spawn(command: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = exec(`${command} "${file.replaceAll('"', '\\"')}"`, (error) => (error ? reject(error) : resolve()));
    child.stdin?.end();
  });
}
