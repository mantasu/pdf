// Shared helpers for the browser end-to-end suites.
const path = require("node:path");

const MOD = process.platform === "darwin" ? "Meta" : "Control";
const SHOTS = process.env.PDF_E2E_SCREENSHOTS;

/** A suite: run `body(t)` and exit non-zero when any check failed. */
function suite(name, body) {
  let failures = 0;
  const t = {
    check(label, condition, detail = "") {
      console.log(`${condition ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
      failures += condition ? 0 : 1;
    },
    shot: (page, label) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `${name}-${label}.png`) }) : undefined),
  };
  body(t)
    .then(() => {
      console.log(failures ? `${failures} FAILED` : "ALL PASSED");
      process.exit(failures ? 1 : 0);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

/** Select `needle` inside a pdf.js text span (scrolled into view); returns its client center. */
function selectText(frame, needle) {
  return frame.evaluate((needle) => {
    for (const span of document.querySelectorAll(".textLayer span")) {
      const node = span.firstChild;
      const index = node?.textContent.indexOf(needle) ?? -1;
      if (index >= 0) {
        span.scrollIntoView({ block: "center" });
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }
    }
    return null;
  }, needle);
}

/** Select `needle` like a user: drag the mouse across it. */
async function dragSelect(page, needle) {
  const at = await selectText(page, needle);
  await page.evaluate(() => getSelection().removeAllRanges());
  // Along the text: horizontal normally, vertical on pages rotated by 90°.
  const vertical = at.bottom - at.top > at.right - at.left;
  await page.mouse.move(...(vertical ? [at.x, at.top + 1] : [at.left + 1, at.y]));
  await page.mouse.down();
  await page.mouse.move(...(vertical ? [at.x, at.bottom - 1] : [at.right - 1, at.y]), { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  return at;
}

const edits = (host) => host.log.filter((m) => m.type === "edit");
const lastEdit = (host) => edits(host).at(-1);

/** Drag with the mouse in small steps. */
async function drag(page, from, to, { shift = false } = {}) {
  await page.mouse.move(...from);
  if (shift) {
    await page.keyboard.down("Shift");
  }
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 10 });
  await page.mouse.up();
  if (shift) {
    await page.keyboard.up("Shift");
  }
  await page.waitForTimeout(120);
}

/** Pick a tool from a toolbar dropdown ("cursor", "markup", "draw", "insert") by its title, then close the dropdown. */
async function useTool(page, group, title) {
  await page.locator(`#pdfToolbar [data-group="${group}"] + .pdf-chevron`).click();
  await page.locator(`.pdf-variants [aria-label="${title}"]`).click();
  // Escape closes the dropdown; with nothing open it would leave the tool instead.
  if (await page.locator(".pdf-menu-root").count()) {
    await page.keyboard.press("Escape");
  }
  const active = await activeTool(page);
  if (!title || active === "select") {
    throw new Error(`"${title}" did not become the active tool`);
  }
}

/** The active tool, from the viewer's tool class. */
const activeTool = (page) => page.evaluate(() => [...document.getElementById("viewerContainer").classList].find((c) => c.startsWith("pdf-tool-"))?.slice("pdf-tool-".length) ?? "select");

/** Count what the viewer drew on the pages. */
const drawn = (page) =>
  page.evaluate(() => ({
    notes: document.querySelectorAll(".pdf-note").length,
    markup: document.querySelectorAll(".pdf-markup-layer > g").length,
    drawings: document.querySelectorAll(".pdf-draw-layer > *").length,
    textboxes: document.querySelectorAll(".pdf-textbox:not(.pdf-textbox-editor)").length,
    images: document.querySelectorAll(".pdf-image").length,
    pdfjs: document.querySelectorAll(".annotationLayer section:not(.linkAnnotation):not(.widgetAnnotation)").length,
  }));

module.exports = { MOD, suite, selectText, dragSelect, edits, lastEdit, drag, drawn, useTool, activeTool };
