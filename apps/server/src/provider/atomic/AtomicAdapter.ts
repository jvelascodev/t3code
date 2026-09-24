import * as NodeCrypto from "node:crypto";
import {
  type AtomicSettings,
  EventId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { atomicError, makeAtomicRpc, type AtomicFrame } from "./AtomicRpc.ts";
import { AtomicTasks } from "./AtomicTasks.ts";
import { atomicObserverSource } from "./AtomicObserverSource.ts";
import {
  ATOMIC_DEFAULT_THINKING_LEVEL,
  AtomicThinkingLevel,
  isAtomicThinkingLevel,
  selectedAtomicThinkingLevel,
} from "./AtomicThinking.ts";

const setModel = (rpc: Rpc, model: string) => {
  const slash = model.indexOf("/");
  return slash <= 0 || slash === model.length - 1
    ? Effect.fail(atomicError("set_model", "Choose an Atomic model using provider/model-id"))
    : rpc.request("set_model", {
        provider: model.slice(0, slash),
        modelId: model.slice(slash + 1),
      });
};

const ThinkingLevelResponse = Schema.Struct({ level: Schema.String });
const AvailableThinkingLevels = Schema.Struct({ levels: Schema.Array(AtomicThinkingLevel) });
const decodeThinkingLevelResponse = Schema.decodeUnknownOption(ThinkingLevelResponse);
const decodeAvailableThinkingLevels = Schema.decodeUnknownEffect(AvailableThinkingLevels);
const availableThinkingLevels = (rpc: Rpc) =>
  rpc.request("get_available_thinking_levels").pipe(
    Effect.flatMap(decodeAvailableThinkingLevels),
    Effect.mapError(() =>
      atomicError("get_available_thinking_levels", "Invalid Atomic thinking levels response"),
    ),
  );
const getState = (rpc: Rpc) =>
  rpc.request("get_state").pipe(
    Effect.flatMap(decodeState),
    Effect.mapError((cause) => atomicError("get_state", String(cause))),
  );
const setThinkingLevel = (rpc: Rpc, level: string) =>
  Effect.gen(function* () {
    if (!isAtomicThinkingLevel(level))
      return yield* atomicError(
        "set_thinking_level",
        `Unsupported Atomic thinking level: ${level}`,
      );
    // Atomic clamps unsupported levels; reject a stale selection instead.
    const available = yield* availableThinkingLevels(rpc);
    if (!available.levels.includes(level))
      return yield* atomicError(
        "set_thinking_level",
        `The current Atomic model does not support ${level} reasoning effort`,
      );
    const response = yield* rpc.request("set_thinking_level", { level });
    const decoded = decodeThinkingLevelResponse(response);
    return decoded._tag === "Some" && isAtomicThinkingLevel(decoded.value.level)
      ? decoded.value.level
      : level;
  });

const PROVIDER = ProviderDriverKind.make("atomic");
const State = Schema.Struct({
  sessionFile: Schema.optional(Schema.String),
  sessionId: Schema.String,
  model: Schema.optional(Schema.Struct({ provider: Schema.String, id: Schema.String })),
  thinkingLevel: Schema.optional(AtomicThinkingLevel),
});
const Resume = Schema.Struct({
  sessionFile: Schema.String,
  baselineThinkingLevel: Schema.optional(AtomicThinkingLevel),
  baselineModel: Schema.optional(Schema.String),
});
const Message = Schema.Struct({
  role: Schema.String,
  stopReason: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
});
const decodeState = Schema.decodeUnknownEffect(State);
const decodeResume = Schema.decodeUnknownEffect(Resume);
const decodeMessage = Schema.decodeUnknownOption(Message);

type Rpc = Effect.Success<ReturnType<typeof makeAtomicRpc>>;
type Session = {
  session: ProviderSession;
  scope: Scope.Closeable;
  rpc: Rpc;
  defaultModel: string | undefined;
  baselineModel: string | undefined;
  thinkingLevel: string | undefined;
  baselineThinkingLevel: string | undefined;
  itemId: RuntimeItemId;
  turnId?: TurnId | undefined;
  error?: string | undefined;
  aborted: boolean;
  closed: boolean;
  dialogs: Map<string, string>;
  tasks: AtomicTasks;
};

export const makeAtomicAdapter = Effect.fn("makeAtomicAdapter")(function* (
  settings: AtomicSettings,
  instanceId: ProviderInstanceId,
  environment: NodeJS.ProcessEnv,
  defaultCwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig;
  const observerDir = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "t3-atomic-observer-" })
    .pipe(Effect.mapError((cause) => atomicError("observer", String(cause))));
  const observerPath = `${observerDir}/observer.mjs`;
  yield* fileSystem
    .writeFileString(observerPath, atomicObserverSource)
    .pipe(Effect.mapError((cause) => atomicError("observer", String(cause))));
  const ownerScope = yield* Effect.scope;
  const events = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const sessions = new Map<ThreadId, Session>();
  const lock = yield* Semaphore.make(1);
  type Event = ProviderRuntimeEvent extends infer E
    ? E extends ProviderRuntimeEvent
      ? Pick<E, "type" | "payload"> & Partial<Pick<E, "itemId" | "requestId">>
      : never
    : never;
  const emit = (ctx: Session, event: Event) =>
    PubSub.publish(events, {
      eventId: EventId.make(NodeCrypto.randomUUID()),
      provider: PROVIDER,
      providerInstanceId: instanceId,
      threadId: ctx.session.threadId,
      createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
      ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
      ...event,
    } as ProviderRuntimeEvent).pipe(Effect.asVoid);
  const finish = (ctx: Session) =>
    Effect.gen(function* () {
      if (!ctx.turnId) return;
      yield* emit(ctx, {
        type: "turn.completed",
        payload: {
          state: ctx.error ? "failed" : ctx.aborted ? "interrupted" : "completed",
          ...(ctx.error ? { errorMessage: ctx.error } : {}),
        },
      });
      ctx.turnId = undefined;
      ctx.session = {
        ...ctx.session,
        activeTurnId: undefined,
        status: "ready",
        updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      };
    });
  const handle = (ctx: Session, frame: AtomicFrame) =>
    Effect.gen(function* () {
      if (ctx.closed) return;
      for (const event of ctx.tasks.project(frame)) yield* emit(ctx, event);
      if (frame.type === "extension_ui_request" && frame.id && frame.method) {
        if (["confirm", "select", "input", "editor"].includes(frame.method)) {
          ctx.dialogs.set(frame.id, frame.method);
          yield* emit(ctx, {
            type: "user-input.requested",
            requestId: RuntimeRequestId.make(frame.id),
            payload: {
              questions: [
                {
                  id: "answer",
                  header: "Atomic",
                  question: frame.title || "Atomic requests input",
                  options: (frame.method === "confirm" ? ["Yes", "No"] : (frame.options ?? [])).map(
                    (label) => ({ label, description: "", value: label }),
                  ),
                  allowCustomAnswer: frame.method === "input" || frame.method === "editor",
                  multiSelect: false,
                },
              ],
            },
          });
        }
        return;
      }
      if (!ctx.turnId) return;
      if (frame.type === "message_start") {
        const message = decodeMessage(frame.message);
        if (message._tag === "Some" && message.value.role === "assistant") {
          ctx.itemId = RuntimeItemId.make(NodeCrypto.randomUUID());
          yield* emit(ctx, {
            type: "item.started",
            itemId: ctx.itemId,
            payload: { itemType: "assistant_message", status: "inProgress" },
          });
        }
      } else if (frame.type === "message_update") {
        const delta = frame.assistantMessageEvent;
        if (delta?.delta && (delta.type === "text_delta" || delta.type === "thinking_delta")) {
          yield* emit(ctx, {
            type: "content.delta",
            itemId: ctx.itemId,
            payload: {
              streamKind: delta.type === "text_delta" ? "assistant_text" : "reasoning_text",
              delta: delta.delta,
            },
          });
        }
      } else if (frame.type === "message_end") {
        const message = decodeMessage(frame.message);
        if (message._tag === "Some" && message.value.role === "assistant") {
          if (message.value.stopReason === "error")
            ctx.error = message.value.errorMessage || "Atomic model request failed";
          else ctx.error = undefined;
          if (message.value.stopReason === "aborted") ctx.aborted = true;
          yield* emit(ctx, {
            type: "item.completed",
            itemId: ctx.itemId,
            payload: { itemType: "assistant_message", status: ctx.error ? "failed" : "completed" },
          });
        }
      } else if (frame.type === "tool_execution_start" || frame.type === "tool_execution_end") {
        if (frame.toolCallId)
          yield* emit(ctx, {
            type: frame.type === "tool_execution_start" ? "item.started" : "item.completed",
            itemId: RuntimeItemId.make(frame.toolCallId),
            payload: {
              itemType: "dynamic_tool_call",
              title: frame.toolName || "Tool",
              status:
                frame.type === "tool_execution_start"
                  ? "inProgress"
                  : frame.isError
                    ? "failed"
                    : "completed",
              data: frame.type === "tool_execution_start" ? frame.args : frame.result,
            },
          });
      } else if (frame.type === "agent_end") yield* finish(ctx);
    });
  const get = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const ctx = sessions.get(threadId);
      return ctx && !ctx.closed
        ? Effect.succeed(ctx)
        : Effect.fail(atomicError("session", "Atomic session is not running"));
    });
  const stop = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const ctx = sessions.get(threadId);
      if (!ctx) return;
      for (const event of ctx.tasks.unavailable()) yield* emit(ctx, event);
      ctx.closed = true;
      sessions.delete(threadId);
      yield* Scope.close(ctx.scope, Exit.void);
    });
  const unsupported = (method: string) =>
    Effect.fail(atomicError(method, `Atomic does not support ${method} in T3 Code`));
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession: (input) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (input.runtimeMode !== "full-access")
            return yield* atomicError(
              "startSession",
              "Atomic requires Full access; its CLI has no built-in sandbox or approval gate.",
            );
          yield* stop(input.threadId);
          const resume =
            input.resumeCursor === undefined
              ? undefined
              : yield* decodeResume(input.resumeCursor).pipe(
                  Effect.mapError(() => atomicError("resume", "Invalid Atomic session cursor")),
                );
          const scope = yield* Scope.fork(ownerScope);
          const args = [
            "--extension",
            observerPath,
            "--append-system-prompt",
            buildRuntimeInstructions({ harness: "Atomic" }),
            ...(resume ? ["--session", resume.sessionFile] : []),
          ];
          if (input.title) args.push("--name", input.title);
          let ctx: Session | undefined;
          const earlyFrames: AtomicFrame[] = [];
          let ready = false;
          const result = yield* Effect.gen(function* () {
            const rpc = yield* makeAtomicRpc({
              binaryPath: settings.binaryPath,
              args,
              cwd: input.cwd ?? defaultCwd,
              environment,
              onEvent: (frame) => {
                if (!ctx || !ready) {
                  if (earlyFrames.length === 512) earlyFrames.shift();
                  earlyFrames.push(frame);
                  return Effect.void;
                }
                return handle(ctx, frame);
              },
              onExit: (error) =>
                Effect.gen(function* () {
                  const current = ctx;
                  if (!current || current.closed) return;
                  current.error = error.message;
                  yield* finish(current);
                  for (const event of current.tasks.unavailable()) yield* emit(current, event);
                  current.closed = true;
                  current.session = {
                    ...current.session,
                    status: "error",
                    lastError: error.message,
                  };
                  yield* emit(current, {
                    type: "session.exited",
                    payload: { reason: error.message, recoverable: true, exitKind: "error" },
                  });
                }),
            });
            const state = yield* getState(rpc);
            const defaultModel =
              state.model && state.model.provider !== "unknown"
                ? `${state.model.provider}/${state.model.id}`
                : undefined;
            let thinkingLevel: string | undefined = state.thinkingLevel;
            const resumeBaseline =
              resume?.baselineModel === undefined || resume.baselineModel === defaultModel
                ? resume?.baselineThinkingLevel
                : undefined;
            let baselineThinkingLevel = resumeBaseline ?? state.thinkingLevel;
            let baselineModel = defaultModel;
            if (input.modelSelection?.model && input.modelSelection.model !== "default") {
              const selectedModel = input.modelSelection.model;
              if (
                selectedModel !== defaultModel &&
                resumeBaseline &&
                thinkingLevel !== resumeBaseline &&
                (yield* availableThinkingLevels(rpc)).levels.includes(resumeBaseline)
              )
                yield* setThinkingLevel(rpc, resumeBaseline);
              yield* setModel(rpc, input.modelSelection.model);
              const switchedState = yield* getState(rpc);
              thinkingLevel = switchedState.thinkingLevel;
              baselineThinkingLevel =
                selectedModel === (resume?.baselineModel ?? defaultModel)
                  ? (resume?.baselineThinkingLevel ?? switchedState.thinkingLevel)
                  : switchedState.thinkingLevel;
              if (
                baselineThinkingLevel &&
                !(yield* availableThinkingLevels(rpc)).levels.includes(baselineThinkingLevel)
              )
                baselineThinkingLevel = switchedState.thinkingLevel;
              baselineModel = selectedModel;
            }
            const requestedThinkingLevel = selectedAtomicThinkingLevel(input.modelSelection);
            if (requestedThinkingLevel === ATOMIC_DEFAULT_THINKING_LEVEL) {
              if (baselineThinkingLevel && thinkingLevel !== baselineThinkingLevel)
                thinkingLevel = yield* setThinkingLevel(rpc, baselineThinkingLevel);
            } else if (requestedThinkingLevel)
              thinkingLevel = yield* setThinkingLevel(rpc, requestedThinkingLevel);
            const now = DateTime.formatIso(DateTime.nowUnsafe());
            const session: ProviderSession = {
              provider: PROVIDER,
              providerInstanceId: instanceId,
              threadId: input.threadId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              cwd: input.cwd ?? defaultCwd,
              ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
              ...(state.sessionFile
                ? {
                    resumeCursor: {
                      sessionFile: state.sessionFile,
                      ...(baselineThinkingLevel ? { baselineThinkingLevel } : {}),
                      ...(baselineModel ? { baselineModel } : {}),
                    },
                  }
                : {}),
              createdAt: now,
              updatedAt: now,
            };
            ctx = {
              session,
              scope,
              rpc,
              defaultModel,
              baselineModel,
              thinkingLevel,
              baselineThinkingLevel,
              itemId: RuntimeItemId.make(NodeCrypto.randomUUID()),
              aborted: false,
              closed: false,
              dialogs: new Map(),
              tasks: new AtomicTasks(),
            };
            sessions.set(input.threadId, ctx);
            yield* emit(ctx, {
              type: "session.started",
              payload: { resume: session.resumeCursor },
            });
            while (earlyFrames.length > 0) {
              const frame = earlyFrames.shift();
              if (frame) yield* handle(ctx, frame);
            }
            ready = true;
            return session;
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(Scope.Scope, scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          return result;
        }),
      ),
    sendTurn: (input) =>
      lock.withPermit(
        Effect.gen(function* () {
          const ctx = yield* get(input.threadId);
          if (input.interactionMode === "plan")
            return yield* atomicError("sendTurn", "Atomic does not expose a restricted plan mode");
          const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
          for (const attachment of input.attachments ?? []) {
            if (attachment.type !== "image") continue;
            const path = resolveAttachmentPath({ attachmentsDir, attachment });
            if (!path) return yield* atomicError("sendTurn", "Invalid image attachment");
            const bytes = yield* fileSystem
              .readFile(path)
              .pipe(Effect.mapError((cause) => atomicError("attachment", String(cause))));
            images.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
          if (!input.input && images.length === 0)
            return yield* atomicError("sendTurn", "A prompt is required");
          if (input.modelSelection && input.modelSelection.model !== ctx.session.model) {
            if (ctx.turnId)
              return yield* atomicError(
                "set_model",
                "Wait for the current turn before changing models",
              );
            const model = input.modelSelection.model;
            const resolved = model === "default" ? ctx.defaultModel : model;
            if (!resolved)
              return yield* atomicError(
                "set_model",
                "Atomic has no configured default model. Choose a model from the catalog.",
              );
            if (ctx.baselineThinkingLevel && ctx.thinkingLevel !== ctx.baselineThinkingLevel) {
              const currentState = yield* getState(ctx.rpc);
              const currentModel = currentState.model
                ? `${currentState.model.provider}/${currentState.model.id}`
                : undefined;
              if (
                currentModel === ctx.baselineModel &&
                isAtomicThinkingLevel(ctx.baselineThinkingLevel) &&
                (yield* availableThinkingLevels(ctx.rpc)).levels.includes(ctx.baselineThinkingLevel)
              )
                ctx.thinkingLevel = yield* setThinkingLevel(ctx.rpc, ctx.baselineThinkingLevel);
            }
            yield* setModel(ctx.rpc, resolved);
            const switchedState = yield* getState(ctx.rpc);
            ctx.session = { ...ctx.session, model };
            ctx.thinkingLevel = switchedState.thinkingLevel;
            ctx.baselineThinkingLevel = switchedState.thinkingLevel;
            ctx.baselineModel = resolved;
            if (ctx.session.resumeCursor && typeof ctx.session.resumeCursor === "object")
              ctx.session = {
                ...ctx.session,
                resumeCursor: {
                  ...ctx.session.resumeCursor,
                  ...(ctx.baselineThinkingLevel
                    ? { baselineThinkingLevel: ctx.baselineThinkingLevel }
                    : {}),
                  baselineModel: resolved,
                },
              };
          }
          const requestedThinkingLevel = selectedAtomicThinkingLevel(input.modelSelection);
          const targetThinkingLevel =
            requestedThinkingLevel === ATOMIC_DEFAULT_THINKING_LEVEL
              ? ctx.baselineThinkingLevel
              : requestedThinkingLevel;
          if (targetThinkingLevel && targetThinkingLevel !== ctx.thinkingLevel) {
            if (ctx.turnId)
              return yield* atomicError(
                "set_thinking_level",
                "Wait for the current turn before changing reasoning effort",
              );
            ctx.thinkingLevel = yield* setThinkingLevel(ctx.rpc, targetThinkingLevel);
          }
          const steering = Boolean(ctx.turnId);
          const turnId = ctx.turnId ?? TurnId.make(NodeCrypto.randomUUID());
          if (!steering) {
            ctx.turnId = turnId;
            ctx.error = undefined;
            ctx.aborted = false;
            ctx.session = { ...ctx.session, activeTurnId: turnId, status: "running" };
            yield* emit(ctx, { type: "turn.started", payload: {} });
          }
          ctx.tasks.recordPrompt(input.input ?? "");
          yield* ctx.rpc
            .request("prompt", {
              message: input.input ?? "Describe the attached images.",
              ...(images.length ? { images } : {}),
              ...(steering ? { streamingBehavior: "steer" } : {}),
            })
            .pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  ctx.tasks.recordPrompt("");
                  if (!steering) {
                    ctx.error = error.detail;
                    yield* finish(ctx);
                  }
                  return yield* error;
                }),
              ),
            );
          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        }),
      ),
    interruptTurn: (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* get(threadId);
        ctx.aborted = true;
        yield* ctx.rpc.request("clear_queue");
        yield* ctx.rpc.request("abort");
      }),
    respondToRequest: () => unsupported("approval requests"),
    respondToUserInput: (threadId, requestId, answers) =>
      Effect.gen(function* () {
        const ctx = yield* get(threadId);
        const method = ctx.dialogs.get(requestId);
        if (!method) return yield* atomicError("userInput", "Unknown Atomic question");
        const raw = answers.answer;
        const value =
          typeof raw === "string"
            ? raw
            : Array.isArray(raw) && typeof raw[0] === "string"
              ? raw[0]
              : undefined;
        yield* ctx.rpc.write({
          type: "extension_ui_response",
          id: requestId,
          ...(method === "confirm"
            ? { confirmed: value === "Yes" }
            : value === undefined
              ? { cancelled: true }
              : { value }),
        });
        ctx.dialogs.delete(requestId);
        yield* emit(ctx, {
          type: "user-input.resolved",
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers },
        });
      }),
    stopSession: stop,
    listSessions: () => Effect.sync(() => Array.from(sessions.values(), (ctx) => ctx.session)),
    hasSession: (threadId) =>
      Effect.sync(() => Boolean(sessions.get(threadId) && !sessions.get(threadId)?.closed)),
    readThread: () => unsupported("native history inspection"),
    rollbackThread: () => unsupported("conversation rollback"),
    stopAll: () => Effect.forEach([...sessions.keys()], stop, { discard: true }),
    streamEvents: Stream.fromPubSub(events),
  };
  yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
  return adapter;
});
