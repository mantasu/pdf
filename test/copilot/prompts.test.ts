import { describe, expect, test } from "vitest";
import { QUICK_ASKS, CHAT_COMMANDS, chatBody, notesDigest, pageTexts, passagePrompt, clip } from "../../src/copilot/prompts";
import type { Annot } from "../../src/pdf/model";

const sticky = (id: string, fields: Partial<Annot> = {}): Annot => ({ id, kind: "note", subtype: "Text", page: 0, rect: [0, 0, 24, 24], opacity: 1, contents: "", author: "Ivy", ...fields });

describe("prompts", () => {
  test("clip breaks long text on word boundaries", () => {
    expect(clip("short", 10)).toBe("short");
    expect(clip("aaaa bbbb cccc", 11)).toBe("aaaa bbbb […]");
    expect(clip("abcdefghijklmnop", 5)).toBe("abcde […]");
  });

  test("inline prompts include page, passage and task", () => {
    const base = { selection: "E = mc^2", pageText: "Page text", page: 3, fileName: "draft.pdf" };
    const explain = passagePrompt({ ...base, action: "explain" });
    expect(explain).toContain("Document: draft.pdf, page 3.");
    expect(explain).toContain('Selected passage:\n"""\nE = mc^2\n"""');
    expect(explain).toContain(QUICK_ASKS.explain);
    expect(explain).toContain("LaTeX between single dollar signs");
    expect(passagePrompt({ ...base, action: "ask", question: "Why?" })).toContain("Question about the selected passage: Why?");
    expect(passagePrompt({ ...base, action: "ask" })).toMatch(/Question about the selected passage: $/u);
  });

  test("page budget favors pages near the one in view", () => {
    const context = { pages: ["one", "two", "three", "x".repeat(100)], page: 2, marks: {} };
    expect(pageTexts(context, 10_000)).toBe(`--- Page 1 ---\none\n\n--- Page 2 ---\ntwo\n\n--- Page 3 ---\nthree\n\n--- Page 4 ---\n${"x".repeat(100)}`);
    const short = pageTexts(context, 70);
    expect(short).toContain("--- Page 2 ---");
    expect(short).not.toContain("--- Page 4 ---");
    expect(short).toMatch(/\[2 more page\(s\) left out: too long\]$/u);
  });

  test("threads collapse into a digest", () => {
    const annotations: Annot[] = [
      sticky("h", { kind: "highlight", subtype: "Highlight", subject: "Highlight", page: 1, contents: "Check this", author: "Ben" }),
      sticky("r1", { replyTo: "h", contents: "Agreed", author: "" }),
      sticky("r2", { replyTo: "r1", contents: "Done" }),
      sticky("s", { replyTo: "h", state: { model: "Review", value: "Accepted" } }),
      sticky("u", { kind: "underline", subtype: "Underline", author: "" }),
      sticky("n", { contents: "  " }),
      sticky("none", { contents: "Open", }),
      sticky("sn", { replyTo: "none", state: { model: "Review", value: "None" } }),
      sticky("loop1", { replyTo: "loop2", contents: "cycle" }),
      sticky("loop2", { replyTo: "loop1" }),
    ];
    expect(notesDigest(annotations, { h: "the marked words", u: "underlined" })).toBe(
      [
        '- p. 2, Highlight, by Ben, [Accepted] on "the marked words": Check this',
        "  - reply by unknown: Agreed",
        "  - reply by Ivy: Done",
        '- p. 1, underline on "underlined"',
        "- p. 1, note, by Ivy: Open",
      ].join("\n"),
    );
    expect(notesDigest([], {})).toBe("(no comments)");
  });

  test("chat prompts combine selection, comments, text and question", () => {
    const context = { pages: ["Intro"], page: 1, marks: {}, selection: { text: "a passage", page: 1 } };
    const request = { fileName: "draft.pdf", context, annotations: [sticky("a", { contents: "Hi" })], budget: 1000 };
    const prompt = chatBody({ ...request, command: "summarize", prompt: "focus on results" });
    expect(prompt).toContain("Document: draft.pdf (1 pages; page 1 is in view).");
    expect(prompt).toContain('Selected passage (page 1):\n"""\na passage\n"""');
    expect(prompt).toContain("Comments:\n- p. 1, note, by Ivy: Hi");
    expect(prompt).toContain("--- Page 1 ---\nIntro");
    expect(prompt.endsWith(`${CHAT_COMMANDS.summarize}\n\nfocus on results`)).toBe(true);
    expect(chatBody({ ...request, context: { ...context, selection: undefined }, command: "unknown", prompt: "Hello?" })).toMatch(/\n\nHello\?$/u);
    expect(chatBody({ ...request, prompt: "  " }).endsWith(CHAT_COMMANDS.summarize)).toBe(true);
  });
});
