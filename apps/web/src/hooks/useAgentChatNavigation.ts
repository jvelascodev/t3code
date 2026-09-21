import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useThreadShell } from "../state/entities";

export function useAgentChatNavigation(environmentId: EnvironmentId) {
  const navigate = useNavigate();
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openChat = useCallback((id: ThreadId) => {
    setError(null);
    setThreadId(id);
  }, []);
  const shell = useThreadShell(threadId === null ? null : { environmentId, threadId });
  const ready = shell !== null;

  useEffect(() => {
    // An action response can arrive before its shell event. The chat route
    // treats an unknown thread as missing, so wait for the matching shell.
    if (threadId === null || !ready) return;
    let cancelled = false;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    })
      .catch(() => {
        if (!cancelled) setError("The conversation could not be opened. Try opening it again.");
      })
      .finally(() => {
        if (!cancelled) setThreadId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, navigate, ready, threadId]);

  return { openChat, isOpening: threadId !== null, error };
}
