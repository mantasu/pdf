import { PDFArray, PDFContext, PDFDict, PDFDocument, PDFObject, PDFPage, PDFRef, PDFStream } from "pdf-lib";
import { KINDS } from "./kinds";
import type { Appearance, WriteContext } from "./kinds";
import type { Annot, Box, OwnedKind } from "./model";
import { toPdfDate } from "./date";
import { Flag, asDict, readBox, readText, key, refId, refOfId, round, stringObject, writeText } from "./objects";
import { PARSE_OPTS, SAVE_OPTS, entryFields, ownershipOf, popupOfManaged } from "./read";
import { isFormatted, parseRc, toRc } from "./richtext";

const POPUP_W = 204;
const POPUP_H = 114;

type Owned = Annot & { kind: OwnedKind };
type Slot = { ref: PDFRef; dict: PDFDict; fresh: boolean };

const isOwned = (a: Annot): a is Owned => a.kind !== "other";

/** Order-independent JSON of stored content, numbers rounded. Identity, bookkeeping and derived values do not count. */
function contentKey(a: Partial<Annot>, derivedRect: boolean): string {
  const { id: _i, ref: _r, page: _p, kind: _k, subtype: _st, subject: _sj, created: _c, replyTo: _rt, image: _im, rect, ...rest } = a;
  const canon = (value: unknown): unknown =>
    typeof value === "number"
      ? round(value)
      : Array.isArray(value)
        ? value.map(canon)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, canon(v)]))
          : value;
  return JSON.stringify(canon(derivedRect ? rest : { ...rest, rect }));
}

function needsRewrite(dict: PDFDict, a: Owned, parentRef: PDFRef | undefined): boolean {
  const stored = entryFields(dict, a.kind, a.subtype, a.page);
  const storedParent = dict.get(key("IRT"));
  const derived = KINDS[a.kind].derivedRect ?? false;
  // Without a usable appearance stream many readers show nothing, so force one.
  const normal = asDict(dict.context, dict.get(key("AP")))?.get(key("N"));
  const resolved = normal && dict.context.lookup(normal);
  return (
    !stored ||
    !(resolved instanceof PDFStream || resolved instanceof PDFDict) ||
    contentKey(stored, derived) !== contentKey(a, derived) ||
    (storedParent instanceof PDFRef ? refId(storedParent) : undefined) !== (parentRef && refId(parentRef))
  );
}

/** `/Contents` (and `/RC` for formatted text), shared by every kind. */
function storeComment(dict: PDFDict, a: Annot): void {
  const contents = a.contents.replace(/\n/gu, "\r");
  const storedRich = parseRc(readText(dict, "RC") ?? "");
  if (a.rich && isFormatted(a.rich)) {
    dict.set(key("RC"), stringObject(toRc(a.rich)));
  } else if (readText(dict, "Contents") !== contents || (storedRich && isFormatted(storedRich))) {
    // Rich text beats /Contents in Acrobat, so stale text or formatting must go.
    dict.delete(key("RC"));
  }
  writeText(dict, "Contents", contents);
}

const pdfDate = (iso: string | undefined, now: Date) => stringObject(toPdfDate(iso ? new Date(iso) : now));

function addAppearance(context: PDFContext, appearance: Appearance, opacity: number): PDFRef {
  const state = { Type: "ExtGState", CA: round(opacity), ca: round(opacity), ...(appearance.blend && { BM: appearance.blend }) };
  return context.register(
    context.flateStream(`/GS0 gs\n${appearance.content}`, {
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: appearance.bbox.map(round),
      Resources: { ExtGState: { GS0: state }, ...appearance.resources },
    }),
  );
}

/** Acrobat's 204x114 pop-up at the page's right edge. */
export function popupRectFor(page: PDFPage, rect: Box): Box {
  const { width, height } = page.getSize();
  const x1 = Math.max(0, width - POPUP_W);
  const top = Math.min(height, Math.max(POPUP_H, rect[3]));
  return [x1, top - POPUP_H, x1 + POPUP_W, top].map(round) as Box;
}

function storePopup(context: PDFContext, page: PDFPage, slot: Slot, a: Annot, rect: Box): void {
  const existing = asDict(context, slot.dict.get(key("Popup")));
  const popup = existing ?? context.obj({ Type: "Annot", Subtype: "Popup", F: Flag.Print | Flag.NoZoom | Flag.NoRotate });
  popup.set(key("Parent"), slot.ref);
  popup.set(key("Rect"), context.obj((a.popup?.rect ?? (existing && readBox(existing)) ?? popupRectFor(page, rect)).map(round)));
  popup.set(key("Open"), context.obj(a.popup?.open ?? false));
  if (!existing) {
    slot.dict.set(key("Popup"), context.register(popup));
  }
}

async function writeOwned(ctx: WriteContext, page: PDFPage, slot: Slot, a: Owned, parentRef: PDFRef | undefined, now: Date): Promise<void> {
  const { dict, fresh } = slot;
  const { context } = ctx.doc;
  const handler = KINDS[a.kind];
  storeComment(dict, a);
  writeText(dict, "T", a.author);
  writeText(dict, "NM", a.id);
  writeText(dict, "Subj", a.subject ?? (fresh ? handler.subject : undefined));
  dict.set(key("M"), pdfDate(a.modified, now));
  if (a.created || fresh) {
    dict.set(key("CreationDate"), pdfDate(a.created, now));
  }
  dict.set(key("P"), page.ref);
  dict.set(key("C"), context.obj((a.color ?? handler.color).map(round)));
  dict.set(key("CA"), context.obj(round(a.opacity)));
  if (fresh) {
    dict.set(key("F"), context.obj(handler.flags | (a.state ? Flag.Hidden : 0)));
  }
  if (parentRef) {
    dict.set(key("IRT"), parentRef);
    dict.delete(key("RT"));
  } else {
    dict.delete(key("IRT"));
  }
  if (a.state) {
    dict.set(key("State"), stringObject(a.state.value));
    dict.set(key("StateModel"), stringObject(a.state.model));
  } else {
    dict.delete(key("State"));
    dict.delete(key("StateModel"));
  }
  const { rect, appearance } = await handler.write(dict, a, ctx);
  dict.set(key("Rect"), context.obj(rect.map(round)));
  dict.set(key("AP"), context.obj({ N: addAppearance(context, appearance, a.opacity) }));
  // Text boxes show their text on the page; everything else gets Acrobat's pop-up.
  if (!parentRef && a.kind !== "freetext") {
    storePopup(context, page, slot, a, rect);
  }
}

/** Unowned annotations only ever take comment and author changes. */
function touchOther(dict: PDFDict, a: Annot, now: Date): void {
  const stored = (readText(dict, "Contents") ?? "").replace(/\r\n?/gu, "\n");
  const storedRich = parseRc(readText(dict, "RC") ?? "");
  const richSame = JSON.stringify(storedRich && isFormatted(storedRich) ? storedRich : undefined) === JSON.stringify(a.rich);
  if (stored === a.contents && (readText(dict, "T") ?? "") === a.author && richSame) {
    return;
  }
  storeComment(dict, a);
  writeText(dict, "T", a.author);
  writeText(dict, "NM", a.id);
  dict.set(key("M"), pdfDate(a.modified, now));
}

/** Drop every indirect object unreachable from the trailer: deleted comments,
 * their pop-ups, superseded appearance streams. Reachability keeps shared
 * streams and structure-tree references alive. */
function sweepGarbage(context: PDFContext): void {
  const live = new Set<PDFRef>();
  const queue: PDFObject[] = Object.values(context.trailerInfo).filter((v): v is PDFObject => v !== undefined);
  while (queue.length > 0) {
    const object = queue.pop();
    if (object instanceof PDFRef) {
      if (!live.has(object)) {
        live.add(object);
        const target = context.lookup(object);
        if (target) {
          queue.push(target);
        }
      }
    } else if (object instanceof PDFDict) {
      queue.push(...object.values());
    } else if (object instanceof PDFArray) {
      queue.push(...object.asArray());
    } else if (object instanceof PDFStream) {
      queue.push(object.dict);
    }
  }
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!live.has(ref)) {
      context.delete(ref);
    }
  }
}

/**
 * Merge the annotation model into `base` (the PDF it was read from, or pdf.js's
 * save output) and return new bytes. Owned annotations match by object
 * reference, then `/NM`; unchanged ones are untouched. Owned annotations
 * missing from the model are deleted with their pop-ups, and replies whose
 * thread is gone go with them.
 */
export async function mergeAnnotations(base: Uint8Array, annotations: readonly Annot[], { now = new Date() } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.load(base, PARSE_OPTS);
  const ctx: WriteContext = { doc, fonts: new Map() };
  const { context } = doc;
  const pages = doc.getPages();

  // 1. Unlink every managed annotation (and pop-up) from the pages.
  const byName = new Map<string, PDFRef>();
  const kept = pages.map((page) =>
    (page.node.lookupMaybe(key("Annots"), PDFArray)?.asArray() ?? []).filter((entry) => {
      const dict = asDict(context, entry);
      const role = dict && ownershipOf(dict).role;
      const nm = dict && readText(dict, "NM");
      if (role === "managed" && entry instanceof PDFRef && nm) {
        byName.set(nm, entry);
      }
      return !dict || (role !== "managed" && !popupOfManaged(context, dict));
    }),
  );

  // 2. Find or allocate a dictionary per annotation so /IRT can resolve.
  const onPages = annotations.filter((a) => a.page >= 0 && a.page < pages.length);
  const byId = new Map(onPages.map((a) => [a.id, a]));
  const threaded = (a: Annot, depth = 0): boolean =>
    !a.replyTo || (depth < onPages.length && byId.has(a.replyTo) && threaded(byId.get(a.replyTo)!, depth + 1));
  const slots = new Map<string, Slot>();
  for (const a of onPages.filter((a) => threaded(a))) {
    const existing = locateExisting(context, a, byName);
    if (existing) {
      slots.set(a.id, { ...existing, fresh: false });
    } else if (isOwned(a)) {
      const dict = context.obj({ Type: "Annot", Subtype: KINDS[a.kind].subtype });
      slots.set(a.id, { ref: context.register(dict), dict, fresh: true });
    }
  }

  // 3. Write changed content and relink owned annotations to their pages.
  for (const a of onPages) {
    const slot = slots.get(a.id);
    const parentRef = a.replyTo ? slots.get(a.replyTo)?.ref : undefined;
    // A reply whose parent cannot be referenced never becomes a note.
    if (!slot || (a.replyTo && !parentRef)) {
      continue;
    }
    if (!isOwned(a)) {
      touchOther(slot.dict, a, now);
      continue;
    }
    if (slot.fresh || needsRewrite(slot.dict, a, parentRef)) {
      await writeOwned(ctx, pages[a.page]!, slot, a, parentRef, now);
    }
    const popup = slot.dict.get(key("Popup"));
    kept[a.page]!.push(slot.ref, ...(popup instanceof PDFRef ? [popup] : []));
  }
  pages.forEach((page, i) => {
    if (kept[i]!.length > 0 || page.node.has(key("Annots"))) {
      page.node.set(key("Annots"), context.obj(kept[i]!));
    }
  });

  // 4. Drop everything nothing refers to any more.
  sweepGarbage(context);
  doc.setModificationDate(now);
  return doc.save(SAVE_OPTS);
}

function locateExisting(context: PDFContext, a: Annot, byName: Map<string, PDFRef>): Omit<Slot, "fresh"> | undefined {
  for (const ref of [refOfId(a.ref), byName.get(a.id)]) {
    const dict = ref && asDict(context, ref);
    const role = dict && ownershipOf(dict);
    const subtype = role && "subtype" in role ? role.subtype : undefined;
    if (dict && subtype && subtype === (isOwned(a) ? KINDS[a.kind].subtype : a.subtype)) {
      return { ref: ref!, dict };
    }
  }
  return undefined;
}
