// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { mergeProviderSnapshot } from "../Layers/ProviderRegistry.ts";
import { AtomicDriver } from "./AtomicDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-atomic-driver-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
);
const windowsHost = HostProcessPlatform.defaultValue() === "win32";
it.layer(testLayer)("Atomic driver", (it) => {
  it.effect(
    "does not launch disabled instances or advertise unsupported background generation",
    () =>
      Effect.gen(function* () {
        const instance = yield* AtomicDriver.create({
          instanceId: ProviderInstanceId.make("atomic-disabled"),
          displayName: undefined,
          enabled: false,
          environment: [],
          config: AtomicDriver.defaultConfig(),
        });
        const snapshot = yield* instance.snapshot.refresh;
        expect(snapshot.status).toBe("disabled");
        expect(snapshot.supportsTextGeneration).toBe(false);
        expect(snapshot.supportsConversationRollback).toBe(false);
        expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Disabled Atomic must not spawn")),
        ),
        Effect.scoped,
      ),
  );

  it.effect.skipIf(windowsHost)(
    "discovers models during the initial provider check and supports manual refresh",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-driver-" });
        const binaryPath = `${directory}/atomic`;
        yield* fs.copyFile(
          NodeURL.fileURLToPath(new URL("../atomic/fixtures/atomic-rpc.mjs", import.meta.url)),
          binaryPath,
        );
        yield* fs.chmod(binaryPath, 0o755);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const releaseInitialCheck = yield* Deferred.make<void>();
        const gatedSpawner = ChildProcessSpawner.make((command) =>
          command._tag === "StandardCommand" && command.args.includes("--version")
            ? Deferred.await(releaseInitialCheck).pipe(Effect.andThen(spawner.spawn(command)))
            : spawner.spawn(command),
        );
        const instance = yield* AtomicDriver.create({
          instanceId: ProviderInstanceId.make("atomic-catalog"),
          displayName: "My Atomic",
          enabled: true,
          environment: [],
          config: { ...AtomicDriver.defaultConfig(), binaryPath },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, gatedSpawner));
        const initialUpdate = yield* instance.snapshot.streamChanges.pipe(
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseInitialCheck, undefined);
        expect(yield* Fiber.join(initialUpdate)).toMatchObject({
          _tag: "Some",
          value: { status: "ready", models: [{ slug: "fixture/test" }] },
        });
        const initial = yield* instance.snapshot.getSnapshot;
        expect(initial).toMatchObject({
          installed: true,
          version: "1.0.0",
          status: "ready",
          displayName: "My Atomic",
          driver: "atomic",
        });
        expect(initial.models.map((model) => model.slug)).toEqual(["fixture/test"]);
        expect(instance.refreshModels).toBeDefined();
        yield* instance.refreshModels!();
        const refreshed = yield* instance.snapshot.getSnapshot;
        expect(refreshed.status).toBe("ready");
        expect(refreshed.models.map((model) => model.slug)).toEqual(["fixture/test"]);
        expect(mergeProviderSnapshot(initial, refreshed).models).toEqual(refreshed.models);
        const fixture = yield* fs.readFileString(binaryPath);
        yield* fs.writeFileString(
          binaryPath,
          fixture.replace('[{ provider: "fixture", id: "test", name: "Test model" }]', "[]"),
        );
        yield* instance.refreshModels!();
        const empty = yield* instance.snapshot.getSnapshot;
        expect(empty).toMatchObject({
          installed: true,
          status: "warning",
          auth: { status: "unauthenticated" },
          models: [],
        });
        expect(empty.message).toContain("/login");
        expect(mergeProviderSnapshot(refreshed, empty).models).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("retries discovery after an initial RPC failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-atomic-driver-" });
      const binaryPath = `${directory}/atomic`;
      const fixture = yield* fs.readFileString(
        NodeURL.fileURLToPath(new URL("../atomic/fixtures/atomic-rpc.mjs", import.meta.url)),
      );
      const failing = fixture.replace(
        'response(command, { models: [{ provider: "fixture", id: "test", name: "Test model" }] })',
        'emit({ type: "response", id: command.id, success: false, error: "Unavailable" })',
      );
      yield* fs.writeFileString(binaryPath, failing);
      yield* fs.chmod(binaryPath, 0o755);
      const instance = yield* AtomicDriver.create({
        instanceId: ProviderInstanceId.make("atomic-retry"),
        displayName: undefined,
        enabled: true,
        environment: [],
        config: { ...AtomicDriver.defaultConfig(), binaryPath },
      });
      const unavailable = yield* instance.snapshot.refresh;
      expect(unavailable).toMatchObject({ installed: true, status: "warning" });
      yield* fs.writeFileString(binaryPath, fixture);
      const recovered = yield* instance.snapshot.refresh;
      expect(recovered).toMatchObject({ installed: true, status: "ready" });
      expect(recovered.models.map((model) => model.slug)).toEqual(["fixture/test"]);
    }).pipe(Effect.scoped),
  );
});
