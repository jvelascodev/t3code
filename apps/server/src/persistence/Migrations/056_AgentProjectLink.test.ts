import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("agent execution migration", (it) => {
  it.effect(
    "separates standalone workspaces from linked projects and retains historical policy",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 55 });
        for (const [id, root, kind] of [
          ["linked", "/work/project", "project"],
          ["standalone", "/state/assistant-workspaces/standalone", "project"],
          ["hashed", "/state/assistant-workspaces/0123456789abcdef/hashed", "project"],
          ["main", "/state/assistant-workspaces/main", "main"],
        ]) {
          yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES (${id!}, ${id!}, ${root!}, '[]', '2026-01-01', '2026-01-01')`;
          yield* sql`INSERT INTO assistants (id, project_id, kind, profile_json)
          VALUES (${id!}, ${id!}, ${kind!}, json_object('threadId', ${id!}, 'conversationThreadIds', json_array(${id + "-old"})))`;
        }
        // Before upgrade, a standalone agent was linked to a project, and another moved back.
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at)
          VALUES ('linked-old', 'hashed', 'Previous standalone conversation', '{}', '2026-01-01', '2026-01-01'),
                 ('standalone-old', 'linked', 'Previous project conversation', '{}', '2026-01-01', '2026-01-01')`;
        yield* runMigrations();
        const profiles = yield* sql<{
          id: string;
          linked: number;
        }>`SELECT id, json_extract(profile_json, '$.projectLinked') AS linked FROM assistants`;
        for (const profile of profiles)
          assert.equal(profile.linked, profile.id === "linked" ? 1 : 0);
        yield* sql`DELETE FROM assistants`;
        const policies = yield* sql<{
          thread_id: string;
          coordinator_only: number;
        }>`SELECT * FROM agent_execution_policies`;
        assert.equal(policies.length, 8);
        for (const policy of policies)
          assert.equal(
            policy.coordinator_only,
            ["linked", "standalone-old"].includes(policy.thread_id) ? 1 : 0,
          );
      }),
  );
});
