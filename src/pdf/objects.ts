/** Typed accessors over pdf-lib objects. */
import { PDFArray, PDFContext, PDFDict, PDFHexString, PDFName, PDFNumber, PDFObject, PDFRef, PDFString } from "pdf-lib";
import type { Box, Rgb } from "./model";

/** Annotation flags (ISO 32000-1 table 165). */
export const Flag = { Hidden: 2, Print: 4, NoZoom: 8, NoRotate: 16 } as const;

export const key = (value: string) => PDFName.of(value);
export const round = (n: number) => Math.round(n * 1000) / 1000;

export const refId = (ref: PDFRef) => `${ref.objectNumber} ${ref.generationNumber}`;

export function refOfId(id: string | undefined): PDFRef | undefined {
  const m = /^(\d+) (\d+)$/u.exec(id ?? "");
  return m ? PDFRef.of(Number(m[1]), Number(m[2])) : undefined;
}

export function asDict(context: PDFContext, value: PDFObject | undefined): PDFDict | undefined {
  const resolved = value instanceof PDFRef ? context.lookup(value) : value;
  return resolved instanceof PDFDict ? resolved : undefined;
}

export function readName(dict: PDFDict, entry: string): string | undefined {
  const value = dict.lookup(key(entry));
  return value instanceof PDFName ? value.decodeText() : undefined;
}

/** A text entry, tolerating writers that store names where strings belong. */
export function readText(dict: PDFDict, entry: string): string | undefined {
  const value = dict.lookup(key(entry));
  return value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName
    ? value.decodeText()
    : undefined;
}

export function readNumber(dict: PDFDict, entry: string): number | undefined {
  const value = dict.lookup(key(entry));
  return value instanceof PDFNumber ? value.asNumber() : undefined;
}

const asNumbers = (array: PDFArray): number[] | undefined => {
  const items = array.asArray().map((_, i) => array.lookup(i));
  return items.every((v) => v instanceof PDFNumber) ? items.map((v) => (v as PDFNumber).asNumber()) : undefined;
};

export function readNumbers(dict: PDFDict, entry: string): number[] | undefined {
  const value = dict.lookup(key(entry));
  return value instanceof PDFArray ? asNumbers(value) : undefined;
}

/** Array of number arrays, e.g. `/InkList`. */
export function readLists(dict: PDFDict, entry: string): number[][] | undefined {
  const value = dict.lookup(key(entry));
  if (!(value instanceof PDFArray)) {
    return undefined;
  }
  const rows = value.asArray().map((_, i) => value.lookup(i)).map((row) => (row instanceof PDFArray ? asNumbers(row) : undefined));
  return rows.every((row) => row !== undefined) ? (rows as number[][]) : undefined;
}

export function readBox(dict: PDFDict, entry = "Rect"): Box | undefined {
  const values = readNumbers(dict, entry);
  if (values?.length !== 4) {
    return undefined;
  }
  const [a, b, c, d] = values as Box;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Color array as RGB: gray (1), RGB (3) or CMYK (4) components; other lengths are transparent. */
export function readColor(dict: PDFDict, entry = "C"): Rgb | undefined {
  const c = readNumbers(dict, entry)?.map(clamp01);
  switch (c?.length) {
    case 1:
      return [c[0]!, c[0]!, c[0]!];
    case 3:
      return c as Rgb;
    case 4: {
      const [cy, m, y, k] = c as [number, number, number, number];
      return [(1 - cy) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
    }
    default:
      return undefined;
  }
}

/** Text object: literal string for printable ASCII, UTF-16BE hex otherwise. */
export function stringObject(value: string): PDFString | PDFHexString {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e\r\n\t]*$/u.test(value)
    ? PDFString.of(value.replace(/[\\()]/gu, "\\$&").replace(/\r/gu, "\\r").replace(/\n/gu, "\\n").replace(/\t/gu, "\\t"))
    : PDFHexString.fromText(value);
}

/** Write a text entry, removing it when the value is empty. */
export function writeText(dict: PDFDict, entry: string, value: string | undefined): void {
  if (value) {
    dict.set(key(entry), stringObject(value));
  } else {
    dict.delete(key(entry));
  }
}
