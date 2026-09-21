import * as Schema from "effect/Schema";
import { AssistantError, supportsAgentCoordination } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AssistantRepository } from "../../../assistants/AssistantRepository.ts";
import { AssistantService } from "../../../assistants/AssistantService.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { AssistantsToolkit } from "./tools.ts";

const isAssistantError = Schema.is(AssistantError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const assistants = yield* AssistantService;
  const repository = yield* AssistantRepository;
  const snapshots = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderRegistry;
  const failure = () =>
    new AssistantError({
      message: "This operation is only available to an assistant with access to this project.",
    });
  const caller = Effect.fn("AssistantsToolkit.caller")(function* () {
    const invocation = yield* McpInvocationContext;
    const profile = yield* repository.findByThread(invocation.threadId);
    if (!profile) return yield* failure();
    return profile;
  });
  const guard = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((error) =>
        isAssistantError(error)
          ? error
          : new AssistantError({ message: "Could not read assistant state. Try again." }),
      ),
    );
  return AssistantsToolkit.of({
    assistant_status: () =>
      guard(
        Effect.gen(function* () {
          const profile = yield* caller();
          const state = yield* assistants.list();
          const shell = yield* snapshots.getShellSnapshot();
          const visible = state.assistants.filter(
            (entry) => profile.kind === "main" || entry.id === profile.id,
          );
          return encodeJson({
            currentAssistant: profile.id,
            assistants: visible,
            defaultModelSelection: state.defaultModelSelection,
            projects: shell.projects
              .filter((project) => profile.kind === "main" || project.id === profile.projectId)
              .map((project) => ({ id: project.id, title: project.title })),
            threads: shell.threads
              .filter(
                (thread) =>
                  thread.archivedAt === null &&
                  (profile.kind === "main" || thread.projectId === profile.projectId),
              )
              .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .slice(0, 100)
              .map((thread) => ({
                id: thread.id,
                projectId: thread.projectId,
                title: thread.title,
                session: thread.session?.status,
                needsApproval: thread.hasPendingApprovals,
                needsInput: thread.hasPendingUserInput,
                pullRequests: thread.pullRequests,
                observedAt: thread.updatedAt,
              })),
            providers: (yield* providers.getProviders).map((provider) => ({
              instanceId: provider.instanceId,
              provider: provider.driver,
              supportsAgentCoordination: supportsAgentCoordination(provider.driver),
              models: provider.models,
            })),
            tasks: state.tasks
              .filter((task) => visible.some((entry) => entry.id === task.assistantId))
              .map((task) => ({
                threadId: task.threadId,
                assistantId: task.assistantId,
                title: task.title,
                stopped: task.stopped,
                summary: task.summary,
                session: task.thread?.session,
                latestTurn: task.thread?.latestTurn,
                needsApproval: task.thread?.hasPendingApprovals,
                needsInput: task.thread?.hasPendingUserInput,
                pullRequests: task.thread?.pullRequests,
                observedAt: task.thread?.updatedAt,
              })),
          });
        }),
      ),
    assistant_action: ({ action }) =>
      guard(
        Effect.gen(function* () {
          const profile = yield* caller();
          if (profile.kind !== "main") {
            if (action.type === "set-default" || action.type === "open-main")
              return yield* failure();
            if (action.type === "stop-task") {
              const task = (yield* repository.tasks()).find(
                (entry) => entry.thread_id === action.threadId,
              );
              if (task?.assistant_id !== profile.id) return yield* failure();
            } else if (action.type === "save") {
              if (
                action.id !== profile.id ||
                (action.projectId && action.projectId !== profile.projectId)
              )
                return yield* failure();
            } else if (action.id !== profile.id) return yield* failure();
          }
          return yield* assistants.act(action);
        }),
      ),
    assistant_thread: ({ threadId }) =>
      guard(
        Effect.gen(function* () {
          const profile = yield* caller();
          const detail = yield* snapshots.getThreadDetailSnapshot(threadId, { turnLimit: 3 });
          if (
            Option.isNone(detail) ||
            (profile.kind !== "main" && detail.value.thread.projectId !== profile.projectId)
          )
            return yield* failure();
          const thread = detail.value.thread;
          return encodeJson({
            id: thread.id,
            title: thread.title,
            session: thread.session,
            messages: thread.messages.map((message) => ({
              role: message.role,
              text: message.text.slice(-12000),
            })),
            pullRequests: thread.pullRequests,
            updatedAt: thread.updatedAt,
          });
        }),
      ),
  });
});
export const AssistantsToolkitHandlersLive = AssistantsToolkit.toLayer(make);
