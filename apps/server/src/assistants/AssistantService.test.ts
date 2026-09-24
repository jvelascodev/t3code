import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as Repository from "./AssistantRepository.ts";
import * as Service from "./AssistantService.ts";
import { assistantInstructions } from "./assistantPolicy.ts";

const testLayer = Service.layer.pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provide(
    Layer.mock(ProviderAdapterRegistry)({
      getInstanceInfo: (instanceId) =>
        Effect.succeed({
          instanceId,
          driverKind: ProviderDriverKind.make(instanceId),
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind: ProviderDriverKind.make(instanceId),
            continuationKey: instanceId,
          },
        }),
    }),
  ),
  Layer.provideMerge(OrchestrationLayerLive),
  Layer.provide(Layer.mock(GitWorkflowService)({ isRepository: () => Effect.succeed(false) })),
  Layer.provide(Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) })),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-assistants-test-" })),
  Layer.provide(NodeServices.layer),
);
const stamp = "2026-09-21T10:00:00.000Z";
const session = (threadId: ThreadId, status: "running" | "ready" | "error", suffix: string) =>
  Effect.flatMap(OrchestrationEngineService, (engine) =>
    engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`server:provider-session-set:${suffix}`),
      threadId,
      session: {
        threadId,
        status,
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: status === "error" ? "Test failure" : null,
        updatedAt: stamp,
      },
      createdAt: stamp,
    }),
  );

it.layer(testLayer)("AssistantService", (it) => {
  it.effect(
    "creates a non-Git project, defaults to Codex, and keeps one assistant per project",
    () =>
      Effect.gen(function* () {
        const service = yield* Service.AssistantService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const first = yield* service.act({
          type: "save",
          name: "Business",
          instructions: "Research competitors.",
        });
        assert.isNotNull(first.assistant);
        const profile = first.assistant!;
        assert.equal(profile.modelSelection.instanceId, "codex");
        const project = yield* snapshots.getProjectShellById(profile.projectId);
        assert.isTrue(Option.isSome(project));
        const collision = yield* service
          .act({
            type: "save",
            projectId: profile.projectId,
            name: "Replacement",
            instructions: "Overwrite",
          })
          .pipe(Effect.result);
        assert.equal(collision._tag, "Failure");
        assert.equal((yield* service.list()).assistants[0]!.name, "Business");
        const update = yield* service.act({
          type: "save",
          id: profile.id,
          projectId: profile.projectId,
          name: "Operations",
          instructions: "Plan operations.",
        });
        assert.equal(update.assistant?.id, profile.id);
        assert.equal(
          (yield* service.list()).assistants.filter(
            (entry) => entry.projectId === profile.projectId,
          ).length,
          1,
        );
      }),
  );

  it.effect(
    "keeps agent conversation identity independent of the profile and task workspace choices",
    () =>
      Effect.gen(function* () {
        const service = yield* Service.AssistantService;
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const repository = yield* Repository.AssistantRepository;
        const created = yield* service.act({
          type: "save",
          name: "Workspace coordinator",
          instructions: "Plan",
        });
        const opened = yield* service.act({ type: "open", id: created.assistant!.id });
        const current = Option.getOrThrow(yield* snapshots.getThreadShellById(opened.threadId!));
        assert.equal(current.worktreePath, null);
        assert.equal(current.branch, null);
        const invalidWorkspace = yield* engine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("legacy-coordinator-worktree"),
            threadId: current.id,
            worktreePath: "/tmp/legacy-agent-worktree",
            branch: "legacy",
          })
          .pipe(Effect.result);
        assert.equal(invalidWorkspace._tag, "Failure");
        yield* service.act({ type: "open", id: created.assistant!.id });
        const repaired = Option.getOrThrow(yield* snapshots.getThreadShellById(current.id));
        assert.equal(repaired.worktreePath, null);
        assert.equal(repaired.branch, null);
        const fresh = yield* service.act({ type: "open", id: created.assistant!.id, fresh: true });
        const next = Option.getOrThrow(yield* snapshots.getThreadShellById(fresh.threadId!));
        assert.equal(next.projectId, current.projectId);
        assert.equal(next.worktreePath, null);
        assert.equal(next.branch, null);
        assert.equal(current.conversationKind, "agent");
        assert.equal(next.conversationKind, "agent");
        const task = yield* service.act({
          type: "delegate",
          id: created.assistant!.id,
          title: "Business task",
          prompt: "Research",
        });
        assert.equal(
          Option.getOrThrow(yield* snapshots.getThreadShellById(task.threadId!)).conversationKind,
          "task",
        );
        yield* repository.remove(created.assistant!.id);
        const replacement = yield* service.act({
          type: "save",
          projectId: current.projectId,
          name: "Replacement",
          instructions: "Plan",
        });
        const repurposed = yield* service
          .act({
            type: "delegate",
            id: replacement.assistant!.id,
            threadId: current.id,
            title: "Not a task",
            prompt: "Implement",
          })
          .pipe(Effect.result);
        assert.equal(repurposed._tag, "Failure");

        assert.equal(
          Option.getOrThrow(yield* snapshots.getThreadShellById(current.id)).conversationKind,
          "agent",
        );
      }),
  );

  it.effect("reassigns an idle agent without moving conversations or project memory", () =>
    Effect.gen(function* () {
      const service = yield* Service.AssistantService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const created = yield* service.act({
        type: "save",
        name: "Reassign",
        instructions: "Coordinate",
      });
      const original = yield* service.act({ type: "open", id: created.assistant!.id });
      const policies = yield* Repository.AssistantRepository;
      assert.isFalse(original.assistant!.projectLinked);
      assert.isFalse(yield* policies.isCoordinatorThread(original.threadId!));
      yield* service.act({
        type: "remember",
        id: original.assistant!.id,
        memory: "Old project decision",
      });
      const target = yield* service.act({ type: "save", name: "Destination", instructions: "" });
      const action = {
        type: "save" as const,
        id: original.assistant!.id,
        projectId: target.assistant!.projectId,
        name: "Reassign",
        instructions: "Coordinate",
      };
      const occupied = yield* service.act(action).pipe(Effect.result);
      assert.equal(occupied._tag, "Failure");
      yield* service.act({ type: "delete", id: target.assistant!.id });
      yield* session(original.threadId!, "running", "reassign-busy");
      const busy = yield* service.act(action).pipe(Effect.result);
      assert.equal(busy._tag, "Failure");
      yield* session(original.threadId!, "ready", "reassign-ready");
      const moved = yield* service.act(action);
      assert.equal(moved.assistant!.id, original.assistant!.id);
      assert.isTrue(moved.assistant!.projectLinked);
      assert.isTrue(yield* policies.isCoordinatorThread(moved.threadId!));
      assert.isFalse(yield* policies.isCoordinatorThread(original.threadId!));
      assert.equal(moved.assistant!.projectId, target.assistant!.projectId);
      assert.equal(moved.assistant!.memory, "");
      assert.equal(moved.assistant!.handoff, "");
      assert.include(moved.assistant!.conversationThreadIds!, original.threadId!);
      assert.notEqual(moved.threadId, original.threadId);
      assert.equal(
        Option.getOrThrow(yield* snapshots.getThreadShellById(original.threadId!)).projectId,
        original.assistant!.projectId,
      );
      assert.equal(
        Option.getOrThrow(yield* snapshots.getThreadShellById(moved.threadId!)).projectId,
        target.assistant!.projectId,
      );
      const back = yield* service.act({ ...action, projectId: original.assistant!.projectId });
      assert.equal(back.assistant!.projectId, original.assistant!.projectId);
      yield* service.act({ type: "delete", id: back.assistant!.id });
      assert.isTrue(yield* policies.isCoordinatorThread(moved.threadId!));
    }),
  );

  it.effect("opening the main assistant twice reuses its conversation", () =>
    Effect.gen(function* () {
      const service = yield* Service.AssistantService;
      const first = yield* service.act({ type: "open-main" });
      const second = yield* service.act({ type: "open-main" });
      assert.equal(first.threadId, second.threadId);
      assert.equal(first.assistant?.kind, "main");
    }),
  );

  it.effect("delegates visible threads and stops new work while paused", () =>
    Effect.gen(function* () {
      const service = yield* Service.AssistantService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const created = yield* service.act({
        type: "save",
        name: "Research",
        instructions: "Research business questions.",
      });
      const id = created.assistant!.id;
      const task = yield* service.act({
        type: "delegate",
        id,
        title: "Competitors",
        prompt: "Compare three competitors.",
      });
      const detail = yield* snapshots.getThreadDetailById(task.threadId!);
      assert.isTrue(Option.isSome(detail));
      if (Option.isSome(detail))
        assert.include(detail.value.messages[0]!.text, "Compare three competitors.");
      assert.isTrue(
        (yield* service.list()).tasks.some((entry) => entry.threadId === task.threadId),
      );
      yield* service.act({ type: "pause", id, paused: true });
      const rejected = yield* service
        .act({ type: "delegate", id, title: "More", prompt: "More research" })
        .pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      yield* service.act({ type: "pause", id, paused: false });
      const resumed = yield* service.act({
        type: "delegate",
        id,
        title: "More",
        prompt: "More research",
      });
      assert.isNotNull(resumed.threadId);
    }),
  );

  it.effect("retains memory and recent conversation when opening a fresh conversation", () =>
    Effect.gen(function* () {
      const service = yield* Service.AssistantService;
      const engine = yield* OrchestrationEngineService;
      const created = yield* service.act({
        type: "save",
        name: "Planning",
        instructions: "Plan my business.",
      });
      const opened = yield* service.act({ type: "open", id: created.assistant!.id });
      yield* service.act({
        type: "remember",
        id: created.assistant!.id,
        memory: "Launch in October.",
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("handoff-message"),
        threadId: opened.threadId!,
        message: {
          messageId: MessageId.make("handoff-message"),
          role: "user",
          text: "We sell handmade furniture.",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: stamp,
      });
      yield* session(opened.threadId!, "ready", "handoff-ready");
      const fresh = yield* service.act({ type: "open", id: created.assistant!.id, fresh: true });
      assert.notEqual(fresh.threadId, opened.threadId);
      assert.deepEqual(fresh.assistant?.conversationThreadIds, [opened.threadId!]);
      assert.equal(fresh.assistant?.memory, "Launch in October.");
      assert.include(assistantInstructions(fresh.assistant!), "handmade furniture");
      const adoption = yield* service
        .act({
          type: "delegate",
          id: created.assistant!.id,
          threadId: opened.threadId!,
          title: "Hidden task",
          prompt: "Research",
        })
        .pipe(Effect.result);
      assert.equal(adoption._tag, "Failure");
      assert.isFalse(
        (yield* service.list()).tasks.some((task) => task.threadId === opened.threadId),
      );
    }),
  );

  it.effect("changes the default only for future assistants", () =>
    Effect.gen(function* () {
      const service = yield* Service.AssistantService;
      const old = yield* service.act({ type: "save", name: "Before default", instructions: "" });
      const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-luna" };
      yield* service.act({ type: "set-default", modelSelection: model });
      const next = yield* service.act({ type: "save", name: "After default", instructions: "" });
      assert.deepEqual(next.assistant?.modelSelection, model);
      assert.notEqual(old.assistant?.modelSelection.model, model.model);
    }),
  );

  it.effect("notifies an idle coordinator once and defers updates while it is busy", () =>
    Effect.gen(function* () {
      const service = yield* Service.AssistantService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const created = yield* service.act({
        type: "save",
        name: "Coordinator",
        instructions: "Coordinate tasks.",
      });
      const task = yield* service.act({
        type: "delegate",
        id: created.assistant!.id,
        title: "Analysis",
        prompt: "Analyze the market.",
      });
      const coordinatorId = task.assistant!.threadId!;
      yield* session(coordinatorId, "running", "coordinator-busy");
      yield* session(task.threadId!, "ready", "task-ready");
      yield* service.reconcile();
      const busyDetail = yield* snapshots.getThreadDetailById(coordinatorId);
      assert.equal(Option.getOrThrow(busyDetail).messages.length, 0);
      yield* session(coordinatorId, "ready", "coordinator-ready");
      yield* service.reconcile();
      yield* service.reconcile();
      const detail = Option.getOrThrow(yield* snapshots.getThreadDetailById(coordinatorId));
      assert.equal(detail.messages.length, 1);
      assert.equal(detail.runtimeMode, "full-access");
      assert.include(detail.messages[0]!.text, task.threadId!);
      const stopped = yield* service
        .act({ type: "stop-task", threadId: task.threadId! })
        .pipe(Effect.result);
      assert.equal(stopped._tag, "Failure");
      assert.isFalse(
        (yield* service.list()).tasks.find((entry) => entry.threadId === task.threadId)!.stopped,
      );
    }),
  );

  it.effect("rejects adopting a thread belonging to another project", () =>
    Effect.gen(function* () {
      const service = yield* Service.AssistantService;
      const first = yield* service.act({ type: "save", name: "First", instructions: "" });
      const second = yield* service.act({ type: "save", name: "Second", instructions: "" });
      const task = yield* service.act({
        type: "delegate",
        id: first.assistant!.id,
        title: "Owned task",
        prompt: "Research",
      });
      const result = yield* service
        .act({
          type: "delegate",
          id: second.assistant!.id,
          threadId: task.threadId!,
          title: "Other project",
          prompt: "Research",
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
  it.effect("limits queued tasks before provider sessions start", () =>
    Effect.gen(function* () {
      const service = yield* Service.AssistantService;
      const created = yield* service.act({ type: "save", name: "Queue", instructions: "" });
      const id = created.assistant!.id;
      for (let i = 0; i < 3; i++)
        yield* service.act({ type: "delegate", id, title: `Task ${i}`, prompt: "Research" });
      const fourth = yield* service
        .act({ type: "delegate", id, title: "Fourth", prompt: "Research" })
        .pipe(Effect.result);
      assert.equal(fourth._tag, "Failure");
      const removal = yield* service.act({ type: "delete", id }).pipe(Effect.result);
      assert.equal(removal._tag, "Failure");
    }),
  );

  it.effect("switches provider without changing task ownership or saved memory", () =>
    Effect.gen(function* () {
      const service = yield* Service.AssistantService;
      const created = yield* service.act({
        type: "save",
        name: "Switch",
        instructions: "Help with planning",
      });
      const id = created.assistant!.id;
      const task = yield* service.act({ type: "delegate", id, title: "Plan", prompt: "Plan" });
      yield* service.act({ type: "remember", id, memory: "Launch in October" });
      const changed = yield* service.act({
        type: "save",
        id,
        name: "Switch",
        instructions: "Help with planning",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
      });
      assert.notEqual(changed.threadId, task.assistant!.threadId);
      assert.equal(changed.assistant?.memory, "Launch in October");
      const owned = (yield* service.list()).tasks.find(
        (entry) => entry.threadId === task.threadId,
      )!;
      assert.equal(owned.assistantId, id);
      assert.equal(owned.thread?.modelSelection.instanceId, "codex");
      yield* session(task.threadId!, "ready", "resume-original-provider");
      const incompatible = yield* service
        .act({
          type: "delegate",
          id,
          threadId: task.threadId!,
          title: "Wrong provider",
          prompt: "Continue",
          modelSelection: changed.assistant!.modelSelection,
        })
        .pipe(Effect.result);
      assert.equal(incompatible._tag, "Failure");
      assert.equal((yield* service.list()).tasks[0]!.title, "Plan");
      yield* service.act({
        type: "delegate",
        id,
        threadId: task.threadId!,
        title: "Continue plan",
        prompt: "Continue",
      });
      const continued = (yield* service.list()).tasks[0]!;
      assert.equal(continued.thread?.modelSelection.instanceId, "codex");
      assert.equal(continued.title, "Continue plan");
    }),
  );
  it.effect("defaults agent conversations to Full access and preserves explicit overrides", () =>
    Effect.gen(function* () {
      const service = yield* Service.AssistantService;
      const snapshots = yield* ProjectionSnapshotQuery;
      const engine = yield* OrchestrationEngineService;
      const main = yield* service.act({ type: "open-main" });
      assert.equal(
        Option.getOrThrow(yield* snapshots.getThreadShellById(main.threadId!)).runtimeMode,
        "full-access",
      );
      const saved = yield* service.act({
        type: "save",
        name: "Manager",
        instructions: "Coordinate",
      });
      const opened = yield* service.act({ type: "open", id: saved.assistant!.id });
      assert.equal(
        Option.getOrThrow(yield* snapshots.getThreadShellById(opened.threadId!)).runtimeMode,
        "full-access",
      );
      yield* engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("test-agent-permission-override"),
        createdAt: stamp,
        threadId: opened.threadId!,
        runtimeMode: "approval-required",
      });
      yield* service.act({ type: "open", id: saved.assistant!.id });
      assert.equal(
        Option.getOrThrow(yield* snapshots.getThreadShellById(opened.threadId!)).runtimeMode,
        "approval-required",
      );
      const task = yield* service.act({
        type: "delegate",
        id: saved.assistant!.id,
        title: "Task",
        prompt: "Investigate",
      });
      assert.equal(
        Option.getOrThrow(yield* snapshots.getThreadShellById(task.threadId!)).runtimeMode,
        "full-access",
      );
      yield* session(task.threadId!, "ready", "permission-task-ready");
      yield* engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("test-task-permission-override"),
        createdAt: stamp,
        threadId: task.threadId!,
        runtimeMode: "approval-required",
      });
      yield* service.act({
        type: "delegate",
        id: saved.assistant!.id,
        threadId: task.threadId!,
        title: "Continue",
        prompt: "Continue",
      });
      assert.equal(
        Option.getOrThrow(yield* snapshots.getThreadShellById(task.threadId!)).runtimeMode,
        "approval-required",
      );
      const fresh = yield* service.act({ type: "open", id: saved.assistant!.id, fresh: true });
      assert.equal(
        Option.getOrThrow(yield* snapshots.getThreadShellById(fresh.threadId!)).runtimeMode,
        "full-access",
      );
    }),
  );
  it.effect(
    "uses Full access for Atomic instances and upgrades existing supervised conversations",
    () =>
      Effect.gen(function* () {
        const service = yield* Service.AssistantService;
        const settings = yield* ServerSettingsService;
        const snapshots = yield* ProjectionSnapshotQuery;
        const engine = yield* OrchestrationEngineService;
        const instanceId = ProviderInstanceId.make("business-runtime");
        yield* settings.updateSettings({
          providerInstances: {
            [instanceId]: { driver: ProviderDriverKind.make("atomic"), enabled: true },
          },
        });
        const created = yield* service.act({
          type: "save",
          name: "Atomic",
          instructions: "Research",
          modelSelection: { instanceId, model: "default" },
        });
        const opened = yield* service.act({ type: "open", id: created.assistant!.id });
        const instructions = assistantInstructions(opened.assistant!, false);
        assert.notInclude(instructions, "Use assistant_action");
        assert.include(instructions, "coordination tools are unavailable");
        assert.include(instructions, "Research");
        assert.equal(
          Option.getOrThrow(yield* snapshots.getThreadShellById(opened.threadId!)).runtimeMode,
          "full-access",
        );
        yield* engine.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("test-atomic-supervised"),
          createdAt: stamp,
          threadId: opened.threadId!,
          runtimeMode: "approval-required",
        });
        yield* service.act({ type: "open", id: created.assistant!.id });
        assert.equal(
          Option.getOrThrow(yield* snapshots.getThreadShellById(opened.threadId!)).runtimeMode,
          "full-access",
        );
        const task = yield* service.act({
          type: "delegate",
          id: created.assistant!.id,
          title: "Atomic task",
          prompt: "Research",
        });
        assert.equal(
          Option.getOrThrow(yield* snapshots.getThreadShellById(task.threadId!)).runtimeMode,
          "full-access",
        );
        const codex = yield* service.act({
          type: "delegate",
          id: created.assistant!.id,
          title: "Codex task",
          prompt: "Research",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-luna" },
        });
        assert.equal(
          Option.getOrThrow(yield* snapshots.getThreadShellById(codex.threadId!)).runtimeMode,
          "full-access",
        );
      }),
  );
});
