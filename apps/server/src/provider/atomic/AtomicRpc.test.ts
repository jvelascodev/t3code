// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as NodeURL from "node:url";
import { makeAtomicRpc } from "./AtomicRpc.ts";

const windowsHost = HostProcessPlatform.defaultValue() === "win32";
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "atomic-rpc-test-" });
  const binaryPath = `${cwd}/atomic`;
  yield* fs.copyFile(
    NodeURL.fileURLToPath(new URL("./fixtures/atomic-rpc.mjs", import.meta.url)),
    binaryPath,
  );
  yield* fs.chmod(binaryPath, 0o755);
  const received = yield* Deferred.make<void>();
  const rpc = yield* makeAtomicRpc({
    binaryPath,
    cwd,
    environment: process.env,
    requestTimeout: "20 millis",
    onEvent: (frame) =>
      frame.type === "pending_rpc"
        ? Deferred.succeed(received, undefined).pipe(Effect.asVoid)
        : Effect.void,
  });
  return { rpc, received };
});

it.live.skipIf(windowsHost)(
  "allows a prompt and an abort to respond after the control deadline",
  () =>
    Effect.gen(function* () {
      const { rpc } = yield* setup;
      expect(yield* rpc.request("prompt", { message: "slow-rpc" })).toEqual({ accepted: true });
      expect(yield* rpc.request("abort", { delayResponse: true })).toEqual(undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(windowsHost)("times out a control request that never responds", () =>
  Effect.gen(function* () {
    const { rpc } = yield* setup;
    const result = yield* rpc.request("never_respond").pipe(
      Effect.as("responded"),
      Effect.catch((error) => Effect.succeed(error.detail)),
    );
    expect(result).toContain("timed out");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(windowsHost)("fails a pending prompt when its session closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const { rpc, received } = yield* setup.pipe(Scope.provide(scope));
    const pending = yield* rpc.request("prompt", { message: "pending-rpc" }).pipe(
      Effect.as("responded"),
      Effect.catch((error) => Effect.succeed(error.detail)),
      Effect.forkChild,
    );
    yield* Deferred.await(received);
    yield* Scope.close(scope, Exit.void);
    expect(yield* Fiber.join(pending)).toContain("Atomic session closed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
