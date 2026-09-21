import { AssistantProfile, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface StoredAssistantTask {
  readonly thread_id: string;
  readonly assistant_id: string;
  readonly title: string;
  readonly summary: string;
  readonly stopped: number;
  readonly notification_key: string;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantProfile));
  const encode = Schema.encodeEffect(Schema.fromJsonString(AssistantProfile));
  const list = Effect.fn("AssistantRepository.list")(function* () {
    const rows = yield* sql<{
      profile_json: string;
    }>`SELECT profile_json FROM assistants ORDER BY kind, id`;
    return yield* Effect.forEach(rows, (row) => decode(row.profile_json));
  });
  const save = Effect.fn("AssistantRepository.save")(function* (profile: AssistantProfile) {
    const json = yield* encode(profile);
    yield* sql`
    INSERT INTO assistants (id, project_id, kind, profile_json)
    VALUES (${profile.id}, ${profile.projectId}, ${profile.kind}, ${json})
    ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, profile_json = excluded.profile_json
  `;
  });
  const tasks = () => sql<StoredAssistantTask>`SELECT * FROM assistant_tasks ORDER BY rowid DESC`;
  const findByThread = Effect.fn("AssistantRepository.findByThread")(function* (
    threadId: ThreadId,
  ) {
    const profiles = yield* list();
    return profiles.find((profile) => profile.threadId === threadId);
  });
  return {
    list,
    save,
    tasks,
    findByThread,
    remove: (id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM assistant_tasks WHERE assistant_id = ${id}`;
          yield* sql`DELETE FROM assistants WHERE id = ${id}`;
        }),
      ),
    saveTask: (task: StoredAssistantTask) =>
      sql`
      INSERT INTO assistant_tasks ${sql.insert({ ...task })}
      ON CONFLICT(thread_id) DO UPDATE SET title = excluded.title, summary = excluded.summary,
        stopped = excluded.stopped, notification_key = excluded.notification_key
    `.pipe(Effect.asVoid),
  };
});
export class AssistantRepository extends Context.Service<
  AssistantRepository,
  Effect.Success<typeof make>
>()("t3/assistants/AssistantRepository") {}
export const layer = Layer.effect(AssistantRepository, make);
