import {
  EnvironmentId,
  ThreadId,
  type PreviewEvent,
  type PreviewListResult,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act } from "react";
import { create } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  reconcilePreviewServerSessions,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import { appAtomRegistry, AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import { usePreviewSession } from "./usePreviewSession";

vi.mock("~/state/preview", () => ({
  previewEnvironment: { list: () => sessionsAtom, events: () => eventsAtom },
}));

const threadRef = {
  environmentId: EnvironmentId.make("background-preview"),
  threadId: ThreadId.make("background-thread"),
};
const snapshot: PreviewSessionSnapshot = {
  threadId: threadRef.threadId,
  tabId: "background-tab",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-09-22T00:00:00.000Z",
};
const sessionsAtom = Atom.make<AsyncResult.AsyncResult<PreviewListResult, Error>>(
  AsyncResult.initial(false),
);
const eventsAtom = Atom.make<AsyncResult.AsyncResult<PreviewEvent, Error>>(
  AsyncResult.initial(false),
);

function BackgroundSession() {
  usePreviewSession(threadRef);
  return null;
}

it("removes background tabs on a close event and on reconciliation after reconnect", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetPreviewStateForTests();
  const subscriptions = vi.spyOn(appAtomRegistry, "subscribe");
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(() => {
      renderer = create(
        <AppAtomRegistryProvider>
          <BackgroundSession />
          <BackgroundSession />
        </AppAtomRegistryProvider>,
      );
    });
    reconcilePreviewServerSessions(threadRef, { sessions: [], serverEpoch: "server", revision: 0 });
    applyPreviewServerSnapshot(threadRef, snapshot);
    await act(() => {
      appAtomRegistry.set(
        sessionsAtom,
        AsyncResult.waiting(
          AsyncResult.success({
            sessions: [],
            serverEpoch: "server",
            revision: 0,
          }),
        ),
      );
    });
    expect(readThreadPreviewState(threadRef).sessions[snapshot.tabId]).toEqual(snapshot);
    for (const closeWhileDisconnected of [false, true]) {
      await act(() => {
        appAtomRegistry.set(
          sessionsAtom,
          AsyncResult.success({
            sessions: [snapshot],
            serverEpoch: "server",
            revision: closeWhileDisconnected ? 3 : 1,
          }),
        );
      });
      expect(readThreadPreviewState(threadRef).sessions[snapshot.tabId]).toEqual(snapshot);
      await act(() => {
        if (closeWhileDisconnected) {
          appAtomRegistry.set(
            sessionsAtom,
            AsyncResult.success({
              sessions: [],
              serverEpoch: "server",
              revision: 4,
            }),
          );
        } else {
          appAtomRegistry.set(
            eventsAtom,
            AsyncResult.success({
              type: "closed",
              threadId: threadRef.threadId,
              tabId: snapshot.tabId,
              serverEpoch: "server",
              revision: 2,
              createdAt: snapshot.updatedAt,
            }),
          );
        }
      });
      expect(readThreadPreviewState(threadRef).sessions).toEqual({});
      expect(readThreadPreviewState(threadRef).snapshot).toBeNull();
    }
    expect(subscriptions.mock.calls.filter(([atom]) => atom === sessionsAtom)).toHaveLength(1);
    expect(subscriptions.mock.calls.filter(([atom]) => atom === eventsAtom)).toHaveLength(1);
  } finally {
    await act(() => renderer?.unmount());
    resetPreviewStateForTests();
    vi.unstubAllGlobals();
    subscriptions.mockRestore();
  }
});
