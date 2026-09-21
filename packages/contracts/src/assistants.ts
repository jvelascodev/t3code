import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, OrchestrationThreadShell } from "./orchestration.ts";

export const AssistantProfile = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  kind: Schema.Literals(["main", "project"]),
  projectLinked: Schema.optionalKey(Schema.Boolean),
  name: TrimmedNonEmptyString,
  instructions: Schema.String.check(Schema.isMaxLength(16000)),
  memory: Schema.String.check(Schema.isMaxLength(24000)),
  handoff: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  modelSelection: ModelSelection,
  threadId: Schema.NullOr(ThreadId),
  conversationThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  paused: Schema.Boolean,
});
export type AssistantProfile = typeof AssistantProfile.Type;

export const AssistantTask = Schema.Struct({
  assistantId: Schema.String,
  threadId: ThreadId,
  title: Schema.String,
  summary: Schema.String,
  stopped: Schema.Boolean,
  thread: Schema.NullOr(OrchestrationThreadShell),
});
export type AssistantTask = typeof AssistantTask.Type;

export const AssistantsSnapshot = Schema.Struct({
  assistants: Schema.Array(AssistantProfile),
  tasks: Schema.Array(AssistantTask),
  defaultModelSelection: ModelSelection,
});
export type AssistantsSnapshot = typeof AssistantsSnapshot.Type;

export const AssistantAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("save"),
    id: Schema.optionalKey(TrimmedNonEmptyString),
    projectId: Schema.optionalKey(ProjectId),
    name: TrimmedNonEmptyString,
    instructions: Schema.String.check(Schema.isMaxLength(16000)),
    modelSelection: Schema.optionalKey(ModelSelection),
  }),
  Schema.Struct({ type: Schema.Literal("open-main") }),
  Schema.Struct({
    type: Schema.Literal("open"),
    id: TrimmedNonEmptyString,
    fresh: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("pause"),
    id: TrimmedNonEmptyString,
    paused: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("delete"), id: TrimmedNonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("remember"),
    id: TrimmedNonEmptyString,
    memory: Schema.String.check(Schema.isMaxLength(24000)),
  }),
  Schema.Struct({ type: Schema.Literal("set-default"), modelSelection: ModelSelection }),
  Schema.Struct({
    type: Schema.Literal("delegate"),
    id: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
    prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(32000)),
    threadId: Schema.optionalKey(ThreadId),
    modelSelection: Schema.optionalKey(ModelSelection),
  }),
  Schema.Struct({ type: Schema.Literal("stop-task"), threadId: ThreadId }),
]);
export type AssistantAction = typeof AssistantAction.Type;
export const AssistantActionResult = Schema.Struct({
  assistant: Schema.NullOr(AssistantProfile),
  threadId: Schema.NullOr(ThreadId),
});
export type AssistantActionResult = typeof AssistantActionResult.Type;

export class AssistantError extends Schema.TaggedError<AssistantError>()("AssistantError", {
  message: Schema.String,
}) {}

/** Providers whose adapters connect the scoped T3 coordination tools. */
export function supportsAgentCoordination(driver: string | undefined): boolean {
  return (
    driver !== undefined &&
    ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"].includes(driver)
  );
}

export const AGENT_CHAT_ONLY_NOTICE =
  "This provider supports chat and delegated task execution, but cannot create agents or coordinate tasks from chat. Choose a provider with coordination support for that work.";
