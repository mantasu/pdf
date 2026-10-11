/**
 * One handler per owned annotation kind: the PDF subtype it claims, how to read
 * its fields and how to write its keys plus appearance stream (`/AP /N`), so
 * every reader shows what the viewer shows. Defaults follow Acrobat.
 */
import { PDFArray, PDFDict, PDFDocument, PDFFont, PDFName, PDFRef } from "pdf-lib";
import { chooseFace, daTag, embedFace, faceWorks, familyNamed } from "./fonts";
import { fromDataUrl, stampPicture } from "./image";
import { type Formula, type TexPart, splitTex, typesetFormulas } from "./math";
import type { Annot, Box, Font, OwnedKind, TextMarkup, TextRun, Rgb } from "./model";
import { Flag, asDict, readColor, readLists, readName, readNumber, readNumbers, readText, key, round, stringObject } from "./objects";

export interface Appearance {
  bbox: Box;
  content: string;
  /** Resources besides the `/GS0` opacity state, e.g. fonts or images. */
  resources?: Record<string, Record<string, PDFRef>>;
  blend?: "Multiply";
}

export interface WriteContext {
  doc: PDFDocument;
  fonts: Map<string, PDFFont>;
}

/** Kind-specific annotation fields (what `read` fills in). */
export type KindFields = Partial<Pick<Annot, "icon" | "quads" | "ink" | "line" | "arrow" | "width" | "fill" | "font" | "image" | "color" | "align" | "vertical">>;

interface KindHandler {
  subtype: string;
  subject: string;
  color: Rgb;
  flags: number;
  /** The rect follows from the geometry, so it is neither compared nor kept. */
  derivedRect?: true;
  /** Extra conditions for claiming an annotation of this subtype. */
  accepts?(dict: PDFDict): boolean;
  read(dict: PDFDict, rect: Box): KindFields;
  /** Set kind keys; returns the final rect and appearance. */
  write(dict: PDFDict, a: Annot, ctx: WriteContext): Promise<{ rect: Box; appearance: Appearance }>;
}

const s = (value: number) => String(round(value));
const paint = (c: Rgb, op: "rg" | "RG") => `${c.map(s).join(" ")} ${op}`;
const pts = (list: number[]) => list.map(s).join(" ");

export function extentOf(values: readonly number[], pad = 0): Box {
  const xs = values.filter((_, i) => i % 2 === 0);
  const ys = values.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad].map(round) as Box;
}

const strokeOf = (dict: PDFDict): number | undefined => {
  const bs = asDict(dict.context, dict.get(key("BS")));
  return (bs && readNumber(bs, "W")) ?? readNumbers(dict, "Border")?.[2];
};

function setStroke(dict: PDFDict, width: number): void {
  dict.set(key("BS"), dict.context.obj({ Type: "Border", W: round(width), S: "S" }));
}

// --- Sticky notes ----------------------------------------------------------------

/** Acrobat's "Comment" balloon scaled into the icon box. */
function noteAppearance(rect: Box, fill: Rgb): Appearance {
  const w = rect[2] - rect[0];
  const h = rect[3] - rect[1];
  const content = [
    `${s(w / 24)} 0 0 ${s(h / 24)} 0 0 cm`,
    paint(fill, "rg"),
    "0.2 0.2 0.2 RG 1 w 1 j",
    "4 23 m 20 23 l 22 23 23 22 23 20 c 23 9 l 23 7 22 6 20 6 l 11 6 l 5 1.5 l 6.5 6 l 4 6 l 2 6 1 7 1 9 c 1 20 l 1 22 2 23 4 23 c h B",
    "1.4 w 1 J 5.5 18 m 18.5 18 l S 5.5 14.5 m 18.5 14.5 l S 5.5 11 m 14 11 l S",
  ].join("\n");
  return { bbox: [0, 0, w, h], content };
}

const note: KindHandler = {
  subtype: "Text",
  subject: "Sticky Note",
  color: [1, 0.82, 0],
  flags: Flag.Print | Flag.NoZoom | Flag.NoRotate,
  read: (dict) => ({ icon: readName(dict, "Name") }),
  async write(dict, a) {
    dict.set(key("Name"), key(a.icon ?? "Comment"));
    if (!dict.has(key("Open"))) {
      dict.set(key("Open"), dict.context.obj(false));
    }
    // Replies and states live in the comment list (Acrobat draws nothing for them).
    const appearance = a.replyTo ? { bbox: [0, 0, 1, 1] as Box, content: "" } : noteAppearance(a.rect, a.color ?? note.color);
    return { rect: a.rect, appearance };
  },
};

// --- Text markup ------------------------------------------------------------------

type Point = [number, number];
const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const gap = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function* eachQuad(list: number[]): Generator<{ tl: Point; tr: Point; bl: Point; br: Point }> {
  for (let i = 0; i + 8 <= list.length; i += 8) {
    const q = list.slice(i, i + 8) as [number, number, number, number, number, number, number, number];
    yield { tl: [q[0], q[1]], tr: [q[2], q[3]], bl: [q[4], q[5]], br: [q[6], q[7]] };
  }
}

/** Corner radius and sideways overhang of a highlight, as fractions of its height. */
const HIGHLIGHT_ROUNDING = 0.22;
const HIGHLIGHT_OVERHANG = 0.08;
const KAPPA = 0.5523;
const unit = (from: Point, to: Point): Point => {
  const length = gap(from, to) || 1;
  return [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
};

/**
 * A highlight quad as a fill path with rounded corners. It reaches a little past the quad's ends, so
 * the rounding never clips the first or last letter (the viewer draws the same shape, geometry.mjs).
 */
function roundedQuad({ tl, tr, bl, br }: { tl: Point; tr: Point; bl: Point; br: Point }): string {
  const height = gap(bl, tl);
  const along = unit(tl, tr);
  const out = (p: Point, sign: number): Point => [p[0] + along[0] * sign * height * HIGHLIGHT_OVERHANG, p[1] + along[1] * sign * height * HIGHLIGHT_OVERHANG];
  const corners = [out(tl, -1), out(tr, 1), out(br, 1), out(bl, -1)];
  const radius = Math.min(height * HIGHLIGHT_ROUNDING, gap(corners[0]!, corners[1]!) / 2);
  const ops: string[] = [];
  corners.forEach((corner, i) => {
    const toPrev = unit(corner, corners[(i + 3) % 4]!);
    const toNext = unit(corner, corners[(i + 1) % 4]!);
    const start: Point = [corner[0] + toPrev[0] * radius, corner[1] + toPrev[1] * radius];
    const end: Point = [corner[0] + toNext[0] * radius, corner[1] + toNext[1] * radius];
    ops.push(`${pts(start)} ${i ? "l" : "m"}`, `${pts(lerp(start, corner, KAPPA))} ${pts(lerp(end, corner, KAPPA))} ${pts(end)} c`);
  });
  return `${ops.join(" ")} h f`;
}

/** The width of a text mark's line: the one chosen, else a fourteenth of the text height. */
const markWidth = (chosen: number | undefined, height: number) => chosen ?? Math.max(0.5, height / 14);

function markupAppearance(kind: TextMarkup, quads: number[], stroke: Rgb, chosenWidth?: number): Appearance {
  const tallest = Math.max(0, ...[...eachQuad(quads)].map(({ tl, bl }) => gap(bl, tl)));
  const bbox = extentOf(quads, Math.max(2, tallest * HIGHLIGHT_OVERHANG + 1, (chosenWidth ?? 0) / 2 + 1));
  if (kind === "highlight") {
    // Multiply like Acrobat: true colors, text below stays readable.
    return { bbox, blend: "Multiply", content: [paint(stroke, "rg"), ...[...eachQuad(quads)].map(roundedQuad)].join("\n") };
  }
  const lines = [paint(stroke, "RG"), "1 J"];
  for (const { tl, tr, bl, br } of eachQuad(quads)) {
    const height = gap(bl, tl);
    const width = markWidth(chosenWidth, height);
    lines.push(`${s(width)} w`);
    if (kind === "squiggly") {
      const start = lerp(bl, tl, 0.06);
      const end = lerp(br, tr, 0.06);
      const up: Point = [(tl[0] - bl[0]) / (height || 1), (tl[1] - bl[1]) / (height || 1)];
      const amplitude = Math.max(0.6, height / 12, width);
      const steps = Math.max(2, Math.round(gap(start, end) / Math.max(1, height / 6, width * 2)));
      const path = Array.from({ length: steps + 1 }, (_, i) => {
        const p = lerp(start, end, i / steps);
        const offset = i % 2 ? amplitude : 0;
        return `${s(p[0] + up[0] * offset)} ${s(p[1] + up[1] * offset)} ${i ? "l" : "m"}`;
      });
      lines.push(`${path.join(" ")} S`);
    } else {
      const t = kind === "strikeout" ? 0.5 : Math.min(0.5, (width / 2 + height * 0.04) / Math.max(height, 1));
      lines.push(`${pts(lerp(bl, tl, t))} m ${pts(lerp(br, tr, t))} l S`);
    }
  }
  return { bbox, content: lines.join("\n") };
}

const boxQuads = ([x1, y1, x2, y2]: Box) => [x1, y2, x2, y2, x1, y1, x2, y1];

function markup(kind: TextMarkup, subtype: string, subject: string, defaultColor: Rgb): KindHandler {
  return {
    subtype,
    subject,
    color: defaultColor,
    flags: Flag.Print,
    derivedRect: true,
    read(dict, rect) {
      const quads = readNumbers(dict, "QuadPoints");
      // A chosen line width is kept in /BS (/Border is ignored: generators often write [0 0 1] for no reason).
      const bs = kind === "highlight" ? undefined : asDict(dict.context, dict.get(key("BS")));
      const width = bs && readNumber(bs, "W");
      return { quads: quads && quads.length >= 8 && quads.length % 8 === 0 ? quads : boxQuads(rect), ...(width !== undefined && { width }) };
    },
    async write(dict, a) {
      const quads = (a.quads ?? boxQuads(a.rect)).map(round);
      dict.set(key("QuadPoints"), dict.context.obj(quads));
      const width = kind === "highlight" ? undefined : a.width;
      if (width === undefined) {
        dict.delete(key("BS"));
      } else {
        setStroke(dict, width);
      }
      const appearance = markupAppearance(kind, quads, a.color ?? defaultColor, width);
      return { rect: appearance.bbox, appearance };
    },
  };
}

// --- Ink, shapes, lines ---------------------------------------------------------------

const ink: KindHandler = {
  subtype: "Ink",
  subject: "Drawing",
  color: [0.9, 0.13, 0.13],
  flags: Flag.Print,
  derivedRect: true,
  read: (dict) => ({ ink: readLists(dict, "InkList"), width: strokeOf(dict) ?? 1 }),
  async write(dict, a) {
    const width = a.width ?? 1;
    const strokes = (a.ink ?? []).filter((stroke) => stroke.length >= 2).map((stroke) => stroke.map(round));
    dict.set(key("InkList"), dict.context.obj(strokes));
    setStroke(dict, width);
    const paths = strokes.map((stroke) => {
      const pairs = Array.from({ length: stroke.length / 2 }, (_, i) => `${s(stroke[2 * i]!)} ${s(stroke[2 * i + 1]!)}`);
      // A lone point becomes a dot: a zero-length line with round caps.
      return `${pairs[0]} m ${(pairs.length > 1 ? pairs.slice(1) : pairs).map((p) => `${p} l`).join(" ")} S`;
    });
    const rect = strokes.length ? extentOf(strokes.flat(), width / 2 + 1) : a.rect;
    return { rect, appearance: { bbox: rect, content: [`${s(width)} w 1 J 1 j`, paint(a.color ?? ink.color, "RG"), ...paths].join("\n") } };
  },
};

/** Bezier approximation of an ellipse inscribed in a box. */
function ellipse([x1, y1, x2, y2]: Box): string {
  const k = 0.5523;
  const [cx, cy, rx, ry] = [(x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) / 2, (y2 - y1) / 2];
  return [
    `${s(cx + rx)} ${s(cy)} m`,
    `${s(cx + rx)} ${s(cy + ry * k)} ${s(cx + rx * k)} ${s(cy + ry)} ${s(cx)} ${s(cy + ry)} c`,
    `${s(cx - rx * k)} ${s(cy + ry)} ${s(cx - rx)} ${s(cy + ry * k)} ${s(cx - rx)} ${s(cy)} c`,
    `${s(cx - rx)} ${s(cy - ry * k)} ${s(cx - rx * k)} ${s(cy - ry)} ${s(cx)} ${s(cy - ry)} c`,
    `${s(cx + rx * k)} ${s(cy - ry)} ${s(cx + rx)} ${s(cy - ry * k)} ${s(cx + rx)} ${s(cy)} c h`,
  ].join(" ");
}

function shape(kind: "square" | "circle", subtype: string, subject: string): KindHandler {
  return {
    subtype,
    subject,
    color: [0.9, 0.13, 0.13],
    flags: Flag.Print,
    read: (dict) => ({ width: strokeOf(dict) ?? 1, fill: readColor(dict, "IC") }),
    async write(dict, a) {
      const width = a.width ?? 1;
      setStroke(dict, width);
      if (a.fill) {
        dict.set(key("IC"), dict.context.obj(a.fill.map(round)));
      } else {
        dict.delete(key("IC"));
      }
      const [x1, y1, x2, y2] = a.rect;
      const inner: Box = [x1 + width / 2, y1 + width / 2, x2 - width / 2, y2 - width / 2];
      const path = kind === "square" ? `${pts(inner.slice(0, 2))} ${s(inner[2] - inner[0])} ${s(inner[3] - inner[1])} re` : ellipse(inner);
      const draw = a.fill ? `${paint(a.fill, "rg")} ${path} B` : `${path} S`;
      return { rect: a.rect, appearance: { bbox: a.rect, content: `${s(width)} w ${paint(a.color ?? [0.9, 0.13, 0.13], "RG")}\n${draw}` } };
    },
  };
}

const ARROW_END = /Arrow$/u;

const line: KindHandler = {
  subtype: "Line",
  subject: "Line",
  color: [0.9, 0.13, 0.13],
  flags: Flag.Print,
  derivedRect: true,
  accepts: (dict) => !dict.has(key("IT")) && readNumbers(dict, "L")?.length === 4,
  read(dict) {
    const end = dict.lookupMaybe(key("LE"), PDFArray)?.lookup(1);
    const arrow = end instanceof PDFName && ARROW_END.test(end.decodeText());
    return { line: readNumbers(dict, "L") as Box, width: strokeOf(dict) ?? 1, ...(arrow && { arrow: true as const }) };
  },
  async write(dict, a) {
    const width = a.width ?? 1;
    const [x1, y1, x2, y2] = a.line!.map(round) as Box;
    dict.set(key("L"), dict.context.obj([x1, y1, x2, y2]));
    setStroke(dict, width);
    const content = [`${s(width)} w 1 J 1 j`, paint(a.color ?? line.color, "RG"), `${s(x1)} ${s(y1)} m ${s(x2)} ${s(y2)} l S`];
    const size = Math.max(6, width * 4);
    if (a.arrow) {
      dict.set(key("LE"), dict.context.obj(["None", "OpenArrow"]));
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const barb = (delta: number): Point => [x2 - size * Math.cos(angle + delta), y2 - size * Math.sin(angle + delta)];
      content.push(`${pts(barb(Math.PI / 6))} m ${s(x2)} ${s(y2)} l ${pts(barb(-Math.PI / 6))} l S`);
    } else {
      dict.delete(key("LE"));
    }
    const rect = extentOf([x1, y1, x2, y2], width / 2 + (a.arrow ? size : 1));
    return { rect, appearance: { bbox: rect, content: content.join("\n") } };
  },
};

// --- Text boxes ---------------------------------------------------------------------------

export const BASE_FONT: Font = { family: "Helvetica", size: 12 };
/** `/Q` values: 0 left, 1 centred, 2 right. */
const ALIGNMENTS = [undefined, "center", "right"] as const;
const INSET = 2;
export const LEADING = 1.2;

const hexOf = (c: Rgb) => `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;

const MAX_STYLE = 2_000;
const MAX_SIZE = 400;
const saneSize = (value: number) => (Number.isFinite(value) && value >= 1 && value <= MAX_SIZE ? value : undefined);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Font and text color from `/DS` (CSS) or `/DA` (content-stream operators).
 * Inputs are untrusted: capped in length, split on delimiters rather than
 * matched with backtracking patterns, and only sane values are accepted.
 */
export function textStyleOf(dict: PDFDict): { font: Font; color?: Rgb } {
  const ds = (readText(dict, "DS") ?? "").slice(0, MAX_STYLE);
  const daTokens = (readText(dict, "DA") ?? "").slice(0, MAX_STYLE).trim().split(/\s+/u);
  const css = new Map(
    ds.split(";").flatMap((declaration) => {
      const colon = declaration.indexOf(":");
      return colon < 0 ? [] : [[declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).trim()] as const];
    }),
  );
  const shorthand = css.get("font") ?? "";
  const tf = daTokens.indexOf("Tf");
  const daFont = tf >= 2 ? { name: daTokens[tf - 2]!.replace(/^\//u, ""), size: Number(daTokens[tf - 1]) } : undefined;
  const sizeText = css.get("font-size") ?? shorthand.split(/\s+/u).find((token) => /^[\d.]+pt$/u.test(token));
  const size = saneSize(Number.parseFloat(sizeText ?? "")) ?? saneSize(daFont?.size ?? Number.NaN) ?? BASE_FONT.size;
  const familyText = css.get("font-family") ?? shorthand.split(/\d[\d.]*pt\s*/u)[1] ?? daFont?.name ?? "";
  const styleText = `${shorthand} ${css.get("font-weight") ?? ""} ${css.get("font-style") ?? ""} ${daFont?.name ?? ""}`;
  const font: Font = {
    family: familyNamed(familyText),
    size,
    ...(/bold/iu.test(styleText) && { bold: true }),
    ...(/italic|oblique/iu.test(styleText) && { italic: true }),
  };
  const cssHex = /^#([\da-f]{6})$/iu.exec(css.get("color") ?? "")?.[1];
  const operator = daTokens.findIndex((token) => token === "rg" || token === "g");
  const operands = operator >= 0 ? daTokens.slice(operator - (daTokens[operator] === "rg" ? 3 : 1), operator).map(Number) : [];
  const daColor = operands.length && operands.every(Number.isFinite) ? operands.map(clamp01) : undefined;
  const textColor: Rgb | undefined = cssHex
    ? ([0, 2, 4].map((i) => round(Number.parseInt(cssHex.slice(i, i + 2), 16) / 255)) as Rgb)
    : daColor?.length === 3
      ? (daColor as Rgb)
      : daColor?.length === 1
        ? [daColor[0]!, daColor[0]!, daColor[0]!]
        : undefined;
  return { font, ...(textColor && { color: textColor }) };
}

/** A placed run of text-box text with its resolved font. */
interface Piece {
  text: string;
  font: PDFFont;
  size: number;
  rise: number;
  width: number;
  underline?: true;
  strike?: true;
  /** A typeset formula (its text is the `$...$` source). */
  formula?: Formula;
}
type PieceStyle = Omit<Piece, "text" | "width">;
/**
 * Letters of upright vertical text in columns of at most `capacity`: words stay whole where they fit, longer ones
 * break anywhere, and the spaces a column breaks at are dropped. Each paragraph starts a new column.
 */
export function stackColumns(paragraphs: TextRun[][], capacity: number): Array<Array<{ text: string; run: TextRun }>> {
  const columns: Array<Array<{ text: string; run: TextRun }>> = [];
  const isSpace = (letter: { text: string }) => /\s/u.test(letter.text);
  const close = (column: Array<{ text: string; run: TextRun }>) => {
    while (column.length && isSpace(column.at(-1)!)) {
      column.pop();
    }
    columns.push(column);
  };
  for (const runs of paragraphs) {
    const words: Array<Array<{ text: string; run: TextRun }>> = [[]];
    for (const run of runs) {
      for (const text of run.text) {
        words.at(-1)!.push({ text, run });
        if (/\s/u.test(text)) {
          words.push([]);
        }
      }
    }
    let column: Array<{ text: string; run: TextRun }> = [];
    for (const word of words) {
      if (column.length && column.length + word.filter((letter) => !isSpace(letter)).length > capacity) {
        close(column);
        column = [];
      }
      for (const letter of word) {
        if (column.length >= capacity) {
          if (isSpace(letter)) {
            continue;
          }
          close(column);
          column = [];
        }
        if (column.length || !isSpace(letter)) {
          column.push(letter);
        }
      }
    }
    close(column);
  }
  return columns;
}

/** A run to lay out; a formula's run never breaks. */
export type LaidRun = TextRun & { formula?: Formula };

/**
 * Lay paragraphs of runs into lines at most `width` wide: greedy word wrap with
 * real font metrics; over-long words split (formulas never do).
 */
export function layoutText(paragraphs: LaidRun[][], width: number, style: (run: LaidRun) => PieceStyle): Piece[][] {
  const lines: Piece[][] = [];
  for (const runs of paragraphs) {
    let line: Piece[] = [];
    let used = 0;
    const measure = (text: string, st: PieceStyle) => (st.formula ? st.formula.width * st.size : st.font.widthOfTextAtSize(text, st.size));
    const emit = (text: string, st: PieceStyle) => {
      const w = measure(text, st);
      const last = line.at(-1);
      // Same-style neighbours merge into one piece (one text operator).
      if (last && !last.formula && !st.formula && last.font === st.font && last.size === st.size && last.rise === st.rise && last.underline === st.underline && last.strike === st.strike) {
        line[line.length - 1] = { ...last, text: last.text + text, width: last.width + w };
      } else {
        line.push({ ...st, text, width: w });
      }
      used += w;
    };
    const wrap = () => {
      lines.push(line);
      line = [];
      used = 0;
    };
    // A word may span runs ("hel" + bold "lo") and wraps as a whole.
    const words: Array<Array<{ text: string; st: PieceStyle }>> = [];
    let word: Array<{ text: string; st: PieceStyle }> = [];
    for (const run of runs) {
      const st = run.formula ? { ...style(run), formula: run.formula } : style(run);
      for (const piece of run.formula ? [run.text] : run.text.split(/(?<=\s)/u).filter(Boolean)) {
        word.push({ text: piece, st });
        if (/\s$/u.test(piece)) {
          words.push(word);
          word = [];
        }
      }
    }
    if (word.length) {
      words.push(word);
    }
    for (const fragments of words) {
      const wordWidth = fragments.reduce((sum, f, i) => sum + measure(i === fragments.length - 1 ? f.text.trimEnd() : f.text, f.st), 0);
      if (used > 0 && used + wordWidth > width) {
        wrap();
      }
      for (const { text, st } of fragments) {
        let rest = text;
        while (!st.formula && rest.length > 1 && measure(rest.trimEnd(), st) > width - used) {
          let cut = rest.length - 1;
          while (cut > 1 && measure(rest.slice(0, cut), st) > width - used) {
            cut--;
          }
          emit(rest.slice(0, cut), st);
          wrap();
          rest = rest.slice(cut);
        }
        emit(rest, st);
      }
    }
    lines.push(line);
  }
  return lines;
}

const freetext: KindHandler = {
  subtype: "FreeText",
  subject: "Text Box",
  color: [0, 0, 0],
  flags: Flag.Print,
  accepts: (dict) => readName(dict, "IT") !== "FreeTextCallout",
  read(dict) {
    // A text box's /C is its background; the text color lives in /DA or /DS.
    const { font, color: text } = textStyleOf(dict);
    const align = ALIGNMENTS[readNumber(dict, "Q") ?? 0];
    const vertical = /writing-mode\s*:\s*vertical/iu.test((readText(dict, "DS") ?? "").slice(0, MAX_STYLE));
    return { font, color: text ?? [0, 0, 0], ...(align && { align }), ...(vertical && { vertical: true as const }) };
  },
  async write(dict, a, ctx) {
    const font = { ...BASE_FONT, ...a.font, size: saneSize(a.font?.size ?? Number.NaN) ?? BASE_FONT.size };
    const textColor = a.color ?? [0, 0, 0];
    const cssStyle = [font.bold && "bold", font.italic && "italic"].filter(Boolean).join(" ");
    dict.set(key("DA"), stringObject(`${paint(textColor, "rg")} /${daTag(font.family)} ${s(font.size)} Tf`));
    const familyCss = font.family.includes(" ") ? `'${font.family}'` : font.family;
    dict.set(key("DS"), stringObject(`font: ${cssStyle ? `${cssStyle} ` : ""}${s(font.size)}pt ${familyCss}; color:${hexOf(textColor)}${a.align ? `; text-align:${a.align}` : ""}${a.vertical ? "; writing-mode:vertical-lr; text-orientation:upright" : ""}`));
    if (a.align) {
      dict.set(key("Q"), dict.context.obj(ALIGNMENTS.indexOf(a.align)));
    } else {
      dict.delete(key("Q"));
    }
    setStroke(dict, 0);
    dict.delete(key("C"));
    const [x1, y1, x2, y2] = a.rect;
    const charsets = new Map<PDFFont, Set<number>>();
    // A font draws only the characters it has (a standard font: WinAnsi); others show as "?" in the appearance (the text itself is kept).
    const winAnsi = (pdfFont: PDFFont, text: string) => {
      const charset = charsets.get(pdfFont) ?? new Set(pdfFont.getCharacterSet());
      charsets.set(pdfFont, charset);
      return [...text].map((ch) => (charset.has(ch.codePointAt(0)!) ? ch : "?")).join("");
    };
    // `$...$` outside code is maths: MathJax outlines, or plain text when it does not typeset.
    const source = (a.rich ?? a.contents.split("\n").map((text): TextRun[] => [{ text }])).map((runs) => runs.flatMap((run) => (run.code ? [{ run, part: { text: run.text } as TexPart }] : splitTex(run.text).map((part) => ({ run, part })))));
    const allText = source.flat().map(({ part }) => part.text).join("");
    const pick = (standardOnly: boolean) => (run: Pick<TextRun, "code" | "bold" | "italic">) => chooseFace({ family: run.code ? "Courier" : font.family, bold: font.bold || run.bold, italic: font.italic || run.italic }, standardOnly);
    const runs = [{}, ...source.flat().map(({ run }) => run)];
    const faces = new Map(runs.map(pick(false)).map((face) => [face.key, face]));
    const works = await Promise.all([...faces.values()].map((face) => faceWorks(face, allText)));
    // A family fontkit cannot handle for this text gives way to the standard font of its kind.
    const faceOf = pick(works.includes(false));
    // Embedding is asynchronous, so every face the box needs is embedded before laying it out.
    for (const run of runs) {
      await embedFace(ctx.doc, ctx.fonts, faceOf(run));
    }
    const runFont = (run: TextRun) => ctx.fonts.get(faceOf(run).key)!;
    const formulas = await typesetFormulas(source.flat().flatMap(({ part }) => (part.tex === undefined ? [] : [part.tex])));
    const paragraphs: LaidRun[][] = source.map((runs) =>
      runs.map(({ run, part }) => {
        const formula = part.tex === undefined ? undefined : formulas.get(part.tex);
        return formula ? { ...run, text: part.text, formula } : { ...run, text: winAnsi(runFont(run), part.text) };
      }),
    );
    const lines = layoutText(paragraphs, x2 - x1 - 2 * INSET, (run) => ({
      font: runFont(run),
      size: run.sup || run.sub ? font.size * 0.7 : font.size,
      rise: run.sup ? font.size * 0.35 : run.sub ? -font.size * 0.15 : 0,
      ...(run.underline && { underline: true as const }),
      ...(run.strike && { strike: true as const }),
    }));
    const ascent = ctx.fonts.get(faceOf({}).key)!.heightAtSize(font.size, { descender: false });
    const names = new Map<PDFFont, string>();
    const text: string[] = [];
    const marks: string[] = [];
    const drawn: string[] = [];
    const show = (pdfFont: PDFFont, size: number, x: number, y: number, value: string) => {
      const fontName = names.get(pdfFont) ?? `F${names.size}`;
      names.set(pdfFont, fontName);
      text.push(`/${fontName} ${s(size)} Tf 1 0 0 1 ${s(x)} ${s(y)} Tm ${pdfFont.encodeText(value).toString()} Tj`);
    };
    if (a.vertical) {
      // Upright letters stacked top to bottom, columns left to right, as the viewer shows them (CSS vertical-lr):
      // each letter takes 1 em down its column, baseline 0.8 em below the top of its cell, centred across the column.
      const column = font.size * LEADING;
      const room = y2 - y1 - 2 * INSET;
      const runsOf = source.map((runs) => runs.map(({ run, part }) => ({ ...run, text: winAnsi(runFont(run), part.text) })));
      stackColumns(runsOf, Math.max(1, Math.floor(room / font.size))).forEach((letters, index) => {
        const slack = room - letters.length * font.size;
        let cell = y2 - INSET - (a.align === "center" ? slack / 2 : a.align === "right" ? slack : 0);
        for (const { text: letter, run } of letters) {
          const pdfFont = runFont(run);
          show(pdfFont, font.size, x1 + INSET + index * column + (column - pdfFont.widthOfTextAtSize(letter, font.size)) / 2, cell - font.size * 0.8, letter);
          cell -= font.size;
        }
      });
    }
    let top = y2 - INSET;
    for (const pieces of a.vertical ? [] : lines) {
      // A tall formula makes its line taller, as in the browser.
      const up = Math.max(ascent, ...pieces.map((p) => (p.formula ? p.formula.ascent * p.size + p.rise : 0)));
      const down = Math.max(font.size * LEADING - ascent, ...pieces.map((p) => (p.formula ? p.formula.descent * p.size - p.rise : 0)));
      const baseline = top - up;
      top = baseline - down;
      // Centred and right-aligned lines are placed without the spaces they wrapped at.
      const last = pieces.at(-1);
      const trailing = last && !last.formula ? last.font.widthOfTextAtSize(last.text.slice(last.text.trimEnd().length), last.size) : 0;
      const slack = x2 - x1 - 2 * INSET - (pieces.reduce((sum, piece) => sum + piece.width, 0) - trailing);
      let x = x1 + INSET + (a.align === "center" ? slack / 2 : a.align === "right" ? slack : 0);
      for (const piece of pieces) {
        const y = baseline + piece.rise;
        if (piece.formula) {
          const k = piece.size / 1000;
          drawn.push(`q ${s(k)} 0 0 ${s(-k)} ${s(x)} ${s(y)} cm ${piece.formula.content} Q`);
        } else {
          show(piece.font, piece.size, x, y, piece.text);
        }
        for (const [on, offset] of [[piece.underline, -piece.size * 0.12], [piece.strike, piece.size * 0.3]] as const) {
          if (on) {
            marks.push(`${s(x)} ${s(y + offset)} m ${s(x + piece.width)} ${s(y + offset)} l S`);
          }
        }
        x += piece.width;
      }
    }
    const content = [`q ${s(x1)} ${s(y1)} ${s(x2 - x1)} ${s(y2 - y1)} re W n`, `BT ${paint(textColor, "rg")}`, ...text, "ET", ...drawn];
    if (marks.length) {
      content.push(`${paint(textColor, "RG")} ${s(Math.max(0.5, font.size / 14))} w`, ...marks);
    }
    content.push("Q");
    const fonts = Object.fromEntries([...names].map(([pdfFont, fontName]) => [fontName, pdfFont.ref]));
    return { rect: a.rect, appearance: { bbox: a.rect, resources: { Font: fonts }, content: content.join("\n") } };
  },
};

// --- Images -------------------------------------------------------------------------------

const image: KindHandler = {
  subtype: "Stamp",
  subject: "Image",
  color: [0, 0, 0],
  flags: Flag.Print,
  accepts: (dict) => stampPicture(dict) !== undefined,
  read: (dict) => ({ image: stampPicture(dict) }),
  async write(dict, a, ctx) {
    const data = fromDataUrl(a.image ?? "");
    const [x1, y1, x2, y2] = a.rect;
    dict.set(key("Name"), key("Image"));
    if (!data) {
      return { rect: a.rect, appearance: { bbox: a.rect, content: "" } };
    }
    const picture = data.mime === "image/png" ? await ctx.doc.embedPng(data.bytes) : await ctx.doc.embedJpg(data.bytes);
    return {
      rect: a.rect,
      appearance: { bbox: a.rect, resources: { XObject: { Im0: picture.ref } }, content: `q ${s(x2 - x1)} 0 0 ${s(y2 - y1)} ${s(x1)} ${s(y1)} cm /Im0 Do Q` },
    };
  },
};

export const KINDS: Readonly<Record<OwnedKind, KindHandler>> = {
  note,
  highlight: markup("highlight", "Highlight", "Highlight", [1, 1, 0]),
  underline: markup("underline", "Underline", "Underline", [0, 0.6, 0.3]),
  strikeout: markup("strikeout", "StrikeOut", "Strikethrough", [0.9, 0.1, 0.1]),
  squiggly: markup("squiggly", "Squiggly", "Squiggly", [0.2, 0.4, 1]),
  freetext,
  ink,
  square: shape("square", "Square", "Rectangle"),
  circle: shape("circle", "Circle", "Oval"),
  line,
  image,
};
