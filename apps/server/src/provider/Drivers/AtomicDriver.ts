import {
  AtomicSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as FileSystem from "effect/FileSystem";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeAtomicAdapter } from "../atomic/AtomicAdapter.ts";
import { atomicModelCapabilities } from "../atomic/AtomicThinking.ts";
import { atomicError, makeAtomicRpc } from "../atomic/AtomicRpc.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  buildServerProvider,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER = ProviderDriverKind.make("atomic");
const defaultCapabilities = atomicModelCapabilities({});
const Models = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      provider: Schema.String,
      name: Schema.String,
      reasoning: Schema.optional(Schema.Boolean),
      thinkingLevelMap: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
    }),
  ),
});
const decodeModels = Schema.decodeUnknownEffect(Models);
const decodeSettings = Schema.decodeSync(AtomicSettings);
const presentation = {
  displayName: "Atomic",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
};
export type AtomicDriverEnv =
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerConfig
  | ServerSettingsService
  | BackgroundPolicy.BackgroundPolicy;

export const AtomicDriver: ProviderDriver<AtomicSettings, AtomicDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Atomic", supportsMultipleInstances: true },
  configSchema: AtomicSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { cwd } = yield* ServerConfig;
      const env = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stamp = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      let models: ReadonlyArray<ServerProviderModel> = [
        {
          slug: "default",
          name: "Atomic default",
          isDefault: true,
          isCustom: false,
          capabilities: defaultCapabilities,
        },
      ];
      let modelsDiscovered = false;
      const modelDiscoverySemaphore = yield* Semaphore.make(1);
      const discoverModels = (force: boolean) =>
        modelDiscoverySemaphore.withPermits(1)(
          Effect.gen(function* () {
            if (modelsDiscovered && !force) return;
            const rpc = yield* makeAtomicRpc({
              binaryPath: config.binaryPath,
              cwd,
              environment: env,
              args: [
                "--no-session",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-tools",
              ],
            });
            const result = yield* rpc
              .request("get_available_models")
              .pipe(Effect.flatMap(decodeModels));
            models = result.models.map((model) => ({
              slug: `${model.provider}/${model.id}`,
              name: model.name,
              subProvider: model.provider,
              isCustom: false,
              capabilities: atomicModelCapabilities(model),
            }));
            modelsDiscovered = true;
          }).pipe(Effect.scoped),
        );
      const build = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) => ({
        ...stamp(
          buildServerProvider({
            presentation,
            enabled,
            checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
            models: providerModelsFromSettings(models, config.customModels, defaultCapabilities),
            probe,
          }),
        ),
        supportsTextGeneration: false,
      });
      const checkProvider = Effect.gen(function* () {
        if (!enabled)
          return build({
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Atomic is disabled.",
          });
        const command = yield* resolveSpawnCommand(config.binaryPath, ["--version"], { env });
        const result = yield* spawnAndCollect(
          config.binaryPath,
          ChildProcess.make(command.command, command.args, { cwd, env, shell: command.shell }),
        ).pipe(Effect.timeout("5 seconds"));
        if (result.code !== 0) return yield* atomicError("version", "Atomic version check failed");
        if (!modelsDiscovered) {
          yield* discoverModels(false).pipe(Effect.timeout("5 seconds"), Effect.ignoreCause());
        }
        return build({
          installed: true,
          version: parseGenericCliVersion(result.stdout),
          status: modelsDiscovered && models.length > 0 ? "ready" : "warning",
          auth: { status: modelsDiscovered && models.length === 0 ? "unauthenticated" : "unknown" },
          message: !modelsDiscovered
            ? "Atomic is installed. Refresh models to check available credentials and models. Full access is required."
            : models.length === 0
              ? "No available Atomic models. Run atomic on the server and use /login, or configure an API key, then refresh models."
              : "Uses Atomic CLI credentials. Full access is required.",
        });
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            build({
              installed: false,
              version: null,
              status: "error",
              auth: { status: "unknown" },
              message:
                "Install @bastani/atomic and run atomic to sign in, or configure its binary path.",
            }),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshot = yield* makeManagedServerProvider({
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: DRIVER,
              packageName: "@bastani/atomic",
            }),
          ),
        getSettings: Effect.succeed(config),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot: () =>
          Effect.succeed(
            build({
              installed: false,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
              message: "Checking Atomic CLI availability…",
            }),
          ),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Failed to create Atomic provider",
              cause,
            }),
        ),
      );
      const adapter = yield* makeAtomicAdapter(config, instanceId, env, cwd).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Failed to load Atomic workflow observer",
              cause,
            }),
        ),
      );
      const unavailable = (operation: string) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail:
              "Atomic background text generation is not supported. Choose another provider for generated titles and Git text.",
          }),
        );
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        refreshModels: () =>
          Effect.gen(function* () {
            yield* discoverModels(true);
            yield* snapshot.refresh;
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER,
                  instanceId,
                  detail: "Could not discover Atomic models",
                  cause,
                }),
            ),
          ),
        textGeneration: {
          generateCommitMessage: () => unavailable("generateCommitMessage"),
          generatePrContent: () => unavailable("generatePrContent"),
          generateBranchName: () => unavailable("generateBranchName"),
          generateThreadTitle: () => unavailable("generateThreadTitle"),
        },
      };
    }),
};
