// Runs the end-to-end suites: `npm run test:e2e` (after `npm run compile`).
// Browser suites drive the real webview in headless Chrome against a fake host built on the
// compiled codec; vscode.cjs drives a real VS Code (skipped when it is not installed).
// Set PDF_E2E_SCREENSHOTS=<dir> to keep screenshots.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const runs = [
  ["comments.cjs", { WIDTH: "700" }],
  ["comments.cjs", { WIDTH: "1400" }],
  ["tools.cjs", {}],
  ["editing.cjs", {}],
  ["copilot.cjs", {}],
  ["vscode.cjs", {}],
];
let failed = 0;
for (const [file, env] of runs) {
  console.log(`\n▶ ${file} ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: "inherit", env: { ...process.env, ...env } });
  failed += result.status === 0 ? 0 : 1;
}
process.exit(failed ? 1 : 0);
