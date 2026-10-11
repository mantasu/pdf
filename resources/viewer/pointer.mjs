/**
 * Mouse and pen input on the pages: presses, drags, clicks, hover and right-click. A single `gesture` record
 * tracks each press until release, whatever it turns out to be; drags show a live preview and save once at the end.
 */
import * as model from "./annotations.mjs";
import { cardId, closeCard, hidePeek, openCard, queuePeek } from "./card.mjs";
import { hasSelection, hideObjectBar, hideSelectionBar, markSelection, openThreadMenu, selectionMenu, showObjectBar, showSelectionBar, snapshotSelection, startNote } from "./commands.mjs";
import { hostCommand, isTextInput, nameOf, pdfViewer } from "./core.mjs";
import { bbox, fitBox, markStrokes, moveBy, outlinePoints, roundPt } from "./geometry.mjs";
import { askSignature, commitTextBox, editTextBox, insertPicture, newTextBox, pictureAt, signatureAt, storedSignature } from "./insert.mjs";
import { canMove, pageAt, pageNear, preview, setHovered, toPdfPoint, topmostAt } from "./layers.mjs";
import { DRAG_TOOLS, TEXT_MARKS, activeTool, afterUse, fieldsFor, onToolChange, toolStyle } from "./tools.mjs";
import { closeMenu, openMenu } from "./ui.mjs";

/** CSS pixels a press must travel to become a drag; also how far apart a double click may land. */
const DRAG_PX = 4;
/** A pen stroke this soon after the last one joins the same drawing. */
const STROKE_JOIN_MS = 3000;
const DOUBLE_CLICK_MS = 450;
/** Fill & Sign marks placed with one click, centred on it: size in PDF points (0: the item brings its own). */
const MARK_SIZES = { check: 14, cross: 14, dot: 6, signature: 0, image: 0 };
const PAGE_COMMANDS = [
  ["Rotate Page", "pdf.rotatePage"],
  ["Delete Page", "pdf.deletePage"],
  ["Move Page Up", "pdf.movePageUp"],
  ["Move Page Down", "pdf.movePageDown"],
  ["Insert Blank Page Before", "pdf.insertBlankPageBefore"],
  ["Insert Blank Page After", "pdf.insertBlankPageAfter"],
];

let gesture = null;
let prevClick = null;
let inkRun = null;
let hoverRaf = 0;

const scroller = () => document.getElementById("viewerContainer");
const noteIconOf = (target) => target?.closest?.(".pdf-note");
const canEdit = () => !model.readOnlyReason();

export function setupPointer() {
  const container = scroller();
  container.addEventListener("pointerdown", (event) => {
    // A press inside the text box being edited just moves its caret; anywhere else commits the box first.
    if (!event.target.closest?.(".pdf-textbox-editor")) {
      commitTextBox();
    }
    onPointerDown(event);
  }, true);
  // A press outside the pages (toolbar, menus, cards) means the next click cannot be a double click.
  document.addEventListener("pointerdown", (event) => {
    if (!container.contains(event.target)) {
      prevClick = null;
    }
  }, true);
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", cancelGesture);
  // Strokes join only the drawing made just before: a reload, an undo/redo or a tool switch ends the run.
  model.onChange((reason) => {
    if (reason === "load" || reason === "replace") {
      inkRun = null;
    }
  });
  onToolChange(() => {
    inkRun = null;
  });
  document.addEventListener("contextmenu", onContextMenu, true);
  container.addEventListener("pointerleave", () => {
    setHovered(null);
    hidePeek();
  });
}

// --- Press and drag ----------------------------------------------------------------------

function startGesture(event, fields) {
  gesture = { startX: event.clientX, startY: event.clientY, pointerId: event.pointerId, dragging: false, ...fields };
  if (fields.capture) {
    event.preventDefault();
    event.stopPropagation();
    scroller().setPointerCapture(event.pointerId);
  }
}

function onPointerDown(event) {
  const { target } = event;
  if (event.button !== 0 || target.closest?.(".pdf-textbox-editor")) {
    return;
  }
  // Beside the pages only Select acts, on a drawing that sticks out past a page's edge.
  if (!target.closest?.(".page")) {
    const point = activeTool() === "select" ? pageNear(event.clientX, event.clientY) : undefined;
    if (point && topmostAt(point)) {
      hidePeek();
      startToolPress(event, "select", point);
    }
    return;
  }
  hidePeek();
  const tool = activeTool();
  // With the hand tool the press belongs to pdf.js, which pans the document.
  if (tool === "hand") {
    return;
  }
  // Select and the text-mark tools can still grab handles and note icons.
  const picking = tool === "select" || TEXT_MARKS.includes(tool);
  const handle = picking && target.closest(".pdf-handle");
  if (handle && canEdit()) {
    const a = model.find(handle.dataset.id);
    const from = bbox(outlinePoints(a));
    const grab = toPdfPoint(a.page, event.clientX, event.clientY);
    // Pin the corner opposite the grabbed handle, axis by axis, so this holds on rotated pages as well.
    const anchor = [Math.abs(grab.x - from[0]) < Math.abs(grab.x - from[2]) ? from[2] : from[0], Math.abs(grab.y - from[1]) < Math.abs(grab.y - from[3]) ? from[3] : from[1]];
    startGesture(event, { kind: "resize", id: a.id, handle: handle.dataset.handle, page: a.page, from, anchor, capture: true });
    return;
  }
  const icon = picking && noteIconOf(target);
  if (icon) {
    const a = model.find(icon.dataset.id);
    const origin = toPdfPoint(a.page, event.clientX, event.clientY);
    // Read-only notes stay where they are, but clicking still toggles their card.
    startGesture(event, { kind: canEdit() ? "move" : "click", id: a.id, page: a.page, origin, clickAction: "toggle-card", cardWasOpen: cardId() === a.id, capture: true });
    return;
  }
  const point = pageAt(event.clientX, event.clientY);
  if (point) {
    startToolPress(event, tool, point);
  }
}

function startToolPress(event, tool, point) {
  if (tool === "note") {
    event.preventDefault();
    afterUse();
    startNote(point.page, point.x, point.y);
  } else if (tool in MARK_SIZES) {
    event.preventDefault();
    stamp(tool, point);
  } else if (tool === "freetext") {
    startGesture(event, { kind: "textbox", page: point.page, origin: point, capture: true });
  } else if (DRAG_TOOLS.includes(tool)) {
    startGesture(event, { kind: "draw", tool, page: point.page, origin: point, points: [point.x, point.y], capture: true });
  } else if (!TEXT_MARKS.includes(tool) && !event.target.closest(".annotationLayer :is(a, input, textarea, select, button)")) {
    // Objects are dragged; over a text mark the press is left alone so a text selection can start.
    const hit = topmostAt(point);
    const movable = hit && canMove(hit) && canEdit();
    startGesture(event, { kind: movable ? "move" : "click", id: hit?.id, page: point.page, origin: point, clickAction: "select", capture: Boolean(movable) });
  }
}

function onPointerMove(event) {
  if (!gesture) {
    queueHover(event);
    return;
  }
  if (!gesture.dragging && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < DRAG_PX) {
    return;
  }
  gesture.dragging = true;
  const point = toPdfPoint(gesture.page, event.clientX, event.clientY);
  if (gesture.kind === "move") {
    closeCard();
    hideObjectBar();
    gesture.patch = moveBy(model.find(gesture.id), point.x - gesture.origin.x, point.y - gesture.origin.y);
    preview(gesture.id, gesture.patch);
  } else if (gesture.kind === "resize") {
    gesture.patch = resized(gesture, model.find(gesture.id), point, event.shiftKey);
    preview(gesture.id, gesture.patch);
  } else if (gesture.kind === "draw") {
    model.setDraft([shapeDraft(gesture, point, event.shiftKey)]);
  } else if (gesture.kind === "textbox") {
    model.setDraft([{ ...model.create({ ...fieldsFor("freetext"), page: gesture.page }), id: "pdf-textbox-draft", contents: "", rect: dragBox(gesture, point, false) }]);
  }
}

function dragBox(g, point, square) {
  const { x, y } = g.origin;
  let [dx, dy] = [point.x - x, point.y - y];
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    [dx, dy] = [Math.sign(dx || 1) * side, Math.sign(dy || 1) * side];
  }
  return bbox([x, y, x + dx, y + dy]).map(roundPt);
}

/** The drawing in progress as a draft annotation; each call adds `point` to a pen stroke, and `constrain` (Shift) snaps lines to 45° steps. */
function shapeDraft(g, point, constrain) {
  const fields = fieldsFor(g.tool);
  const base = { ...model.create({ ...fields, page: g.page }), id: "pdf-drawing-draft" };
  if (g.tool === "ink") {
    g.points.push(roundPt(point.x), roundPt(point.y));
    return { ...base, ink: [[...g.points]], rect: bbox(g.points) };
  }
  if (fields.kind === "line") {
    let { x, y } = point;
    const { origin } = g;
    if (constrain) {
      const angle = Math.round(Math.atan2(y - origin.y, x - origin.x) / (Math.PI / 4)) * (Math.PI / 4);
      const length = Math.hypot(x - origin.x, y - origin.y);
      [x, y] = [origin.x + length * Math.cos(angle), origin.y + length * Math.sin(angle)];
    }
    const line = [origin.x, origin.y, x, y].map(roundPt);
    return { ...base, line, rect: bbox(line) };
  }
  return { ...base, rect: dragBox(g, point, constrain) };
}

/** The patch for a resize: one end of a line, or a box from the pinned corner (images and Shift keep the aspect ratio). */
function resized(g, a, point, constrain) {
  if (g.handle === "start" || g.handle === "end") {
    const line = [...a.line];
    line.splice(g.handle === "start" ? 0 : 2, 2, roundPt(point.x), roundPt(point.y));
    return { line, rect: bbox(line) };
  }
  const [x1, y1, x2, y2] = g.from;
  const [ax, ay] = g.anchor;
  let [w, h] = [Math.max(4, Math.abs(point.x - ax)), Math.max(4, Math.abs(point.y - ay))];
  if (a.kind === "image" || constrain) {
    const ratio = (x2 - x1) / (y2 - y1 || 1);
    [w, h] = w / h > ratio ? [h * ratio, h] : [w, w / ratio];
  }
  const to = [point.x < ax ? ax - w : ax, point.y < ay ? ay - h : ay, point.x < ax ? ax : ax + w, point.y < ay ? ay : ay + h];
  return fitBox(a, g.from, to);
}

// --- Release and clicks ------------------------------------------------------------------

function onPointerUp(event) {
  const done = gesture;
  gesture = null;
  if (!done) {
    afterTextSelect(event);
    return;
  }
  if (done.capture && scroller().hasPointerCapture(done.pointerId)) {
    scroller().releasePointerCapture(done.pointerId);
  }
  const point = toPdfPoint(done.page, event.clientX, event.clientY);
  if (done.kind === "move" || done.kind === "resize") {
    preview(done.id, null);
    if (done.dragging) {
      model.patch(done.id, done.patch, done.kind === "move" ? "Move" : "Resize");
      // What was dragged ends up selected, so a click elsewhere deselects it and takes its bar away.
      model.select(done.id);
      showObjectBar(done.id);
    } else {
      handleClick(done);
    }
  } else if (done.kind === "draw") {
    commitDrawing(done, point, event.shiftKey);
  } else if (done.kind === "textbox") {
    // Open a text box at the press; a drag wider than 20 pt also sets its width.
    model.setDraft([]);
    afterUse();
    const width = done.dragging ? Math.abs(point.x - done.origin.x) : 0;
    const [left, top] = done.dragging ? [Math.min(point.x, done.origin.x), Math.max(point.y, done.origin.y)] : [done.origin.x, done.origin.y];
    newTextBox(done.page, left, top, width > 20 ? width : undefined);
  } else if (done.dragging || hasSelection()) {
    afterTextSelect(event);
  } else {
    handleClick(done);
  }
}

function commitDrawing(g, point, constrain) {
  const draft = g.dragging ? shapeDraft(g, point, constrain) : undefined;
  model.setDraft([]);
  if (!draft) {
    return;
  }
  const [x1, y1, x2, y2] = bbox(outlinePoints(draft));
  // Shapes under 3 pt are slips of the hand; pen strokes are kept at any size.
  if (draft.kind !== "ink" && Math.max(x2 - x1, y2 - y1) < 3) {
    return;
  }
  const { id: _draftId, ...fields } = draft;
  const recent = inkRun && draft.kind === "ink" && Date.now() - inkRun.at < STROKE_JOIN_MS ? model.find(inkRun.id) : undefined;
  const style = (b) => JSON.stringify([b.page, b.color, b.width, b.opacity]);
  if (recent && style(recent) === style(draft)) {
    const ink = [...recent.ink, ...draft.ink];
    model.patch(recent.id, { ink, rect: bbox(ink.flat()) }, "Draw");
    inkRun = { ...inkRun, at: Date.now() };
    return;
  }
  const a = model.create(fields);
  model.add([a], `Add ${a.kind === "ink" ? "Drawing" : a.arrow ? "Arrow" : { line: "Line", square: "Rectangle", circle: "Oval" }[a.kind]}`);
  inkRun = a.kind === "ink" ? { id: a.id, at: Date.now() } : null;
  afterCreate(a);
}

function stamp(name, { page, x, y }) {
  if (!canEdit()) {
    return;
  }
  const a = name === "signature" ? signatureAt(page, x, y) : name === "image" ? pictureAt(page, x, y) : markAt(name, page, x, y);
  if (a) {
    model.add([a], `Add ${nameOf(a)}`);
    afterCreate(a);
  }
}

/** A check, cross or dot in the tool's style; the check and the cross are pen strokes inside the mark's square (boxed ones a bit larger). */
function markAt(name, page, x, y) {
  const { style } = toolStyle(name);
  const r = (MARK_SIZES[name] * (style === "boxed" ? 1.25 : style === "ring" ? 1.4 : 1)) / 2;
  const rect = [x - r, y - r, x + r, y + r].map(roundPt);
  const ink = name === "dot" ? undefined : markStrokes(name, style, x, y, r);
  return model.create({ ...fieldsFor(name), page, rect, ...(ink && { ink }) });
}

/** Once something is made, count the tool as used; if that brought back Select, select the new object. */
function afterCreate(a) {
  afterUse();
  if (activeTool() === "select") {
    model.select(a.id);
    showObjectBar(a.id);
  }
}

/** On release over selected text: deselect the annotation, then apply the active text-mark tool or show the selection bar. */
function afterTextSelect(event) {
  if (event.button !== 0 || !hasSelection() || !event.target.closest?.(".page, .textLayer")) {
    return;
  }
  closeCard();
  model.select(null);
  if (TEXT_MARKS.includes(activeTool())) {
    markSelection(activeTool(), snapshotSelection());
    afterUse();
  } else {
    showSelectionBar();
  }
}

/** pointercancel: drop whatever the gesture was previewing, committing nothing. */
function cancelGesture() {
  if (gesture) {
    if (gesture.id) {
      preview(gesture.id, null);
    }
    // Gesture drafts have "pdf-" ids; a draft note or comment being written stays.
    model.setDraft(model.drafts().filter((a) => !a.id.startsWith("pdf-")));
    gesture = null;
  }
}

/** Clicks pair into double clicks here, not via `dblclick`: the first click often redraws the page and the browser then never sends one. */
function handleClick({ id, clickAction, cardWasOpen, startX, startY }) {
  const now = performance.now();
  const isDouble = id && prevClick?.id === id && now - prevClick.time < DOUBLE_CLICK_MS && Math.hypot(startX - prevClick.x, startY - prevClick.y) < DRAG_PX;
  prevClick = isDouble ? null : { id, time: now, x: startX, y: startY };
  const a = id && model.find(id);
  if (isDouble) {
    // A double click types into a text box, or opens any other annotation's comment for editing.
    hideObjectBar();
    if (a?.kind === "freetext") {
      editTextBox(a.id);
    } else if (a && a.kind !== "other" && canEdit()) {
      openCard(a.id, { focus: "edit" });
    }
    return;
  }
  if (!a) {
    model.select(null);
    closeCard();
    return;
  }
  if (clickAction === "toggle-card") {
    if (cardWasOpen) {
      closeCard();
    } else {
      openCard(id);
    }
    return;
  }
  // The card opens only with a comment or reply to read; for an empty one the object bar offers "Comment", as in Acrobat.
  if (cardId() !== id) {
    closeCard();
  }
  model.select(id);
  if (a.kind !== "freetext" && (a.contents.trim() || model.replies(id).length)) {
    openCard(id);
  }
  showObjectBar(id);
}

// --- Hover and context menu --------------------------------------------------------------

/** At most once a frame: frame the annotation under the pointer, set the cursor class and peek at its comment. */
function queueHover(event) {
  if (hoverRaf) {
    return;
  }
  const { clientX, clientY, target, buttons } = event;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    const tool = activeTool();
    if (buttons !== 0 || (tool !== "select" && tool !== "hand")) {
      return;
    }
    const icon = noteIconOf(target);
    // Over a note icon nothing is hit-tested (so nothing gets a frame): the icon styles its own hover.
    const point = !icon && scroller().contains(target) && !target.closest(".pdf-popup") ? pageNear(clientX, clientY) : undefined;
    const hit = point ? topmostAt(point) : undefined;
    setHovered(hit?.id ?? null);
    const pointable = tool === "select" && hit;
    const grabbable = pointable && canMove(hit) && canEdit();
    scroller().classList.toggle("pdf-over-object", Boolean(grabbable));
    scroller().classList.toggle("pdf-over-annotation", Boolean(pointable && !grabbable));
    const id = icon?.dataset.id ?? hit?.id ?? null;
    if (id) {
      queuePeek(id, clientX, clientY);
    } else {
      hidePeek();
    }
  });
}

function onContextMenu(event) {
  const { target, clientX: x, clientY: y } = event;
  // Text fields keep the browser's cut/copy/paste menu, and pdf.js's own popups are left alone.
  if (isTextInput(target) || target.closest?.(".pdf-menu-root, #toolbarContainer, .doorHanger, .doorHangerRight, dialog")) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  hidePeek();
  closeMenu();
  hideSelectionBar();
  // Snapshot the selection now; the browser may clear it before a menu item is picked.
  const selection = snapshotSelection();
  const id = noteIconOf(target)?.dataset.id ?? target.closest?.(".pdf-card")?.dataset.id ?? (target.closest?.(".pdf-popup") ? cardId() : null);
  const point = target.closest?.(".page") ? pageAt(x, y) : undefined;
  const near = scroller().contains(target) ? pageNear(x, y) : undefined;
  const hit = id ? model.find(id) : selection ? undefined : near && topmostAt(near);
  if (hit) {
    openThreadMenu(hit, x, y);
  } else if (selection) {
    openMenu(selectionMenu(selection), x, y);
  } else {
    openMenu(pageMenu(point), x, y);
  }
}

function pageMenu(point) {
  const pageNumber = point ? point.page + 1 : (pdfViewer()?.currentPageNumber ?? 1);
  const disabled = Boolean(model.readOnlyReason());
  return [
    ...(point
      ? [
          { label: "Add Sticky Note Here", action: () => startNote(point.page, point.x, point.y), disabled },
          { label: "Add Text Here", action: () => newTextBox(point.page, point.x, point.y), disabled },
          { label: "Insert Image Here…", action: () => insertPicture(point), disabled },
          { label: "Sign Here…", action: () => signAt(point), disabled },
          { separator: true },
        ]
      : []),
    ...PAGE_COMMANDS.map(([label, command]) => ({ label, action: () => hostCommand(command, pageNumber), disabled })),
    { separator: true },
    { label: "Save", action: () => hostCommand("workbench.action.files.save") },
    { label: "Print…", action: () => hostCommand("pdf.print") },
  ];
}

async function signAt(point) {
  if (storedSignature() || (await askSignature())) {
    stamp("signature", point);
  }
}
