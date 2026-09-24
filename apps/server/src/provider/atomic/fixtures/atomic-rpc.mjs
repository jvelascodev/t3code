#!/usr/bin/env node
import * as NodeReadline from "node:readline";
if (process.argv.includes("--version")) {
  console.log("1.0.0");
  process.exit(0);
}
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const response = (command, data) =>
  emit({ type: "response", id: command.id, command: command.type, success: true, data });
let model;
if (process.argv.includes("early-observer")) {
  emit({
    type: "extension_ui_request",
    method: "setWidget",
    widgetKey: "t3-atomic-observer",
    widgetLines: [
      JSON.stringify({
        kind: "activity",
        frame: {
          kind: "snapshot",
          availability: "ready",
          roots: [{ rootRunId: "existing-run", state: "working", reason: "executing" }],
        },
      }),
    ],
  });
}
for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === "get_state")
    response(command, {
      sessionId: "fixture",
      sessionFile: process.argv.includes("--session")
        ? process.argv[process.argv.indexOf("--session") + 1]
        : "/tmp/atomic-fixture.jsonl",
      model: { provider: "fixture", id: "default" },
    });
  else if (command.type === "get_available_models")
    response(command, { models: [{ provider: "fixture", id: "test", name: "Test model" }] });
  else if (command.type === "set_model") {
    model = command.modelId;
    response(command, {});
  } else if (command.type === "prompt") {
    if (command.message === "reject") {
      emit({ type: "response", id: command.id, success: false, error: "Rejected prompt" });
      continue;
    }
    if (command.message === "malformed") {
      process.stdout.write("not-json\n");
      continue;
    }
    if (command.message === "crash") process.exit(1);
    response(command);
    if (command.message === "wait") continue;
    if (command.message === "question") {
      emit({
        type: "extension_ui_request",
        id: "question-1",
        method: "select",
        title: "Choose",
        options: ["A", "B"],
      });
      continue;
    }
    if (command.message === "tasks") {
      const observe = (value) =>
        emit({
          type: "extension_ui_request",
          method: "setWidget",
          widgetKey: "t3-atomic-observer",
          widgetLines: [JSON.stringify(value)],
        });
      observe({
        kind: "activity",
        frame: {
          kind: "snapshot",
          availability: "ready",
          roots: [{ rootRunId: "run-1", state: "working", reason: "executing" }],
        },
      });
      observe({
        kind: "lifecycle",
        event: {
          rootRunId: "run-1",
          runId: "run-1",
          target: {
            kind: "stage",
            runId: "run-1",
            stageId: "research",
            stageName: "Research",
            status: "running",
          },
        },
      });
      emit({
        type: "tool_execution_update",
        toolCallId: "subagent-call",
        toolName: "subagent",
        partialResult: {
          details: {
            runId: "children-1",
            results: [
              {
                agent: "reviewer",
                task: "Review the change",
                status: "continued",
                progress: {
                  index: 0,
                  status: "running",
                  currentTool: "read",
                  currentToolArgs: "src/index.ts",
                  tokens: 42,
                  toolCount: 1,
                  durationMs: 150,
                },
              },
            ],
          },
        },
      });
      emit({ type: "agent_end", messages: [] });
      observe({
        kind: "lifecycle",
        event: {
          rootRunId: "run-1",
          runId: "run-1",
          target: {
            kind: "stage",
            runId: "run-1",
            stageId: "research",
            stageName: "Research",
            status: "completed",
          },
        },
      });
      emit({
        type: "tool_execution_end",
        toolCallId: "subagent-call",
        toolName: "subagent",
        result: {
          details: {
            runId: "children-1",
            results: [
              {
                agent: "reviewer",
                task: "Review the change",
                status: "ok",
                finalOutput: "No issues found",
                progress: { index: 0, status: "completed" },
              },
            ],
          },
        },
      });
      observe({
        kind: "lifecycle",
        event: {
          rootRunId: "run-1",
          runId: "run-1",
          target: { kind: "run", runId: "run-1", status: "completed" },
        },
      });
      continue;
    }
    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "Thinking" },
    });
    emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: command.images?.length
          ? `images:${command.images[0].mimeType}:${command.images[0].data}`
          : "Hello\u2028world " + (model ?? "default"),
      },
    });
    emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { content: [] },
      isError: false,
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: command.message === "error" ? "error" : "stop",
        errorMessage: "Model failed",
      },
    });
    emit({ type: "agent_end", messages: [] });
  } else if (command.type === "abort") {
    emit({ type: "agent_end", messages: [] });
    response(command);
  } else if (command.type === "extension_ui_response") {
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: command.value },
    });
    emit({ type: "agent_end", messages: [] });
  } else response(command);
}
