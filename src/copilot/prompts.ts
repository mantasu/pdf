/**
 * Everything the extension tells Copilot: instructions, the passage and page for
 * inline questions, and for @pdf the document's text and comments. Pure
 * functions, so the prompts read and test easily.
 */
import type { Annot } from "../pdf/model";

export type AskAction = "explain" | "summarize" | "define" | "ask";
export type ChatCommand = "summarize" | "explain" | "comments";

/** What only the viewer knows: the text, the page in view, the selection. */
export interface DocContext {
  /** Text of each page. */
  pages: string[];
  /** 1-based page in view. */
  page: number;
  selection?: { text: string; page: number };
  /** Text under each text-markup annotation, by annotation id. */
  marks: Record<string, string>;
}

const SYSTEM = [
  "You help someone read a PDF (often a research paper) in VS Code.",
  "Answer in Markdown; write mathematics as LaTeX between single dollar signs, like $x^2$.",
  "Rely on the document text given. If it does not contain the answer, say so before using general knowledge.",
].join(" ");

export const QUICK_ASKS: Record<Exclude<AskAction, "ask">, string> = {
  explain: "Explain the selected passage in plain words, in the context of the document. Keep it short.",
  summarize: "Summarize the selected passage in two or three sentences.",
  define: "Define the technical terms, symbols and notation used in the selected passage, as a short list.",
};

export const CHAT_COMMANDS: Record<ChatCommand, string> = {
  summarize: "Summarize the document: its question, approach, main results and limitations, in short sections.",
  explain: "Explain the selected passage in plain words, in the context of the document.",
  comments:
    "Go through the comments on this document (highlights, notes, drawings and their replies). Group them by theme, say what each one asks for or points out, and list the ones that look unresolved.",
};

/** At most `max` characters, cut at a word where possible. */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const space = text.lastIndexOf(" ", max);
  return `${text.slice(0, space > max * 0.8 ? space : max)} […]`;
}

const quoted = (label: string, text: string) => `${label}:\n"""\n${text}\n"""`;

/** An inline question about a selected passage (the quick-action bar's "Ask Copilot"). */
export function passagePrompt(request: { action: AskAction; question?: string; selection: string; pageText: string; page: number; fileName: string }): string {
  const task = request.action === "ask" ? `Question about the selected passage: ${request.question ?? ""}` : QUICK_ASKS[request.action];
  return [
    SYSTEM,
    `Document: ${request.fileName}, page ${request.page}.`,
    quoted("Text of that page", clip(request.pageText, 12_000)),
    quoted("Selected passage", clip(request.selection, 4_000)),
    task,
  ].join("\n\n");
}

/** The document's text by page within a character budget (pages nearest the one in view first). */
export function pageTexts(context: DocContext, budget: number): string {
  const order = context.pages.map((_, i) => i).sort((a, b) => Math.abs(a + 1 - context.page) - Math.abs(b + 1 - context.page) || a - b);
  const kept = new Set<number>();
  let used = 0;
  for (const i of order) {
    const size = context.pages[i]!.length + 20;
    if (used + size <= budget) {
      kept.add(i);
      used += size;
    }
  }
  const parts = context.pages.flatMap((text, i) => (kept.has(i) ? [`--- Page ${i + 1} ---\n${text}`] : []));
  const left = context.pages.length - kept.size;
  return left ? `${parts.join("\n\n")}\n\n[${left} more page(s) left out: too long]` : parts.join("\n\n");
}

/** Comment threads as a readable list: page, kind, author, status, marked text, comment, replies. */
export function notesDigest(annotations: readonly Annot[], marks: Record<string, string>): string {
  const byId = new Map(annotations.map((a) => [a.id, a]));
  const threadRoot = (a: Annot): Annot => {
    const seen = new Set<string>();
    let current = a;
    while (current.replyTo && byId.has(current.replyTo) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.replyTo)!;
    }
    return current;
  };
  const repliesBy = new Map<string, Annot[]>();
  for (const a of annotations.filter((x) => x.replyTo)) {
    const root = threadRoot(a);
    repliesBy.set(root.id, [...(repliesBy.get(root.id) ?? []), a]);
  }
  const lines: string[] = [];
  for (const root of annotations.filter((a) => !a.replyTo)) {
    const children = repliesBy.get(root.id) ?? [];
    const replies = children.filter((c) => !c.state && c.contents.trim());
    const status = children.filter((c) => c.state?.model === "Review").at(-1)?.state?.value;
    const mark = marks[root.id];
    if (!root.contents.trim() && !replies.length && !mark) {
      continue;
    }
    const head = [`p. ${root.page + 1}`, root.subject ?? root.kind, root.author && `by ${root.author}`, status && status !== "None" && `[${status}]`].filter(Boolean).join(", ");
    lines.push(`- ${head}${mark ? ` on "${clip(mark, 300)}"` : ""}${root.contents.trim() ? `: ${root.contents.trim()}` : ""}`);
    for (const reply of replies) {
      lines.push(`  - reply by ${reply.author || "unknown"}: ${reply.contents.trim()}`);
    }
  }
  return lines.length ? lines.join("\n") : "(no comments)";
}

/** A question to @pdf, with the document, its comments and the selection as context. */
export function chatBody(request: { command?: string; prompt: string; fileName: string; context: DocContext; annotations: readonly Annot[]; budget: number }): string {
  const command = request.command && request.command in CHAT_COMMANDS ? CHAT_COMMANDS[request.command as ChatCommand] : undefined;
  const { selection } = request.context;
  const parts = [SYSTEM, `Document: ${request.fileName} (${request.context.pages.length} pages; page ${request.context.page} is in view).`];
  if (selection) {
    parts.push(quoted(`Selected passage (page ${selection.page})`, clip(selection.text, 4_000)));
  }
  parts.push(`Comments:\n${notesDigest(request.annotations, request.context.marks)}`);
  parts.push(quoted("Document text", pageTexts(request.context, request.budget)));
  parts.push([command, request.prompt.trim()].filter(Boolean).join("\n\n") || CHAT_COMMANDS.summarize);
  return parts.join("\n\n");
}
