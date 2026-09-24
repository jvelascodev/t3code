import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN conversation_kind TEXT NOT NULL DEFAULT 'task'`;
  // Preserve identity for current and historical agent conversations independently of profiles.
  yield* sql`CREATE TEMP TABLE agent_conversation_ids AS
    SELECT json_extract(profile_json, '$.threadId') AS thread_id FROM assistants
    WHERE json_extract(profile_json, '$.threadId') IS NOT NULL
    UNION
    SELECT history.value AS thread_id FROM assistants, json_each(profile_json, '$.conversationThreadIds') AS history`;
  yield* sql`UPDATE projection_threads SET conversation_kind = 'agent', branch = NULL, worktree_path = NULL
    WHERE thread_id IN (SELECT thread_id FROM agent_conversation_ids)`;
  // Rebuilding projections must retain the same purpose and workspace policy.
  yield* sql`UPDATE orchestration_events SET payload_json = json_set(payload_json,
    '$.conversationKind', 'agent', '$.branch', NULL, '$.worktreePath', NULL)
    WHERE event_type = 'thread.created' AND stream_id IN (SELECT thread_id FROM agent_conversation_ids)`;
  yield* sql`UPDATE orchestration_events SET payload_json = json_set(payload_json, '$.branch', NULL, '$.worktreePath', NULL)
    WHERE event_type = 'thread.meta-updated' AND stream_id IN (SELECT thread_id FROM agent_conversation_ids)
    AND (json_type(payload_json, '$.branch') IS NOT NULL OR json_type(payload_json, '$.worktreePath') IS NOT NULL)`;
  yield* sql`DROP TABLE agent_conversation_ids`;
});
