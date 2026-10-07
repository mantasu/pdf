/**
 * Right-click context menu: commenting, save/print and the page operations,
 * routed either directly (highlight, add comment) or through the host as
 * `command` messages (allowlisted in src/protocol.ts). Page operations act on
 * the page under the cursor, not the globally current one.
 */
import { app, post, ui } from "./util.mjs";
import { addCommentAtPoint } from "./notes.mjs";
import { closeDoorHangers } from "./interactions.mjs";

/** 1-based page number under a client point, or the current page. */
function pageAt(clientX, clientY) {
  const viewer = app()?.pdfViewer;
  for (const view of viewer?._pages ?? []) {
    const rect = view?.div?.getBoundingClientRect?.();
    if (rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return view.id;
    }
  }
  return viewer?.currentPageNumber ?? 1;
}

function pageCommand(command) {
  return () => post({ type: "command", command, args: [contextPage] });
}

const MENU = [
  { label: "Highlight selection", action: () => ui()?.highlightSelection("context_menu") },
  { label: "Add Comment", action: () => addCommentAtPoint(contextPoint[0], contextPoint[1]) },
  { label: "Save", action: () => post({ type: "command", command: "df.save" }) },
  { label: "Print", action: () => post({ type: "command", command: "df.print" }) },
  { sep: true },
  { label: "Rotate Page", action: pageCommand("df.rotatePage") },
  { label: "Delete Page", action: pageCommand("df.deletePage") },
  { label: "Move Page Up", action: pageCommand("df.movePageUp") },
  { label: "Move Page Down", action: pageCommand("df.movePageDown") },
  { label: "Insert Blank Page Before", action: pageCommand("df.insertBlankPageBefore") },
  { label: "Insert Blank Page After", action: pageCommand("df.insertBlankPageAfter") },
];

let contextPoint = [0, 0];
let contextPage = 1;
let menuEl;

function hideMenu() {
  menuEl?.remove();
  menuEl = undefined;
}

function showMenu(x, y) {
  hideMenu();
  menuEl = document.createElement("div");
  menuEl.className = "df-context-menu";
  for (const item of MENU) {
    if (item.sep) {
      menuEl.append(document.createElement("hr"));
      continue;
    }
    const entry = document.createElement("button");
    entry.type = "button";
    entry.textContent = item.label;
    entry.addEventListener("click", () => {
      hideMenu();
      item.action();
    });
    menuEl.append(entry);
  }
  document.body.append(menuEl);
  menuEl.style.left = `${Math.min(x, innerWidth - menuEl.offsetWidth)}px`;
  menuEl.style.top = `${Math.min(y, innerHeight - menuEl.offsetHeight)}px`;
}

export function initContextMenu() {
  document.addEventListener(
    "contextmenu",
    (event) => {
      // Let pdf.js handle right-clicks inside its own editors/toolbar widgets.
      if (event.target?.closest?.(".editorParamsToolbar, #toolbarViewer, dialog")) {
        return;
      }
      event.preventDefault();
      contextPoint = [event.clientX, event.clientY];
      contextPage = pageAt(event.clientX, event.clientY);
      closeDoorHangers();
      showMenu(event.clientX, event.clientY);
    },
    true,
  );
  document.addEventListener("click", hideMenu, true);
  window.addEventListener("blur", hideMenu);
}
