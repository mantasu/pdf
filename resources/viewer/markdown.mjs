/**
 * Converts Copilot's Markdown into the rich-text runs comments use (bold, italic, code; `$...$` maths
 * stays as text), so the card and the comment saved from it look alike. Markdown headings become bold
 * paragraphs, and list markers are kept as plain text.
 */
import { isFormatted, toPlain } from "./richtext.mjs";

// Maths goes first so its `*` and `_` never count as emphasis. Groups: math, code, bold (`**`),
// bold (`__`), italic (`*`), italic (`_`), link label, link url.
const INLINE_PATTERN =
  /(\$[^$\n]+?\$)|`([^`\n]+)`|\*\*(.+?)\*\*(?!\*)|__(.+?)__(?!_)|(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])|(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)|\[([^\]\n]+)\]\(([^)\s]+)\)/gu;
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/u;
const RUN_FLAGS = ["bold", "italic", "code"];

/** `\(x\)`, `\[x\]` and `$$x$$` as Copilot writes them all become `$x$`, display maths on one line. */
export function unifyMath(markdown) {
  const dollars = (inner) => `$${inner.trim().replace(/\s*\n\s*/gu, " ")}$`;
  return markdown
    .replace(/\r/gu, "")
    .replace(/\$\$([\s\S]+?)\$\$/gu, (_, inner) => dollars(inner))
    .replace(/\\\[([\s\S]+?)\\\]/gu, (_, inner) => dollars(inner))
    .replace(/\\\((.+?)\\\)/gu, (_, inner) => dollars(inner));
}

/** A Markdown answer as `{ contents, rich? }`, the same shape a comment typed in the viewer has. */
export function fromMarkdown(markdown) {
  const paragraphs = [];
  let inFence = false;
  for (const line of unifyMath(markdown).split("\n")) {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
    } else if (inFence) {
      paragraphs.push(line ? [{ text: line, code: true }] : []);
    } else if (!HORIZONTAL_RULE.test(line)) {
      paragraphs.push(blockRuns(line));
    }
  }
  // No blank paragraphs at either end, and never two in a row.
  const rich = paragraphs.filter((runs, i) => runs.length || (i > 0 && paragraphs[i - 1].length));
  while (rich.length && !rich.at(-1).length) {
    rich.pop();
  }
  return { contents: toPlain(rich), ...(isFormatted(rich) && { rich }) };
}

function blockRuns(line) {
  const heading = /^\s{0,3}#{1,6}\s+(.*)$/u.exec(line);
  if (heading) {
    return inlineRuns(heading[1], { bold: true });
  }
  const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u.exec(line);
  if (item) {
    const marker = /\d/u.test(item[2]) ? item[2] : "•";
    return inlineRuns(`${"  ".repeat(Math.floor(item[1].length / 2))}${marker} ${item[3]}`);
  }
  const quote = /^\s*>\s?(.*)$/u.exec(line);
  if (quote) {
    return inlineRuns(quote[1], { italic: true });
  }
  return line.trim() ? inlineRuns(line.trim()) : [];
}

/** Split text into runs by its inline syntax; `style` holds the flags of an enclosing span. */
function inlineRuns(text, style = {}) {
  const runs = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    if (match.index > cursor) {
      runs.push({ text: text.slice(cursor, match.index), ...style });
    }
    const [whole, math, code, bold, boldUnderscore, italic, italicUnderscore, label, url] = match;
    if (math) {
      runs.push({ text: math, ...style });
    } else if (code) {
      runs.push({ text: code, ...style, code: true });
    } else if (bold || boldUnderscore) {
      runs.push(...inlineRuns(bold || boldUnderscore, { ...style, bold: true }));
    } else if (italic || italicUnderscore) {
      runs.push(...inlineRuns(italic || italicUnderscore, { ...style, italic: true }));
    } else {
      runs.push({ text: `${label} (${url})`, ...style });
    }
    cursor = match.index + whole.length;
  }
  if (cursor < text.length) {
    runs.push({ text: text.slice(cursor), ...style });
  }
  // Merge neighbouring runs with equal flags.
  return runs.reduce((out, run) => {
    const previous = out.at(-1);
    if (previous && RUN_FLAGS.every((flag) => previous[flag] === run[flag])) {
      out[out.length - 1] = { ...previous, text: previous.text + run.text };
    } else {
      out.push(run);
    }
    return out;
  }, []);
}
