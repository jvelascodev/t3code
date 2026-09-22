import type { AssistantAction, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useRef, useState } from "react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { assistants } from "../state/assistants";
import { useEnvironmentQuery } from "../state/query";
import { useAgentChatNavigation } from "./useAgentChatNavigation";

export function useAgentActions(environmentId: EnvironmentId, onNavigated?: () => void) {
  const query = useEnvironmentQuery(assistants.list({ environmentId, input: {} }));
  const navigation = useAgentChatNavigation(environmentId, onNavigated);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const { refresh } = query;
  const { openChat } = navigation;
  const act = useCallback(
    async (action: AssistantAction, open = false) => {
      if (busy.current) return false;
      busy.current = true;
      setPending(true);
      setError(null);
      try {
        const result = await runAtomCommand(appAtomRegistry, assistants.act, {
          environmentId,
          input: action,
        });
        if (result._tag !== "Success") {
          const cause = Cause.squash(result.cause);
          setError(cause instanceof Error ? cause.message : "Could not update agent. Try again.");
          return false;
        }
        refresh();
        if (open && result.value.threadId) openChat(result.value.threadId);
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not update agent. Try again.");
        return false;
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [environmentId, refresh, openChat],
  );
  return { query, act, pending: pending || navigation.isOpening, error: error ?? navigation.error };
}
