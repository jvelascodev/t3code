import {
  AssistantAction,
  AssistantActionResult,
  AssistantError,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export const AssistantsToolkit = Toolkit.make(
  Tool.make("assistant_status", {
    description:
      "Read your assistant's configuration, projects, up to 100 recent active threads, delegated tasks, provider choices, and observed PR status. Main assistants can see all projects. Only available inside assistant conversations.",
    success: Schema.String,
    failure: AssistantError,
    dependencies: [McpInvocationContext],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false),
  Tool.make("assistant_action", {
    description:
      "Create or edit project assistants, open a conversation, delegate or resume work, stop a task, pause/resume coordination, save durable memory, or change the default provider. Omit projectId when saving a new assistant to create a general-purpose project without Git. Use IDs from assistant_status. Codex is the initial default. At most three delegated tasks run per assistant. Merge and deploy permissions are not granted by delegation.",
    parameters: Schema.Struct({ action: Schema.toType(AssistantAction) }),
    success: AssistantActionResult,
    failure: AssistantError,
    dependencies: [McpInvocationContext],
  }),
  Tool.make("assistant_thread", {
    description:
      "Read the last three turns and current PR evidence of a thread in your project. Inspect results before declaring a delegated task successful.",
    parameters: Schema.Struct({ threadId: ThreadId }),
    success: Schema.String,
    failure: AssistantError,
    dependencies: [McpInvocationContext],
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false),
);
