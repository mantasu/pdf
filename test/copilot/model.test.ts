import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode"));

import { CancellationTokenSource, ConfigurationTarget, LanguageModelError, configuration, fakeModel, languageModels, lm, quickPick, resetMock, shownWarnings, window, workspace } from "../__mocks__/vscode";
import { NO_CHAT, askChat, chooseModel, friendlyError, pickModel } from "../../src/copilot/model";

const claude = () => fakeModel(["from Claude"], 64_000, { id: "claude-x", name: "Claude X", family: "claude", vendor: "anthropic" });

beforeEach(() => resetMock());

describe("asking Copilot", () => {
  test("friendlyError covers each LanguageModelError code", () => {
    expect(friendlyError(LanguageModelError.NoPermissions())).toMatch(/may not use this language model yet/u);
    expect(friendlyError(LanguageModelError.Blocked())).toBe("The language model declined this request.");
    expect(friendlyError(LanguageModelError.NotFound())).toBe(NO_CHAT);
    expect(friendlyError(new LanguageModelError("rate limited", "Other"))).toBe("rate limited");
    expect(friendlyError(new Error("boom"))).toBe("boom"); // non-model errors pass through
    expect(friendlyError("plain")).toBe("plain"); // even non-errors
  });

  test("askChat streams chunks from the first copilot model", async () => {
    const model = fakeModel(["Hel", "lo"]);
    languageModels.push(model);
    const chunks: string[] = [];
    await askChat("prompt", new CancellationTokenSource().token as never, (text) => chunks.push(text));
    expect(chunks).toEqual(["Hel", "lo"]);
    expect(lm.selectChatModels).toHaveBeenCalledWith();
    expect(model.sendRequest.mock.calls[0]![0]).toEqual([expect.objectContaining({ role: "user", content: "prompt" })]);
  });

  test("askChat rejects with a friendly message when Copilot is absent or refuses", async () => {
    const token = new CancellationTokenSource().token as never;
    await expect(askChat("p", token, () => undefined)).rejects.toThrow(NO_CHAT);
    languageModels.push(fakeModel(LanguageModelError.Blocked()));
    await expect(askChat("p", token, () => undefined)).rejects.toThrow("The language model declined this request.");
  });

  test("chooseModel takes the setting's model (id, name or family, any case), else a Copilot one, else any", async () => {
    const [other, copilot] = [claude(), fakeModel([])];
    languageModels.push(other, copilot);
    expect(await chooseModel()).toBe(copilot);
    expect(await chooseModel(" CLAUDE X ")).toBe(other);
    expect(await chooseModel("claude-x")).toBe(other);
    expect(await chooseModel("Claude")).toBe(other);
    expect(await chooseModel("unknown")).toBe(copilot);
    languageModels.splice(1);
    expect(await chooseModel()).toBe(other); // no Copilot model: whatever there is
  });

  test("askChat asks the preferred model", async () => {
    languageModels.push(fakeModel(["from Copilot"]), claude());
    const chunks: string[] = [];
    await askChat("prompt", new CancellationTokenSource().token as never, (text) => chunks.push(text), "claude-x");
    expect(chunks).toEqual(["from Claude"]);
  });

  test("pickModel lists every model and saves the choice to the user settings", async () => {
    await pickModel();
    expect(shownWarnings).toEqual([NO_CHAT]); // nothing to pick from
    languageModels.push(fakeModel([]), claude());
    quickPick.choose = (items) => items[2];
    await pickModel();
    expect(window.showQuickPick.mock.calls[0]![0]).toEqual([
      { label: "Automatic", description: "a Copilot model", id: "", picked: true },
      { label: "GPT X", description: "copilot · gpt", id: "gpt-x", picked: false },
      { label: "Claude X", description: "anthropic · claude", id: "claude-x", picked: false },
    ]);
    expect(configuration.get("copilot.model")).toBe("claude-x");
    const settings = workspace.getConfiguration.mock.results.at(-1)!.value as { update: ReturnType<typeof vi.fn> };
    expect(settings.update).toHaveBeenCalledWith("copilot.model", "claude-x", ConfigurationTarget.Global);
    // The current choice is marked; dismissing the list changes nothing.
    quickPick.choose = () => undefined;
    await pickModel();
    expect((window.showQuickPick.mock.calls[1]![0] as Array<{ picked: boolean }>).map((item) => item.picked)).toEqual([false, false, true]);
    expect(configuration.get("copilot.model")).toBe("claude-x");
  });
});
