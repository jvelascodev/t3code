import { describe, expect, it } from "vite-plus/test";
import { AtomicTasks } from "./AtomicTasks.ts";

describe("Atomic task projection", () => {
  it("marks a detached child unavailable after its tool call ends", () => {
    const tasks = new AtomicTasks();
    const child = (type: "tool_execution_update" | "tool_execution_end") =>
      tasks.project({
        type,
        toolCallId: "detached-call",
        toolName: "subagent",
        ...(type === "tool_execution_update"
          ? {
              partialResult: {
                details: { results: [{ agent: "reviewer", task: "Review", status: "continued" }] },
              },
            }
          : {
              result: {
                details: { results: [{ agent: "reviewer", task: "Review", status: "continued" }] },
              },
            }),
      });
    expect(child("tool_execution_update")).toContainEqual(
      expect.objectContaining({
        type: "task.progress",
        payload: expect.objectContaining({ status: "running" }),
      }),
    );
    expect(child("tool_execution_end")).toContainEqual(
      expect.objectContaining({
        type: "task.progress",
        payload: expect.objectContaining({
          status: "idle",
          summary: "Detached; activity unavailable",
        }),
      }),
    );
    expect(tasks.unavailable()).toEqual([]);
  });

  it("clears an unconfirmed slash workflow name at the next prompt", () => {
    const tasks = new AtomicTasks();
    tasks.recordPrompt("/workflow old-name");
    tasks.recordPrompt("Start a different workflow");
    const events = tasks.project({
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "t3-atomic-observer",
      widgetLines: [
        JSON.stringify({
          kind: "lifecycle",
          event: {
            rootRunId: "new-run",
            runId: "new-run",
            target: { kind: "run", runId: "new-run", status: "running" },
          },
        }),
      ],
    });
    expect(events.find((event) => event.type === "task.started")?.payload).toMatchObject({
      title: "Atomic workflow new-run",
    });
  });

  it("keeps parallel child identities stable when Atomic omits a run ID from progress", () => {
    const tasks = new AtomicTasks();
    const progress = tasks.project({
      type: "tool_execution_update",
      toolCallId: "tool-7",
      toolName: "subagent",
      partialResult: {
        details: {
          mode: "parallel",
          results: [
            {
              agent: "researcher",
              task: "Find the code",
              status: "continued",
              progress: { index: 0, status: "running" },
            },
            {
              agent: "reviewer",
              task: "Review the code",
              status: "continued",
              progress: { index: 1, status: "running" },
            },
          ],
          progress: [
            { index: 0, status: "running", currentTool: "search", tokens: 12 },
            { index: 1, status: "running", currentTool: "read", tokens: 27 },
          ],
        },
      },
    });
    expect(
      progress
        .filter((event) => event.type === "task.started")
        .map((event) => event.payload.taskId),
    ).toEqual(["atomic:subagent:tool-7:0", "atomic:subagent:tool-7:1"]);
    expect(
      progress
        .filter((event) => event.type === "task.progress")
        .map((event) => event.payload.summary),
    ).toEqual(["search", "read"]);
    const terminal = tasks.project({
      type: "tool_execution_end",
      toolCallId: "tool-7",
      toolName: "subagent",
      result: {
        details: {
          mode: "parallel",
          runId: "run-7",
          results: [
            {
              agent: "researcher",
              task: "Find the code",
              status: "ok",
              finalOutput: "Found it",
              progress: { index: 0, status: "completed" },
            },
            {
              agent: "reviewer",
              task: "Review the code",
              status: "error",
              envelope: "Review failed",
              progress: { index: 1, status: "failed" },
            },
          ],
        },
      },
    });
    expect(
      terminal
        .filter((event) => event.type === "task.completed")
        .map((event) => [event.payload.taskId, event.payload.status]),
    ).toEqual([
      ["atomic:subagent:tool-7:0", "completed"],
      ["atomic:subagent:tool-7:1", "failed"],
    ]);
  });

  it("restores active workflows from a snapshot and settles removed runs without guessing success", () => {
    const tasks = new AtomicTasks();
    const observed = (frame: unknown) => ({
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "t3-atomic-observer",
      widgetLines: [JSON.stringify({ kind: "activity", frame })],
    });
    const active = tasks.project(
      observed({
        kind: "snapshot",
        availability: "ready",
        roots: [{ rootRunId: "run-3", state: "blocked", reason: "awaiting_input" }],
      }),
    );
    expect(active).toContainEqual(
      expect.objectContaining({
        type: "task.updated",
        payload: expect.objectContaining({ taskId: "atomic:workflow:run-3", status: "waiting" }),
      }),
    );
    expect(active).toContainEqual(
      expect.objectContaining({
        type: "task.progress",
        payload: expect.objectContaining({ summary: "Waiting for input" }),
      }),
    );
    expect(
      tasks.project(
        observed({
          kind: "changed",
          root: { rootRunId: "run-3", state: "working", reason: "executing" },
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "task.progress",
        payload: expect.objectContaining({
          taskId: "atomic:workflow:run-3",
          status: "running",
          summary: "Running",
        }),
      }),
    );
    expect(
      tasks.project(
        observed({
          kind: "changed",
          root: { rootRunId: "run-3", state: "working", reason: "stopping" },
        }),
      ),
    ).toContainEqual(
      expect.objectContaining({
        type: "task.progress",
        payload: expect.objectContaining({ taskId: "atomic:workflow:run-3", summary: "Stopping" }),
      }),
    );
    expect(tasks.unavailable()).toContainEqual(
      expect.objectContaining({
        type: "task.progress",
        payload: expect.objectContaining({ taskId: "atomic:workflow:run-3", status: "idle" }),
      }),
    );
    const removed = tasks.project(observed({ kind: "removed", rootRunId: "run-3" }));
    expect(removed).toContainEqual(
      expect.objectContaining({
        type: "task.updated",
        payload: expect.objectContaining({ taskId: "atomic:workflow:run-3", status: "idle" }),
      }),
    );
    expect(removed.some((event) => event.type === "task.completed")).toBe(false);
    expect(removed).toContainEqual(
      expect.objectContaining({
        type: "task.progress",
        payload: expect.objectContaining({ summary: "Workflow activity unavailable" }),
      }),
    );
  });

  it("clears a stale running root when Atomic reports an unavailable snapshot", () => {
    const tasks = new AtomicTasks();
    const observed = (frame: unknown) => ({
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "t3-atomic-observer",
      widgetLines: [JSON.stringify({ kind: "activity", frame })],
    });
    tasks.project(
      observed({
        kind: "snapshot",
        availability: "ready",
        roots: [{ rootRunId: "run-5", state: "working", reason: "executing" }],
      }),
    );
    const lost = tasks.project(observed({ kind: "snapshot", availability: "recovering" }));
    expect(lost).toContainEqual(
      expect.objectContaining({
        type: "task.progress",
        payload: expect.objectContaining({
          taskId: "atomic:workflow:run-5",
          status: "idle",
          summary: "Workflow activity unavailable",
        }),
      }),
    );
  });

  it("marks active stages unavailable when their workflow disappears", () => {
    const tasks = new AtomicTasks();
    const observe = (kind: "lifecycle" | "activity", value: unknown) => ({
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "t3-atomic-observer",
      widgetLines: [
        JSON.stringify(kind === "lifecycle" ? { kind, event: value } : { kind, frame: value }),
      ],
    });
    tasks.project(
      observe("lifecycle", {
        rootRunId: "run-6",
        runId: "run-6",
        target: { kind: "run", runId: "run-6", status: "running" },
      }),
    );
    tasks.project(
      observe("lifecycle", {
        rootRunId: "run-6",
        runId: "run-6",
        target: {
          kind: "stage",
          runId: "run-6",
          stageId: "review",
          stageName: "Review",
          status: "running",
        },
      }),
    );
    const lost = tasks.project(
      observe("activity", { kind: "snapshot", availability: "recovering" }),
    );
    expect(
      lost
        .filter((event) => event.type === "task.progress" && event.payload.status === "idle")
        .map((event) => event.payload.taskId),
    ).toEqual(["atomic:workflow:run-6:wf:run-6:stage:review", "atomic:workflow:run-6"]);
    expect(tasks.unavailable()).toEqual([]);
  });

  it("replaces a waiting cue when a workflow finishes directly from blocked", () => {
    const tasks = new AtomicTasks();
    const observe = (kind: "activity" | "lifecycle", value: unknown) => ({
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "t3-atomic-observer",
      widgetLines: [
        JSON.stringify(kind === "activity" ? { kind, frame: value } : { kind, event: value }),
      ],
    });
    tasks.project(
      observe("activity", {
        kind: "changed",
        root: { rootRunId: "run-7", state: "blocked", reason: "awaiting_input" },
      }),
    );
    const terminal = tasks.project(
      observe("lifecycle", {
        rootRunId: "run-7",
        runId: "run-7",
        target: { kind: "run", runId: "run-7", status: "completed" },
      }),
    );
    expect(terminal).toContainEqual(
      expect.objectContaining({
        type: "task.completed",
        payload: expect.objectContaining({
          taskId: "atomic:workflow:run-7",
          status: "completed",
          summary: "Completed",
        }),
      }),
    );
  });

  it("preserves Atomic's distinct terminal outcomes and failed tool clue", () => {
    const terminal = (runId: string, status: string, failedTool?: string) => {
      const tasks = new AtomicTasks();
      const lifecycle = (target: unknown) =>
        tasks.project({
          type: "extension_ui_request",
          method: "setWidget",
          widgetKey: "t3-atomic-observer",
          widgetLines: [
            JSON.stringify({ kind: "lifecycle", event: { rootRunId: runId, runId, target } }),
          ],
        });
      lifecycle({ kind: "run", runId, status: "running" });
      if (failedTool) lifecycle({ kind: "tool", runId, toolName: failedTool, status: "failed" });
      return lifecycle({ kind: "run", runId, status }).find(
        (event) => event.type === "task.completed",
      )?.payload;
    };
    expect(terminal("skipped-run", "skipped")).toMatchObject({
      status: "completed",
      summary: "Skipped",
    });
    expect(terminal("killed-run", "killed")).toMatchObject({
      status: "stopped",
      summary: "Killed",
    });
    expect(terminal("failed-run", "failed", "run-tests")).toMatchObject({
      status: "failed",
      summary: "Failed; last failed tool: run-tests",
    });
  });

  it("attributes nested tools and stages to their owning run", () => {
    const tasks = new AtomicTasks();
    const lifecycle = (target: unknown) =>
      tasks.project({
        type: "extension_ui_request",
        method: "setWidget",
        widgetKey: "t3-atomic-observer",
        widgetLines: [
          JSON.stringify({
            kind: "lifecycle",
            event: { rootRunId: "root", runId: "child", target },
          }),
        ],
      });
    lifecycle({ kind: "run", runId: "root", status: "running" });
    lifecycle({ kind: "run", runId: "child", status: "running" });
    const stage = lifecycle({
      kind: "stage",
      runId: "child",
      stageId: "verify",
      stageName: "Verify",
      status: "running",
    });
    expect(stage.find((event) => event.type === "task.started")?.payload).toMatchObject({
      taskId: "atomic:workflow:root:wf:child:stage:verify",
      parentAgentId: "atomic:workflow:root:wf:child:run",
    });
    const failedTool = lifecycle({
      kind: "tool",
      runId: "child",
      toolName: "run-tests",
      status: "failed",
    });
    expect(failedTool.find((event) => event.type === "task.progress")?.payload).toMatchObject({
      taskId: "atomic:workflow:root:wf:child:run",
      summary: "Failed run-tests",
    });
    const prompt = lifecycle({ kind: "prompt", runId: "child", status: "opened" });
    expect(prompt.find((event) => event.type === "task.progress")?.payload).toMatchObject({
      taskId: "atomic:workflow:root:wf:child:run",
      summary: "Waiting for input",
      status: "waiting",
    });
    const cancelled = lifecycle({ kind: "prompt", runId: "child", status: "cancelled" });
    expect(cancelled.find((event) => event.type === "task.progress")?.payload).toMatchObject({
      taskId: "atomic:workflow:root:wf:child:run",
      summary: "Prompt cancelled",
      status: "waiting",
    });
    const childFailed = lifecycle({ kind: "run", runId: "child", status: "failed" });
    expect(childFailed.find((event) => event.type === "task.completed")?.payload).toMatchObject({
      taskId: "atomic:workflow:root:wf:child:run",
      summary: "Failed; last failed tool: run-tests",
    });
    const rootFailed = lifecycle({ kind: "run", runId: "root", status: "failed" });
    expect(rootFailed.find((event) => event.type === "task.completed")?.payload).toMatchObject({
      taskId: "atomic:workflow:root",
      summary: "Failed",
    });
  });

  it("names direct workflow launches and shows durable tool steps", () => {
    const tasks = new AtomicTasks();
    tasks.recordPrompt('/workflow ship-feature task="Fix the bug"');
    const observed = (event: unknown) => ({
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "t3-atomic-observer",
      widgetLines: [JSON.stringify({ kind: "lifecycle", event })],
    });
    const started = tasks.project(
      observed({
        rootRunId: "run-4",
        runId: "run-4",
        target: { kind: "run", runId: "run-4", status: "running" },
      }),
    );
    expect(started).toContainEqual(
      expect.objectContaining({
        type: "task.started",
        payload: expect.objectContaining({ title: "ship-feature", runHandles: { runId: "run-4" } }),
      }),
    );
    const step = tasks.project(
      observed({
        rootRunId: "run-4",
        runId: "run-4",
        target: { kind: "tool", runId: "run-4", toolName: "run-tests", status: "running" },
      }),
    );
    expect(step).toContainEqual(
      expect.objectContaining({
        type: "task.progress",
        payload: expect.objectContaining({
          summary: "Running run-tests",
          lastToolName: "run-tests",
        }),
      }),
    );
  });
});
