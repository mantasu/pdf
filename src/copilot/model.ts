/**
 * Copilot access through VS Code's Language Model API: the user's own subscription, or a model added
 * with their own key (Anthropic, OpenAI, ...), never a key of ours. VS Code asks once whether the
 * extension may use a model. The `pdf-editor.copilot.model` setting picks one; else a Copilot model is used.
 */
import { CancellationToken, ConfigurationTarget, LanguageModelChat, LanguageModelChatMessage, LanguageModelError, lm, window, workspace } from "vscode";

export const NO_CHAT = "No language model is available. Install GitHub Copilot Chat and sign in, or add a model with your own API key in the chat model picker (Manage Models), then try again.";
export const MODEL_SETTING = "copilot.model";

/** A friendly reason for a failed request. */
export function friendlyError(error: unknown): string {
  if (error instanceof LanguageModelError) {
    switch (error.code) {
      case LanguageModelError.NoPermissions.name:
        return "PDF Viewer may not use this language model yet: allow it when VS Code asks (or under Accounts > Manage Language Model Access).";
      case LanguageModelError.Blocked.name:
        return "The language model declined this request.";
      case LanguageModelError.NotFound.name:
        return NO_CHAT;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** Send one prompt, streaming the answer's text. */
export async function streamText(model: LanguageModelChat, messages: LanguageModelChatMessage[], token: CancellationToken, onText: (text: string) => void): Promise<void> {
  const response = await model.sendRequest(messages, { justification: "PDF Viewer sends the PDF text you ask about to the language model." }, token);
  for await (const text of response.text) {
    onText(text);
  }
}

const matches = (model: LanguageModelChat, wanted: string) => [model.id, model.name, model.family].some((field) => field.toLowerCase() === wanted);

/** The model named by `preferred` (its id, name or family, any case), else the first Copilot model, else any model. */
export async function chooseModel(preferred = ""): Promise<LanguageModelChat | undefined> {
  const models = await lm.selectChatModels();
  const wanted = preferred.trim().toLowerCase();
  return (wanted ? models.find((model) => matches(model, wanted)) : undefined) ?? models.find((model) => model.vendor === "copilot") ?? models[0];
}

/** Ask the chosen model one question; failures throw a friendly message. */
export async function askChat(prompt: string, token: CancellationToken, onText: (text: string) => void, preferred = ""): Promise<void> {
  const model = await chooseModel(preferred);
  if (!model) {
    throw new Error(NO_CHAT);
  }
  try {
    await streamText(model, [LanguageModelChatMessage.User(prompt)], token, onText);
  } catch (error) {
    throw new Error(friendlyError(error));
  }
}

/** "PDF: Choose Copilot Model…": every model VS Code offers, saved to the user's `pdf-editor.copilot.model`. */
export async function pickModel(): Promise<void> {
  const models = await lm.selectChatModels();
  if (!models.length) {
    await window.showWarningMessage(NO_CHAT);
    return;
  }
  const settings = workspace.getConfiguration("pdf-editor");
  const current = settings.get<string>(MODEL_SETTING, "").trim().toLowerCase();
  const items = [
    { label: "Automatic", description: "a Copilot model", id: "", picked: !current },
    ...models.map((model) => ({ label: model.name, description: `${model.vendor} · ${model.family}`, id: model.id, picked: matches(model, current) })),
  ];
  const choice = await window.showQuickPick(items, { title: "Model for Ask Copilot in PDFs", placeHolder: "The @pdf chat participant uses the model picked in the chat instead" });
  if (choice) {
    await settings.update(MODEL_SETTING, choice.id, ConfigurationTarget.Global);
  }
}
