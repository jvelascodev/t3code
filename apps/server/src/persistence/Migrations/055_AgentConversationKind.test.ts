import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("agent conversation migration", (it) => {
  it.effect(
    "preserves current and historical agent identity through replay without changing task worktrees",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 54 });
        yield* sql`INSERT INTO assistants (id, project_id, kind, profile_json) VALUES ('agent', 'project', 'project', json_object('threadId', 'current-agent', 'conversationThreadIds', json_array('historic-agent')))`;
        for (const id of ["current-agent", "historic-agent", "task"]) {
          yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, branch, worktree_path)
        VALUES (${id}, 'project', ${id}, '2026-01-01', '2026-01-01', 'feature', '/tmp/worktree')`;
          for (const [version, type] of [
            [1, "thread.created"],
            [2, "thread.meta-updated"],
          ] as const) {
            yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${`${id}-${version}`}, 'thread', ${id}, ${version}, ${type}, '2026-01-01', 'server', json_object('threadId', ${id}, 'branch', 'feature', 'worktreePath', '/tmp/worktree'), '{}')`;
          }
        }
        yield* runMigrations({ toMigrationInclusive: 55 });
        yield* sql`DELETE FROM assistants`;
        const rows = yield* sql<{
          thread_id: string;
          conversation_kind: string;
          branch: string | null;
          worktree_path: string | null;
        }>`SELECT thread_id, conversation_kind, branch, worktree_path FROM projection_threads ORDER BY thread_id`;
        for (const row of rows) {
          const agent = row.thread_id !== "task";
          assert.equal(row.conversation_kind, agent ? "agent" : "task");
          assert.equal(row.worktree_path, agent ? null : "/tmp/worktree");
          assert.equal(row.branch, agent ? null : "feature");
        }
        const events = yield* sql<{
          stream_id: string;
          event_type: string;
          conversation_kind: string | null;
          worktree_path: string | null;
          branch: string | null;
        }>`SELECT stream_id, event_type, json_extract(payload_json, '$.conversationKind') AS conversation_kind, json_extract(payload_json, '$.worktreePath') AS worktree_path, json_extract(payload_json, '$.branch') AS branch FROM orchestration_events`;
        for (const event of events) {
          const agent = event.stream_id !== "task";
          if (event.event_type === "thread.created")
            assert.equal(event.conversation_kind, agent ? "agent" : null);
          assert.equal(event.worktree_path, agent ? null : "/tmp/worktree");
          assert.equal(event.branch, agent ? null : "feature");
        }
      }),
  );
});
