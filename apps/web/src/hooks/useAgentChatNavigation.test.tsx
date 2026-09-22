import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useAgentChatNavigation } from "./useAgentChatNavigation";

const state = vi.hoisted(() => ({
  shells: new Set<string>(),
  onNavigated: vi.fn(),
  navigate: vi.fn(async (_options: unknown) => {}),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../state/entities", () => ({
  useThreadShell: (ref: { environmentId: string; threadId: string } | null) =>
    ref && state.shells.has(`${ref.environmentId}/${ref.threadId}`) ? ref : null,
}));

const environmentId = EnvironmentId.make("project-environment");
const threadId = ThreadId.make("new-agent-conversation");
let renderer: ReactTestRenderer;
let navigation: ReturnType<typeof useAgentChatNavigation>;
function Probe() {
  const value = useAgentChatNavigation(environmentId, state.onNavigated);
  useLayoutEffect(() => {
    navigation = value;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.shells.clear();
  state.onNavigated.mockReset();
  state.navigate.mockReset();
  state.navigate.mockResolvedValue(undefined);
  await act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it.each(["/draft/existing-task", "/"])(
  "waits for a new conversation's shell instead of falling back to %s",
  async (fallback) => {
    let location = "/assistants";
    state.navigate.mockImplementation(async (options) => {
      const { params } = options as { params: { environmentId: string; threadId: string } };
      const key = `${params.environmentId}/${params.threadId}`;
      location = state.shells.has(key) ? `/${key}` : fallback;
    });
    await act(() => navigation.openChat(threadId));
    expect(navigation.isOpening).toBe(true);
    expect(location).toBe("/assistants");
    expect(state.navigate).not.toHaveBeenCalled();

    // A different environment's conversation must not release this navigation.
    state.shells.add(`other-environment/${threadId}`);
    await act(() => renderer.update(<Probe />));
    expect(state.navigate).not.toHaveBeenCalled();
    state.shells.add(`${environmentId}/${threadId}`);
    await act(() => renderer.update(<Probe />));
    expect(location).toBe(`/${environmentId}/${threadId}`);
    expect(navigation.isOpening).toBe(false);
    await act(() => renderer.update(<Probe />));
    expect(state.navigate).toHaveBeenCalledTimes(1);
  },
);

it("opens an existing conversation immediately and supports opening another", async () => {
  state.shells.add(`${environmentId}/${threadId}`);
  await act(() => navigation.openChat(threadId));
  expect(state.navigate).toHaveBeenCalledTimes(1);
  const next = ThreadId.make("next-agent-conversation");
  await act(() => navigation.openChat(next));
  expect(state.navigate).toHaveBeenCalledTimes(1);
  state.shells.add(`${environmentId}/${next}`);
  await act(() => renderer.update(<Probe />));
  expect(state.navigate).toHaveBeenLastCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: next },
  });
});

it("does not navigate after the user leaves the agents page", async () => {
  await act(() => navigation.openChat(threadId));
  await act(() => renderer.unmount());
  state.shells.add(`${environmentId}/${threadId}`);
  expect(state.navigate).not.toHaveBeenCalled();
});

it("releases pending state after a navigation failure so the user can retry", async () => {
  state.shells.add(`${environmentId}/${threadId}`);
  state.navigate.mockRejectedValueOnce(new Error("Navigation failed"));
  await act(() => navigation.openChat(threadId));
  expect(navigation.isOpening).toBe(false);
  expect(navigation.error).toContain("could not be opened");
  await act(() => navigation.openChat(threadId));
  expect(navigation.error).toBeNull();
  expect(state.navigate).toHaveBeenCalledTimes(2);
});

it("keeps its host open while waiting for shell and navigation completion", async () => {
  let finish!: () => void;
  state.navigate.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await act(() => navigation.openChat(threadId));
  expect(state.onNavigated).not.toHaveBeenCalled();
  state.shells.add(`${environmentId}/${threadId}`);
  await act(() => renderer.update(<Probe />));
  expect(state.onNavigated).not.toHaveBeenCalled();
  await act(async () => {
    finish();
  });
  expect(state.onNavigated).toHaveBeenCalledOnce();
});
it("does not close its host when navigation fails", async () => {
  state.shells.add(`${environmentId}/${threadId}`);
  state.navigate.mockRejectedValueOnce(new Error("Navigation failed"));
  await act(() => navigation.openChat(threadId));
  expect(state.onNavigated).not.toHaveBeenCalled();
  expect(navigation.error).toContain("could not be opened");
});
