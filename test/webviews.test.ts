import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("./__mocks__/vscode"));

import { Uri } from "vscode";
import { WebviewCollection } from "../src/webviews";

interface FakePanel {
  posted: unknown[];
  onDidDispose: (listener: () => void) => { dispose: () => void };
  webview: { postMessage: (m: unknown) => Promise<boolean> };
  dispose: () => void;
}

function fake(): FakePanel {
  let listener: (() => void) | undefined;
  const view: FakePanel = {
    posted: [],
    onDidDispose: (l) => {
      listener = l;
      return { dispose: vi.fn() };
    },
    webview: {
      postMessage: async (m) => {
        view.posted.push(m);
        return true;
      },
    },
    dispose: () => listener?.(),
  };
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WebviewCollection", () => {
  test("posts to all panels of a document", () => {
    const collection = new WebviewCollection();
    const uri = Uri.file("/a.pdf");
    const other = Uri.file("/b.pdf");
    const first = fake();
    const second = fake();
    const third = fake();
    collection.add(uri, first as never);
    collection.add(uri, second as never);
    collection.add(other, third as never);

    collection.postMessage(uri, { type: "reload" });
    expect(first.posted).toEqual([{ type: "reload" }]);
    expect(second.posted).toEqual([{ type: "reload" }]);
    expect(third.posted).toEqual([]);
  });

  test("removes webviews when disposed", () => {
    const collection = new WebviewCollection();
    const uri = Uri.file("/a.pdf");
    const view = fake();
    collection.add(uri, view as never);
    view.dispose();
    collection.postMessage(uri, { type: "reload" });
    expect(view.posted).toHaveLength(0);
    expect([...collection.get(uri)]).toHaveLength(0);
  });

  test("keeps sibling panels alive when one of several is disposed", () => {
    const collection = new WebviewCollection();
    const uri = Uri.file("/a.pdf");
    const first = fake();
    const second = fake();
    collection.add(uri, first as never);
    collection.add(uri, second as never);
    first.dispose();
    collection.postMessage(uri, { type: "reload" });
    expect(first.posted).toHaveLength(0);
    expect(second.posted).toEqual([{ type: "reload" }]);
    expect([...collection.get(uri)]).toEqual([second]);
  });

  test("get returns empty for unknown documents", () => {
    const collection = new WebviewCollection();
    expect([...collection.get(Uri.file("/missing.pdf"))]).toHaveLength(0);
  });
});
