import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { AssistantService } from "./AssistantService.ts";

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const assistants = yield* AssistantService;
  const start = Effect.fn("AssistantReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    const worker = yield* makeDrainableWorker((_item: void) =>
      assistants
        .reconcile()
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Assistant coordination could not process an update", { error }),
          ),
        ),
    );
    yield* events.pipe(
      Stream.filter(
        (event) =>
          event.type === "thread.session-set" ||
          event.type === "thread.turn-diff-completed" ||
          (event.type === "thread.activity-appended" &&
            ["approval.requested", "user-input.requested", "runtime.error"].includes(
              event.payload.activity.kind,
            )),
      ),
      Stream.runForEach(() => worker.enqueue(undefined)),
      Effect.forkScoped,
    );
    yield* worker.enqueue(undefined);
    return worker;
  });
  return { start };
});
export class AssistantReactor extends Context.Service<
  AssistantReactor,
  Effect.Success<typeof make>
>()("t3/assistants/AssistantReactor") {}
export const layer = Layer.effect(AssistantReactor, make);
