import type { AssistantProfile, ThreadId } from "@t3tools/contracts";

export function agentConversationIds(agent: AssistantProfile): ThreadId[] {
  return [
    ...new Set([
      ...(agent.threadId ? [agent.threadId] : []),
      ...(agent.conversationThreadIds ?? []),
    ]),
  ];
}

/** Callers supply profiles from the active environment only. */
export function agentForConversation(profiles: readonly AssistantProfile[], threadId: ThreadId) {
  return profiles.find((profile) => agentConversationIds(profile).includes(threadId));
}
