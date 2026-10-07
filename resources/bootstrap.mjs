/**
 * Webview bootstrap: thin entry point that configures the stock pdf.js viewer
 * for the VS Code webview and wires the df modules. Feature code lives in
 * resources/df/:
 *
 *   util.mjs        — host bridge, config, viewer accessors
 *   config.mjs      — viewer options + tool defaults
 *   dialog.mjs      — comment write/reply/edit dialog
 *   comments.mjs    — comment model (author /T, sticky notes, /IRT replies)
 *   notes.mjs       — Note tool, on-page icons, sidebar selection sync
 *   sidebar.mjs     — comments-panel refresh + reply/edit/delete/resolve
 *   contextmenu.mjs — right-click menu
 *   interactions.mjs — door-hanger auto-close, click-to-select editors
 *   document.mjs    — open/serialize/save/print/dirty lifecycle
 */
import { configureViewer } from "./df/config.mjs";
import { app, config, post, postError } from "./df/util.mjs";
import { setCommentChangeHandler } from "./df/comments.mjs";
import { initNotes } from "./df/notes.mjs";
import { initCommentEvents, refreshSidebar } from "./df/sidebar.mjs";
import { initContextMenu } from "./df/contextmenu.mjs";
import { initInteractions } from "./df/interactions.mjs";
import { initDocEvents, openDocument, serialize } from "./df/document.mjs";

configureViewer();

// Comment changes mark the editor dirty and refresh the sidebar + icons.
setCommentChangeHandler(refreshSidebar);

window.addEventListener("message", async (event) => {
  if (event.origin !== window.origin) {
    return;
  }
  const message = event.data;
  await app().initializedPromise;
  try {
    switch (message?.type) {
      case "request-save":
        post({ type: "saved", data: await serialize() });
        break;
      case "request-print":
        post({ type: "print", data: await serialize() });
        break;
      case "reload": {
        const page = message.page ?? app().pdfViewer?.currentPageNumber ?? 1;
        app()._hasChanges = () => false;
        await openDocument(page);
        break;
      }
      default:
        break;
    }
  } catch (error) {
    postError(error);
  }
});

// Open links to sibling files with regular VS Code editors.
document.addEventListener(
  "click",
  (event) => {
    const anchor = event.target?.closest?.("a");
    if (anchor?.href && !anchor.href.startsWith("#") && anchor.href.startsWith(config.resourceRoot)) {
      event.preventDefault();
      post({ type: "open", url: anchor.href });
    }
  },
  true,
);

void (async () => {
  try {
    await app().initializedPromise;
    initCommentEvents();
    initNotes();
    initContextMenu();
    initInteractions();
    initDocEvents();
    await openDocument();
  } catch (error) {
    postError(error);
  }
})();
