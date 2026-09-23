import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { Route } from "./_chat.assistants";
const mocks = vi.hoisted(() => ({ connected: false, act: vi.fn(), setDialog: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: unknown }) => ({
    ...options,
    useSearch: () => ({}),
  }),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "environment", label: "Test" }] }),
  useEnvironment: () => ({ connection: { phase: mocks.connected ? "connected" : "connecting" } }),
}));
vi.mock("../components/agents/AgentManagement", () => ({
  useAgentManagement: () => ({
    act: mocks.act,
    setDialog: mocks.setDialog,
    pending: false,
    error: null,
    dialogs: null,
  }),
}));
vi.mock("../components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => children,
  SidebarTrigger: () => null,
}));
vi.mock("../components/WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../env", () => ({ isElectron: false }));
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.connected = false;
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});
it("waits for the environment connection before opening main, and does not open twice on rerender", async () => {
  // The real router exposes component through its options; the mock keeps that shape below.
  const Page = (Route as unknown as { component: () => ReactNode }).component;
  await act(() => {
    renderer = create(<Page />);
  });
  expect(mocks.act).not.toHaveBeenCalled();
  mocks.connected = true;
  await act(() => renderer.update(<Page />));
  expect(mocks.act).toHaveBeenCalledExactlyOnceWith({ type: "open-main" }, true);
  await act(() => renderer.update(<Page />));
  expect(mocks.act).toHaveBeenCalledOnce();
});
