/**
 * What the webview knows about annotations: the saved list (see src/pdf/model.ts for its shape),
 * a draft that is not committed yet, and which one is selected. Every commit is sent to the host
 * as a single undo step, and the host's undo/redo replaces the list through `restore()`.
 */
import { STATUSES, config, timestamp, toHost, uuid } from "./core.mjs";

const watchers = new Set();
let committed = [];
let pending = [];
let selection = null;
let lockReason = null;

/** `callback(reason)` runs on every change: "load" | "replace" | "edit" | "draft" | "select". Returns an unsubscribe function. */
export function onChange(callback) {
  watchers.add(callback);
  return () => watchers.delete(callback);
}

const notify = (reason) => watchers.forEach((callback) => callback(reason));

export const list = () => committed;
export const drafts = () => pending;
export const selectedId = () => selection;
export const readOnlyReason = () => lockReason;
export const currentUser = () => config.authorName ?? "";
export const find = (id) => committed.find((a) => a.id === id) ?? pending.find((a) => a.id === id);

export function reset(annotations, reason) {
  committed = annotations;
  lockReason = reason ?? null;
  pending = [];
  selection = null;
  notify("load");
}

/** Undo or redo in the host handed back an earlier state. */
export function restore(annotations) {
  committed = annotations;
  if (selection && !find(selection)) {
    selection = null;
  }
  notify("replace");
}

function record(label, next) {
  committed = next;
  toHost({ type: "edit", label, annotations: next });
  notify("edit");
}

// --- Threads ---------------------------------------------------------------------

const isReply = (a) => a.replyTo !== undefined && find(a.replyTo) !== undefined;

/** Acrobat nests replies to replies; the hop limit guards against `replyTo` cycles. */
export function rootOf(annotation) {
  let node = annotation;
  for (let hops = 0; node && isReply(node) && hops < committed.length; hops++) {
    node = find(node.replyTo);
  }
  return node;
}

/** Only thread roots get drawn and listed in the sidebar. */
export const threads = () => committed.filter((a) => !isReply(a));

const threadOf = (rootId) => committed.filter((a) => a.id !== rootId && isReply(a) && rootOf(a).id === rootId);
const dateKey = (a, key, fallback) => a[key] ?? a[fallback] ?? "";
const oldestFirst = (key, fallback) => (a, b) => dateKey(a, key, fallback).localeCompare(dateKey(b, key, fallback));
const stateMarks = (rootId, stateModel) => threadOf(rootId).filter((a) => a.state?.model === stateModel).sort(oldestFirst("modified", "created"));

/** The written replies of a thread (state marks excluded), oldest first. */
export const replies = (rootId) => threadOf(rootId).filter((a) => !a.state).sort(oldestFirst("created", "modified"));

/** Latest review state of a thread, e.g. "Accepted"; undefined when unset or reset to "None". */
export function reviewStatus(rootId) {
  const latest = stateMarks(rootId, "Review").at(-1)?.state.value;
  return latest && latest !== "None" ? latest : undefined;
}

/** Acrobat keeps checkmarks per person, so other authors' marks are ignored. */
export const checkedByMe = (rootId) => stateMarks(rootId, "Marked").filter((a) => a.author === currentUser()).at(-1)?.state.value === "Marked";

/** A reply or state needs a writable file and a parent the file can point to. */
export const canReply = (a) => Boolean(a) && !lockReason && (a.kind !== "other" || a.ref !== undefined);

/** Whether a thread has something to discuss (its comment, a text box's text, or replies), which a status or reply needs. */
export const hasDiscussion = (a) => Boolean(a) && (a.contents.trim() !== "" || replies(a.id).length > 0);

// --- Mutations ---------------------------------------------------------------------

export function create(fields) {
  const now = timestamp();
  return { id: uuid(), opacity: 1, contents: "", author: currentUser(), created: now, modified: now, ...fields };
}

export function add(annotations, label) {
  record(label, [...committed, ...annotations]);
}

/** Replies and state marks sit in a 24pt square at the root's top-left corner, as in Acrobat. */
const cornerOf = (root) => ({ page: root.page, rect: [root.rect[0], root.rect[3] - 24, root.rect[0] + 24, root.rect[3]] });

/** Apply `[id, change]` pairs as one undo step: a change patches a thread root (a new rect drags its replies along); `null` deletes the whole thread. */
export function patchMany(changes, label) {
  const now = timestamp();
  const removed = new Set();
  const patched = new Map();
  const moved = new Map();
  for (const [id, change] of changes) {
    const target = find(id);
    if (!target) {
      continue;
    }
    const childIds = threadOf(id).map((a) => a.id);
    if (change === null) {
      [id, ...childIds].forEach((removedId) => removed.add(removedId));
      continue;
    }
    const next = { ...target, ...change, modified: now };
    patched.set(id, next);
    if (change.rect) {
      childIds.forEach((childId) => moved.set(childId, cornerOf(next)));
    }
  }
  if (removed.size === 0 && patched.size === 0) {
    return;
  }
  if (removed.has(selection)) {
    selection = null;
  }
  record(label, committed.filter((a) => !removed.has(a.id)).map((a) => patched.get(a.id) ?? (moved.has(a.id) ? { ...a, ...moved.get(a.id) } : a)));
}

export function patch(id, change, label) {
  patchMany([[id, change]], label);
}

/** Removing a root removes its whole thread; removing a reply re-attaches its answers to its own parent. */
export function remove(id, label) {
  const target = committed.find((a) => a.id === id);
  if (target && isReply(target)) {
    record(label, committed.filter((a) => a.id !== id).map((a) => (a.replyTo === id ? { ...a, replyTo: target.replyTo } : a)));
  } else {
    patchMany([[id, null]], label);
  }
}

const childOf = (rootId, fields) => create({ kind: "note", subtype: "Text", icon: "Comment", replyTo: rootId, ...cornerOf(find(rootId)), ...fields });

export function addReply(rootId, contents, rich) {
  if (canReply(find(rootId)) && contents.trim()) {
    add([childOf(rootId, { contents, ...(rich && { rich }), color: [1, 0.82, 0] })], "Add Reply");
  }
}

/** Write the current user's mark for a state model, reusing their earlier mark if there is one. */
function setMark(rootId, stateModel, value, label) {
  if (!canReply(find(rootId))) {
    return;
  }
  const contents = `${value} set by ${currentUser()}`;
  const mine = stateMarks(rootId, stateModel).find((a) => a.author === currentUser());
  if (mine) {
    patch(mine.id, { state: { model: stateModel, value }, contents }, label);
  } else {
    add([childOf(rootId, { contents, state: { model: stateModel, value } })], label);
  }
}

export function setReviewStatus(rootId, value, label = `Set Status: ${STATUSES[value]?.label ?? "None"}`) {
  setMark(rootId, "Review", value, label);
}

/** One-click resolve: the "Completed" review state, or back to none when the thread is resolved already. */
export function toggleResolved(rootId) {
  const resolved = reviewStatus(rootId) === "Completed";
  setReviewStatus(rootId, resolved ? "None" : "Completed", resolved ? "Reopen" : "Resolve");
}

export function toggleCheck(rootId) {
  const value = checkedByMe(rootId) ? "Unmarked" : "Marked";
  setMark(rootId, "Marked", value, value === "Marked" ? "Add Checkmark" : "Remove Checkmark");
}

// --- Draft and selection ---------------------------------------------------------------

export function setDraft(annotations) {
  pending = annotations;
  notify("draft");
}

/** Commit the draft as one edit, merging `fields` (such as the first comment's text) into its first annotation. */
export function commitDraft(fields, label) {
  const [first, ...rest] = pending;
  pending = [];
  if (first) {
    add([{ ...first, ...fields, modified: timestamp() }, ...rest], label);
  } else {
    notify("draft");
  }
}

export function select(id) {
  if (selection !== id) {
    selection = id;
    notify("select");
  }
}
