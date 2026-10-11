/**
 * Copilot questions about selected text. The host forwards each one to VS Code's language models and the
 * reply is streamed into a card next to the passage. This module also answers the @pdf chat participant's
 * context requests: the text of each page, what was last selected, and the words under each text mark.
 */
import { ICON, h, hostCommand, iconNode, pdfApp, toHost } from "./core.mjs";
import { fromMarkdown } from "./markdown.mjs";
import { screenBox } from "./layers.mjs";
import { dragBy, makeConnector, placeCard } from "./ui.mjs";
import { openCard } from "./card.mjs";
import { richNodes } from "./richtext.mjs";
import { copyToClipboard } from "./commands.mjs";
import * as model from "./annotations.mjs";
import { TEXT_MARKS, fieldsFor } from "./tools.mjs";
import { inQuads } from "./geometry.mjs";

/** Card titles per action; "ask" waits for a typed question. */
const ACTIONS = { explain: "Explain", summarize: "Summarize", define: "Define terms", ask: "Ask" };
/** The @pdf prompt that "Continue in Chat" pre-fills, so the chat stays on the same subject. */
const CHAT_QUERIES = { explain: "@pdf /explain ", summarize: "@pdf Summarize the selected passage. ", define: "@pdf Define the terms in the selected passage. ", ask: "@pdf " };

let copilotCard = null;
let copilotLine = null;
/** State of the open card (request id, selection, action, question, streamed text, done/error, drag offset, answer node). */
let session = null;
let nextRequestId = 1;
let paintFrame = 0;

export function copilotOpen() {
  return copilotCard !== null;
}

export function copilotMenu(selection) {
  return [
    ...Object.entries(ACTIONS).map(([action, label]) => ({ label: action === "ask" ? "Ask a Question…" : label, icon: ICON.copilot, action: () => openCopilot(selection, action) })),
    { separator: true },
    { label: "Ask in Copilot Chat (@pdf)…", action: () => hostCommand("pdf.askInChat", "@pdf ", true) },
  ];
}

export function closeCopilot() {
  if (session && !session.done) {
    toHost({ type: "copilot-cancel", requestId: session.requestId });
  }
  copilotCard?.remove();
  copilotLine?.remove();
  copilotCard = copilotLine = session = null;
}

/** Open a card for `selection`: send the request at once, or for "ask" wait for the typed question. */
function openCopilot(selection, action) {
  closeCopilot();
  session = { selection, action, text: "", done: false, offset: { x: 0, y: 0 } };
  copilotCard = h("div", { className: "pdf-popup pdf-copilot", role: "dialog", "aria-label": "Copilot" });
  copilotLine = makeConnector();
  copilotCard.addEventListener("pointerdown", (event) => {
    const start = { ...session.offset };
    dragBy(event, ".pdf-copilot-header", (dx, dy) => {
      session.offset = { x: start.x + dx, y: start.y + dy };
      positionCard();
    });
  });
  document.body.append(copilotLine, copilotCard);
  if (action === "ask") {
    renderCard();
    copilotCard.querySelector("textarea")?.focus({ preventScroll: true });
  } else {
    sendRequest();
  }
}

async function sendRequest(question) {
  const request = Object.assign(session, { requestId: nextRequestId++, question, text: "", done: false, error: undefined });
  renderCard();
  const part = request.selection.parts[0];
  toHost({ type: "copilot", requestId: request.requestId, action: request.action, ...(question && { question }), selection: request.selection.text, pageText: await pageText(part.page), page: part.page + 1 });
}

/** Host replies for the open request: streamed text ("copilot-text"), then the end, maybe with an error. */
export function onCopilotReply(message) {
  if (!session || message.requestId !== session.requestId) {
    return;
  }
  if (message.type === "copilot-text") {
    session.text += message.text;
    // Repaint just the answer, once per frame, so the buttons are not rebuilt under the pointer (Stop stays clickable).
    if (!paintFrame) {
      paintFrame = requestAnimationFrame(() => {
        paintFrame = 0;
        if (session?.answer) {
          session.answer.replaceChildren(...answerNodes());
          positionCard();
        }
      });
    }
  } else {
    Object.assign(session, { done: true, error: message.error });
    renderCard();
  }
}

export function setupCopilot() {
  document.addEventListener("selectionchange", trackSelection);
  // A press outside the card closes it and cancels the reply, except on menus and the selection bar.
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (copilotCard && !copilotCard.contains(event.target) && !event.target.closest?.(".pdf-menu-root, .pdf-quickbar")) {
        closeCopilot();
      }
    },
    true,
  );
  const reposition = () => copilotCard && requestAnimationFrame(positionCard);
  document.getElementById("viewerContainer")?.addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("resize", reposition);
  for (const name of ["scalechanging", "rotationchanging", "pagerendered"]) {
    pdfApp().eventBus.on(name, reposition);
  }
}

function renderCard() {
  const { action, selection, requestId } = session;
  const header = h(
    "div",
    { className: "pdf-copilot-header" },
    iconNode("span", ICON.copilot, { className: "pdf-copilot-icon", "aria-hidden": "true" }),
    h("span", { className: "pdf-copilot-title" }, `Copilot · ${ACTIONS[action]}`),
    iconNode("button", ICON.close, { type: "button", className: "pdf-icon-button", title: "Close", "aria-label": "Close", onclick: closeCopilot }),
  );
  const quote = h("blockquote", { className: "pdf-copilot-quote", title: selection.text }, selection.text);
  copilotCard.replaceChildren(header, quote, ...(action === "ask" && requestId === undefined ? questionForm() : answerSection()));
  positionCard();
}

function questionForm() {
  const input = h("textarea", { className: "pdf-copilot-input", rows: 2, placeholder: "Ask about this passage…", "aria-label": "Question" });
  const submit = () => input.value.trim() && sendRequest(input.value.trim());
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      closeCopilot();
    }
  });
  return [input, h("div", { className: "pdf-edit-buttons" }, textButton("Ask", submit, true))];
}

function answerSection() {
  const { action, question, text, done, error, requestId } = session;
  const { contents } = fromMarkdown(text);
  const buttons = done
    ? [
        textButton("Continue in Chat", () => hostCommand("pdf.askInChat", `${CHAT_QUERIES[action]}${action === "ask" ? question : ""}`, true)),
        contents && textButton("Copy", () => copyToClipboard(contents)),
        contents && !model.readOnlyReason() && textButton("Add as Comment", addAsComment, true),
      ]
    : textButton("Stop", () => toHost({ type: "copilot-cancel", requestId }));
  session.answer = h("div", { className: "pdf-copilot-answer", "aria-live": "polite" }, ...answerNodes());
  return [
    question && h("div", { className: "pdf-copilot-question" }, question),
    session.answer,
    error && h("div", { className: "pdf-copilot-error", role: "alert" }, error),
    h("div", { className: "pdf-edit-buttons" }, buttons),
  ].filter(Boolean);
}

function answerNodes() {
  const { contents, rich } = fromMarkdown(session.text);
  if (contents) {
    return richNodes(contents, rich);
  }
  return session.done ? [] : [h("div", { className: "pdf-copilot-thinking" }, "Thinking", h("span", { className: "pdf-dots" }))];
}

const textButton = (label, onclick, primary = false) => h("button", { type: "button", className: `pdf-button${primary ? " primary" : ""}`, onclick }, label);

/** Turn the answer into a highlight on the passage (one per page part), the comment on the first. */
function addAsComment() {
  const { selection, text } = session;
  const { contents, rich } = fromMarkdown(text);
  const fields = fieldsFor("highlight");
  const highlights = selection.parts.map((part, i) => model.create({ ...fields, page: part.page, rect: part.rect, quads: part.quads, ...(i === 0 && { contents, ...(rich && { rich }), author: "Copilot" }) }));
  closeCopilot();
  model.add(highlights, "Add Copilot Comment");
  openCard(highlights[0].id);
}

function positionCard() {
  if (copilotCard) {
    const part = session.selection.parts[0];
    placeCard(copilotCard, copilotLine, screenBox({ kind: "highlight", page: part.page, rect: part.rect, quads: part.quads }), part.page, session.offset);
  }
}

// --- Context for @pdf ---------------------------------------------------------------------

/** What the @pdf participant learns about the open PDF. */
export async function pdfContext() {
  const pdf = pdfApp().pdfDocument;
  const pages = await Promise.all(Array.from({ length: pdf?.numPages ?? 0 }, (_, i) => pageText(i)));
  const marks = {};
  for (const mark of model.threads().filter((a) => TEXT_MARKS.includes(a.kind))) {
    marks[mark.id] = await textUnder(mark);
  }
  return { pages, page: pdfApp().page ?? 1, ...(lastSelection?.text && { selection: lastSelection }), marks };
}

/** The most recent text selection in the pages; it survives focus moving out of the webview (e.g. to Copilot Chat). */
let lastSelection = null;

function trackSelection() {
  const selection = getSelection();
  const node = selection?.anchorNode;
  const page = (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest?.(".page");
  if (selection && !selection.isCollapsed && page) {
    lastSelection = { text: selection.toString().trim(), page: Number(page.dataset.pageNumber) };
  } else if (document.hasFocus()) {
    lastSelection = null;
  }
}

/** pdf.js text items per page index, with each item's font family; cached per loaded document. */
const textItemsByDocument = new WeakMap();

function textItems(pageIndex) {
  const pdf = pdfApp().pdfDocument;
  const byPage = textItemsByDocument.get(pdf) ?? new Map();
  textItemsByDocument.set(pdf, byPage);
  if (!byPage.has(pageIndex)) {
    const content = pdf.getPage(pageIndex + 1).then((p) => p.getTextContent());
    byPage.set(pageIndex, content.then(({ items, styles }) => items.filter((item) => "str" in item).map((item) => ({ ...item, family: styles[item.fontName]?.fontFamily ?? "sans-serif" }))));
  }
  return byPage.get(pageIndex);
}

async function pageText(pageIndex) {
  return (await textItems(pageIndex)).map((item) => item.str + (item.hasEOL ? "\n" : "")).join("");
}

/** The text covered by a highlight or other text mark: the characters whose middle falls in its quads. */
async function textUnder(annotation) {
  const pieces = [];
  for (const item of await textItems(annotation.page)) {
    const [a, b, c, d, e, f] = item.transform;
    const scale = Math.hypot(a, b) || 1;
    const centers = glyphCenters(item);
    // A glyph's middle: its centre along the baseline, lifted by roughly a third of the font size.
    const covered = [...item.str].filter((_, i) => inQuads(e + (a / scale) * centers[i] + c * 0.35, f + (b / scale) * centers[i] + d * 0.35, annotation.quads ?? [], 1));
    if (covered.length) {
      pieces.push(covered.join(""));
    }
  }
  return pieces.join(" ").replace(/\s+/gu, " ").trim();
}

let measureContext = null;

/** Each character's centre along a text item, spacing the item's width by the font family's glyph widths. */
function glyphCenters(item) {
  measureContext ??= document.createElement("canvas").getContext("2d");
  measureContext.font = `100px ${item.family}`;
  const widths = [...item.str].map((ch) => measureContext.measureText(ch).width);
  const total = widths.reduce((sum, w) => sum + w, 0) || 1;
  let covered = 0;
  return widths.map((w) => {
    covered += w;
    return ((covered - w / 2) / total) * item.width;
  });
}
