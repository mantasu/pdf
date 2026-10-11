/**
 * Rich comment text: `Rich` (paragraphs of formatted runs) <-> the XHTML `/RC`
 * string Acrobat uses (ISO 32000-1 §12.7.3.4). Parsing is tolerant: only text
 * and a fixed set of formatting flags survive, never markup.
 */
import type { Rich, TextRun } from "./model";

type Flags = Omit<TextRun, "text">;
const FLAGS = ["bold", "italic", "underline", "strike", "sup", "sub", "code"] as const;

const TAG_FLAGS: Readonly<Record<string, Flags>> = {
  b: { bold: true },
  strong: { bold: true },
  i: { italic: true },
  em: { italic: true },
  u: { underline: true },
  s: { strike: true },
  strike: { strike: true },
  del: { strike: true },
  sup: { sup: true },
  sub: { sub: true },
  code: { code: true },
  tt: { code: true },
};
const BLOCKS = new Set(["p", "div", "li", "br"]);

export const toPlain = (rich: Rich) => rich.map((p) => p.map((r) => r.text).join("")).join("\n");
export const isFormatted = (rich: Rich) => rich.some((p) => p.some((r) => FLAGS.some((k) => r[k])));

function styleFlags(style: string): Flags {
  const flags: Flags = {};
  for (const declaration of style.split(";")) {
    const [property = "", value = ""] = declaration.split(":").map((part) => part.trim().toLowerCase());
    if (property === "font-weight" && (value === "bold" || Number(value) >= 600)) {
      flags.bold = true;
    } else if (property === "font-style" && /italic|oblique/u.test(value)) {
      flags.italic = true;
    } else if (property === "text-decoration") {
      Object.assign(flags, value.includes("underline") && { underline: true }, value.includes("line-through") && { strike: true });
    } else if (property === "vertical-align") {
      Object.assign(flags, /super|^\+/u.test(value) && { sup: true }, /sub|^-/u.test(value) && { sub: true });
    } else if (property === "font-family" && /courier|mono/u.test(value)) {
      flags.code = true;
    }
  }
  return flags;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    if (!entity.startsWith("#")) {
      return ENTITIES[entity.toLowerCase()] ?? match;
    }
    const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** Merge equal-formatting neighbours; drop empty runs and trailing empty paragraphs. */
export function mergeRuns(rich: Rich): Rich {
  const same = (a: TextRun, b: TextRun) => FLAGS.every((k) => a[k] === b[k]);
  const paragraphs = rich.map((paragraph) =>
    paragraph.reduce<TextRun[]>((runs, run) => {
      const last = runs.at(-1);
      if (!run.text) {
        return runs;
      }
      if (last && same(last, run)) {
        runs[runs.length - 1] = { ...last, text: last.text + run.text };
      } else {
        runs.push({ ...run });
      }
      return runs;
    }, []),
  );
  while (paragraphs.length > 1 && paragraphs.at(-1)!.length === 0) {
    paragraphs.pop();
  }
  return paragraphs;
}

/** Beyond this size `/RC` is markup nobody typed; it is treated as plain text. */
const MAX_RICH = 200_000;

/**
 * Parse `/RC` XHTML; undefined when it holds no text. One forward scan (no
 * backtracking regexes over the whole input) so hostile files stay fast.
 */
export function parseRc(xml: string): Rich | undefined {
  const source = xml.slice(0, MAX_RICH);
  const paragraphs: TextRun[][] = [[]];
  const stack: Array<{ tag: string; flags: Flags }> = [];
  const current = (): Flags => Object.assign({}, ...stack.map((entry) => entry.flags));
  const newParagraph = () => {
    if (paragraphs.at(-1)!.length > 0) {
      paragraphs.push([]);
    }
  };
  const addText = (value: string) => {
    // Indentation between tags is not content.
    if (!(value.trim() === "" && value.includes("\n"))) {
      paragraphs.at(-1)!.push({ text: decodeEntities(value), ...current() });
    }
  };
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("<", i);
    if (open === -1) {
      addText(source.slice(i));
      break;
    }
    if (open > i) {
      addText(source.slice(i, open));
    }
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    const close = source.indexOf(">", open + 1);
    if (close === -1) {
      break;
    }
    i = close + 1;
    const match = /^(\/?)([a-z][\w:.-]*)/iu.exec(source.slice(open + 1, close));
    if (!match) {
      continue; // <?xml ...?>, <!DOCTYPE ...> and stray "<"
    }
    const [whole, closing, rawTag] = match;
    const attributes = source.slice(open + 1 + whole.length, close);
    const tag = rawTag!.toLowerCase().replace(/^.*:/u, "");
    if (BLOCKS.has(tag)) {
      newParagraph();
    }
    if (closing) {
      const index = stack.findLastIndex((entry) => entry.tag === tag);
      if (index >= 0) {
        stack.splice(index);
      }
    } else if (!attributes.trimEnd().endsWith("/") && tag !== "br") {
      const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(attributes);
      stack.push({ tag, flags: { ...TAG_FLAGS[tag], ...styleFlags(style?.[1] ?? style?.[2] ?? "") } });
    }
  }
  const rich = mergeRuns(paragraphs);
  return toPlain(rich) ? rich : undefined;
}

const escapeXml = (text: string) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

function runStyle(run: TextRun): string {
  const decoration = [run.underline && "underline", run.strike && "line-through"].filter(Boolean).join(" ");
  return [
    run.bold && "font-weight:bold",
    run.italic && "font-style:italic",
    decoration && `text-decoration:${decoration}`,
    // Acrobat only reads the sign of the offset: "super"/"sub" both become superscript.
    run.sup && "vertical-align:+4.0pt",
    run.sub && "vertical-align:-2.0pt",
    run.code && "font-family:Courier",
  ]
    .filter(Boolean)
    .join(";");
}

/** Serialize to Acrobat-style `/RC` XHTML. */
export function toRc(rich: Rich): string {
  const paragraphs = rich
    .map((paragraph) => {
      const runs = paragraph.map((run) => {
        const style = runStyle(run);
        return style ? `<span style="${style}">${escapeXml(run.text)}</span>` : escapeXml(run.text);
      });
      return `<p dir="ltr">${runs.join("")}</p>`;
    })
    .join("");
  return (
    '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" ' +
    'xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:23.8.0" xfa:spec="2.0.2">' +
    `${paragraphs}</body>`
  );
}
