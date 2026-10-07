/**
 * Interaction fixes on top of stock pdf.js:
 *
 *  - Tool door-hangers (the Highlight / Text / Draw option popups) never close
 *    on their own: once a tool is active the popup stays open while the user
 *    works on the page. Close it when the user clicks anywhere else or presses
 *    Escape, like Acrobat does.
 *  - In select (arrow) mode, a single click cannot grab an existing highlight:
 *    pdf.js disables pointer events on the editor layer and only reacts to
 *    double-click. Make a single click select the editor under the cursor and
 *    click-on-empty-space deselect, like the official PDF editors.
 */
import { app, bus, ui } from "./util.mjs";

const DOORHANGERS = [
  "editorHighlightParamsToolbar",
  "editorFreeTextParamsToolbar",
  "editorInkParamsToolbar",
  "editorStampParamsToolbar",
  "editorSignatureParamsToolbar",
  "editorCommentParamsToolbar",
];

function openPanels() {
  // pdf.js hides panels with the "hidden" class; check both mechanisms.
  return DOORHANGERS.map((id) => document.getElementById(id)).filter(
    (el) => el && !el.hidden && !el.classList.contains("hidden"),
  );
}

/**
 * Close every open tool door-hanger, keeping button state consistent.
 * pdf.js shows/hides these panels with the "hidden" *class* (see
 * toggleExpandedBtn); setting the `hidden` attribute instead desyncs the
 * button state and the panels can never open again.
 */
export function closeDoorHangers() {
  for (const panel of openPanels()) {
    panel.classList.add("hidden");
    const button = document.querySelector(`[aria-controls="${panel.id}"]`);
    button?.classList.remove("toggled");
    button?.setAttribute("aria-expanded", "false");
  }
}

function initDoorHangerAutoClose() {
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (openPanels().length === 0) {
        return;
      }
      // Interacting with a panel, a toolbar or a dialog keeps it open;
      // pdf.js closes panels itself when another tool button is pressed.
      const keep = event.target?.closest?.(
        ".editorParamsToolbar, .toolbarButton, .toolbarButtonWithContainer, #toolbarViewer, dialog, .dialog, .df-context-menu, .popupWrapper, #editorToolbar",
      );
      if (keep) {
        return;
      }
      closeDoorHangers();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && openPanels().length > 0) {
        closeDoorHangers();
      }
    },
    true,
  );
}

const EDITOR_SELECTOR = ".highlightEditor, .freeTextEditor, .inkEditor, .stampEditor";

/**
 * pdf.js toggles a tool *off* when its toolbar button is clicked again. That
 * makes it impossible to re-open the color/size panel after drawing (users
 * think the tool is "stuck on the drawing"), so instead: clicking the already
 * active tool keeps the tool and re-opens its door-hanger, Acrobat-style.
 * Escape exits the tool (see initToolEscape).
 */
const TOOL_PANELS = {
  editorHighlightButton: "editorHighlightParamsToolbar",
  editorFreeTextButton: "editorFreeTextParamsToolbar",
  editorInkButton: "editorInkParamsToolbar",
  editorStampButton: "editorStampParamsToolbar",
};
const TOOL_MODES = {
  editorHighlightButton: 9, // HIGHLIGHT
  editorFreeTextButton: 3, // FREETEXT
  editorInkButton: 15, // INK
  editorStampButton: 13, // STAMP
};

function initToolReopen() {
  document
    .getElementById("editorModeButtons")
    ?.addEventListener(
      "click",
      (event) => {
        const button = event.target?.closest?.("button.toolbarButton");
        const mode = button && TOOL_MODES[button.id];
        if (!mode) {
          return;
        }
        const viewer = app()?.pdfViewer;
        const current = viewer?.annotationEditorMode;
        if (!viewer || (typeof current === "object" ? current?.mode : current) !== mode) {
          return; // not the active tool: let pdf.js switch normally
        }
        // Swallow pdf.js's toggle-to-NONE: keep the tool and show its options.
        event.stopPropagation();
        const manager = ui();
        if (mode === 15) {
          manager?.commitOrRemove?.();
        }
        // A selected editor keeps its selection so the panel shows *its*
        // color / font / size, letting the user tweak the existing object.
        if (!manager?.firstSelectedEditor) {
          manager?.unselectAll?.();
        }
        const panel = document.getElementById(TOOL_PANELS[button.id]);
        if (panel?.classList.contains("hidden")) {
          panel.classList.remove("hidden");
          button.classList.add("toggled");
          button.setAttribute("aria-expanded", "true");
        }
      },
      true,
    );
}

/** Escape leaves the active drawing tool (and the eraser), like Acrobat. */
function initToolEscape() {
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") {
        return;
      }
      // A dialog or an open door-hanger handles Escape itself.
      if (
        document.querySelector(".df-comment-dialog:not([hidden]), dialog[open]") ||
        openPanels().length > 0
      ) {
        return;
      }
      const viewer = app()?.pdfViewer;
      const mode = viewer?.annotationEditorMode;
      const value = typeof mode === "object" ? mode?.mode : mode;
      if (value > 0 && value !== 16 /* POPUP: the sidebar closes on its own */) {
        viewer.annotationEditorMode = { mode: 0 };
      }
    },
    true,
  );
}

/**
 * Select the editor for a saved annotation element (double-click equivalent).
 * pdf.js ignores the `switchannotationeditormode` event when the requested
 * mode equals the current one, which made "Add Comment" on an already-active
 * annotation silently do nothing — so when the converted editor exists, drive
 * it directly instead of going through the event bus.
 */
export function selectSavedAnnotation(el, { editComment = false, enterEdit = false } = {}) {
  const viewer = app()?.pdfViewer;
  const manager = ui();
  const mode = annotationEditorMode(el);
  if (!viewer || !manager || mode === undefined) {
    return false;
  }
  const id = el.getAttribute("data-annotation-id");
  const page = el.closest(".page");
  const view = viewer._pages?.find((v) => v.div === page || v.div?.contains(page));
  for (const editor of manager.getEditors(Math.max(0, (view?.id ?? 1) - 1))) {
    if (editor.annotationElementId === id && !editor.deleted) {
      manager.setSelected(editor);
      if (editComment) {
        editor.editComment();
      } else if (enterEdit) {
        editor.enterInEditMode();
      } else {
        editor.focus();
      }
      return true;
    }
  }
  bus()?.dispatch("switchannotationeditormode", {
    source: window,
    mode,
    editId: id,
    editComment,
    mustEnterInEditMode: enterEdit,
  });
  return true;
}

/**
 * pdf.js re-enables hit-testing for one moment with the `getElements` class
 * (its own double-click hack). Reuse the same trick so a single click can find
 * the editor div under the pointer even though the layer is disabled.
 */
export function editorDivAt(page, clientX, clientY) {
  const layer = page.querySelector(":scope > .annotationEditorLayer");
  if (!layer) {
    return null;
  }
  if (layer.classList.contains("disabled")) {
    layer.classList.add("getElements");
    const hit = document
      .elementsFromPoint(clientX, clientY)
      .find((el) => el.matches?.(EDITOR_SELECTOR));
    layer.classList.remove("getElements");
    return hit ?? null;
  }
  // Layer enabled (a tool is active): editor divs are hit-testable already.
  return document
    .elementsFromPoint(clientX, clientY)
    .find((el) => el.matches?.(EDITOR_SELECTOR) && layer.contains(el)) ?? null;
}

/** The editor object under a client point, if any. */
export function editorAt(clientX, clientY) {
  const viewer = app()?.pdfViewer;
  const manager = ui();
  if (!viewer || !manager) {
    return null;
  }
  const page = document
    .elementsFromPoint(clientX, clientY)
    .find((el) => el.classList?.contains("page"));
  if (!page) {
    return null;
  }
  const div = editorDivAt(page, clientX, clientY);
  if (!div) {
    return null;
  }
  const view = viewer._pages?.find((v) => v.div === page || v.div?.contains(page));
  for (const editor of manager.getEditors(Math.max(0, (view?.id ?? 1) - 1))) {
    if (editor.div === div) {
      return editor;
    }
  }
  return null;
}

/**
 * A saved annotation element (from the file's annotation layer) whose rect
 * contains the client point. Annotation elements are pointer-events:none in
 * select mode, so hit-testing is done with bounding rectangles; the
 * innermost (smallest) match wins.
 */
export function savedAnnotationAt(clientX, clientY) {
  let best;
  let bestArea = Infinity;
  for (const el of document.querySelectorAll(".page .annotationLayer [data-annotation-id]")) {
    if (annotationEditorMode(el) === undefined) {
      continue; // not an annotation with an editor equivalent (widget, link…)
    }
    const r = el.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) {
      continue;
    }
    const area = r.width * r.height;
    if (area < bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best ?? null;
}

function initClickSelect() {
  document.addEventListener(
    "click",
    (event) => {
      if (event.button !== 0) {
        return;
      }
      if (event.target?.closest?.("#toolbarViewer, dialog, .dialog, .df-context-menu, .editorParamsToolbar, popup, .popupWrapper")) {
        return;
      }
      const viewer = app()?.pdfViewer;
      const mode = viewer?.annotationEditorMode;
      if (!viewer || (typeof mode === "object" ? mode?.mode : mode) !== 0) {
        return; // an edit tool is active: pdf.js handles clicks itself
      }
      // A saved annotation from the file (highlight, ink, text box, image):
      // select it with a single click by dispatching the same event pdf.js
      // fires on double-click — it converts the annotation into a selected
      // editor. Without this, a saved highlight can only be grabbed by first
      // activating its tool. These elements are pointer-events:none in select
      // mode, so hit-test by rectangle rather than event target.
      const annotEl = savedAnnotationAt(event.clientX, event.clientY);
      if (annotEl && annotationEditorMode(annotEl) !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        selectSavedAnnotation(annotEl);
        return;
      }
      const manager = ui();
      if (!manager) {
        return;
      }
      const page = event.target?.closest?.(".page");
      if (!page) {
        return; // space between pages
      }
      const view = viewer._pages?.find((v) => v.div === page || v.div?.contains(page));
      const div = editorDivAt(page, event.clientX, event.clientY);
      if (!div) {
        // Click on empty page space: deselect, like Acrobat.
        const selected = manager.firstSelectedEditor;
        if (selected) {
          manager.unselect(selected);
        }
        return;
      }
      const editor = [...manager.getEditors(Math.max(0, (view?.id ?? 1) - 1))].find((e) => e.div === div);
      if (editor) {
        event.preventDefault();
        event.stopPropagation();
        manager.setSelected(editor);
      }
    },
    true,
  );
}

/**
 * The editor mode matching a saved annotation element in the annotation
 * layer, or undefined when the element has no editor equivalent. Mirrors
 * the annotationEditorType of the corresponding AnnotationElement subclass.
 */
export function annotationEditorMode(el) {
  const c = el.classList;
  if (c.contains("highlightAnnotation") || c.contains("underlineAnnotation") || c.contains("strikeOutAnnotation") || c.contains("squigglyAnnotation")) {
    return 9; // HIGHLIGHT
  }
  if (c.contains("inkAnnotation")) {
    return 15; // INK
  }
  if (c.contains("freeTextAnnotation")) {
    return 3; // FREETEXT
  }
  if (c.contains("stampAnnotation")) {
    return 13; // STAMP
  }
  return undefined;
}

export function initInteractions() {
  initDoorHangerAutoClose();
  initClickSelect();
  initToolReopen();
  initToolEscape();
}
