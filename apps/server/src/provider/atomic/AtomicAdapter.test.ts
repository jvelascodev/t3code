// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AtomicSettings,
  ProviderInstanceId,
  ThreadId,
  ProviderRuntimeEvent,
  ApprovalRequestId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeURL from "node:url";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ServerConfig } from "../../config.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { makeAtomicAdapter } from "./AtomicAdapter.ts";

const decodeSettings = Schema.decodeEffect(AtomicSettings);
const decodeRuntimeEvent = Schema.decodeUnknownEffect(ProviderRuntimeEvent);
const windowsHost = HostProcessPlatform.defaultValue() === "win32";
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-atomic-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "atomic-test-" });
  const binaryPath = `${directory}/atomic`;
  yield* fs.copyFile(
    NodeURL.fileURLToPath(new URL("./fixtures/atomic-rpc.mjs", import.meta.url)),
    binaryPath,
  );
  yield* fs.chmod(binaryPath, 0o755);
  const adapter = yield* makeAtomicAdapter(
    yield* decodeSettings({ binaryPath }),
    ProviderInstanceId.make("atomic-test"),
    process.env,
    directory,
  );
  const events = yield* Stream.toQueue(adapter.streamEvents, { capacity: "unbounded" });
  const threadId = ThreadId.make("atomic-thread");
  return { adapter, events, threadId, directory };
});
const nextEvent = <T extends ProviderRuntimeEvent["type"]>(
  events: Effect.Success<typeof setup>["events"],
  type: T,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(events);
      yield* decodeRuntimeEvent(event);
      if (event.type === type) return event as Extract<ProviderRuntimeEvent, { type: T }>;
    }
  });

it.layer(layer)("Atomic adapter", (it) => {
  it.effect.skipIf(windowsHost)(
    "applies selected thinking effort on start, between turns, and resume",
    () =>
      Effect.gen(function* () {
        const { adapter, events, threadId } = yield* setup;
        const selection = (effort: string) => ({
          instanceId: ProviderInstanceId.make("atomic-test"),
          model: "fixture/test",
          options: [{ id: "effort", value: effort }],
        });
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          modelSelection: selection("high"),
        });
        for (const effort of ["high", "low"] as const) {
          yield* adapter.sendTurn({
            threadId,
            input: "thinking",
            modelSelection: selection(effort),
          });
          yield* nextEvent(events, "content.delta");
          expect((yield* nextEvent(events, "content.delta")).payload.delta).toBe(
            `Thinking level: ${effort}`,
          );
          yield* nextEvent(events, "turn.completed");
        }
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { sessionFile: "/tmp/resume-specific.jsonl" },
          modelSelection: selection("low"),
        });
        yield* adapter.sendTurn({ threadId, input: "thinking", modelSelection: selection("low") });
        yield* nextEvent(events, "content.delta");
        expect((yield* nextEvent(events, "content.delta")).payload.delta).toBe(
          "Thinking level: low",
        );
        yield* nextEvent(events, "turn.completed");
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "restores Atomic's setting after a selected effort, including after resume",
    () =>
      Effect.gen(function* () {
        const { adapter, events, threadId } = yield* setup;
        const selection = (model: string, effort: string) => ({
          instanceId: ProviderInstanceId.make("atomic-test"),
          model,
          options: [{ id: "effort", value: effort }],
        });
        const readLevel = (model: string, effort: string) =>
          Effect.gen(function* () {
            yield* adapter.sendTurn({
              threadId,
              input: "thinking",
              modelSelection: selection(model, effort),
            });
            yield* nextEvent(events, "content.delta");
            const level = (yield* nextEvent(events, "content.delta")).payload.delta;
            yield* nextEvent(events, "turn.completed");
            return level;
          });
        const session = yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          modelSelection: selection("fixture/test", "high"),
        });
        expect(session.resumeCursor).toEqual({
          sessionFile: "/tmp/atomic-fixture.jsonl",
          baselineThinkingLevel: "medium",
          baselineModel: "fixture/test",
        });
        expect(yield* readLevel("fixture/test", "high")).toBe("Thinking level: high");
        expect(yield* readLevel("fixture/test", "default")).toBe("Thinking level: medium");
        expect(yield* readLevel("fixture/test", "low")).toBe("Thinking level: low");
        expect(yield* readLevel("fixture/limited", "default")).toBe("Thinking level: medium");
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          resumeCursor: {
            sessionFile: "/tmp/resume-high.jsonl",
            baselineThinkingLevel: "medium",
            baselineModel: "fixture/test",
          },
          modelSelection: selection("fixture/test", "default"),
        });
        expect(yield* readLevel("fixture/test", "default")).toBe("Thinking level: medium");
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          resumeCursor: {
            sessionFile: "/tmp/resume-limited.jsonl",
            baselineThinkingLevel: "medium",
            baselineModel: "fixture/test",
          },
          modelSelection: selection("fixture/test", "default"),
        });
        expect(yield* readLevel("fixture/test", "default")).toBe("Thinking level: medium");
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("switches models after Atomic changes its own current model", () =>
    Effect.gen(function* () {
      const { adapter, events, threadId } = yield* setup;
      const selection = (model: string, effort: string) => ({
        instanceId: ProviderInstanceId.make("atomic-test"),
        model,
        options: [{ id: "effort", value: effort }],
      });
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        modelSelection: selection("fixture/test", "high"),
      });
      yield* adapter.sendTurn({
        threadId,
        input: "external-model-change",
        modelSelection: selection("fixture/test", "high"),
      });
      yield* nextEvent(events, "turn.completed");
      yield* adapter.sendTurn({
        threadId,
        input: "thinking",
        modelSelection: selection("fixture/limited", "default"),
      });
      yield* nextEvent(events, "content.delta");
      expect((yield* nextEvent(events, "content.delta")).payload.delta).toBe(
        "Thinking level: high",
      );
      yield* nextEvent(events, "turn.completed");
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "streams text and tool activity, switches models, and retains a resume cursor",
    () =>
      Effect.gen(function* () {
        const { adapter, events, threadId } = yield* setup;
        const session = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        expect(session.resumeCursor).toEqual({
          sessionFile: "/tmp/atomic-fixture.jsonl",
          baselineThinkingLevel: "medium",
          baselineModel: "fixture/default",
        });
        const result = yield* adapter.sendTurn({
          threadId,
          input: "hello",
          modelSelection: {
            instanceId: ProviderInstanceId.make("atomic-test"),
            model: "fixture/test",
          },
        });
        expect(result.resumeCursor).toEqual({
          sessionFile: "/tmp/atomic-fixture.jsonl",
          baselineThinkingLevel: "medium",
          baselineModel: "fixture/test",
        });
        const thinking = yield* nextEvent(events, "content.delta");
        expect(thinking.payload).toMatchObject({ streamKind: "reasoning_text", delta: "Thinking" });
        const text = yield* nextEvent(events, "content.delta");
        expect(text.payload.delta).toBe("Hello\u2028world test");
        expect((yield* nextEvent(events, "item.completed")).payload.itemType).toBe(
          "dynamic_tool_call",
        );
        expect((yield* nextEvent(events, "turn.completed")).payload.state).toBe("completed");
        yield* adapter.stopSession(threadId);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { sessionFile: "/tmp/resume-specific.jsonl" },
        });
        expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual({
          sessionFile: "/tmp/resume-specific.jsonl",
          baselineThinkingLevel: "medium",
          baselineModel: "fixture/default",
        });
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("rejects unsupported permission modes before spawning", () =>
    Effect.gen(function* () {
      const { adapter, threadId } = yield* setup;
      const error = yield* adapter
        .startSession({ threadId, runtimeMode: "approval-required" })
        .pipe(Effect.flip);
      expect(error.message).toContain("Full access");
      expect(yield* adapter.listSessions()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("retains a workflow snapshot emitted before session setup", () =>
    Effect.gen(function* () {
      const { adapter, events, threadId } = yield* setup;
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        title: "early-observer",
      });
      const started = yield* nextEvent(events, "session.started");
      expect(runtimeEventToActivities(started)).toEqual([
        expect.objectContaining({
          kind: "atomic.session.started",
          payload: { timelineBypass: true },
        }),
      ]);
      expect((yield* nextEvent(events, "task.started")).payload).toMatchObject({
        taskId: "atomic:workflow:existing-run",
        taskType: "local_workflow",
      });
      expect((yield* nextEvent(events, "task.progress")).payload).toMatchObject({
        taskId: "atomic:workflow:existing-run",
        status: "running",
      });
      yield* adapter.stopSession(threadId);
      expect((yield* nextEvent(events, "task.progress")).payload).toMatchObject({
        taskId: "atomic:workflow:existing-run",
        status: "idle",
        summary: "Atomic activity unavailable",
      });
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("rejects a thinking level unsupported by the selected model", () =>
    Effect.gen(function* () {
      const { adapter, threadId } = yield* setup;
      const error = yield* adapter
        .startSession({
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("atomic-test"),
            model: "fixture/plain",
            options: [{ id: "effort", value: "high" }],
          },
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("does not support high reasoning effort");
      expect(yield* adapter.listSessions()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("marks model errors as failed and interrupts active turns", () =>
    Effect.gen(function* () {
      const { adapter, events, threadId } = yield* setup;
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "error" });
      expect((yield* nextEvent(events, "turn.completed")).payload).toMatchObject({
        state: "failed",
        errorMessage: "Model failed",
      });
      yield* adapter.sendTurn({ threadId, input: "wait" });
      yield* adapter.interruptTurn(threadId);
      expect((yield* nextEvent(events, "turn.completed")).payload.state).toBe("interrupted");
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("settles rejected prompts and unexpected process exits", () =>
    Effect.gen(function* () {
      const { adapter, events, threadId } = yield* setup;
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "reject" }).pipe(Effect.flip);
      expect((yield* nextEvent(events, "turn.completed")).payload).toMatchObject({
        state: "failed",
        errorMessage: "Rejected prompt",
      });
      yield* adapter.sendTurn({ threadId, input: "crash" }).pipe(Effect.flip);
      expect((yield* nextEvent(events, "turn.completed")).payload.state).toBe("failed");
      expect((yield* nextEvent(events, "session.exited")).payload.recoverable).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("returns native question answers and resumes the turn", () =>
    Effect.gen(function* () {
      const { adapter, events, threadId } = yield* setup;
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "question" });
      const question = yield* nextEvent(events, "user-input.requested");
      expect(question.payload.questions[0]?.options.map((option) => option.value)).toEqual([
        "A",
        "B",
      ]);
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("question-1"), {
        answer: ["B"],
      });
      expect((yield* nextEvent(events, "content.delta")).payload.delta).toBe("B");
      expect((yield* nextEvent(events, "turn.completed")).payload.state).toBe("completed");
    }).pipe(Effect.scoped),
  );
  it.effect.skipIf(windowsHost)(
    "passes images through native RPC and isolates simultaneous sessions",
    () =>
      Effect.gen(function* () {
        const { adapter, events, threadId } = yield* setup;
        const fs = yield* FileSystem.FileSystem;
        const { attachmentsDir } = yield* ServerConfig;
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        yield* fs.writeFileString(`${attachmentsDir}/atomic-image.png`, "fixture-image");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const otherThreadId = ThreadId.make("other-atomic-thread");
        yield* adapter.startSession({ threadId: otherThreadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({
          threadId,
          input: "image",
          attachments: [
            {
              type: "image",
              id: "atomic-image",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 13,
            },
          ],
        });
        yield* nextEvent(events, "content.delta");
        expect((yield* nextEvent(events, "content.delta")).payload.delta).toBe(
          "images:image/png:Zml4dHVyZS1pbWFnZQ==",
        );
        yield* nextEvent(events, "turn.completed");
        yield* adapter.stopSession(threadId);
        expect(yield* adapter.hasSession(otherThreadId)).toBe(true);
        yield* adapter.sendTurn({ threadId: otherThreadId, input: "hello" });
        expect((yield* nextEvent(events, "turn.completed")).threadId).toBe(otherThreadId);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "fails a malformed RPC stream instead of leaving a running turn",
    () =>
      Effect.gen(function* () {
        const { adapter, events, threadId } = yield* setup;
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "malformed" }).pipe(Effect.flip);
        expect((yield* nextEvent(events, "turn.completed")).payload.state).toBe("failed");
        expect((yield* nextEvent(events, "session.exited")).payload.exitKind).toBe("error");
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "projects workflow stages and subagent activity after the parent turn",
    () =>
      Effect.gen(function* () {
        const { adapter, events, threadId } = yield* setup;
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "tasks" });
        const workflow = yield* nextEvent(events, "task.started");
        expect(workflow.payload).toMatchObject({
          taskId: "atomic:workflow:run-1",
          taskType: "local_workflow",
        });
        const stage = yield* nextEvent(events, "task.started");
        expect(stage.payload).toMatchObject({
          taskId: "atomic:workflow:run-1:wf:run-1:stage:research",
          title: "Research",
          parentAgentId: "atomic:workflow:run-1",
        });
        const child = yield* nextEvent(events, "task.started");
        expect(child.payload).toMatchObject({
          taskId: "atomic:subagent:subagent-call:0",
          role: "reviewer",
          description: "Review the change",
        });
        const progress = yield* nextEvent(events, "task.progress");
        expect(progress.payload).toMatchObject({
          summary: "read src/index.ts",
          lastToolName: "read",
          typedUsage: { totalTokens: 42 },
        });
        yield* nextEvent(events, "turn.completed");
        const completedStage = yield* nextEvent(events, "task.completed");
        expect(completedStage.payload.taskId).toBe("atomic:workflow:run-1:wf:run-1:stage:research");
        const completedChild = yield* nextEvent(events, "task.completed");
        expect(completedChild.payload).toMatchObject({
          taskId: "atomic:subagent:subagent-call:0",
          summary: "No issues found",
        });
        const retained = runtimeEventToActivities({
          ...completedChild,
          payload: { ...completedChild.payload, summary: "x".repeat(5000) },
        })[0];
        expect((retained?.payload as { detail?: string } | undefined)?.detail).toHaveLength(4096);
        const completedWorkflow = yield* nextEvent(events, "task.completed");
        expect(completedWorkflow.payload.taskId).toBe("atomic:workflow:run-1");
      }).pipe(Effect.scoped),
  );
});
