import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("vscode", async () => await import("../__mocks__/vscode"));

import { EventEmitter } from "../__mocks__/vscode";
import { ViewLink, asBytes } from "../../src/editor/session";

function stubPanel() {
  const received = new EventEmitter<unknown>();
  const posted: unknown[] = [];
  const panel = {
    webview: {
      onDidReceiveMessage: received.event,
      postMessage: vi.fn(async (message: unknown) => {
        posted.push(message);
        return true;
      }),
    },
  };
  return { panel, posted, receive: received.fire };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("asBytes", () => {
  test("normalizes typed arrays and buffers", () => {
    const bytes = new Uint8Array([1, 2]);
    expect(asBytes(bytes)).toBe(bytes);
    expect(asBytes(bytes.buffer)).toEqual(bytes);
    expect(asBytes("nope")).toBeUndefined();
  });
});

describe("ViewLink", () => {
  let harness: ReturnType<typeof stubPanel>;
  let onMessage: ReturnType<typeof vi.fn>;
  let session: ViewLink;

  beforeEach(() => {
    harness = stubPanel();
    onMessage = vi.fn();
    session = new ViewLink(harness.panel as never, onMessage);
  });

  test("forwards protocol messages and ignores anything else", () => {
    harness.receive({ type: "ready" });
    harness.receive("garbage");
    harness.receive({ kind: "no type" });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ type: "ready" });
  });

  test("posts messages to the webview", () => {
    session.post({ type: "annotations", annotations: [] });
    expect(harness.posted).toEqual([{ type: "annotations", annotations: [] }]);
  });

  test("resolves snapshots by request id, with form data", async () => {
    const pending = session.fetchState();
    const request = harness.posted[0] as { type: string; requestId: number };
    expect(request.type).toBe("request-snapshot");
    harness.receive({ type: "snapshot", requestId: 999, snapshot: { annotations: [] } });
    harness.receive({
      type: "snapshot",
      requestId: request.requestId,
      snapshot: { annotations: [{ id: "a" }], formData: new Uint8Array([7]).buffer },
    });
    await expect(pending).resolves.toEqual({ annotations: [{ id: "a" }], formData: new Uint8Array([7]) });
    expect(onMessage).not.toHaveBeenCalled();
  });

  test("omits absent form data", async () => {
    const pending = session.fetchState();
    const { requestId } = harness.posted[0] as { requestId: number };
    harness.receive({ type: "snapshot", requestId, snapshot: { annotations: [] } });
    await expect(pending).resolves.toEqual({ annotations: [] });
  });

  test("rejects invalid snapshots", async () => {
    const pending = session.fetchState();
    const { requestId } = harness.posted[0] as { requestId: number };
    harness.receive({ type: "snapshot", requestId, snapshot: { annotations: "no" } });
    await expect(pending).rejects.toThrow(/invalid response/u);
  });

  test("times out when the webview does not answer", async () => {
    vi.useFakeTimers();
    const pending = session.fetchState();
    const assertion = expect(pending).rejects.toThrow(/did not respond/u);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  test("dispose fails pending requests and stops listening", async () => {
    const pending = session.fetchState();
    session.dispose();
    await expect(pending).rejects.toThrow(/invalid response/u);
    harness.receive({ type: "ready" });
    expect(onMessage).not.toHaveBeenCalled();
  });
});
