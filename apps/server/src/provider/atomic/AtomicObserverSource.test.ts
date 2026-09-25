import { afterEach, expect, it } from "vite-plus/test";
import { atomicObserverSource } from "./AtomicObserverSource.ts";

const bridgeKey = Symbol.for("t3.atomic.observer");
afterEach(() => {
  Reflect.deleteProperty(globalThis, bridgeKey);
});

it("forwards a stage task snapshot and later changes through the owning RPC session", async () => {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(atomicObserverSource).toString("base64")}`;
  const observer = (await import(/* @vite-ignore */ moduleUrl)).default;
  const rootHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const stageHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const published: unknown[] = [];
  const root = {
    mode: "rpc",
    ui: {
      setWidget: (_key: string, lines: string[]) => published.push(JSON.parse(lines[0]!)),
    },
    observeWorkflowActivity: () => ({ dispose() {} }),
  };
  observer({
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) =>
      rootHandlers.set(name, handler),
  });
  rootHandlers.get("session_start")?.({}, root);

  const first = {
    ref: { taskId: "child-1" },
    kind: "agent",
    title: "Investigate",
    agentName: "debugger",
    launchOrdinal: 0,
    execution: { kind: "running" },
    attention: { kind: "none" },
    currentAction: { tool: "read", text: "Reading the log" },
  };
  const subscription = {
    snapshot: { tasks: [first] },
    onReconcile: (_snapshot: unknown) => {},
    events: { async *[Symbol.asyncIterator]() {} },
    dispose() {},
  };
  observer({
    on: (name: string, handler: (event: unknown, ctx: unknown) => void) =>
      stageHandlers.set(name, handler),
  });
  stageHandlers.get("session_start")?.(
    {},
    {
      mode: "print",
      orchestrationContext: {
        kind: "workflow-stage",
        workflowRunId: "run-1",
        workflowStageId: "orchestrator",
        workflowStageName: "orchestrator-1",
      },
      getAgentTaskHost: () => ({ watchOwnerTasks: () => ({ ok: true, value: subscription }) }),
    },
  );
  expect(published).toContainEqual({
    kind: "stage_task",
    runId: "run-1",
    stageId: "orchestrator",
    stageName: "orchestrator-1",
    task: expect.objectContaining({ taskId: "child-1", execution: { kind: "running" } }),
  });

  subscription.onReconcile({
    tasks: [
      { ...first, execution: { kind: "settled", result: { kind: "completed" } } },
      { ...first, ref: { taskId: "child-2" }, launchOrdinal: 1 },
    ],
  });
  expect(published).toContainEqual(
    expect.objectContaining({
      task: expect.objectContaining({
        taskId: "child-1",
        execution: { kind: "settled", result: { kind: "completed" } },
      }),
    }),
  );
  expect(published).toContainEqual(
    expect.objectContaining({ task: expect.objectContaining({ taskId: "child-2" }) }),
  );
  stageHandlers.get("session_shutdown")?.({}, {});
  rootHandlers.get("session_shutdown")?.({}, {});
});
