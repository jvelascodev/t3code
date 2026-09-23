import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useAgentActions } from "./useAgentActions";

const mocks = vi.hoisted(() => ({ run: vi.fn(), refresh: vi.fn(), openChat: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: (...args: unknown[]) => mocks.run(...args),
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/assistants", () => ({ assistants: { list: vi.fn(), act: {} } }));
vi.mock("../state/query", () => ({ useEnvironmentQuery: () => ({ refresh: mocks.refresh }) }));
vi.mock("./useAgentChatNavigation", () => ({
  useAgentChatNavigation: () => ({ openChat: mocks.openChat, isOpening: false, error: null }),
}));
const environmentId = EnvironmentId.make("remote-environment");
const threadId = ThreadId.make("new-agent-thread");
let actions: ReturnType<typeof useAgentActions>;
let renderer: ReactTestRenderer;
function Probe() {
  const value = useAgentActions(environmentId);
  useLayoutEffect(() => {
    actions = value;
  });
  return null;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  await act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});
it("creates a conversation in the selected environment and waits through shared shell navigation", async () => {
  mocks.run.mockResolvedValue({ _tag: "Success", value: { threadId } });
  await act(async () => {
    expect(await actions.act({ type: "open", id: "chosen-agent", fresh: true }, true)).toBe(true);
  });
  expect(mocks.run.mock.calls[0]?.[2]).toEqual({
    environmentId,
    input: { type: "open", id: "chosen-agent", fresh: true },
  });
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(mocks.openChat).toHaveBeenCalledWith(threadId);
});
it("prevents duplicate mutations while a response is pending", async () => {
  let finish!: (value: unknown) => void;
  mocks.run.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    const first = actions.act({ type: "pause", id: "chosen-agent", paused: true });
    expect(await actions.act({ type: "delete", id: "chosen-agent" })).toBe(false);
    finish({ _tag: "Success", value: { threadId: null } });
    await first;
  });
  expect(mocks.run).toHaveBeenCalledOnce();
  expect(mocks.openChat).not.toHaveBeenCalled();
});
it("reports connection errors and allows a retry without navigating on failure", async () => {
  mocks.run.mockRejectedValueOnce(new Error("Environment disconnected"));
  await act(async () => {
    expect(await actions.act({ type: "open-main" }, true)).toBe(false);
  });
  expect(actions.error).toBe("Environment disconnected");
  expect(actions.pending).toBe(false);
  expect(mocks.openChat).not.toHaveBeenCalled();
  mocks.run.mockResolvedValue({ _tag: "Success", value: { threadId } });
  await act(async () => {
    expect(await actions.act({ type: "open-main" }, true)).toBe(true);
  });
  expect(actions.error).toBeNull();
  expect(mocks.openChat).toHaveBeenCalledWith(threadId);
});
