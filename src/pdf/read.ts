import { randomUUID } from "node:crypto";
import { PDFArray, PDFContext, PDFDict, PDFDocument, PDFObject, PDFRef, ParseSpeeds } from "pdf-lib";
import { KINDS } from "./kinds";
import type { Annot, AnnotKind, AnnotState, OwnedKind, ReviewValue } from "./model";
import { fromPdfDate } from "./date";
import { Flag, asDict, readBox, readColor, readName, readNumber, readText, key, refId } from "./objects";
import { isFormatted, parseRc, toPlain } from "./richtext";

export const PARSE_OPTS = { ignoreEncryption: true, updateMetadata: false, parseSpeed: ParseSpeeds.Fastest } as const;
export const SAVE_OPTS = { objectsPerTick: Number.POSITIVE_INFINITY } as const;

const KIND_BY_SUBTYPE = new Map(Object.entries(KINDS).map(([kind, h]) => [h.subtype, kind as OwnedKind]));

/** Markup subtypes (ISO 32000-1 table 170) still listed for commenting when unowned. */
const LISTED_SUBTYPES = new Set([...KIND_BY_SUBTYPE.keys(), "Polygon", "PolyLine", "Caret", "FileAttachment", "Sound", "Redact"]);

export type Ownership =
  | { role: "managed"; kind: OwnedKind; subtype: string }
  | { role: "other"; subtype: string }
  | { role: "popup" }
  | { role: "ignored" };

/**
 * Who owns an annotation: the extension ("managed": it draws and rewrites it),
 * pdf.js ("other": only listed, its comment editable), or neither. Hidden roots
 * and grouped annotations (`/RT /Group`) are left alone.
 */
export function ownershipOf(dict: PDFDict): Ownership {
  const subtype = readName(dict, "Subtype");
  if (subtype === "Popup") {
    return { role: "popup" };
  }
  if (subtype === undefined || readName(dict, "RT") === "Group") {
    return { role: "ignored" };
  }
  const reply = dict.lookup(key("IRT")) instanceof PDFDict;
  const hidden = ((readNumber(dict, "F") ?? 0) & Flag.Hidden) !== 0;
  const kind = KIND_BY_SUBTYPE.get(subtype);
  if (kind && (reply || !hidden) && (KINDS[kind].accepts?.(dict) ?? true)) {
    return { role: "managed", kind, subtype };
  }
  return LISTED_SUBTYPES.has(subtype) && !hidden && !reply ? { role: "other", subtype } : { role: "ignored" };
}

export function popupOfManaged(context: PDFContext, dict: PDFDict): boolean {
  const parent = readName(dict, "Subtype") === "Popup" ? asDict(context, dict.get(key("Parent"))) : undefined;
  return parent !== undefined && ownershipOf(parent).role === "managed";
}

const REVIEW_VALUES = new Set(["None", "Accepted", "Rejected", "Cancelled", "Completed"]);

export function stateOf(dict: PDFDict): AnnotState | undefined {
  const value = readText(dict, "State");
  if (value === undefined) {
    return undefined;
  }
  const marked = value === "Marked" || value === "Unmarked";
  const model = readText(dict, "StateModel") ?? (marked ? "Marked" : "Review");
  if (model === "Marked" && marked) {
    return { model, value };
  }
  return model === "Review" && REVIEW_VALUES.has(value) ? { model, value: value as ReviewValue } : undefined;
}

/** Every model field held directly in an annotation dictionary. */
export function entryFields(dict: PDFDict, kind: AnnotKind, subtype: string, page: number): Omit<Annot, "id" | "replyTo"> | undefined {
  const rect = readBox(dict);
  if (!rect) {
    return undefined;
  }
  const handler = kind === "other" ? undefined : KINDS[kind];
  const popup = asDict(dict.context, dict.get(key("Popup")));
  const popupRect = popup && readBox(popup);
  const rich = parseRc(readText(dict, "RC") ?? "");
  const contents = (readText(dict, "Contents") ?? (rich ? toPlain(rich) : "")).replace(/\r\n?/gu, "\n");
  const fields = {
    kind,
    subtype,
    page,
    rect,
    opacity: Math.min(1, Math.max(0, readNumber(dict, "CA") ?? 1)),
    contents,
    author: readText(dict, "T") ?? "",
    rich: rich && isFormatted(rich) ? rich : undefined,
    color: readColor(dict),
    subject: readText(dict, "Subj"),
    created: fromPdfDate(readText(dict, "CreationDate")),
    modified: fromPdfDate(readText(dict, "M")),
    state: kind === "note" ? stateOf(dict) : undefined,
    popup: popupRect && { rect: popupRect, open: popup!.lookup(key("Open"))?.toString() === "true" },
    ...handler?.read(dict, rect),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Omit<Annot, "id" | "replyTo">;
}

export interface ParseResult {
  annotations: Annot[];
  /** The PDF pdf.js renders: managed annotations unlinked, object numbers unchanged. */
  viewBytes: Uint8Array;
  /** Why comments cannot be edited, when that is the case. */
  readOnly?: string;
}

/** Parse a PDF's annotations and build the bytes pdf.js renders. */
export async function parsePdf(bytes: Uint8Array, newId: () => string = randomUUID): Promise<ParseResult> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, PARSE_OPTS);
  } catch (error) {
    return { annotations: [], viewBytes: bytes, readOnly: `The file could not be parsed for editing (${String(error)}).` };
  }
  if (doc.isEncrypted) {
    return { annotations: [], viewBytes: bytes, readOnly: "The file is encrypted, so comments cannot be edited." };
  }
  const { context } = doc;
  const found: Array<{ dict: PDFDict; ref?: PDFRef; page: number; kind: AnnotKind; subtype: string }> = [];
  let unlinked = false;

  doc.getPages().forEach((page, pageIndex) => {
    const entries = page.node.lookupMaybe(key("Annots"), PDFArray)?.asArray() ?? [];
    const owned = new Set<PDFDict>();
    for (const entry of entries) {
      const dict = asDict(context, entry);
      const role = dict && ownershipOf(dict);
      if (role?.role === "managed" || role?.role === "other") {
        found.push({ dict: dict!, ref: entry instanceof PDFRef ? entry : undefined, page: pageIndex, kind: role.role === "managed" ? role.kind : "other", subtype: role.subtype });
        if (role.role === "managed") {
          owned.add(dict!);
          const popup = asDict(context, dict!.get(key("Popup")));
          if (popup) {
            owned.add(popup);
          }
        }
      }
    }
    const kept = entries.filter((entry: PDFObject) => {
      const dict = asDict(context, entry);
      return !dict || !(owned.has(dict) || popupOfManaged(context, dict));
    });
    if (kept.length !== entries.length) {
      page.node.set(key("Annots"), context.obj(kept));
      unlinked = true;
    }
  });

  const usedIds = new Set<string>();
  const idOf = new Map<PDFDict, string>();
  const annotations: Annot[] = [];
  for (const item of found) {
    const entry = entryFields(item.dict, item.kind, item.subtype, item.page);
    if (entry) {
      const nm = readText(item.dict, "NM")?.trim();
      const id = nm && !usedIds.has(nm) ? nm : newId();
      usedIds.add(id);
      idOf.set(item.dict, id);
      annotations.push({ id, ...(item.ref && { ref: refId(item.ref) }), ...entry });
    }
  }
  // Resolve /IRT once every annotation has an id; replies live on their thread's page.
  const byId = new Map(annotations.map((a) => [a.id, a]));
  for (const item of found) {
    const annotation = byId.get(idOf.get(item.dict) ?? "");
    const parentId = idOf.get(asDict(context, item.dict.get(key("IRT")))!);
    if (annotation && parentId && parentId !== annotation.id) {
      annotation.replyTo = parentId;
    }
  }
  for (const annotation of annotations) {
    let root = annotation;
    for (let depth = 0; root.replyTo && byId.has(root.replyTo) && depth < annotations.length; depth++) {
      root = byId.get(root.replyTo)!;
    }
    annotation.page = root.page;
  }
  return { annotations, viewBytes: unlinked ? await doc.save(SAVE_OPTS) : bytes };
}
