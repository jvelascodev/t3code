import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { ProviderAdapterRequestError } from "../Errors.ts";

export const AtomicFrame = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  success: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.Unknown),
  assistantMessageEvent: Schema.optional(
    Schema.Struct({
      type: Schema.String,
      delta: Schema.optional(Schema.String),
      contentIndex: Schema.optional(Schema.Int),
    }),
  ),
  toolCallId: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
  method: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.String)),
});
export type AtomicFrame = typeof AtomicFrame.Type;
const encodeFrame = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(AtomicFrame));

export const atomicError = (method: string, detail: string) =>
  new ProviderAdapterRequestError({ provider: "atomic", method, detail });

/** One scoped Atomic process. Only LF delimits RPC frames; Unicode separators are content. */
export const makeAtomicRpc = Effect.fn("makeAtomicRpc")(function* (options: {
  binaryPath: string;
  args?: ReadonlyArray<string>;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  onEvent?: (frame: AtomicFrame) => Effect.Effect<void>;
  onExit?: (error: ProviderAdapterRequestError) => Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawn = yield* resolveSpawnCommand(
    options.binaryPath,
    ["--mode", "rpc", ...(options.args ?? [])],
    { env: options.environment },
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawn.command, spawn.args, {
        cwd: options.cwd,
        env: options.environment,
        shell: spawn.shell,
      }),
    )
    .pipe(Effect.mapError((cause) => atomicError("spawn", String(cause))));
  const input = yield* Queue.unbounded<Uint8Array>();
  const pending = new Map<string, Deferred.Deferred<unknown, ProviderAdapterRequestError>>();
  let sequence = 0;
  let failure: ProviderAdapterRequestError | undefined;
  let buffer = "";
  let stderr = "";
  const fail = (error: ProviderAdapterRequestError) =>
    Effect.gen(function* () {
      if (failure) return;
      failure = error;
      for (const waiter of pending.values()) yield* Deferred.fail(waiter, error);
      pending.clear();
      yield* options.onExit?.(error) ?? Effect.void;
      yield* child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore);
    });
  yield* Stream.fromQueue(input).pipe(
    Stream.run(child.stdin),
    Effect.catch((cause) => fail(atomicError("stdin", String(cause)))),
    Effect.forkScoped,
  );
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        stderr = (stderr + chunk).slice(-4000);
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, "");
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          const frame = yield* decodeFrame(line).pipe(
            Effect.mapError(() => atomicError("decode", "Invalid Atomic RPC frame")),
          );
          if (frame.type === "response" && frame.id) {
            const waiter = pending.get(frame.id);
            if (waiter) {
              if (frame.success) yield* Deferred.succeed(waiter, frame.data);
              else
                yield* Deferred.fail(
                  waiter,
                  atomicError("response", frame.error ?? "Atomic rejected the request"),
                );
            }
          } else yield* options.onEvent?.(frame) ?? Effect.void;
        }
      }),
    ),
    Effect.catch((cause) => fail(atomicError("stdout", String(cause)))),
    Effect.andThen(
      Effect.suspend(() => fail(atomicError("exit", stderr.trim() || "Atomic RPC stream closed"))),
    ),
    Effect.forkScoped,
  );
  const write = (frame: Readonly<Record<string, unknown>>) =>
    Effect.gen(function* () {
      if (failure) return yield* failure;
      const encoded = yield* encodeFrame(frame).pipe(
        Effect.mapError((cause) => atomicError("encode", String(cause))),
      );
      yield* Queue.offer(input, new TextEncoder().encode(encoded + "\n"));
    });
  const request = (type: string, fields: Readonly<Record<string, unknown>> = {}) =>
    Effect.gen(function* () {
      const id = String(++sequence);
      const waiter = yield* Deferred.make<unknown, ProviderAdapterRequestError>();
      pending.set(id, waiter);
      return yield* write({ ...fields, type, id }).pipe(
        Effect.andThen(Deferred.await(waiter)),
        Effect.timeout("30 seconds"),
        Effect.catchTag("TimeoutError", () => {
          const error = atomicError(type, "Atomic RPC request timed out");
          return fail(error).pipe(Effect.andThen(Effect.fail(error)));
        }),
        Effect.mapError((cause) => atomicError(type, String(cause))),
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id);
          }),
        ),
      );
    });
  yield* Effect.addFinalizer(() => fail(atomicError("close", "Atomic session closed")));
  return { request, write };
});
