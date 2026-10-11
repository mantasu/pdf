/**
 * Text-box font families: the three PDF standard fonts, which every reader has built in, and the
 * Google Fonts in resources/fonts (fetched by scripts/pdfjs.mjs), whose glyphs get embedded. A
 * family whose files are missing, or that fontkit cannot handle for some text, falls back to the
 * standard font of its kind, so writing never fails.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
import type { Font, FontFamily } from "./model";

type Kind = "sans" | "serif" | "mono";
interface Family {
  kind: Kind;
  /** Standard 14 fonts: regular, bold, italic, bold italic. */
  standard?: readonly [StandardFonts, StandardFonts, StandardFonts, StandardFonts];
  /** File stem in resources/fonts (`<stem>-Regular.ttf` and so on). */
  file?: string;
}

const FAMILIES: Readonly<Record<FontFamily, Family>> = {
  Helvetica: { kind: "sans", standard: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique] },
  Times: { kind: "serif", standard: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic] },
  Courier: { kind: "mono", standard: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique] },
  Roboto: { kind: "sans", file: "Roboto" },
  Lora: { kind: "serif", file: "Lora" },
  "Comic Neue": { kind: "sans", file: "ComicNeue" },
};
export const FONT_FAMILIES = Object.keys(FAMILIES) as FontFamily[];

const STANDARD_OF: Readonly<Record<Kind, FontFamily>> = { sans: "Helvetica", serif: "Times", mono: "Courier" };
/** `/DA` names a font from the form resources every reader knows, so it says Helvetica, Times or Courier. */
const DA_TAGS: Readonly<Record<Kind, string>> = { sans: "Helv", serif: "TiRo", mono: "Cour" };
const STYLE_NAMES = ["Regular", "Bold", "Italic", "BoldItalic"] as const;

export const daTag = (family: FontFamily) => DA_TAGS[FAMILIES[family].kind];

/** The family a font name stands for: one of ours by name, else the standard font of its kind. */
export function familyNamed(value: string): FontFamily {
  const first = value.split(",")[0]!.replace(/["']/gu, "").trim();
  const squashed = first.toLowerCase().replace(/[\s_-]/gu, "");
  const ours = FONT_FAMILIES.filter((family) => FAMILIES[family].file).find((family) => squashed.startsWith(family.toLowerCase().replace(/\s/gu, "")));
  if (ours) {
    return ours;
  }
  return /cour|mono/iu.test(first) ? "Courier" : /tim|tiro|serif$/iu.test(first) && !/sans/iu.test(first) ? "Times" : "Helvetica";
}

let fontDir: string | undefined;

/** resources/fonts, from out/ (the bundle), out/pdf/ (compiled) or src/pdf/ (tests). */
function fontFolder(): string | undefined {
  fontDir ??= [join(__dirname, "..", "resources", "fonts"), join(__dirname, "..", "..", "resources", "fonts")].find((dir) => existsSync(dir));
  return fontDir;
}

/** A font resolved for writing: a standard font, or a file to embed. `key` identifies it in a per-document cache. */
export interface FaceChoice {
  key: string;
  standard?: StandardFonts;
  file?: string;
}

/** How `font` gets drawn: the family's own file for the style, else (or with `standardOnly`) the matching standard font. */
export function chooseFace(font: Pick<Font, "family" | "bold" | "italic">, standardOnly = false): FaceChoice {
  const family = FAMILIES[font.family] ?? FAMILIES.Helvetica;
  const style = (font.bold ? 1 : 0) + (font.italic ? 2 : 0);
  const folder = standardOnly ? undefined : fontFolder();
  const file = folder && family.file ? join(folder, `${family.file}-${STYLE_NAMES[style]}.ttf`) : undefined;
  if (file && existsSync(file)) {
    return { key: file, file };
  }
  const standard = (family.standard ?? FAMILIES[STANDARD_OF[family.kind]].standard!)[style]!;
  return { key: standard, standard };
}

const embedFile = async (doc: PDFDocument, file: string) => {
  doc.registerFontkit(fontkit as never);
  return doc.embedFont(readFileSync(file), { subset: true });
};

/**
 * Whether fontkit can lay out `text` in a font file and write the subset. Some fonts trip it up on
 * some text, and the failure would only surface when saving, sinking the whole save, so the text is
 * tried in a scratch document first.
 */
export async function faceWorks(face: FaceChoice, text: string): Promise<boolean> {
  if (!face.file) {
    return true;
  }
  try {
    const scratch = await PDFDocument.create();
    const font = await embedFile(scratch, face.file);
    font.encodeText(text);
    font.widthOfTextAtSize(text, 12);
    await scratch.save();
    return true;
  } catch {
    return false;
  }
}

/** Embed a face once per document (fonts from files are subset to the glyphs used). */
export async function embedFace(doc: PDFDocument, cache: Map<string, PDFFont>, face: FaceChoice): Promise<PDFFont> {
  let embedded = cache.get(face.key);
  if (!embedded) {
    embedded = face.file ? await embedFile(doc, face.file) : doc.embedStandardFont(face.standard!);
    cache.set(face.key, embedded);
  }
  return embedded;
}
