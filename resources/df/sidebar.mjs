/**
 * Bridge to the (patched) pdf.js comments sidebar: refreshes the list after
 * df comment changes, and dispatches reply/edit/delete/resolve actions from
 * its buttons.
 */
import { bus, ui } from "./util.mjs";
import { deleteComment, editCommentText, replyToComment, resolveComment } from "./comments.mjs";
import { openDialog } from "./dialog.mjs";
import { refreshOverlay } from "./notes.mjs";

export function refreshSidebar() {
  const sidebar = document.getElementById("editorCommentsSidebar");
  const visible = sidebar && !sidebar.closest("[hidden]") && !sidebar.hidden;
  if (ui()?.dfShowComments && visible) {
    void ui().dfShowComments();
  }
  refreshOverlay();
}

/** Wire the sidebar's action events. Call once at startup. */
export function initCommentEvents() {
  bus().on("dfcommentreply", (event) => {
    const parent = event.annotation;
    openDialog({
      title: `Reply${parent.user ? ` to ${parent.user}` : ""}`,
      placeholder: "Reply\u2026",
      onCommit: (text) => text && replyToComment(parent, text),
    });
  });
  bus().on("dfcommentedit", (event) => {
    const entry = event.annotation;
    openDialog({
      title: "Edit comment",
      text: entry.contentsObj?.str || entry.contents || "",
      onCommit: (text) => editCommentText(entry, text),
    });
  });
  bus().on("dfcommentdelete", (event) => deleteComment(event.annotation));
  bus().on("dfcommentresolve", (event) => resolveComment(event.annotation));
}
