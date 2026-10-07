/**
 * Standalone sticky notes: a toolbar Note button plus click-to-place, and
 * on-page icons for notes that are new this session (pdf.js only renders
 * icons for annotations already saved in the file). Click (or double-click)
 * an icon to edit its comment; drag an icon to move the note — pdf.js
 * cannot reposition saved annotations, so we store a rect override instead.
 */
import { app, bus, pageViewFromPoint, toPdfPoint, ui } from "./util.mjs";
import {
  addStickyNote,
  allComments,
  deleteComment,
  eachStorageEntry,
  editCommentText,
  moveStickyNote,
} from "./comments.mjs";
import { openDialog } from "./dialog.mjs";
import { editorAt, savedAnnotationAt, selectSavedAnnotation } from "./interactions.mjs";

let noteMode = false;
const overlays = new Map();

function setNoteMode(on) {
  noteMode = on;
  document.body.classList.toggle("df-note-mode", on);
  document.getElementById("dfNoteButton")?.classList.toggle("toggled", on);
  document.removeEventListener("click", placeNote, true);
  if (on) {
    document.addEventListener("click", placeNote, true);
    // Leaving any active drawing tool: otherwise the page keeps the highlight /
    // ink cursor and the note cursor never shows (the cursor looks "stuck").
    const viewer = app()?.pdfViewer;
    const mode = viewer?.annotationEditorMode;
    if (viewer && (typeof mode === "object" ? mode?.mode : mode) > 0) {
      viewer.annotationEditorMode = { mode: 0 };
    }
  }
}

function noteText(note) {
  return note?.contentsObj?.str ?? note?.contents ?? "";
}

/** Edit an existing note (empty text deletes it); the dialog opens by the icon. */
export function openNoteDialog(note, at) {
  openDialog({
    title: `Comment by ${note.user || note.titleObj?.str || "you"}`,
    text: noteText(note),
    at,
    onCommit: (text) => {
      if (text === noteText(note)) {
        return;
      }
      if (text) {
        editCommentText(note, text);
      } else {
        deleteComment(note);
      }
    },
  });
}

function placeNote(event) {
  if (
    event.target?.closest?.(
      ".df-comment-dialog, dialog, .df-context-menu, .df-note-icon, #toolbarViewer, .dialog",
    )
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  setNoteMode(false);
  const view = pageViewFromPoint(event.clientX, event.clientY);
  if (!view) {
    return;
  }
  const [x, y] = toPdfPoint(view, event.clientX, event.clientY);
  openDialog({
    title: "Add note",
    at: { x: event.clientX, y: event.clientY },
    onCommit: (text) => text && addStickyNote(view.id - 1, x, y, text),
  });
}

/** The saved-file sticky-note icon under a client point, if any. */
function savedNoteIconAt(clientX, clientY) {
  for (const el of document.querySelectorAll(
    ".page .annotationLayer .textAnnotation[data-annotation-id]",
  )) {
    const r = el.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
      return el;
    }
  }
  return null;
}

/**
 * Show the comment dialog for a client point (used by the context menu).
 * Acrobat-style: when the point is on an annotation (e.g. a highlight) or
 * there is a text selection, the comment binds to that mark instead of
 * creating a standalone sticky note.
 */
export function addCommentAtPoint(clientX, clientY) {
  const at = { x: clientX, y: clientY };
  // 1. A saved sticky note: edit its text (it has no pdf.js editor).
  const icon = savedNoteIconAt(clientX, clientY);
  if (icon) {
    const id = icon.getAttribute("data-annotation-id");
    const entry = allComments().find((e) => e.id === id);
    if (entry) {
      openNoteDialog(entry, at);
      return;
    }
  }
  // 2. Comment on the annotation under the cursor (highlight, drawing, ...).
  const editor = editorAt(clientX, clientY);
  if (editor?.canAddComment) {
    editor.editComment();
    return;
  }
  // A saved annotation from the file: convert it to a selected editor the
  // same way a double-click does, and open its comment editor. Works even
  // when that annotation's mode is already active (see selectSavedAnnotation).
  const saved = savedAnnotationAt(clientX, clientY);
  if (saved) {
    selectSavedAnnotation(saved, { editComment: true });
    return;
  }
  // 3. Comment on the current text selection: creates the highlight and opens
  // its comment editor, like Acrobat's "Add note inside selection".
  const selection = document.getSelection?.();
  if (selection && !selection.isCollapsed && selection.toString().trim()) {
    ui()?.commentSelection("context_menu");
    return;
  }
  // 4. Otherwise a standalone sticky note at the point.
  const view = pageViewFromPoint(clientX, clientY);
  if (!view) {
    return;
  }
  const [x, y] = toPdfPoint(view, clientX, clientY);
  openDialog({
    title: "Add note",
    at,
    onCommit: (text) => text && addStickyNote(view.id - 1, x, y, text),
  });
}

function addNoteButton() {
  const container = document.getElementById("editorComment");
  if (!container || document.getElementById("dfNoteButton")) {
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "toolbarButtonWithContainer";
  const button = document.createElement("button");
  button.id = "dfNoteButton";
  button.className = "toolbarButton dfNoteButton";
  button.type = "button";
  button.tabIndex = 0;
  button.title = "Add note (sticky note on the page)";
  button.setAttribute("aria-label", "Add note (sticky note on the page)");
  button.addEventListener("click", () => setNoteMode(!noteMode));
  wrap.append(button);
  container.before(wrap);
}

// --- Drag-to-move -----------------------------------------------------------

/** Set for a moment after a drag so the trailing click does not open a dialog. */
let justDragged = false;
export function wasJustDragged() {
  return justDragged;
}

/**
 * Drag `icon` from a pointerdown event. `getRect` returns the current PDF
 * rect; the icon follows the pointer and the new rect is committed on release.
 */
function startDrag(down, icon, view, getRect, onMove) {
  if (down.button !== 0) {
    return;
  }
  down.stopPropagation();
  const start = toPdfPoint(view, down.clientX, down.clientY);
  const rect0 = [...getRect()];
  const scale = view.viewport.scale || 1;
  let moved = false;
  const onMovePointer = (event) => {
    const [x, y] = toPdfPoint(view, event.clientX, event.clientY);
    const dx = x - start[0];
    const dy = y - start[1];
    if (!moved && Math.hypot(dx, dy) * scale < 4) {
      return;
    }
    moved = true;
    icon.style.transform = `translate(${dx * scale}px, ${-dy * scale}px)`;
  };
  const onUp = (event) => {
    document.removeEventListener("pointermove", onMovePointer, true);
    document.removeEventListener("pointerup", onUp, true);
    icon.style.transform = "";
    if (!moved) {
      return;
    }
    justDragged = true;
    setTimeout(() => (justDragged = false), 300);
    const [x, y] = toPdfPoint(view, event.clientX, event.clientY);
    const dx = x - start[0];
    const dy = y - start[1];
    const w = rect0[2] - rect0[0];
    const h = rect0[3] - rect0[1];
    const pw = view.viewport.width / scale;
    const ph = view.viewport.height / scale;
    const nx = Math.min(Math.max(rect0[0] + dx, 0), pw - w);
    const ny = Math.min(Math.max(rect0[1] + dy, 0), ph - h);
    onMove([nx, ny, nx + w, ny + h]);
  };
  document.addEventListener("pointermove", onMovePointer, true);
  document.addEventListener("pointerup", onUp, true);
}

/** Redraw unsaved-note icons and hide icons of notes deleted this session. */
export function refreshOverlay() {
  const viewer = app().pdfViewer;
  if (!viewer) {
    return;
  }
  const deletedFileIds = new Set();
  const movedFileIds = new Set();
  const wanted = new Map();
  eachStorageEntry((value) => {
    if (value?.dfComment !== true) {
      return;
    }
    if (value.deleted) {
      deletedFileIds.add(value.id);
    } else if (value.dfParentId) {
      // replies are sidebar-only, never an on-page icon
    } else if (!value.fileId || value.dfMoved) {
      wanted.set(value.pageIndex, (wanted.get(value.pageIndex) || []).concat(value));
      if (value.dfMoved) {
        movedFileIds.add(value.fileId);
      }
    }
  });
  for (const el of document.querySelectorAll(".textAnnotation[data-annotation-id]")) {
    const id = el.getAttribute("data-annotation-id");
    // Hide icons of deleted notes, and of saved notes moved this session —
    // the overlay icon below shows the new position instead.
    el.style.display = deletedFileIds.has(id) || movedFileIds.has(id) ? "none" : "";
  }
  for (const [pageIndex, notes] of wanted) {
    const view = viewer.getPageView(pageIndex);
    if (!view?.div) {
      continue;
    }
    let layer = overlays.get(pageIndex);
    // pdf.js replaces the page's DOM on every (re)render; a cached layer can
    // end up detached, which made unsaved note icons vanish after zooming or
    // resizing. Re-attach whenever the cached layer left the page.
    if (!layer || !layer.isConnected) {
      layer = document.createElement("div");
      layer.className = "df-note-overlay";
      view.div.append(layer);
      overlays.set(pageIndex, layer);
    }
    const { pageWidth, pageHeight, pageX, pageY } = view.viewport.rawDims;
    layer.replaceChildren();
    for (const note of notes) {
      const [x1, , , y2] = note.rect;
      // A <div>, not an <img>: images are natively draggable, and dragging one
      // out of the page looked like the note "turning into an image".
      const icon = document.createElement("div");
      icon.className = "df-note-icon";
      icon.draggable = false;
      icon.title = note.contents || "Comment";
      icon.style.left = `${(100 * (x1 - pageX)) / pageWidth}%`;
      icon.style.top = `${(100 * (pageHeight - y2 + pageY)) / pageHeight}%`;
      icon.addEventListener("click", (event) => {
        if (wasJustDragged()) {
          return;
        }
        event.stopPropagation();
        openNoteDialog(note, { x: event.clientX, y: event.clientY });
      });
      icon.addEventListener("pointerdown", (down) =>
        startDrag(down, icon, view, () => note.rect, (rect) => moveStickyNote(note, rect)),
      );
      layer.append(icon);
    }
  }
  for (const [pageIndex, layer] of overlays) {
    if (!wanted.has(pageIndex)) {
      layer.remove();
      overlays.delete(pageIndex);
    }
  }
}

/** Clear all overlay state, e.g. when the document reloads. */
function clearOverlays() {
  for (const layer of overlays.values()) {
    layer.remove();
  }
  overlays.clear();
}

export function initNotes() {
  // Single-click a saved note icon → highlight its row in the comments sidebar,
  // like Acrobat's bidirectional page ↔ Comments panel selection.
  document.addEventListener(
    "click",
    (event) => {
      if (wasJustDragged()) {
        return;
      }
      const id = event.target
        ?.closest?.(".textAnnotation[data-annotation-id]")
        ?.getAttribute("data-annotation-id");
      if (!id) {
        return;
      }
      const list = document.getElementById("editorCommentsSidebarList");
      const row = list?.querySelector(`li[data-df-id="${CSS.escape(id)}"]`);
      if (!row) {
        return;
      }
      for (const el of list.querySelectorAll("li.selected")) {
        el.classList.toggle("selected", el === row);
      }
      row.classList.add("selected");
      row.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
    true,
  );

  // Double-click a saved sticky-note icon to edit (empty text deletes).
  document.addEventListener(
    "dblclick",
    (event) => {
      const icon = event.target?.closest?.(".textAnnotation[data-annotation-id]");
      if (!icon || wasJustDragged()) {
        return;
      }
      const entry = allComments().find((e) => e.id === icon.getAttribute("data-annotation-id"));
      if (!entry) {
        return;
      }
      event.preventDefault();
      openNoteDialog(entry, { x: event.clientX, y: event.clientY });
    },
    true,
  );

  // Drag saved note icons (pdf.js cannot move file annotations): store a rect
  // override so the new position is written on save.
  document.addEventListener(
    "pointerdown",
    (event) => {
      const el = event.target?.closest?.(".textAnnotation[data-annotation-id]");
      if (!el || event.button !== 0 || el.dataset.dfDrag) {
        return;
      }
      const page = el.closest(".page");
      const view = app()
        ?.pdfViewer?._pages?.find((v) => v.div === page || v.div?.contains(page));
      if (!view) {
        return;
      }
      el.dataset.dfDrag = "1";
      const id = el.getAttribute("data-annotation-id");
      const viewPortPdfRect = () => {
        const scale = view.viewport.scale || 1;
        const layer = view.div.querySelector(":scope > .annotationLayer");
        const r = el.getBoundingClientRect();
        const layerRect = (layer || view.div).getBoundingClientRect();
        const [x, top] = view.viewport.convertToPdfPoint(r.left - layerRect.left, r.top - layerRect.top);
        const w = r.width / scale;
        const h = r.height / scale;
        return [x, top - h, x + w, top];
      };
      const save = async (rect) => {
        let entry = allComments().find((e) => e.id === id);
        if (!entry) {
          // Sidebar never opened: load the annotation so its text survives the
          // rect override instead of being replaced by an empty note.
          const page = await app().pdfDocument.getPage(view.id);
          const anns = await page.getAnnotations();
          entry = { ...anns.find((a) => a.id === id), rect, pageIndex: view.id - 1 };
          if (!entry.id) {
            return;
          }
        }
        moveStickyNote(entry, rect);
      };
      startDrag(event, el, view, () => {
        const entry = allComments().find((e) => e.id === id);
        return entry?.rect || viewPortPdfRect();
      }, save);
    },
    true,
  );

  for (const event of ["pagerendered", "scalechanging", "rotationchanging", "editorsrendered"]) {
    bus().on(event, () => refreshOverlay());
  }

  // Leaving select mode (a real tool was activated) cancels note mode.
  bus().on("editormodechanged", ({ mode }) => {
    if (mode !== 0 && noteMode) {
      setNoteMode(false);
    }
  });
}

/** Called once per document open. */
export function onNotesDocumentOpen() {
  clearOverlays();
  setNoteMode(false);
  addNoteButton();
  refreshOverlay();
}
