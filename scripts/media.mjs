// Regenerates the README media in resources/media from a real VS Code running this extension on
// example.pdf (macOS path by default, else set PDF_VSCODE): banner.gif, a scripted tour captured
// from the window's compositor over CDP and encoded here, and the screenshot-*.png crops.
// `node scripts/media.mjs banner` or `... screenshots` makes just one.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gifenc from "gifenc";
import { GifWriter } from "omggif";
import { PNG } from "pngjs";
import { _electron } from "playwright-core";

const ROOT = join(import.meta.dirname, "..");
const MEDIA = join(ROOT, "resources", "media");
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const CODE = process.env.PDF_VSCODE ?? "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
const [WIDTH, HEIGHT, FPS] = [1000, 500, 12];

const SETTINGS = {
  "window.zoomLevel": 0,
  "window.titleBarStyle": "native",
  "window.customTitleBarVisibility": "never",
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.startupEditor": "none",
  "workbench.layoutControl.enabled": false,
  "workbench.activityBar.location": "hidden",
  "workbench.statusBar.visible": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.tips.enabled": false,
  "breadcrumbs.enabled": false,
  "chat.commandCenter.enabled": false,
  "pdf.authorName": "John",
};

/** Runs `script(win, frame, folder)` with example.pdf open in a fresh `width`×`height` VS Code window. */
async function withExample([width, height], script) {
  const home = mkdtempSync(join(tmpdir(), "pdf-vscode-"));
  const folder = join(home, "paper");
  mkdirSync(join(home, "user", "User"), { recursive: true });
  mkdirSync(folder);
  writeFileSync(join(home, "user", "User", "settings.json"), JSON.stringify(SETTINGS));
  copyFileSync(join(ROOT, "resources", "example.pdf"), join(folder, "example.pdf"));
  const app = await _electron.launch({
    executablePath: CODE,
    args: [`--extensionDevelopmentPath=${ROOT}`, `--user-data-dir=${home}/user`, `--extensions-dir=${home}/ext`, "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--new-window", folder],
  });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await win.waitForTimeout(4000);
    await win.keyboard.press(`${MOD}+b`); // hide the side bar
    const frame = await open(win, "example.pdf");
    await addOverlay(win);
    await script(win, frame, folder);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
}

/** Opens a file through Quick Open and returns the viewer's frame once all of it has rendered. */
async function open(win, file) {
  await win.keyboard.press("F1");
  await win.waitForTimeout(400);
  await win.keyboard.press("Backspace");
  await win.keyboard.type(file);
  await win.waitForTimeout(600);
  await win.keyboard.press("Enter");
  for (let i = 0; i < 200; i++, await win.waitForTimeout(100)) {
    for (const frame of win.frames().filter((f) => f.url().includes("fake.html"))) {
      if ((await frame.evaluate(() => PDFViewerApplication.pdfDocument?.numPages).catch(() => 0)) === 3) {
        await frame.locator(".pdf-textbox .pdf-math svg").first().waitFor({ timeout: 10000 });
        return frame;
      }
    }
  }
  throw new Error(`${file} never opened in the viewer`);
}

const OVERLAY_CSS = `
  #demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; transform: translate(-60px, -60px); filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.4)); }
  #demo-cursor i { position: absolute; left: -12px; top: -12px; width: 24px; height: 24px; border-radius: 50%; background: rgb(64 156 255 / 0.45); transform: scale(0); transition: transform 160ms ease-out; }
  #demo-cursor.down i { transform: scale(1); }
  #demo-caption { position: fixed; left: 50%; bottom: 26px; z-index: 2147483646; transform: translateX(-50%); pointer-events: none; opacity: 0; transition: opacity 250ms;
    padding: 10px 22px; border-radius: 999px; background: rgb(20 20 28 / 0.86); color: #fff; font: 600 22px system-ui, sans-serif; box-shadow: 0 6px 24px rgb(0 0 0 / 0.3); }
  #demo-card { position: fixed; inset: 0; z-index: 2147483645; display: none; align-items: center; justify-content: center; gap: 34px;
    background: rgb(24 24 27 / 0.94); color: #f2f2f5; font: 400 30px/1.35 system-ui, sans-serif; text-align: center; }
  #demo-card h1 { margin: 0 0 16px; font-size: 64px; line-height: 1.1; color: #5aa2ff; }
  #demo-card p { margin: 0; color: #b9b9c6; }
  #demo-card span { display: inline-block; margin: 28px 5px 0; padding: 7px 16px; border: 1px solid #44444c; border-radius: 999px; background: #2a2a30; color: #e6e6ec; font: 500 19px system-ui, sans-serif; }
  #demo-card.image div { max-width: 400px; text-align: left; font-size: 24px; }
  #demo-card.image h1 { font-size: 40px; color: #f2f2f5; }
  #demo-card figure { margin: 0; color: #a0a0ae; font: 500 15px system-ui, sans-serif; }
  #demo-card img { display: block; height: 76vh; margin-bottom: 10px; border-radius: 6px; box-shadow: 0 10px 34px rgb(0 0 0 / 0.25); }
`;

/** Adds `window.demo` to the workbench: `cursor(x, y, down)`, `caption(text)` and `card({ title, ... })`. */
function addOverlay(win) {
  return win.evaluate((css) => {
    const el = (tag, props, ...children) => {
      const node = Object.assign(document.createElement(tag), props);
      node.append(...children);
      return node;
    };
    // The workbench takes stylesheets and DOM nodes but blocks innerHTML (Trusted Types).
    const svg = (tag, attrs) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
      Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
      return node;
    };
    const arrow = svg("svg", { viewBox: "0 0 24 24", width: "26" });
    arrow.append(svg("path", { d: "M3 2 L3 19 L7.5 14.8 L10.6 21.5 L13.4 20.3 L10.4 13.7 L16.5 13.7 Z", fill: "#111", stroke: "#fff", "stroke-width": "1.5", "stroke-linejoin": "round" }));
    const cursor = el("div", { id: "demo-cursor" }, el("i"), arrow);
    const caption = el("div", { id: "demo-caption" });
    const card = el("div", { id: "demo-card" });
    document.head.append(el("style", { textContent: css }));
    document.body.append(card, caption, cursor);
    window.demo = {
      cursor(x, y, down) {
        cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
        cursor.classList.toggle("down", down);
      },
      caption(text) {
        caption.style.opacity = text ? "1" : "0";
        if (text) caption.textContent = text;
      },
      /** A full-window card (no title hides it): heading, subtitle and chips, or a picture beside them. */
      card({ title, subtitle, chips = [], image, label } = {}) {
        card.className = image ? "image" : "";
        card.style.display = title ? "flex" : "none";
        card.replaceChildren();
        if (title) card.append(el("div", {}, el("h1", { textContent: title }), el("p", { textContent: subtitle }), ...chips.map((chip) => el("span", { textContent: chip }))));
        if (image) card.append(el("figure", {}, el("img", { src: image }), label));
      },
    };
  }, OVERLAY_CSS);
}

/** Mouse, keyboard and lookups in window coordinates, with the drawn cursor following the mouse. */
function hand(win, frame) {
  let at = [0, 0];
  const show = (point, down = false) => win.evaluate(([x, y, down]) => window.demo.cursor(x, y, down), [...point, down]);
  const frameBox = async () => (await frame.frameElement()).boundingBox();

  /** Glides to `to` in `steps` eased steps, holding the button if `down`. */
  async function move(to, { steps = 18, down = false } = {}) {
    const from = at;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
      const point = [0, 1].map((k) => from[k] + (to[k] - from[k]) * ease);
      await win.mouse.move(...point);
      await show(point, down);
    }
    at = to;
  }
  async function click(point, options) {
    await move(point, options);
    await show(point, true);
    await win.mouse.down();
    await win.waitForTimeout(70);
    await win.mouse.up();
    await win.waitForTimeout(90);
    await show(point);
  }
  async function drag(from, to, steps = 22) {
    await move(from);
    await show(from, true);
    await win.mouse.down();
    await move(to, { steps, down: true });
    await win.mouse.up();
    await show(to);
  }
  /** Middle of the first element in the viewer matching `selector`. */
  async function center(selector) {
    const box = await frame.locator(selector).first().boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  }
  /** Where PDF point (x, y) of a page (0-based) is on screen. */
  async function pagePoint(page, x, y) {
    const offset = await frameBox();
    const [left, top] = await frame.evaluate(([page, x, y]) => {
      const { div, viewport } = PDFViewerApplication.pdfViewer.getPageView(page);
      const [px, py] = viewport.convertToViewportPoint(x, y);
      const box = div.getBoundingClientRect();
      return [box.left + div.clientLeft + px, box.top + div.clientTop + py];
    }, [page, x, y]);
    return [offset.x + left, offset.y + top];
  }
  /** Start and end of `text` in the text layer, at mid-height. */
  async function phrase(text) {
    const offset = await frameBox();
    const [left, right, middle] = await frame.evaluate((text) => {
      for (const { firstChild: node } of document.querySelectorAll(".textLayer span")) {
        const at = node?.textContent.indexOf(text) ?? -1;
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + text.length);
          const box = range.getBoundingClientRect();
          return [box.left, box.right, box.top + box.height / 2];
        }
      }
      throw new Error(`"${text}" is not in the text layer`);
    }, text);
    return [[offset.x + left + 1, offset.y + middle], [offset.x + right - 1, offset.y + middle]];
  }
  /** Smooth-scrolls so PDF height `y` of a page sits `margin` px under the top of the viewer. */
  async function scrollTo(page, y, margin = 60) {
    await frame.evaluate(([page, y, margin]) => {
      const { div, viewport } = PDFViewerApplication.pdfViewer.getPageView(page);
      document.getElementById("viewerContainer").scrollTo({ top: div.offsetTop + viewport.convertToViewportPoint(0, y)[1] - margin, behavior: "smooth" });
    }, [page, y, margin]);
    await win.waitForTimeout(900);
  }
  return {
    move,
    click,
    drag,
    center,
    pagePoint,
    phrase,
    scrollTo,
    caption: (text) => win.evaluate((text) => window.demo.caption(text), text),
    type: (text, delay = 45) => win.keyboard.type(text, { delay }),
    wait: (ms) => win.waitForTimeout(ms),
  };
}

/** Screenshots for the README, each cropped to what it shows. */
async function screenshots(win, frame) {
  const h = hand(win, frame);

  /** Saves the area around the given elements at 2× for sharp images. */
  async function shoot(name, selectors) {
    await h.move([-50, -50], { steps: 1 });
    const boxes = await Promise.all(selectors.map((selector) => frame.locator(selector).first().boundingBox()));
    const view = await (await frame.frameElement()).boundingBox();
    const left = Math.max(view.x, Math.min(...boxes.map((b) => b.x)) - 16);
    const top = Math.max(view.y, Math.min(...boxes.map((b) => b.y)) - 16);
    const right = Math.min(view.x + view.width, Math.max(...boxes.map((b) => b.x + b.width)) + 16);
    const bottom = Math.min(view.y + view.height, Math.max(...boxes.map((b) => b.y + b.height)) + 16);
    const clip = { x: left, y: top, width: right - left, height: bottom - top, scale: 2 };
    const { data } = await (await win.context().newCDPSession(win)).send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
    writeFileSync(join(MEDIA, `screenshot-${name}.png`), Buffer.from(data, "base64"));
    console.log(`screenshot-${name}.png: ${Math.round(clip.width)}×${Math.round(clip.height)}`);
  }

  // Zoomed out a little so the comment card fits beside the page.
  await frame.evaluate(() => (PDFViewerApplication.pdfViewer.currentScaleValue = "0.9"));
  await h.scrollTo(0, 560, 40);

  // A highlight with its comment and the action bar.
  const [start, end] = await h.phrase("text boxes, images, signatures");
  const middle = [(start[0] + end[0]) / 2, start[1]];
  await h.drag(start, end, 6);
  await h.click(await h.center('.pdf-quickbar [aria-label="Highlight"]'));
  await h.click(middle);
  await h.click(await h.center('.pdf-actionbar [aria-label="Comment"]'));
  await h.type("Worth trying all of these, with $\\frac{1}{2}$ the effort.", 0);
  await h.click(await h.center(".pdf-popup-body .pdf-button.primary"));
  await h.click(middle);
  await h.wait(1500);
  await shoot("comment", [".pdf-actionbar", ".pdf-popup", ".pdf-outline.selected"]);
  await win.keyboard.press("Escape");
  await win.keyboard.press("Escape");

  // The drawing tools' dropdown.
  await h.click(await h.center('#pdfToolbar [data-group="draw"] + .pdf-chevron'));
  await h.wait(600);
  await shoot("tools", ["#pdfToolbar", ".pdf-tool-dropdown"]);
}

/** The banner: a title card, then the tour. */
async function banner(win, frame, folder) {
  await win.evaluate(() =>
    window.demo.card({
      title: "PDFs, right in VS Code",
      subtitle: "Read and annotate papers without leaving the editor",
      chips: ["Highlight", "Comment", "Maths", "Ask Copilot", "Draw", "Fill & sign", "Opens in Acrobat"],
    }),
  );
  const shots = await record(win, () => tour(win, frame, folder));
  console.log(`${shots.length} frames captured`);
  writeGif(shots);
}

/** Collects the window's frames, each with its time in seconds, while `run` runs. */
async function record(win, run) {
  const cdp = await win.context().newCDPSession(win);
  const shots = [];
  cdp.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
    shots.push({ png: Buffer.from(data, "base64"), time: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: Math.round(WIDTH * 0.96), maxHeight: Math.round(HEIGHT * 0.96) });
  await run();
  await cdp.send("Page.stopScreencast");
  // A frame only arrives on change, so repeat the last one up to now.
  shots.push({ ...shots.at(-1), time: Date.now() / 1000 });
  return shots;
}

async function tour(win, frame, folder) {
  const h = hand(win, frame);
  await h.move([WIDTH * 0.9, HEIGHT * 0.85], { steps: 1 });
  await frame.evaluate(() => (PDFViewerApplication.pdfViewer.currentScaleValue = "1.3"));
  await h.scrollTo(0, 545, 30);
  await h.wait(700);
  await win.evaluate(() => window.demo.card());
  await h.wait(300);

  await h.caption("Highlight & comment, with maths");
  const [start, end] = await h.phrase("text boxes, images, signatures");
  await h.drag(start, end, 14);
  await h.click(await h.center('.pdf-quickbar [aria-label="Highlight"]'), { steps: 12 });
  await h.click([(start[0] + end[0]) / 2, start[1]], { steps: 10 });
  await h.click(await h.center('.pdf-actionbar [aria-label="Comment"]'), { steps: 10 });
  await h.type("Try these! Even maths: $e^{i\\pi} + 1 = 0$", 22);
  await h.click(await h.center(".pdf-popup-body .pdf-button.primary"), { steps: 10 });
  await h.wait(1200);
  await win.keyboard.press("Escape");
  await win.keyboard.press("Escape");

  // The recording profile has no Copilot sign-in: hide the error it shows and stream a canned answer.
  await h.caption("Ask Copilot about any passage");
  const [from, to] = await h.phrase("standard PDF annotations");
  await h.drag(from, to, 12);
  await frame.evaluate(() => new MutationObserver(() => document.querySelectorAll(".pdf-copilot-error").forEach((node) => node.remove())).observe(document.body, { childList: true, subtree: true }));
  await h.click(await h.center('.pdf-quickbar [aria-label="Ask Copilot"]'), { steps: 10 });
  await h.click(await h.center('.pdf-menu-item:has-text("Explain")'), { steps: 8 });
  await frame.evaluate(async (answer) => {
    for (const text of answer.match(/\S+\s*/gu)) {
      window.postMessage({ type: "copilot-text", requestId: 1, text, scripted: true }, "*");
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
    window.postMessage({ type: "copilot-done", requestId: 1, scripted: true }, "*");
  }, "The annotation types defined by the PDF standard, so Acrobat, Preview and browsers show them as they are.");
  await h.wait(1400);
  await win.keyboard.press("Escape");

  // Circle a bar of the chart.
  await h.caption("Draw, fill in forms & sign");
  await h.scrollTo(0, 340, 20);
  await h.click(await h.center('#pdfToolbar [data-group="draw"]'), { steps: 12 });
  const ring = [];
  for (let i = 0; i <= 20; i++) {
    const angle = (i / 20) * Math.PI * 2.15 - Math.PI / 2;
    ring.push(await h.pagePoint(0, 397 + Math.cos(angle) * 22, 310 + Math.sin(angle) * 40));
  }
  await stroke(win, h, ring, 10, 2);
  await win.keyboard.press("Escape");

  // Jump (not scroll) to the form on page 3, fill it in and sign.
  await frame.evaluate(() => {
    const { div, viewport } = PDFViewerApplication.pdfViewer.getPageView(2);
    document.getElementById("viewerContainer").scrollTop = div.offsetTop + viewport.convertToViewportPoint(0, 700)[1] - 20;
  });
  await h.wait(400);
  const form = '.page[data-page-number="3"] .annotationLayer';
  await h.click(await h.center(`${form} input[type="text"] >> nth=1`), { steps: 12 });
  await h.type("john@example.com", 22);
  await h.click(await h.center(`${form} input[type="checkbox"]`), { steps: 8 });
  await h.click(await h.center('#pdfToolbar [data-group="insert"] + .pdf-chevron'), { steps: 12 });
  await h.click(await h.center('.pdf-variants [aria-label="Sign"]'), { steps: 8 });
  const pad = await frame.locator(".pdf-signature-pad").boundingBox();
  const onPad = ([x, y]) => [pad.x + pad.width * x, pad.y + pad.height * y];
  // Handwriting-ish: six loops of different heights, then an underline swoosh.
  const loops = [1, 0.35, 0.45, 0.95, 0.4, 0.8];
  const word = Array.from({ length: 60 }, (_, i) => {
    const u = (i / 59) * loops.length;
    const [tall, f] = [loops[Math.min(loops.length - 1, Math.floor(u))], u % 1];
    const y = 0.66 - (tall * 0.21 * (1 - Math.cos(f * Math.PI * 2)));
    return [0.16 + (0.62 * i) / 59 + 0.035 * tall * Math.sin(f * Math.PI * 2) + 0.18 * (0.66 - y), y];
  });
  const swoosh = Array.from({ length: 10 }, (_, i) => [0.12 + (0.7 * i) / 9, 0.8 - 0.07 * Math.sin((i / 9) * Math.PI)]);
  await stroke(win, h, word.map(onPad), 6, 1);
  await stroke(win, h, swoosh.map(onPad), 6, 1);
  await h.click(await h.center(".pdf-dialog .pdf-button.primary"), { steps: 10 });
  await h.click(await h.pagePoint(2, 260, 525), { steps: 12 });
  await h.wait(700);

  // Save, then show the saved file as macOS Preview renders it.
  await h.caption("⌘S saves standard PDF annotations");
  await win.keyboard.press(`${MOD}+s`);
  await h.wait(1300);
  await h.caption("");
  const thumbs = mkdtempSync(join(tmpdir(), "pdf-preview-"));
  execFileSync("qlmanage", ["-t", "-s", "900", "-o", thumbs, join(folder, "example.pdf")], { stdio: "ignore" });
  const image = `data:image/png;base64,${readFileSync(join(thumbs, "example.pdf.png")).toString("base64")}`;
  rmSync(thumbs, { recursive: true, force: true });
  await win.evaluate(
    (image) =>
      window.demo.card({
        title: "Continue in Acrobat or Preview",
        subtitle: "Comments, highlights, drawings and signatures are standard PDF annotations: every reader shows them.",
        image,
        label: "The saved file in macOS Preview",
      }),
    image,
  );
  await h.move([WIDTH + 40, HEIGHT + 40], { steps: 1 });
  await h.wait(3000);
}

/** Draws through `points` with the button held. */
async function stroke(win, h, [first, ...rest], approach, steps) {
  await h.move(first, { steps: approach });
  await win.mouse.down();
  for (const point of rest) {
    await h.move(point, { steps, down: true });
  }
  await win.mouse.up();
}

/**
 * Encodes the shots at a fixed frame rate with one shared palette (no flicker between frames).
 * Each frame after the first holds only the rectangle that changed, unchanged pixels in it
 * transparent; a frame with no change just lengthens the previous one.
 */
function writeGif(shots) {
  const { width, height } = PNG.sync.read(shots[0].png);
  const ticks = [];
  for (let t = shots[0].time, i = 0; t <= shots.at(-1).time + 1 / FPS; t += 1 / FPS) {
    while (shots[i + 1]?.time <= t) i++;
    ticks.push(shots[i]);
  }

  // Palette of 255 colors (index 255 stays free for transparency) from every third pixel of ~24 frames.
  const every = Math.max(1, Math.floor(ticks.length / 24));
  const picked = ticks.filter((_, i) => i % every === 0);
  const sample = new Uint8Array(picked.length * Math.ceil((width * height) / 3) * 4);
  let n = 0;
  for (const shot of picked) {
    const { data } = PNG.sync.read(shot.png);
    for (let p = 0; p < width * height; p += 3, n += 4) sample.set(data.subarray(p * 4, p * 4 + 4), n);
  }
  const palette = gifenc.quantize(sample.subarray(0, n), 255);

  const frames = [];
  let shown = null;
  let last = null;
  let pixels = null;
  for (const shot of ticks) {
    if (shot !== last) [last, pixels] = [shot, gifenc.applyPalette(PNG.sync.read(shot.png).data, palette)];
    if (!shown) {
      frames.push({ x: 0, y: 0, w: width, h: height, pixels, delay: 100 / FPS });
    } else {
      const box = changed(shown, pixels, width, height);
      if (!box) {
        frames.at(-1).delay += 100 / FPS;
        continue;
      }
      const [x, y, w, h] = box;
      const patch = new Uint8Array(w * h);
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const o = (y + row) * width + x + col;
          patch[row * w + col] = pixels[o] === shown[o] ? 255 : pixels[o];
        }
      }
      frames.push({ x, y, w, h, pixels: patch, delay: 100 / FPS, transparent: 255 });
    }
    shown = pixels;
  }

  const colors = palette.map(([r, g, b]) => (r << 16) | (g << 8) | b);
  const buffer = Buffer.alloc(64 * 1024 * 1024);
  const gif = new GifWriter(buffer, width, height, { palette: [...colors, ...Array(256 - colors.length).fill(0)], loop: 0 });
  for (const { x, y, w, h, pixels, delay, transparent = null } of frames) {
    gif.addFrame(x, y, w, h, pixels, { delay: Math.round(delay), disposal: 1, transparent });
  }
  writeFileSync(join(MEDIA, "banner.gif"), buffer.subarray(0, gif.end()));
  console.log(`banner.gif: ${width}×${height}, ${(ticks.length / FPS).toFixed(1)} s, ${(statSync(join(MEDIA, "banner.gif")).size / 2 ** 20).toFixed(2)} MB`);
}

/** [x, y, width, height] of the pixels that differ between two indexed frames, or null. */
function changed(a, b, width, height) {
  let [x1, y1, x2, y2] = [width, height, -1, -1];
  for (let o = 0; o < a.length; o++) {
    if (a[o] !== b[o]) {
      const [x, y] = [o % width, Math.floor(o / width)];
      [x1, y1, x2, y2] = [Math.min(x1, x), Math.min(y1, y), Math.max(x2, x), Math.max(y2, y)];
    }
  }
  return x2 < 0 ? null : [x1, y1, x2 - x1 + 1, y2 - y1 + 1];
}

if (process.argv[2] !== "screenshots") await withExample([WIDTH, HEIGHT], banner);
if (process.argv[2] !== "banner") await withExample([1180, 760], screenshots);
