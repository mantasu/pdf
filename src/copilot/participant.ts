/**
 * @pdf in Copilot Chat: questions about the PDF in the viewer, answered with its
 * text, selection and comments as context. /summarize, /explain (the selection)
 * and /comments are shortcuts.
 */
import { ChatContext, ChatRequest, ChatRequestTurn, ChatResponseMarkdownPart, ChatResponseStream, ChatResponseTurn, CancellationToken, Disposable, LanguageModelChatMessage, chat } from "vscode";
import type { Annot } from "../pdf/model";
import { friendlyError, streamText } from "./model";
import { type DocContext, chatBody } from "./prompts";

export const ASSISTANT = "pdf.assistant";

/** The open PDF as the chat participant needs it. */
export interface OpenDoc {
  fileName: string;
  context: DocContext;
  annotations: readonly Annot[];
}

/** Earlier @pdf turns of this conversation, so follow-ups work. */
export function chatHistory(context: ChatContext): LanguageModelChatMessage[] {
  return context.history.slice(-8).flatMap((turn) => {
    if (turn.participant !== ASSISTANT) {
      return [];
    }
    if (turn instanceof ChatRequestTurn) {
      return [LanguageModelChatMessage.User(`${turn.command ? `/${turn.command} ` : ""}${turn.prompt}`)];
    }
    const text = (turn as ChatResponseTurn).response.flatMap((part) => (part instanceof ChatResponseMarkdownPart ? [part.value.value] : [])).join("");
    return text ? [LanguageModelChatMessage.Assistant(text)] : [];
  });
}

export function makeHandler(openDoc: () => Promise<OpenDoc | undefined>) {
  return async (request: ChatRequest, context: ChatContext, stream: ChatResponseStream, token: CancellationToken): Promise<object> => {
    const doc = await openDoc().catch(() => undefined);
    if (!doc) {
      stream.markdown("Open a PDF first (any `.pdf` file in VS Code), then ask again.");
      return {};
    }
    if (request.command === "explain" && !doc.context.selection) {
      stream.markdown("Select a passage in the PDF first, then ask `@pdf /explain` again.");
      return {};
    }
    stream.progress(`Reading ${doc.fileName}…`);
    // Roughly three characters per token, leaving room for the answer.
    const budget = Math.max(8_000, (request.model.maxInputTokens - 4_000) * 3);
    const prompt = chatBody({ command: request.command, prompt: request.prompt, fileName: doc.fileName, context: doc.context, annotations: doc.annotations, budget });
    try {
      await streamText(request.model, [...chatHistory(context), LanguageModelChatMessage.User(prompt)], token, (text) => stream.markdown(text));
    } catch (error) {
      stream.markdown(`\n\n**Copilot could not answer:** ${friendlyError(error)}`);
    }
    return {};
  };
}

export function registerChat(openDoc: () => Promise<OpenDoc | undefined>): Disposable {
  return chat.createChatParticipant(ASSISTANT, makeHandler(openDoc));
}
