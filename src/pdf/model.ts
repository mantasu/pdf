/** Plain-JSON annotation model shared by the host (pdf/read, pdf/write) and the viewer. */

/** `[x1, y1, x2, y2]`, PDF user space (origin bottom-left). */
export type Box = [number, number, number, number];
/** RGB in 0..1, as in a PDF `/C` array. */
export type Rgb = [number, number, number];

export type TextMarkup = "highlight" | "underline" | "strikeout" | "squiggly";
export type OwnedKind = "note" | TextMarkup | "freetext" | "ink" | "square" | "circle" | "line" | "image";
export type AnnotKind = OwnedKind | "other";

export type ReviewValue = "None" | "Accepted" | "Rejected" | "Cancelled" | "Completed";
export type AnnotState =
  | { model: "Review"; value: ReviewValue }
  | { model: "Marked"; value: "Marked" | "Unmarked" };

/** One formatted span; paragraphs are arrays of runs. */
export interface TextRun {
  text: string;
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  sup?: true;
  sub?: true;
  code?: true;
}
export type Rich = TextRun[][];

export type FontFamily = "Helvetica" | "Times" | "Courier" | "Roboto" | "Lora" | "Comic Neue";
export interface Font {
  family: FontFamily;
  size: number;
  bold?: true;
  italic?: true;
}

export interface Annot {
  /** Stable identity, stored as `/NM`. */
  id: string;
  /** `"<num> <gen>"` reference in the file it was read from. */
  ref?: string;
  kind: AnnotKind;
  /** `/Subtype` without the slash. */
  subtype: string;
  /** 0-based page index. */
  page: number;
  rect: Box;
  color?: Rgb;
  /** `/CA`, 0..1. */
  opacity: number;
  /** Plain comment text (`/Contents`); for text boxes, the box's text. */
  contents: string;
  /** Formatted text (`/RC`), only when formatting is present. */
  rich?: Rich;
  /** Author (`/T`). */
  author: string;
  subject?: string;
  /** ISO 8601 (`/CreationDate`, `/M`). */
  created?: string;
  modified?: string;
  /** Id of the annotation replied to (`/IRT`). */
  replyTo?: string;
  /** Review/marked state (state annotations only). */
  state?: AnnotState;
  popup?: { rect: Box; open: boolean };

  /** note: icon name (`/Name`). */
  icon?: string;
  /** Markup QuadPoints, 8 numbers per quad (TL, TR, BL, BR). */
  quads?: number[];
  /** ink: flat `[x, y, ...]` strokes (`/InkList`). */
  ink?: number[][];
  /** line endpoints (`/L`); `arrow` draws an open arrowhead at the end. */
  line?: Box;
  arrow?: true;
  /** Stroke width (`/BS /W`). */
  width?: number;
  /** square/circle fill (`/IC`). */
  fill?: Rgb;
  /** freetext font; `color` is the text color. */
  font?: Font;
  /** freetext: line alignment (`/Q`); absent means left. */
  align?: "center" | "right";
  /** freetext: upright letters stacked top to bottom, columns left to right; kept in `/DS` as `writing-mode: vertical-lr`. */
  vertical?: true;
  /** image: `data:` URL. */
  image?: string;
}
