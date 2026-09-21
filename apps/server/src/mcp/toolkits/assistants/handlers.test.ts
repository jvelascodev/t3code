import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AssistantProfile,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { AssistantRepository } from "../../../assistants/AssistantRepository.ts";
import { AssistantService } from "../../../assistants/AssistantService.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { AssistantsToolkitHandlersLive } from "./handlers.ts";
import { AssistantsToolkit } from "./tools.ts";

const profile: AssistantProfile = {
  id: "assistant-one",
  projectId: ProjectId.make("project-one"),
  kind: "project",
  name: "Planning",
  instructions: "Plan",
  memory: "",
  handoff: "",
  paused: false,
  threadId: ThreadId.make("assistant-thread"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-luna" },
};
const makeHarness = (caller: AssistantProfile | undefined) =>
  Effect.gen(function* () {
    let actions = 0;
    const dependencies = Layer.mergeAll(
      Layer.mock(AssistantRepository)({
        findByThread: () => Effect.succeed(caller),
      }),
      Layer.mock(AssistantService)({
        act: () => {
          actions++;
          return Effect.succeed(
            caller
              ? { assistant: caller, threadId: caller.threadId }
              : { assistant: null, threadId: null },
          );
        },
      }),
      Layer.mock(ProjectionSnapshotQuery)({}),
      Layer.mock(ProviderRegistry)({}),
    );
    const toolkit = yield* AssistantsToolkit.pipe(
      Effect.provide(AssistantsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
    );
    const call = (action: Parameters<typeof toolkit.handle<"assistant_action">>[1]) =>
      toolkit.handle("assistant_action", action).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provideService(McpInvocationContext, {
          environmentId: EnvironmentId.make("environment-one"),
          threadId: ThreadId.make("caller"),
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set<never>(),
          issuedAt: 1,
        }),
      );
    return { call, actions: () => actions };
  });

it.effect("ordinary task agents cannot create assistants", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(undefined);
    const result = yield* harness
      .call({ action: { type: "save", name: "Other", instructions: "" } })
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(harness.actions(), 0);
  }),
);
it.effect("project assistants cannot change another assistant or the environment default", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(profile);
    for (const action of [
      { type: "pause" as const, id: "someone-else", paused: true },
      { type: "set-default" as const, modelSelection: profile.modelSelection },
    ]) {
      const result = yield* harness.call({ action }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }
    assert.equal(harness.actions(), 0);
  }),
);
it.effect(
  "main assistants can create project assistants and project assistants can delegate their own work",
  () =>
    Effect.gen(function* () {
      const main = yield* makeHarness({ ...profile, kind: "main" });
      yield* main.call({
        action: { type: "save", name: "Business", instructions: "Plan operations" },
      });
      assert.equal(main.actions(), 1);
      const project = yield* makeHarness(profile);
      yield* project.call({
        action: { type: "delegate", id: profile.id, title: "Research", prompt: "Compare options" },
      });
      assert.equal(project.actions(), 1);
    }),
);
