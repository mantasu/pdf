/**
 * The card where comments are read and written, shown next to its annotation (only one is open), and the
 * small preview on hover. The first thing posted is the annotation's comment; anything after it is a reply.
 * A card is in "compose" (first comment of something new), "view" or "edit" mode.
 */
import * as model from "./annotations.mjs";
import { hideObjectBar, openThreadMenu, statusMenu } from "./commands.mjs";
import { ICON, STATUSES, formatDate, h, iconNode, nameOf, noteSvg, pdfApp, rgbToHex } from "./core.mjs";
import { screenBox } from "./layers.mjs";
import { commentEditor, richNodes } from "./richtext.mjs";
import { dragBy, makeConnector, openMenu, placeCard } from "./ui.mjs";

let cardEl = null;
let cardLine = null;
/** @type {{ id: string, mode: "view"|"edit"|"compose", label?: string, editingReply?: string } | null} */
let cardState = null;
/** Live editors on the card: `comment`, `reply` (the reply box) and `replyEdit` ({ id, editor }). */
let openEditors = {};
/** Per-thread offset from the default spot, kept for the session once the user drags a card. */
const dragOffsets = new Map();
let placeFrame = 0;
let peekEl = null;
let peekTimer = 0;

export function cardId() {
  return cardState?.id ?? null;
}

const cardAnnotation = () => (cardState ? model.find(cardState.id) : undefined);
/** Whether the card may edit an annotation's own comment (text boxes keep theirs on the page). */
const canEdit = (a) => !model.readOnlyReason() && a.kind !== "other" && a.kind !== "freetext";
const isCommented = (a) => a.contents.trim() !== "";
const isChanged = ({ contents, rich }, storedText, storedRich) => contents !== storedText || JSON.stringify(rich) !== JSON.stringify(storedRich);

// --- Open, compose, close ------------------------------------------------------------------

/** Open the card of the thread containing `id`; `focus` is "edit" or "reply" to start typing there. */
export function openCard(id, { focus } = {}) {
  hidePeek();
  const annotation = model.find(id);
  const root = annotation && model.rootOf(annotation);
  if (!root) {
    return;
  }
  if (cardState?.id === root.id && cardState.mode !== "compose") {
    // Same thread: only move the focus, so nothing typed so far is lost to a rebuild.
    if (focus === "edit" && cardState.mode === "view" && canEdit(root)) {
      switchMode("edit");
    } else if (focus === "reply") {
      openEditors.reply?.focus();
    }
    return;
  }
  closeCard();
  const startEditing = canEdit(root) && (focus === "edit" || !isCommented(root));
  cardState = { id: root.id, mode: startEditing ? "edit" : "view" };
  model.select(root.id);
  mountCard();
  if (focus === "reply") {
    openEditors.reply?.focus();
  } else if (startEditing) {
    openEditors.comment?.focus();
  }
}

/** Open a card on the current draft so its first comment can be written; `label` names the undo step. */
export function composeCard(label) {
  const first = model.drafts()[0];
  if (!first) {
    return;
  }
  closeCard();
  hideObjectBar();
  cardState = { id: first.id, mode: "compose", label };
  mountCard();
  openEditors.comment?.focus();
}

/** Save whatever is typed, then reopen the same thread if it still exists. */
export function flushCard() {
  const id = cardState?.id;
  closeCard();
  if (id && model.list().some((a) => a.id === id)) {
    openCard(id);
  }
}

/** Close the card, saving typed text (and committing a draft) unless `discard` (Escape, Cancel) is set. */
export function closeCard({ discard = false } = {}) {
  if (!cardState) {
    return;
  }
  const closing = cardState;
  const { comment, reply, replyEdit } = openEditors;
  forgetCard();
  if (closing.mode === "compose") {
    const value = comment?.value() ?? { contents: "" };
    // A highlight or other mark was made deliberately and survives without text; an empty note has no point.
    if (!discard && (value.contents || model.drafts()[0]?.kind !== "note")) {
      model.commitDraft(value, closing.label);
    } else {
      model.setDraft([]);
    }
    return;
  }
  if (discard) {
    return;
  }
  const annotation = model.find(closing.id);
  if (closing.mode === "edit" && annotation && comment) {
    saveComment(annotation, comment.value());
  }
  if (replyEdit) {
    saveReplyEdit(replyEdit.id, replyEdit.editor.value());
  }
  const replyValue = reply?.value();
  if (replyValue?.contents) {
    model.addReply(closing.id, replyValue.contents, replyValue.rich);
  }
}

/** Drop the card's state and DOM without saving anything. */
function forgetCard() {
  cardState = null;
  openEditors = {};
  cardEl?.remove();
  cardLine?.remove();
  cardEl = cardLine = null;
}

function saveComment(annotation, value) {
  // Against the trimmed stored text, so outer whitespace alone does not count as an edit.
  if (isChanged(value, annotation.contents.trim(), annotation.rich)) {
    model.patch(annotation.id, { contents: value.contents, rich: value.rich }, isCommented(annotation) ? "Edit Comment" : "Add Comment");
  }
}

function saveReplyEdit(id, value) {
  const reply = model.find(id);
  if (reply && value.contents && isChanged(value, reply.contents, reply.rich)) {
    model.patch(id, { contents: value.contents, rich: value.rich }, "Edit Reply");
  }
}

// --- Card DOM -------------------------------------------------------------------------

/** A status label with its icon; with `onclick` it is a button (that opens the status menu). */
export function statusPill(status, onclick) {
  const { label, icon } = STATUSES[status];
  const pill = iconNode(onclick ? "button" : "span", ICON[icon], { className: "pdf-status-pill", dataset: { status }, ...(onclick && { type: "button", title: "Change status", onclick }) });
  pill.append(h("span", {}, label));
  return pill;
}

/** Where a click on a status pill opens the status menu. */
const statusMenuAt = (annotation) => (event) => {
  event.stopPropagation();
  const { left, bottom } = event.currentTarget.getBoundingClientRect();
  openMenu(statusMenu(annotation), left, bottom + 4);
};

/**
 * Marker, author and "type · date" line, with the review status (a pill; `changeStatus` makes it open the status
 * menu) or the user's checkmark; also used by the preview and the sidebar.
 */
export function cardHeader(annotation, { status, checked, changeStatus = false } = {}) {
  const color = rgbToHex(annotation.color) ?? "#FFD100";
  const header = h(
    "div",
    { className: "pdf-thread-header" },
    annotation.kind === "note" ? iconNode("span", noteSvg(color), { className: "pdf-kind-marker note" }) : h("span", { className: `pdf-kind-marker ${annotation.kind}`, style: { "--pdf-marker": color } }),
    h(
      "div",
      { className: "pdf-thread-meta" },
      h("span", { className: "pdf-author" }, annotation.author || "Unknown author"),
      h("span", { className: "pdf-date" }, `${nameOf(annotation)} · ${formatDate(annotation.modified ?? annotation.created)}`),
    ),
  );
  if (status) {
    header.append(statusPill(status, changeStatus && !model.readOnlyReason() ? statusMenuAt(annotation) : undefined));
  } else if (checked) {
    header.insertAdjacentHTML("beforeend", `<span class="pdf-status-badge" data-status="Marked" title="Checked by you">${ICON.check}</span>`);
  }
  return header;
}

/**
 * The round ✓ that resolves a thread in one click, on threads with something to resolve and no status yet;
 * once a thread has a status, its pill is the control (it opens the status menu, where Resolved can be undone).
 */
export function resolveButton(annotation) {
  if (!model.canReply(annotation) || !model.hasDiscussion(annotation) || model.reviewStatus(annotation.id)) {
    return undefined;
  }
  return iconNode("button", ICON.resolve, {
    type: "button",
    className: "pdf-icon-button pdf-resolve",
    title: "Resolve",
    "aria-label": "Resolve",
    onclick: (event) => {
      event.stopPropagation();
      model.toggleResolved(annotation.id);
    },
  });
}

const headerButton = (icon, title, onclick) => iconNode("button", icon, { type: "button", className: "pdf-icon-button", title, "aria-label": title, onclick });
const textButton = (className, label, onclick) => h("button", { type: "button", className, onclick }, label);
const editButtons = (onCancel, onConfirm, confirmLabel) => h("div", { className: "pdf-edit-buttons" }, textButton("pdf-button", "Cancel", onCancel), textButton("pdf-button primary", confirmLabel, onConfirm));
const commentText = (a, props) => h("div", { className: "pdf-comment-text", ...props }, ...richNodes(a.contents, a.rich));

function mountCard() {
  const annotation = cardAnnotation();
  cardEl = h("div", { className: "pdf-popup", role: "dialog", "aria-label": `${nameOf(annotation)} by ${annotation.author}` });
  cardLine = makeConnector();
  document.body.append(cardLine, cardEl);
  // Pressing on the header drags the card aside; the offset is remembered per thread.
  cardEl.addEventListener("pointerdown", (event) => {
    const id = cardState.id;
    const start = dragOffsets.get(id) ?? { x: 0, y: 0 };
    dragBy(event, ".pdf-thread-header", (dx, dy) => {
      dragOffsets.set(id, { x: start.x + dx, y: start.y + dy });
      positionCard();
    });
  });
  renderCard();
}

/** Rebuild the card from the model; editors carry over whatever was typed in them. */
function renderCard() {
  const annotation = cardAnnotation();
  const composing = cardState.mode === "compose";
  const moreActions = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    openThreadMenu(cardAnnotation(), rect.left, rect.bottom + 2);
  };
  const buttons = h(
    "div",
    { className: "pdf-popup-actions" },
    composing ? undefined : resolveButton(annotation),
    composing ? undefined : headerButton(ICON.more, "More actions", moreActions),
    headerButton(ICON.close, "Close", () => closeCard({ discard: cardState?.mode === "compose" })),
  );
  const header = cardHeader(annotation, { status: composing ? undefined : model.reviewStatus(annotation.id), checked: model.checkedByMe(annotation.id), changeStatus: true });
  header.append(buttons);
  cardEl.replaceChildren(header, commentSection(annotation), ...replySection(annotation));
  queuePosition();
}

function commentSection(annotation) {
  if (cardState.mode === "view") {
    if (!isCommented(annotation)) {
      return h("div", { hidden: true });
    }
    const editable = canEdit(annotation);
    return commentText(annotation, { title: editable ? "Double-click to edit" : undefined, ondblclick: editable ? () => switchMode("edit") : undefined });
  }
  const composing = cardState.mode === "compose";
  const typed = openEditors.comment?.value();
  const editor = commentEditor({
    contents: typed?.contents ?? (composing ? "" : annotation.contents),
    rich: typed ? typed.rich : composing ? undefined : annotation.rich,
    placeholder: annotation.kind === "note" ? "Write a note…" : "Add a comment…",
    label: "Comment",
    onSubmit: submitComment,
    onCancel: cancelComment,
  });
  openEditors.comment = editor;
  return h("div", { className: "pdf-popup-body" }, editor.root, editButtons(cancelComment, submitComment, composing || !isCommented(annotation) ? "Post" : "Save"));
}

function submitComment() {
  if (cardState.mode === "compose") {
    flushCard();
    return;
  }
  const annotation = cardAnnotation();
  const value = openEditors.comment.value();
  if (!value.contents && !isCommented(annotation)) {
    closeCard({ discard: true });
    return;
  }
  openEditors.comment = undefined;
  cardState.mode = "view";
  saveComment(annotation, value);
  // Saving notifies the model listener below, which may already have closed the card.
  if (cardState) {
    renderCard();
  }
}

function cancelComment() {
  // Backing out of a first comment leaves nothing to show.
  if (cardState.mode === "compose" || !isCommented(cardAnnotation())) {
    closeCard({ discard: true });
  } else {
    switchMode("view");
  }
}

function switchMode(mode) {
  cardState.mode = mode;
  openEditors.comment = undefined;
  renderCard();
  if (mode === "edit") {
    openEditors.comment?.focus();
  }
}

function replySection(annotation) {
  if (cardState.mode === "compose") {
    return [];
  }
  const replies = model.replies(annotation.id);
  const sections = replies.length ? [h("div", { className: "pdf-replies" }, replies.map(replyRow))] : [];
  // A thread needs something to reply to: a comment, a text box's own text, or earlier replies.
  const replyable = model.canReply(annotation) && (isCommented(annotation) || annotation.kind === "freetext" || replies.length > 0);
  if (!replyable || cardState.mode !== "view") {
    openEditors.reply = undefined;
    return sections;
  }
  const typed = openEditors.reply?.value();
  const send = h("button", { type: "button", className: "pdf-button primary", disabled: !typed?.contents }, "Reply");
  const editor = commentEditor({
    contents: typed?.contents ?? "",
    rich: typed?.rich,
    placeholder: "Reply…",
    label: "Reply",
    onSubmit: sendReply,
    onCancel: () => editor.area.blur(),
    onInput: () => {
      send.disabled = !editor.value().contents;
    },
  });
  send.addEventListener("click", sendReply);
  openEditors.reply = editor;
  sections.push(h("div", { className: "pdf-reply-box" }, editor.root, send));
  return sections;
}

function sendReply() {
  const value = openEditors.reply?.value();
  if (cardState && value?.contents) {
    openEditors.reply = undefined;
    model.addReply(cardState.id, value.contents, value.rich);
  }
}

function replyRow(reply) {
  const row = h(
    "div",
    { className: "pdf-reply", dataset: { id: reply.id } },
    h(
      "div",
      { className: "pdf-reply-head" },
      h("span", { className: "pdf-author" }, reply.author || "Unknown author"),
      h("span", { className: "pdf-date" }, formatDate(reply.modified ?? reply.created)),
      model.readOnlyReason()
        ? undefined
        : h("span", { className: "pdf-reply-actions" }, textButton("pdf-link-button", "Edit", () => startReplyEdit(reply.id)), textButton("pdf-link-button", "Delete", () => model.remove(reply.id, "Delete Reply"))),
    ),
  );
  if (cardState.editingReply !== reply.id) {
    row.append(commentText(reply));
    return row;
  }
  const finish = (save) => {
    const edit = openEditors.replyEdit;
    openEditors.replyEdit = undefined;
    cardState.editingReply = undefined;
    if (save) {
      saveReplyEdit(reply.id, edit.editor.value());
    }
    renderCard();
  };
  const editor = commentEditor({ contents: reply.contents, rich: reply.rich, label: "Edit reply", onSubmit: () => finish(true), onCancel: () => finish(false) });
  openEditors.replyEdit = { id: reply.id, editor };
  row.append(editor.root, editButtons(() => finish(false), () => finish(true), "Save"));
  requestAnimationFrame(() => editor.focus());
  return row;
}

function startReplyEdit(id) {
  cardState.editingReply = id;
  renderCard();
}

// Follow model changes (undo/redo, sidebar edits) at load, so the card never shows stale or deleted threads.
model.onChange((reason) => {
  if (!cardState || reason === "select" || reason === "draft") {
    return;
  }
  if (cardAnnotation()) {
    renderCard();
  } else {
    forgetCard();
  }
});

function positionCard() {
  placeFrame = 0;
  const annotation = cardAnnotation();
  if (cardEl) {
    placeCard(cardEl, cardLine, annotation && screenBox(annotation), annotation?.page, dragOffsets.get(cardState.id));
  }
}

function queuePosition() {
  if (cardEl && !placeFrame) {
    placeFrame = requestAnimationFrame(positionCard);
  }
}

/** Close the card on presses outside it (clicking outside keeps typed text) and keep it beside its annotation. */
export function setupCard() {
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      // Menus and the object bar act on this same thread, so pressing them leaves the card open.
      if (!cardEl || cardEl.contains(target) || target.closest?.(".pdf-menu-root, .pdf-actionbar")) {
        return;
      }
      // Presses on the icon of the note whose card is showing are left to pointer.mjs, which toggles the card.
      if (!target.closest?.(`.pdf-note[data-id="${CSS.escape(cardState.id)}"]`)) {
        closeCard();
      }
    },
    true,
  );
  document.getElementById("viewerContainer")?.addEventListener("scroll", queuePosition, { passive: true });
  window.addEventListener("resize", queuePosition);
  for (const name of ["scalechanging", "rotationchanging", "pagerendered", "updateviewarea"]) {
    pdfApp().eventBus.on(name, queuePosition);
  }
}

// --- Hover preview --------------------------------------------------------------------

/** Show a thread's preview after the pointer rests on it for 350 ms; never for the thread whose card is open. */
export function queuePeek(id, clientX, clientY) {
  clearTimeout(peekTimer);
  if (cardState?.id === id) {
    hidePeek();
  } else if (peekEl?.dataset.id !== id) {
    hidePeek();
    peekTimer = setTimeout(() => showPeek(id, clientX, clientY), 350);
  }
}

export function hidePeek() {
  clearTimeout(peekTimer);
  peekEl?.remove();
  peekEl = null;
}

function showPeek(id, clientX, clientY) {
  const annotation = model.find(id);
  const replies = annotation ? model.replies(id) : [];
  // Nothing to preview: no comment, no replies, not a note; text boxes already show their text.
  if (!annotation || cardState?.id === id || (!isCommented(annotation) && !replies.length && annotation.kind !== "note") || annotation.kind === "freetext") {
    return;
  }
  peekEl = h(
    "div",
    { className: "pdf-preview", dataset: { id }, role: "tooltip" },
    cardHeader(annotation, { status: model.reviewStatus(id), checked: model.checkedByMe(id) }),
    isCommented(annotation) ? commentText(annotation) : undefined,
    replies.length ? h("div", { className: "pdf-preview-replies" }, replies.length === 1 ? "1 reply" : `${replies.length} replies`) : undefined,
  );
  document.body.append(peekEl);
  // Below-right of the pointer, flipped above it when it would run off the bottom, kept inside the window.
  const { width, height } = peekEl.getBoundingClientRect();
  peekEl.style.left = `${Math.max(8, Math.min(clientX + 14, innerWidth - width - 8))}px`;
  peekEl.style.top = `${Math.max(8, clientY + 18 + height > innerHeight - 8 ? clientY - height - 12 : clientY + 18)}px`;
}
