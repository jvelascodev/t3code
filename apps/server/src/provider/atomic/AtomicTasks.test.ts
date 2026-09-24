import { describe, expect, it } from "vite-plus/test";
import { AtomicTasks } from "./AtomicTasks.ts";

describe("Atomic task projection", () => {
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
