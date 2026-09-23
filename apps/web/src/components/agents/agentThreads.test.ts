import { ProjectId, ProviderInstanceId, ThreadId, type AssistantProfile } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { agentConversationIds, agentForConversation } from "./agentThreads";
const current = ThreadId.make("current");
const previous = ThreadId.make("previous");
const profile: AssistantProfile = {
  id: "agent",
  kind: "project",
  projectId: ProjectId.make("workspace"),
  projectLinked: false,
  name: "Operations",
  instructions: "",
  memory: "",
  handoff: "",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
  paused: false,
  threadId: current,
  conversationThreadIds: [previous, current, previous],
};
it("lists the current conversation once before historical conversations", () => {
  expect(agentConversationIds(profile)).toEqual([current, previous]);
});
it("recognizes historical standalone conversations without assigning unrelated task threads", () => {
  expect(agentForConversation([profile], previous)).toBe(profile);
  expect(agentForConversation([profile], ThreadId.make("delegated-task"))).toBeUndefined();
  expect(agentForConversation([], current)).toBeUndefined();
});
it("preserves history when the agent has no active conversation", () => {
  expect(
    agentConversationIds({ ...profile, threadId: null, conversationThreadIds: [previous] }),
  ).toEqual([previous]);
  expect(agentConversationIds({ ...profile, threadId: null, conversationThreadIds: [] })).toEqual(
    [],
  );
});
