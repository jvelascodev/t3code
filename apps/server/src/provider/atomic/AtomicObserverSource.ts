/** Loaded into Atomic's RPC process to forward its public workflow hooks. */
export const atomicObserverSource = `
export default function (pi) {
  let subscription;
  let taskSubscription;
  const bridgeKey = Symbol.for("t3.atomic.observer");
  const bridge = globalThis[bridgeKey] ??= { publish: undefined, pending: [] };
  const publish = (ctx, value) => {
    if (ctx.mode === "rpc") {
      ctx.ui.setWidget("t3-atomic-observer", [JSON.stringify(value)]);
    }
  };
  const publishStage = (value) => {
    if (bridge.publish) bridge.publish(value);
    else {
      bridge.pending.push(value);
      if (bridge.pending.length > 256) bridge.pending.shift();
    }
  };
  const watchStageTasks = (ctx) => {
    const stage = ctx.orchestrationContext;
    if (stage?.kind !== "workflow-stage" || taskSubscription) return;
    const watched = ctx.getAgentTaskHost?.().watchOwnerTasks();
    if (!watched?.ok) return;
    taskSubscription = watched.value;
    const sent = new Map();
    const publishSnapshot = (snapshot) => {
      for (const task of snapshot.tasks) {
        if (task.kind !== "agent") continue;
        const record = {
          taskId: task.ref.taskId,
          parentTaskId: task.parentTaskId,
          title: task.title.slice(0, 4096),
          role: task.agentName,
          model: task.model,
          effort: task.thinking,
          ordinal: task.launchOrdinal,
          execution: task.execution.kind === "settled"
            ? {
                kind: "settled",
                result: {
                  kind: task.execution.result.kind,
                  message: task.execution.result.message?.slice(0, 4096),
                  cause: task.execution.result.cause,
                },
              }
            : { kind: task.execution.kind },
          attention: task.attention.kind,
          action: task.currentAction?.text.slice(0, 180),
          tool: task.currentAction?.tool,
          metrics: task.metrics,
        };
        const encoded = JSON.stringify(record);
        if (sent.get(record.taskId) === encoded) continue;
        sent.set(record.taskId, encoded);
        publishStage({
          kind: "stage_task",
          runId: stage.workflowRunId,
          stageId: stage.workflowStageId,
          stageName: stage.workflowStageName,
          task: record,
        });
      }
    };
    taskSubscription.onReconcile = publishSnapshot;
    publishSnapshot(taskSubscription.snapshot);
    void (async () => {
      try {
        for await (const _event of taskSubscription.events) {
          publishSnapshot(taskSubscription.snapshot);
        }
      } catch {
        // A later session attachment publishes a fresh snapshot.
      }
    })();
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx.orchestrationContext?.kind === "workflow-stage") {
      watchStageTasks(ctx);
      return;
    }
    if (ctx.mode !== "rpc" || ctx.subagentPolicy) return;
    bridge.publish = (value) => publish(ctx, value);
    for (const value of bridge.pending.splice(0)) bridge.publish(value);
    subscription?.dispose();
    subscription = ctx.observeWorkflowActivity((frame) => publish(ctx, { kind: "activity", frame }));
  });
  pi.on("agent_start", (_event, ctx) => watchStageTasks(ctx));
  pi.on("workflow_lifecycle", (event, ctx) => {
    if (!ctx.subagentPolicy && !ctx.orchestrationContext) {
      publish(ctx, { kind: "lifecycle", event });
    }
  });
  pi.on("session_shutdown", () => {
    subscription?.dispose();
    if (subscription) bridge.publish = undefined;
    subscription = undefined;
    taskSubscription?.dispose();
    taskSubscription = undefined;
  });
}
`;
