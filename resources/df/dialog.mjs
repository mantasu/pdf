/**
 * A small modal used for writing, replying to and editing comments.
 * Ctrl/Cmd+Enter commits, Escape cancels.
 */

let dialogEl;
let dialogContext = null;

function build() {
  if (dialogEl) {
    return dialogEl;
  }
  dialogEl = document.createElement("div");
  dialogEl.className = "df-comment-dialog";
  dialogEl.setAttribute("role", "dialog");
  dialogEl.setAttribute("aria-modal", "true");

  const title = document.createElement("div");
  title.className = "df-comment-dialog-title";
  const area = document.createElement("textarea");
  area.className = "df-comment-dialog-text";
  area.placeholder = "Type a comment\u2026";

  const buttons = document.createElement("div");
  buttons.className = "df-comment-dialog-buttons";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary";
  save.textContent = "Save";
  buttons.append(cancel, save);

  dialogEl.append(title, area, buttons);
  document.body.append(dialogEl);

  cancel.addEventListener("click", () => closeDialog());
  save.addEventListener("click", () => commit());
  area.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      commit();
    } else if (event.key === "Escape") {
      closeDialog();
    }
  });
  return dialogEl;
}

function commit() {
  const ctx = dialogContext;
  const text = dialogEl.querySelector(".df-comment-dialog-text").value.trim();
  closeDialog();
  ctx?.onCommit(text);
}

// Click anywhere outside (or press Escape) dismisses the dialog, so it can
// never get stuck on screen while the user works on the page.
function onDocPointerDown(event) {
  if (!dialogContext || dialogEl?.hidden) {
    return;
  }
  if (!event.target?.closest?.(".df-comment-dialog")) {
    closeDialog();
  }
}

function onDocKeyDown(event) {
  if (event.key === "Escape" && dialogContext && !dialogEl?.hidden) {
    event.preventDefault();
    closeDialog();
  }
}

document.addEventListener("pointerdown", onDocPointerDown, true);
document.addEventListener("keydown", onDocKeyDown, true);

/**
 * Acrobat puts the comment box next to the mark, never over the page centre.
 * @param {{title: string, text?: string, placeholder?: string,
 *   at?: {x:number,y:number}, onCommit: (text: string) => void}} opts
 */
export function openDialog(opts) {
  const el = build();
  dialogContext = opts;
  el.querySelector(".df-comment-dialog-title").textContent = opts.title;
  const area = el.querySelector(".df-comment-dialog-text");
  area.placeholder = opts.placeholder || "Type a comment\u2026";
  area.value = opts.text || "";
  el.hidden = false;
  placeAt(el, opts.at);
  area.focus();
}

function placeAt(el, at) {
  if (!at) {
    el.style.left = "";
    el.style.top = "";
    el.style.transform = "";
    return;
  }
  el.style.transform = "none";
  const { width, height } = el.getBoundingClientRect();
  const gap = 12;
  let x = at.x + gap;
  let y = at.y + gap;
  if (x + width > innerWidth - gap) {
    x = at.x - width - gap;
  }
  if (y + height > innerHeight - gap) {
    y = Math.max(gap, at.y - height - gap);
  }
  el.style.left = `${Math.max(gap, x)}px`;
  el.style.top = `${Math.max(gap, y)}px`;
}

export function closeDialog() {
  dialogContext = null;
  if (dialogEl) {
    dialogEl.hidden = true;
  }
}
