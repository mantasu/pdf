/**
 * Comment model: comments (sticky notes, replies, edited file annotations)
 * live in pdf.js annotationStorage as pseudo-entries (`annotationType` 1001,
 * see scripts/patch-pdfjs.mjs). The patched worker serializes them to
 * spec-compliant PDF: `/Subtype /Text`, `/T` author, `/Contents`, `/IRT`
 * replies — so Adobe and other viewers read them natively.
 *
 * Entries loaded from the file keep their object-reference id ("5R") and are
 * changed by *storing an override* under that id (`fileId`); new notes get a
 * generated `df-*` id and are stored as fresh pseudo-annotations.
 */
import { app, config, pdfDate, post, ui } from "./util.mjs";

/** Pseudo annotation type handled by our patched worker. */
export const NOTE_TYPE = 1001;
const PREF = "pdfjs_internal_editor_";

const storage = () => app().pdfDocument?.annotationStorage;

/** Called after any comment change so the UI can refresh. */
let onChanged = () => {};
export function setCommentChangeHandler(fn) {
  onChanged = fn;
}

function storageEntry(id, data) {
  storage()?.setValue(`${PREF}${id}`, data);
}

function storageRemove(id) {
  storage()?.remove(`${PREF}${id}`);
}

let noteSeq = 0;
function newEntryId() {
  return `df-note-${Date.now().toString(36)}-${(noteSeq++).toString(36)}`;
}

/** All comments known to the sidebar: file notes, editors and pseudo-entries. */
export function allComments() {
  return ui()?.dfComments ?? [];
}

/** Sidebar entries whose id is a PDF object reference (like "5R") came from the file. */
export function isFileId(id) {
  return typeof id === "string" && /^\d+R\d*$/u.test(id);
}

/** Acrobat-style pop-up note rectangle (180x100, just right of the icon). */
function popupRect(rect) {
  const [x, , , top] = rect;
  return [x + 24, top - 100, x + 204, top];
}

/** Keep or synthesize a pop-up dict so edited notes still open in Acrobat. */
function popupFor(entry, rect, text) {
  if (entry.popup) {
    return { ...entry.popup, rect: entry.popup.rect || popupRect(rect), contents: text };
  }
  if (entry.popupRef) {
    return { rect: popupRect(rect), contents: text };
  }
  return undefined;
}

function toPdfEntry(entry, text, extra = {}) {
  const now = pdfDate();
  const id = entry.id;
  const rect = entry.rect ? [...entry.rect] : [0, 0, 20, 20];
  return {
    dfComment: true,
    annotationType: NOTE_TYPE,
    fileId: isFileId(id) ? id : undefined,
    id,
    dfId: entry.dfId || (isFileId(id) ? undefined : id),
    dfParentId: entry.dfParentId || entry.inReplyTo || undefined,
    pageIndex: entry.pageIndex,
    rect,
    contents: text,
    contentsObj: { str: text },
    popup: popupFor(entry, rect, text),
    user:
      entry.user || entry.titleObj?.str || config.authorName || undefined,
    creationDate: entry.creationDate || now,
    modificationDate: entry.modificationDate || now,
    resolved: entry.dfResolved || entry.resolved || undefined,
    ...extra,
  };
}

export function addStickyNote(pageIndex, x, y, text) {
  const id = newEntryId();
  const now = pdfDate();
  // Acrobat puts the icon's *top-left* at the click point; PDF y grows up, so
  // the rect's top edge must be the click y itself.
  const rect = [x, y - 20, x + 20, y];
  storageEntry(id, {
    annotationType: NOTE_TYPE,
    dfComment: true,
    id,
    dfId: id,
    pageIndex,
    rect,
    contents: text,
    popup: { rect: popupRect(rect), contents: text },
    user: config.authorName || undefined,
    creationDate: now,
    modificationDate: now,
  });
  onChanged();
}

export function replyToComment(parent, text) {
  const id = newEntryId();
  const now = pdfDate();
  storageEntry(id, {
    annotationType: NOTE_TYPE,
    dfComment: true,
    id,
    dfId: id,
    dfParentId: parent.uid || parent.id,
    pageIndex: parent.pageIndex,
    rect: parent.rect ? [...parent.rect] : [0, 0, 20, 20],
    contents: text,
    user: config.authorName || undefined,
    creationDate: now,
    modificationDate: now,
  });
  onChanged();
}

/** Move a sticky note (and its popup) to a new PDF rectangle. */
export function moveStickyNote(entry, rect) {
  const text = entry.contentsObj?.str || entry.contents || "";
  const data = toPdfEntry(entry, text, {
    rect,
    // marker: the file icon (if any) is replaced by an overlay icon at the
    // new position until the file is saved and reloaded
    dfMoved: true,
    modificationDate: pdfDate(),
  });
  // The popup box must follow the icon; saved notes only carry a popup *ref*,
  // so replace whatever popup toPdfEntry produced with the moved rect.
  if (entry.popup || entry.popupRef) {
    data.popup = { rect: popupRect(rect), contents: text };
  }
  storageEntry(entry.id, data);
  post({ type: "dirty", dirty: true });
  onChanged();
}

export function editCommentText(entry, text) {
  storageEntry(entry.id, toPdfEntry(entry, text, { modificationDate: pdfDate() }));
  onChanged();
}

/** Toggle the Acrobat-style resolved state (/State /Closed + /StateModel /Review). */
export function resolveComment(entry) {
  const resolved = !entry.dfResolved;
  const text = entry.contentsObj?.str || entry.contents || "";
  storageEntry(entry.id, toPdfEntry(entry, text, { resolved }));
  onChanged();
}

/**
 * Delete a comment and every reply that threads from it. A file-loaded
 * comment is removed by storing a `deleted` override under its ref id; a
 * new (in-session) comment is removed from storage outright. Replies match
 * their parent by `inReplyTo` (loaded from the file) or `dfParentId` (new).
 */
function deleteCascade(entry) {
  const id = entry.id;
  if (isFileId(id)) {
    storageEntry(id, toPdfEntry(entry, entry.contentsObj?.str || entry.contents || "", {
      deleted: true,
      popupRef: entry.popupRef || undefined,
    }));
  } else {
    storageRemove(id);
  }
  for (const reply of allComments()) {
    if (reply.id === id || reply.deleted) {
      continue;
    }
    if (reply.inReplyTo !== id && reply.dfParentId !== id) {
      continue;
    }
    if (isFileId(reply.id)) {
      storageEntry(reply.id, {
        dfComment: true,
        annotationType: NOTE_TYPE,
        fileId: reply.id,
        id: reply.id,
        pageIndex: reply.pageIndex,
        deleted: true,
        popupRef: reply.popupRef || undefined,
      });
    } else {
      storageRemove(reply.id);
    }
  }
}

export function deleteComment(entry) {
  if (!entry.id) {
    return;
  }
  deleteCascade(entry);
  // Removing storage entries does not always mark the doc dirty.
  post({ type: "dirty", dirty: true });
  onChanged();
}

/** Raw storage iteration, for the overlay / deleted-icon logic. */
export function eachStorageEntry(fn) {
  for (const [, value] of storage() ?? []) {
    fn(value);
  }
}
