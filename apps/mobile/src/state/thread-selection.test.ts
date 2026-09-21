import {
  EnvironmentId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { threadDetailToShell } from "./thread-selection";

const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

it.each(["agent", "task", undefined] as const)(
  "preserves %s workspace policy when only conversation detail is loaded",
  (conversationKind) => {
    const shell = threadDetailToShell(EnvironmentId.make("environment"), {
      ...baseThread,
      conversationKind,
    });
    expect(shell.conversationKind).toBe(conversationKind ?? "task");
    expect(shell.conversationKind !== "agent").toBe(conversationKind !== "agent");
  },
);
