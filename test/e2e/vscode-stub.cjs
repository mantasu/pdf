// Minimal stand-in for the vscode module, enough for out/editor/html.js.
const path = require("node:path");
class Uri {
  constructor(scheme, p, fragment = "") { this.scheme = scheme; this.path = p; this.fragment = fragment; }
  static file(p) { return new Uri("file", p); }
  static joinPath(base, ...parts) { return new Uri(base.scheme, path.posix.join(base.path, ...parts)); }
  with(c) { return new Uri(c.scheme ?? this.scheme, c.path ?? this.path, c.fragment ?? this.fragment); }
  get fsPath() { return this.path; }
  toString() { return `${this.scheme}://${this.path}`; }
}
module.exports = { Uri, workspace: { getConfiguration: () => ({ get: (_k, d) => d }) } };
