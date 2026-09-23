#!/usr/bin/env node
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("1.0.0");
  process.exit(0);
}
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const response = (command, data) =>
  emit({ type: "response", id: command.id, command: command.type, success: true, data });
let model;
let thinkingLevel = "medium";
const noModels = false;
const failModels = false;
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === "get_state")
    response(command, {
      sessionId: "fixture",
      sessionFile: process.argv.includes("--session")
        ? process.argv[process.argv.indexOf("--session") + 1]
        : "/tmp/atomic-fixture.jsonl",
      model: { provider: "fixture", id: "default" },
      thinkingLevel,
    });
  else if (command.type === "get_available_models") {
    if (failModels) {
      emit({ type: "response", id: command.id, success: false, error: "Unavailable" });
      continue;
    }
    response(command, {
      models: noModels
        ? []
        : [
            {
              provider: "fixture",
              id: "test",
              name: "Test model",
              reasoning: true,
              thinkingLevelMap: { xhigh: null, max: "max" },
            },
            {
              provider: "fixture",
              id: "limited",
              name: "Limited model",
              reasoning: true,
              thinkingLevelMap: {
                off: null,
                minimal: null,
                low: null,
                medium: null,
                xhigh: null,
                max: "max",
              },
            },
            { provider: "fixture", id: "plain", name: "Plain model", reasoning: false },
          ],
    });
  } else if (command.type === "set_model") {
    model = command.modelId;
    response(command, {});
  } else if (command.type === "get_available_thinking_levels") {
    response(command, {
      levels:
        model === "plain"
          ? ["off"]
          : model === "limited"
            ? ["high", "max"]
            : ["off", "minimal", "low", "medium", "high", "max"],
    });
  } else if (command.type === "set_thinking_level") {
    thinkingLevel = command.level;
    response(command, { level: thinkingLevel });
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
          : command.message === "thinking"
            ? `Thinking level: ${thinkingLevel}`
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
