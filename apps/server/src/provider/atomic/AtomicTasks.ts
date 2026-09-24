import { RuntimeTaskId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { AtomicFrame } from "./AtomicRpc.ts";

type TaskEvent =
  Extract<ProviderRuntimeEvent, { type: `task.${string}` }> extends infer E
    ? E extends ProviderRuntimeEvent
      ? Pick<E, "type" | "payload">
      : never
    : never;

const WorkflowRoot = Schema.Struct({
  rootRunId: Schema.String,
  state: Schema.String,
  reason: Schema.String,
  needsAttention: Schema.optional(Schema.Boolean),
});
const WorkflowActivity = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    availability: Schema.String,
    roots: Schema.optional(Schema.Array(WorkflowRoot)),
  }),
  Schema.Struct({ kind: Schema.Literal("changed"), root: WorkflowRoot }),
  Schema.Struct({ kind: Schema.Literal("removed"), rootRunId: Schema.String }),
]);
const WorkflowLifecycle = Schema.Struct({
  rootRunId: Schema.String,
  runId: Schema.String,
  target: Schema.Struct({
    kind: Schema.String,
    status: Schema.String,
    previousStatus: Schema.optional(Schema.String),
    runId: Schema.String,
    stageId: Schema.optional(Schema.String),
    stageName: Schema.optional(Schema.String),
    toolName: Schema.optional(Schema.String),
  }),
});
const ObserverMessage = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("activity"), frame: WorkflowActivity }),
  Schema.Struct({ kind: Schema.Literal("lifecycle"), event: WorkflowLifecycle }),
]);
const decodeObserver = Schema.decodeUnknownOption(Schema.fromJsonString(ObserverMessage));

const SubagentResult = Schema.Struct({
  agent: Schema.String,
  task: Schema.String,
  status: Schema.String,
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  finalOutput: Schema.optional(Schema.String),
  envelope: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.String),
  progress: Schema.optional(Schema.Unknown),
});
const SubagentDetails = Schema.Struct({
  runId: Schema.optional(Schema.String),
  results: Schema.Array(SubagentResult),
  progress: Schema.optional(Schema.Array(Schema.Unknown)),
});
const SubagentProgress = Schema.Struct({
  index: Schema.Int,
  status: Schema.String,
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  currentTool: Schema.optional(Schema.String),
  currentToolArgs: Schema.optional(Schema.String),
  recentTools: Schema.optional(
    Schema.Array(Schema.Struct({ tool: Schema.String, args: Schema.optional(Schema.String) })),
  ),
  recentOutput: Schema.optional(Schema.Array(Schema.String)),
  tokens: Schema.optional(Schema.Finite),
  toolCount: Schema.optional(Schema.Finite),
  durationMs: Schema.optional(Schema.Finite),
});
const decodeSubagentProgress = Schema.decodeUnknownOption(SubagentProgress);
const decodeWorkflowArgs = Schema.decodeUnknownOption(
  Schema.Struct({
    action: Schema.String,
    workflow: Schema.optional(Schema.String),
    workflowId: Schema.optional(Schema.String),
  }),
);
const decodeToolResult = Schema.decodeUnknownOption(
  Schema.Struct({
    details: Schema.optional(Schema.Unknown),
    content: Schema.optional(
      Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
    ),
  }),
);
const decodeRunText = Schema.decodeOption(
  Schema.fromJsonString(Schema.Struct({ runId: Schema.String })),
);
const decodeRunDetails = Schema.decodeUnknownOption(Schema.Struct({ runId: Schema.String }));
const decodeSubagentToolResult = Schema.decodeUnknownOption(
  Schema.Struct({ details: SubagentDetails }),
);

const workflowId = (runId: string) => RuntimeTaskId.make(`atomic:workflow:${runId}`);
// The :wf: segment groups members with their root run in both web and mobile.
const workflowMemberId = (rootRunId: string, runId: string, id: string) =>
  RuntimeTaskId.make(`atomic:workflow:${rootRunId}:wf:${runId}:${id}`);
const subagentId = (toolCallId: string, index: number) =>
  RuntimeTaskId.make(`atomic:subagent:${toolCallId}:${index}`);
const short = (value: string) => (value.length > 180 ? `${value.slice(0, 179)}…` : value);
const resultText = (value: string) => (value.length > 4096 ? `${value.slice(0, 4095)}…` : value);
const terminalWorkflowStatus = (status: string | undefined) =>
  status === "completed" || status === "failed" || status === "cancelled" || status === "killed";

function rootActivitySummary(root: typeof WorkflowRoot.Type): string | undefined {
  if (root.state === "working" && root.needsAttention)
    return "Running · input or intervention needed";
  if (root.reason === "awaiting_input") return "Waiting for input";
  if (root.reason === "manual_intervention") return "Needs intervention";
  if (root.reason === "stopping") return "Stopping";
  if (root.reason === "paused") return "Paused";
  if (root.reason === "retrying") return "Retrying";
  if (root.state === "working") return "Running";
  return undefined;
}

function workflowStatus(
  status: string,
): "pending" | "running" | "waiting" | "idle" | "completed" | "failed" | "cancelled" | undefined {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "awaiting_input":
    case "blocked":
      return "waiting";
    case "paused":
      return "idle";
    case "completed":
    case "skipped":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "killed":
      return "cancelled";
    default:
      return undefined;
  }
}

/** Converts Atomic's structured observations to the task lifecycle shared by clients. */
export class AtomicTasks {
  readonly #started = new Set<string>();
  readonly #terminal = new Set<string>();
  readonly #workflowNames = new Map<string, string>();
  readonly #toolNames = new Map<string, string>();
  readonly #observedRoots = new Set<string>();
  readonly #active = new Map<RuntimeTaskId, { description: string; taskType: string }>();
  readonly #failedTool = new Map<RuntimeTaskId, string>();
  #pendingNamedRun: string | undefined;

  /** A direct `/workflow name` command names the next new root run. */
  recordPrompt(input: string): void {
    this.#pendingNamedRun = undefined;
    const name = /^\/workflow\s+([\w-]+)(?:\s|$)/i.exec(input.trim())?.[1];
    if (
      !name ||
      /^(list|get|inputs|models|status|stages|stage|transcript|answer|pause|quit|resume|reload|dependency|connect|run)$/i.test(
        name,
      )
    )
      return;
    this.#pendingNamedRun = name;
  }

  /** A closing Atomic process can no longer report progress for its active tasks. */
  unavailable(): TaskEvent[] {
    const events: TaskEvent[] = [...this.#active].map(([taskId, task]) => ({
      type: "task.progress",
      payload: {
        taskId,
        description: task.description,
        summary: "Atomic activity unavailable",
        status: "idle",
        taskType: task.taskType,
      },
    }));
    this.#active.clear();
    this.#failedTool.clear();
    return events;
  }

  #unavailableMembers(rootRunId: string): TaskEvent[] {
    const prefix = `${workflowId(rootRunId)}:wf:`;
    const events: TaskEvent[] = [];
    for (const [taskId, task] of this.#active) {
      if (!taskId.startsWith(prefix)) continue;
      this.#active.delete(taskId);
      this.#failedTool.delete(taskId);
      events.push({
        type: "task.progress",
        payload: {
          taskId,
          description: task.description,
          summary: "Workflow activity unavailable",
          status: "idle",
          taskType: task.taskType,
        },
      });
    }
    return events;
  }

  #start(
    id: RuntimeTaskId,
    payload: Extract<TaskEvent, { type: "task.started" }>["payload"],
  ): TaskEvent[] {
    if (this.#started.has(id)) return [];
    this.#started.add(id);
    return [{ type: "task.started", payload }];
  }

  #status(
    id: RuntimeTaskId,
    status: ReturnType<typeof workflowStatus>,
    linkage: {
      title: string;
      taskType: string;
      parentAgentId?: string;
      workflowName?: string;
      runHandles?: { runId: string };
    },
    reactivated = false,
    rawStatus?: string,
  ): TaskEvent[] {
    if (!status || (this.#terminal.has(id) && !reactivated)) return [];
    if (reactivated) {
      this.#terminal.delete(id);
      this.#failedTool.delete(id);
    }
    const started = this.#start(id, { taskId: id, description: linkage.title, ...linkage });
    if (status === "completed" || status === "failed" || status === "cancelled") {
      this.#terminal.add(id);
      this.#active.delete(id);
      const summary =
        rawStatus === "skipped"
          ? "Skipped"
          : rawStatus === "killed"
            ? "Killed"
            : rawStatus === "cancelled"
              ? "Cancelled"
              : status === "failed"
                ? this.#failedTool.has(id)
                  ? `Failed; ${this.#failedTool.get(id)}`
                  : "Failed"
                : status === "cancelled"
                  ? "Stopped"
                  : "Completed";
      this.#failedTool.delete(id);
      return [
        ...started,
        {
          type: "task.completed",
          payload: {
            taskId: id,
            status: status === "cancelled" ? "stopped" : status,
            summary,
            ...linkage,
          },
        },
      ];
    }
    if (status === "idle") this.#active.delete(id);
    else this.#active.set(id, { description: linkage.title, taskType: linkage.taskType });
    return [...started, { type: "task.updated", payload: { taskId: id, status, ...linkage } }];
  }

  project(frame: AtomicFrame): TaskEvent[] {
    if (
      frame.type === "extension_ui_request" &&
      frame.method === "setWidget" &&
      frame.widgetKey === "t3-atomic-observer"
    ) {
      const decoded = decodeObserver(frame.widgetLines?.[0]);
      if (decoded._tag === "None") return [];
      const message = decoded.value;
      if (message.kind === "lifecycle") {
        const { rootRunId, target } = message.event;
        this.#observedRoots.add(rootRunId);
        if (target.kind === "run") {
          if (
            target.runId === rootRunId &&
            target.status === "running" &&
            !this.#workflowNames.has(rootRunId) &&
            this.#pendingNamedRun
          ) {
            this.#workflowNames.set(rootRunId, this.#pendingNamedRun);
            this.#pendingNamedRun = undefined;
          }
          const id =
            target.runId === rootRunId
              ? workflowId(rootRunId)
              : workflowMemberId(rootRunId, target.runId, "run");
          const title =
            this.#workflowNames.get(target.runId) ?? `Atomic workflow ${target.runId.slice(0, 8)}`;
          return this.#status(
            id,
            workflowStatus(target.status),
            {
              title,
              taskType: target.runId === rootRunId ? "local_workflow" : "workflow_stage",
              ...(target.runId === rootRunId ? {} : { parentAgentId: workflowId(rootRunId) }),
              ...(this.#workflowNames.get(target.runId) ? { workflowName: title } : {}),
              runHandles: { runId: target.runId },
            },
            terminalWorkflowStatus(target.previousStatus) && target.status === "running",
            target.status,
          );
        }
        if (target.kind === "stage" && target.stageId && target.stageName) {
          const parent = workflowId(rootRunId);
          const owningRun =
            target.runId === rootRunId ? parent : workflowMemberId(rootRunId, target.runId, "run");
          return [
            ...(this.#started.has(parent)
              ? []
              : this.#status(parent, "running", {
                  title:
                    this.#workflowNames.get(rootRunId) ??
                    `Atomic workflow ${rootRunId.slice(0, 8)}`,
                  taskType: "local_workflow",
                  runHandles: { runId: rootRunId },
                })),
            ...(owningRun === parent || this.#started.has(owningRun)
              ? []
              : this.#status(owningRun, "running", {
                  title: `Atomic workflow ${target.runId.slice(0, 8)}`,
                  taskType: "workflow_stage",
                  parentAgentId: parent,
                  runHandles: { runId: target.runId },
                })),
            ...this.#status(
              workflowMemberId(rootRunId, target.runId, `stage:${target.stageId}`),
              workflowStatus(target.status),
              {
                title: target.stageName,
                taskType: "workflow_stage",
                parentAgentId: owningRun,
                workflowName:
                  this.#workflowNames.get(rootRunId) ?? `Atomic workflow ${rootRunId.slice(0, 8)}`,
              },
              terminalWorkflowStatus(target.previousStatus) && target.status === "running",
              target.status,
            ),
          ];
        }
        if (target.kind === "tool" && target.toolName) {
          const isRoot = target.runId === rootRunId;
          const id = isRoot
            ? workflowId(rootRunId)
            : workflowMemberId(rootRunId, target.runId, "run");
          if (this.#terminal.has(id)) return [];
          if (target.status === "failed")
            this.#failedTool.set(id, short(`last failed tool: ${target.toolName}`));
          else if (target.status === "running") this.#failedTool.delete(id);
          const title =
            this.#workflowNames.get(target.runId) ?? `Atomic workflow ${target.runId.slice(0, 8)}`;
          const started = this.#started.has(id)
            ? []
            : this.#status(id, "running", {
                title,
                taskType: isRoot ? "local_workflow" : "workflow_stage",
                ...(isRoot ? {} : { parentAgentId: workflowId(rootRunId) }),
                runHandles: { runId: target.runId },
              });
          return target.status === "running" ||
            target.status === "completed" ||
            target.status === "failed"
            ? [
                ...started,
                {
                  type: "task.progress",
                  payload: {
                    taskId: id,
                    description: title,
                    summary: short(
                      `${target.status === "running" ? "Running" : target.status === "failed" ? "Failed" : "Finished"} ${target.toolName}`,
                    ),
                    lastToolName: target.toolName,
                    taskType: isRoot ? "local_workflow" : "workflow_stage",
                  },
                },
              ]
            : started;
        }
        if (target.kind === "prompt") {
          const isRoot = target.runId === rootRunId;
          const id = isRoot
            ? workflowId(rootRunId)
            : workflowMemberId(rootRunId, target.runId, "run");
          if (this.#terminal.has(id)) return [];
          const title =
            this.#workflowNames.get(target.runId) ?? `Atomic workflow ${target.runId.slice(0, 8)}`;
          const started = this.#started.has(id)
            ? []
            : this.#status(id, "waiting", {
                title,
                taskType: isRoot ? "local_workflow" : "workflow_stage",
                ...(isRoot ? {} : { parentAgentId: workflowId(rootRunId) }),
                runHandles: { runId: target.runId },
              });
          const summary =
            target.status === "opened"
              ? "Waiting for input"
              : target.status === "answered"
                ? "Input answered"
                : "Prompt cancelled";
          return [
            ...started,
            {
              type: "task.progress",
              payload: {
                taskId: id,
                description: title,
                summary,
                status: "waiting",
                taskType: isRoot ? "local_workflow" : "workflow_stage",
              },
            },
          ];
        }
        return [];
      }
      const activity = message.frame;
      if (activity.kind === "removed") {
        this.#observedRoots.delete(activity.rootRunId);
        this.#failedTool.delete(workflowId(activity.rootRunId));
        const members = this.#unavailableMembers(activity.rootRunId);
        const id = workflowId(activity.rootRunId);
        const title =
          this.#workflowNames.get(activity.rootRunId) ??
          `Atomic workflow ${activity.rootRunId.slice(0, 8)}`;
        const changed = this.#status(id, "idle", {
          title:
            this.#workflowNames.get(activity.rootRunId) ??
            `Atomic workflow ${activity.rootRunId.slice(0, 8)}`,
          taskType: "local_workflow",
          runHandles: { runId: activity.rootRunId },
        });
        return this.#terminal.has(id)
          ? [...changed, ...members]
          : [
              ...changed,
              ...members,
              {
                type: "task.progress",
                payload: {
                  taskId: id,
                  description: title,
                  summary: "Workflow activity unavailable",
                  status: "idle",
                  taskType: "local_workflow",
                },
              },
            ];
      }
      const roots =
        activity.kind === "changed"
          ? [activity.root]
          : activity.availability === "ready"
            ? (activity.roots ?? [])
            : [];
      const currentRoots = new Set(roots.map((root) => root.rootRunId));
      const unavailable =
        activity.kind === "snapshot"
          ? [...this.#observedRoots].filter((id) => !currentRoots.has(id))
          : [];
      if (activity.kind === "snapshot") this.#observedRoots.clear();
      const events = roots.flatMap((root) => {
        this.#observedRoots.add(root.rootRunId);
        const id = workflowId(root.rootRunId);
        const status: "running" | "waiting" | "idle" =
          root.state === "working" ? "running" : root.state === "blocked" ? "waiting" : "idle";
        const changed = this.#status(workflowId(root.rootRunId), status, {
          title:
            this.#workflowNames.get(root.rootRunId) ??
            `Atomic workflow ${root.rootRunId.slice(0, 8)}`,
          taskType: "local_workflow",
          runHandles: { runId: root.rootRunId },
        });
        const summary = rootActivitySummary(root);
        return summary && !this.#terminal.has(id)
          ? [
              ...changed,
              {
                type: "task.progress" as const,
                payload: {
                  taskId: id,
                  description: `Atomic workflow ${root.rootRunId.slice(0, 8)}`,
                  summary,
                  status,
                  taskType: "local_workflow",
                },
              },
            ]
          : changed;
      });
      return [
        ...events,
        ...unavailable.flatMap((rootRunId) => {
          const id = workflowId(rootRunId);
          const members = this.#unavailableMembers(rootRunId);
          if (this.#terminal.has(id)) return members;
          this.#active.delete(id);
          this.#failedTool.delete(id);
          const title =
            this.#workflowNames.get(rootRunId) ?? `Atomic workflow ${rootRunId.slice(0, 8)}`;
          return [
            ...members,
            {
              type: "task.progress" as const,
              payload: {
                taskId: id,
                description: title,
                summary: "Workflow activity unavailable",
                status: "idle" as const,
                taskType: "local_workflow",
              },
            },
          ];
        }),
      ];
    }

    if (
      frame.type === "tool_execution_start" &&
      frame.toolCallId &&
      frame.toolName === "workflow"
    ) {
      const args = decodeWorkflowArgs(frame.args);
      if (args._tag === "Some" && args.value.action === "run")
        this.#toolNames.set(
          frame.toolCallId,
          args.value.workflow ?? args.value.workflowId ?? "Atomic workflow",
        );
    }
    if (frame.type === "tool_execution_end" && frame.toolCallId && frame.toolName === "workflow") {
      const name = this.#toolNames.get(frame.toolCallId);
      this.#toolNames.delete(frame.toolCallId);
      const result = decodeToolResult(frame.result);
      const text =
        result._tag === "Some"
          ? result.value.content?.find((part) => part.type === "text")?.text
          : undefined;
      const parsed = text ? decodeRunText(text) : undefined;
      const fromDetails = decodeRunDetails(
        result._tag === "Some" ? result.value.details : undefined,
      );
      const runId =
        parsed?._tag === "Some"
          ? parsed.value.runId
          : fromDetails._tag === "Some"
            ? fromDetails.value.runId
            : undefined;
      if (runId) {
        const resolvedName = name ?? "Atomic workflow";
        this.#workflowNames.set(runId, resolvedName);
        return [
          {
            type: "task.updated",
            payload: {
              taskId: workflowId(runId),
              title: resolvedName,
              workflowName: resolvedName,
              taskType: "local_workflow",
            },
          },
        ];
      }
    }

    if (
      (frame.type !== "tool_execution_update" && frame.type !== "tool_execution_end") ||
      frame.toolName !== "subagent" ||
      !frame.toolCallId
    )
      return [];
    const toolResult = frame.type === "tool_execution_update" ? frame.partialResult : frame.result;
    const wrapper = decodeSubagentToolResult(toolResult);
    if (wrapper._tag === "None") return [];
    const { runId, results } = wrapper.value.details;
    const toolCallId = frame.toolCallId;
    return results.flatMap((result, position): TaskEvent[] => {
      const progress = decodeSubagentProgress(result.progress);
      const latestProgress = wrapper.value.details.progress
        ?.map((entry) => decodeSubagentProgress(entry))
        .find(
          (entry) =>
            entry._tag === "Some" &&
            entry.value.index === (progress._tag === "Some" ? progress.value.index : position),
        );
      const detail =
        latestProgress?._tag === "Some"
          ? latestProgress.value
          : progress._tag === "Some"
            ? progress.value
            : undefined;
      const index = detail?.index ?? position;
      const id = subagentId(toolCallId, index);
      const linkage = {
        title: short(result.task),
        role: result.agent,
        taskType: "subagent",
        model: result.model ?? detail?.model,
        effort: result.thinking ?? detail?.thinking,
        agentIndex: index,
        ...(runId ? { runHandles: { runId } } : {}),
      };
      const started = this.#start(id, { taskId: id, description: short(result.task), ...linkage });
      if (this.#terminal.has(id)) return started;
      const status =
        result.status === "continued"
          ? "running"
          : result.status === "ok" || result.status === "completed"
            ? "completed"
            : result.status === "interrupted" || result.status === "killed"
              ? "cancelled"
              : result.status === "error"
                ? "failed"
                : undefined;
      if (status === "completed" || status === "failed" || status === "cancelled") {
        this.#terminal.add(id);
        this.#active.delete(id);
        const outcome = [
          ...(status === "failed" ? [result.error, result.cause] : []),
          result.finalOutput,
          result.envelope,
          result.task,
        ].find((value) => value?.trim());
        return [
          ...started,
          {
            type: "task.completed",
            payload: {
              taskId: id,
              status: status === "cancelled" ? "stopped" : status,
              ...(outcome ? { summary: resultText(outcome) } : {}),
              ...linkage,
            },
          },
        ];
      }
      if (frame.type === "tool_execution_end" && result.status === "continued") {
        this.#active.delete(id);
        return [
          ...started,
          {
            type: "task.progress",
            payload: {
              taskId: id,
              description: short(result.task),
              summary: "Detached; activity unavailable",
              status: "idle",
              ...linkage,
            },
          },
        ];
      }
      this.#active.set(id, { description: short(result.task), taskType: "subagent" });
      const lastTool = detail?.recentTools?.at(-1);
      const current = detail?.currentTool
        ? `${detail.currentTool}${detail.currentToolArgs ? ` ${detail.currentToolArgs}` : ""}`
        : lastTool
          ? `${lastTool.tool}${lastTool.args ? ` ${lastTool.args}` : ""}`
          : (detail?.recentOutput?.at(-1) ?? result.task);
      const lastToolName = detail?.currentTool ?? lastTool?.tool;
      const tokens = detail?.tokens;
      return [
        ...started,
        {
          type: "task.progress",
          payload: {
            taskId: id,
            description: short(result.task),
            summary: short(current),
            status: "running",
            ...linkage,
            ...(lastToolName ? { lastToolName } : {}),
            ...(tokens !== undefined && Number.isFinite(tokens) && tokens >= 0
              ? {
                  typedUsage: {
                    totalTokens: Math.floor(tokens),
                    ...(detail?.toolCount !== undefined
                      ? { toolUses: Math.max(0, Math.floor(detail.toolCount)) }
                      : {}),
                    ...(detail?.durationMs !== undefined
                      ? { durationMs: Math.max(0, Math.floor(detail.durationMs)) }
                      : {}),
                  },
                }
              : {}),
          },
        },
      ];
    });
  }
}
