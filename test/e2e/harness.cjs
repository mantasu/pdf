// Browser harness for the viewer webview: serves the real extension HTML and
// assets, replaces acquireVsCodeApi with a bridge to a fake host that uses the
// real compiled codec (out/pdf) and an undo/redo stack like VS Code's.
// Requires `npm run compile` and a local Chrome (or PDF_E2E_CHANNEL=chromium /
// msedge with a matching Playwright browser).
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const os = require("node:os");
const { chromium } = require("playwright-core");

const REPO = path.resolve(__dirname, "../..");

// out/editor/html.js imports "vscode"; give it the small stand-in.
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(this, request === "vscode" ? path.join(__dirname, "vscode-stub.cjs") : request, ...rest);
};
const { parsePdf } = require(`${REPO}/out/pdf/read.js`);
const { mergeAnnotations } = require(`${REPO}/out/pdf/write.js`);
const { perform } = require(`${REPO}/out/pdf/pages.js`);
const { HtmlBuilder } = require(`${REPO}/out/editor/html.js`);
const { Uri } = require("vscode");

const MIME = {
  ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".html": "text/html",
  ".json": "application/json", ".wasm": "application/wasm", ".pdf": "application/pdf",
  ".svg": "image/svg+xml", ".png": "image/png", ".ftl": "text/plain", ".bcmap": "application/octet-stream",
  ".ttf": "font/ttf", ".pfb": "application/octet-stream", ".icc": "application/octet-stream",
};

const SHIM = `(() => {
  const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const enc = (v) => v instanceof Uint8Array ? { __b64: toB64(v) } : Array.isArray(v) ? v.map(enc) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) : v;
  const dec = (v) => v && typeof v === "object" && "__b64" in v ? fromB64(v.__b64) : Array.isArray(v) ? v.map(dec) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)])) : v;
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__toHost(enc(m)), getState() {}, setState() {} });
  window.__fromHost = (m) => window.postMessage(dec(m), "*");
})();`;

const encode = (v) =>
  v instanceof Uint8Array ? { __b64: Buffer.from(v).toString("base64") }
  : Array.isArray(v) ? v.map(encode)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]))
  : v;
const decode = (v) =>
  v && typeof v === "object" && "__b64" in v ? new Uint8Array(Buffer.from(v.__b64, "base64"))
  : Array.isArray(v) ? v.map(decode)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]))
  : v;

class Host {
  constructor(page, bytes, savePath) {
    this.page = page;
    this.savePath = savePath;
    this.log = [];
    this.parsed = new Map();
    this.past = [];
    this.future = [];
    this.pending = new Map();
    this.nextId = 1;
    this.bytes = bytes;
    this.saves = 0;
    this.printed = 0;
    this.copilot = [];
    this.chat = [];
    this.cancelled = new Set();
  }
  async parse(working) {
    if (!this.parsed.has(working)) this.parsed.set(working, await parsePdf(working));
    return { working, annotations: this.parsed.get(working).annotations };
  }
  view(state) {
    const p = this.parsed.get(state.working);
    return { data: state.formData ?? p.viewBytes, annotations: state.annotations, ...(p.readOnly ? { readOnly: p.readOnly } : {}) };
  }
  sameView(a, b) { return a.working === b.working && a.formData === b.formData; }
  async init() { this.state = await this.parse(this.bytes); }
  async answerQuestion({ requestId, action, question }) {
    if (question === "fail") {
      await this.send({ type: "copilot-done", requestId, error: "GitHub Copilot is not available. Install GitHub Copilot Chat and sign in, then try again." });
      return;
    }
    const answer = `## ${action}\n\nThe passage relates energy and mass: \\(E = mc^2\\), with **c** the speed of light.\n\n- uses \`code\`\n- and *care*`;
    for (const chunk of answer.match(/[\s\S]{1,10}/gu)) {
      if (this.cancelled.has(requestId)) break;
      await this.send({ type: "copilot-text", requestId, text: chunk });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await this.send({ type: "copilot-done", requestId });
  }
  send(msg) { return this.page.evaluate((m) => window.__fromHost(m), encode(msg)); }
  record(label, before, after) {
    this.state = after;
    this.past.push({ label, before, after });
    this.future = [];
    if (!this.sameView(before, after)) this.send({ type: "load", ...this.view(after) });
  }
  show(state, previous) {
    if (this.sameView(previous, state)) this.send({ type: "annotations", annotations: state.annotations });
    else this.send({ type: "load", ...this.view(state) });
  }
  /** Like the provider: save and page operations commit what is being typed; form edits do not. */
  async snapshot(flush = true) {
    const requestId = this.nextId++;
    const result = new Promise((resolve) => this.pending.set(requestId, resolve));
    await this.send({ type: "request-snapshot", requestId, flush });
    return result;
  }
  async build(snapshot) {
    return mergeAnnotations(snapshot.formData ?? this.state.formData ?? this.state.working, snapshot.annotations);
  }
  async onMessage(raw) {
    const msg = decode(raw);
    this.log.push(msg);
    switch (msg.type) {
      case "ready":
        await this.send({ type: "load", ...this.view(this.state), page: 1 });
        break;
      case "snapshot":
        this.pending.get(msg.requestId)?.(msg.snapshot);
        break;
      case "edit":
        this.record(msg.label, this.state, { working: this.state.working, annotations: msg.annotations });
        break;
      case "form-edit": {
        const { formData } = await this.snapshot(false);
        if (formData) {
          const before = this.state;
          this.state = { ...before, formData };
          this.past.push({ label: "form", before, after: this.state });
          this.future = [];
        }
        break;
      }
      case "copilot":
        // A stand-in for Copilot: streams a canned Markdown answer (or fails for the question "fail").
        this.copilot.push(msg);
        void this.answerQuestion(msg);
        break;
      case "copilot-cancel":
        this.cancelled.add(msg.requestId);
        break;
      case "error":
        console.error("WEBVIEW ERROR:", msg.message);
        break;
      case "command":
        await this.command(msg.command, msg.args ?? []);
        break;
      default:
        break;
    }
  }
  async command(command, args) {
    if (command === "undo") {
      const entry = this.past.pop();
      if (entry) { this.future.push(entry); const prev = this.state; this.state = entry.before; this.show(entry.before, prev); }
    } else if (command === "redo") {
      const entry = this.future.pop();
      if (entry) { this.past.push(entry); const prev = this.state; this.state = entry.after; this.show(entry.after, prev); }
    } else if (command === "workbench.action.files.save") {
      const bytes = await this.build(await this.snapshot());
      fs.writeFileSync(this.savePath, bytes);
      this.saves++;
    } else if (command === "pdf.print") {
      this.printed++;
    } else if (command === "pdf.askInChat") {
      this.chat.push(args);
    } else if (command.startsWith("pdf.")) {
      const ops = { "pdf.rotatePage": "rotate", "pdf.deletePage": "delete", "pdf.movePageUp": "move-up", "pdf.movePageDown": "move-down", "pdf.insertBlankPageBefore": "insert-before", "pdf.insertBlankPageAfter": "insert-after" };
      const merged = await this.build(await this.snapshot());
      const result = await perform(ops[command], merged, args[0] ?? 1);
      if (result) this.record(command, await this.parse(merged), await this.parse(result));
    }
  }
}

async function start({ pdf, width = 1400, height = 900, savePath = path.join(os.tmpdir(), "pdf-e2e-saved.pdf"), colorScheme = "light" }) {
  const bytes = new Uint8Array(fs.readFileSync(pdf));
  const pdfDir = path.dirname(pdf);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === "/shim.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(SHIM);
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(server.html);
    }
    if (url.pathname.startsWith("/fs/")) {
      const file = decodeURIComponent(url.pathname.slice(3));
      if ((file.startsWith(REPO) || file.startsWith(pdfDir)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        return res.end(fs.readFileSync(file));
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const webview = {
    cspSource: origin,
    asWebviewUri: (uri) => ({ toString: () => `${origin}/fs${uri.path}` }),
  };
  server.html = new HtmlBuilder(REPO, fs.readFileSync(`${REPO}/resources/pdf.js/web/viewer.html`, "utf8"))
    .render(webview, Uri.file(pdf))
    .replace("<head>", '<head>\n<script src="/shim.js"></script>');

  const browser = await chromium.launch({ channel: process.env.PDF_E2E_CHANNEL ?? "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  const host = new Host(page, bytes, savePath);
  await host.init();
  await page.exposeFunction("__toHost", (m) => host.onMessage(m));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelectorAll(".page canvas").length > 0 && document.querySelector(".pdf-ui-layer"), null, { timeout: 20000 });
  await page.waitForTimeout(300);
  return {
    page, host, errors, origin,
    close: async () => { await browser.close(); server.close(); },
  };
}

module.exports = { start, REPO };
