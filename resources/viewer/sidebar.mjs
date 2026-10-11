/**
 * The comments sidebar docked right of the pages: one card per thread, by page or newest first,
 * narrowed by a search box, a type filter and a switch hiding closed (resolved) threads. A card jumps
 * to its annotation and opens its comment card, the only place comments are edited.
 */
import * as model from "./annotations.mjs";
import { cardHeader, openCard, resolveButton } from "./card.mjs";
import { ICON, h, iconNode, isClosed, localStore, pdfApp } from "./core.mjs";
import { fracBox, scrollToThread } from "./layers.mjs";
import { richNodes } from "./richtext.mjs";
import { TEXT_MARKS } from "./tools.mjs";

const STORED_WIDTH = "pdf.commentsPanelWidth";
const STORED_OPEN = "pdf.commentsPanelOpen";
const STORED_HIDE_CLOSED = "pdf.commentsHideClosed";
const TYPE_FILTERS = {
  all: { label: "All types", test: () => true },
  notes: { label: "Sticky notes", test: (a) => a.kind === "note" },
  markup: { label: "Text markup", test: (a) => TEXT_MARKS.includes(a.kind) },
  drawings: { label: "Drawings & shapes", test: (a) => ["ink", "line", "square", "circle"].includes(a.kind) },
  objects: { label: "Text boxes & images", test: (a) => a.kind === "freetext" || a.kind === "image" },
  other: { label: "Other", test: (a) => a.kind === "other" },
};

let listNode = null;
let countNode = null;
let toolbarButton = null;
const filters = { text: "", type: "all", sort: "page", hideClosed: localStore.get(STORED_HIDE_CLOSED) === "1" };

const outerContainer = () => document.getElementById("outerContainer");
const isOpen = () => outerContainer()?.classList.contains("pdf-panel-open") ?? false;
/** The pages' area changed width: pdf.js refits "Automatic" and "Page Width" zoom on resize. */
const refitPages = () => pdfApp()?.eventBus?.dispatch("resize", { source: window });

export function toggleSidebar(open = !isOpen()) {
  outerContainer()?.classList.toggle("pdf-panel-open", open);
  toolbarButton?.classList.toggle("toggled", open);
  toolbarButton?.setAttribute("aria-expanded", String(open));
  localStore.set(STORED_OPEN, open ? "1" : "0");
  refresh();
  refitPages();
}

/** Build the sidebar; `button` is the toolbar toggle that mirrors its open state. */
export function setupSidebar(button) {
  toolbarButton = button;
  const search = h("input", { type: "search", className: "pdf-panel-filter", placeholder: "Search comments", "aria-label": "Search comments", oninput: (event) => setFilter("text", event.currentTarget.value.trim().toLowerCase()) });
  const close = iconNode("button", ICON.close, { type: "button", className: "pdf-icon-button", title: "Close comments", "aria-label": "Close comments", onclick: () => toggleSidebar(false) });
  const hideClosed = iconNode("button", ICON.resolve, {
    type: "button",
    className: "pdf-icon-button pdf-hide-closed",
    title: "Hide resolved and closed comments",
    "aria-label": "Hide resolved and closed comments",
    "aria-pressed": String(filters.hideClosed),
    onclick: () => {
      hideClosed.setAttribute("aria-pressed", String(!filters.hideClosed));
      localStore.set(STORED_HIDE_CLOSED, filters.hideClosed ? "0" : "1");
      setFilter("hideClosed", !filters.hideClosed);
    },
  });
  const typeLabels = Object.fromEntries(Object.entries(TYPE_FILTERS).map(([key, { label }]) => [key, label]));
  countNode = h("span", { className: "pdf-panel-count" }, "0");
  listNode = h("div", { className: "pdf-panel-list", role: "list" });
  outerContainer().append(
    h(
      "aside",
      { id: "pdfCommentsPanel", className: "pdf-panel", "aria-label": "Comments" },
      h("div", { className: "pdf-panel-resizer", role: "separator", "aria-orientation": "vertical", onpointerdown: startResize }),
      h("div", { className: "pdf-panel-header" }, h("h2", {}, "Comments ", countNode), h("div", { className: "pdf-panel-actions" }, hideClosed, close)),
      search,
      h("div", { className: "pdf-panel-controls" }, filterSelect(typeLabels, "type", "Filter by type"), filterSelect({ page: "By page", newest: "Newest first" }, "sort", "Sort")),
      listNode,
    ),
  );
  const width = localStore.get(STORED_WIDTH);
  if (width) {
    document.documentElement.style.setProperty("--pdf-panel-width", width);
  }
  model.onChange(refresh);
  toggleSidebar(localStore.get(STORED_OPEN) === "1");
}

function setFilter(field, value) {
  filters[field] = value;
  refresh();
}

/** A `<select>` bound to one of the `filters` fields. */
function filterSelect(options, field, label) {
  const choices = Object.entries(options).map(([value, text]) => h("option", { value, selected: filters[field] === value }, text));
  return h("select", { className: "pdf-panel-select", "aria-label": label, onchange: (event) => setFilter(field, event.currentTarget.value) }, choices);
}

function refresh() {
  const threads = model.threads();
  countNode.textContent = String(threads.length);
  if (!isOpen()) {
    return;
  }
  const shown = inDisplayOrder(threads).filter((annotation) => passesFilters(annotation));
  if (!shown.length) {
    const lines = threads.length
      ? [filters.hideClosed && threads.some((annotation) => passesFilters(annotation, true)) ? "Every match is resolved or closed." : "No comments match the filters."]
      : ["No comments yet.", "Select text to highlight or comment on it, or use the tools in the toolbar."];
    listNode.replaceChildren(h("div", { className: "pdf-panel-empty" }, lines.map((line) => h("p", {}, line))));
    return;
  }
  listNode.replaceChildren();
  let page = -1;
  for (const annotation of shown) {
    if (filters.sort === "page" && annotation.page !== page) {
      page = annotation.page;
      listNode.append(h("div", { className: "pdf-page-heading", role: "heading", "aria-level": "3" }, `Page ${page + 1}`));
    }
    listNode.append(threadCard(annotation));
  }
  listNode.querySelector(".pdf-card.selected")?.scrollIntoView({ block: "nearest" });
}

function inDisplayOrder(threads) {
  if (filters.sort === "newest") {
    const changedAt = (a) => a.modified ?? a.created ?? "";
    return threads.toSorted((a, b) => changedAt(b).localeCompare(changedAt(a)));
  }
  // Reading order: by page, then top to bottom, then left to right as displayed.
  const keyed = threads.map((annotation) => ({ annotation, box: fracBox(annotation) ?? [0, 0, 0, 0] }));
  return keyed.sort((p, q) => p.annotation.page - q.annotation.page || p.box[1] - q.box[1] || p.box[0] - q.box[0]).map((entry) => entry.annotation);
}

/** The type filter, the search text (against the authors and texts of the whole thread) and, unless `anyStatus`, the closed-thread switch. */
function passesFilters(annotation, anyStatus = false) {
  const haystack = [annotation, ...model.replies(annotation.id)].map((a) => `${a.author} ${a.contents}`).join(" ").toLowerCase();
  const shownStatus = anyStatus || !filters.hideClosed || !isClosed(model.reviewStatus(annotation.id));
  return TYPE_FILTERS[filters.type].test(annotation) && (!filters.text || haystack.includes(filters.text)) && shownStatus;
}

const replyRow = (reply) => h("div", { className: "pdf-card-reply" }, h("span", { className: "pdf-author" }, reply.author || "Unknown author"), h("span", { className: "pdf-comment-text" }, reply.contents));

function threadCard(annotation) {
  const replies = model.replies(annotation.id);
  const reveal = () => {
    model.select(annotation.id);
    scrollToThread(annotation);
    // Wait a frame so the page is laid out where the comment card will anchor.
    requestAnimationFrame(() => openCard(annotation.id));
  };
  const onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      reveal();
    }
  };
  const status = model.reviewStatus(annotation.id);
  const header = cardHeader(annotation, { status, checked: model.checkedByMe(annotation.id), changeStatus: true });
  const resolve = resolveButton(annotation);
  if (resolve) {
    header.append(resolve);
  }
  const classes = ["pdf-card", model.selectedId() === annotation.id && "selected", isClosed(status) && "pdf-closed"].filter(Boolean).join(" ");
  return h(
    "div",
    { className: classes, dataset: { id: annotation.id, ...(status && { status }) }, tabIndex: 0, role: "listitem", onclick: reveal, onkeydown },
    header,
    annotation.contents.trim()
      ? h("div", { className: "pdf-comment-text" }, ...richNodes(annotation.contents, annotation.rich))
      : h("div", { className: "pdf-comment-text empty" }, "No comment"),
    replies.length ? h("div", { className: "pdf-card-replies" }, replies.map(replyRow)) : undefined,
  );
}

/** Drag the sidebar's left edge; the width stays within bounds and is remembered on release. */
function startResize(event) {
  event.preventDefault();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  const onMove = (move) => {
    const width = Math.min(Math.max(innerWidth - move.clientX, 220), Math.max(240, innerWidth * 0.6));
    document.documentElement.style.setProperty("--pdf-panel-width", `${Math.round(width)}px`);
  };
  const endEvents = ["pointerup", "pointercancel", "lostpointercapture"];
  const onEnd = () => {
    handle.removeEventListener("pointermove", onMove);
    endEvents.forEach((type) => handle.removeEventListener(type, onEnd));
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    localStore.set(STORED_WIDTH, getComputedStyle(document.documentElement).getPropertyValue("--pdf-panel-width"));
    refitPages();
  };
  handle.addEventListener("pointermove", onMove);
  endEvents.forEach((type) => handle.addEventListener(type, onEnd));
}
