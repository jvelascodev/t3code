import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE assistants (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    profile_json TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX assistants_main ON assistants(kind) WHERE kind = 'main'`;
  yield* sql`CREATE TABLE assistant_tasks (
    thread_id TEXT PRIMARY KEY,
    assistant_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    stopped INTEGER NOT NULL DEFAULT 0,
    notification_key TEXT NOT NULL DEFAULT ''
  )`;
  yield* sql`CREATE INDEX assistant_tasks_owner ON assistant_tasks(assistant_id)`;
});
