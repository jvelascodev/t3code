import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Both legacy standalone layouts: directly under the home, or under a dev-state hash.
  yield* sql`CREATE TEMP TABLE standalone_agent_projects AS
    SELECT project_id FROM (
      SELECT project_id, replace(workspace_root, char(92), '/') AS root FROM projection_projects
    ) WHERE root LIKE '%/assistant-workspaces/' || project_id
      OR (root LIKE '%/assistant-workspaces/________________/' || project_id
        AND substr(root, -length(project_id) - 17, 16) NOT GLOB '*[^0-9a-f]*')`;
  yield* sql`UPDATE assistants SET profile_json = json_set(profile_json, '$.projectLinked', json(
    CASE WHEN kind = 'main' OR project_id IN (
      SELECT project_id FROM standalone_agent_projects
    ) THEN 'false' ELSE 'true' END
  )) WHERE json_type(profile_json, '$.projectLinked') IS NULL`;
  yield* sql`CREATE TABLE agent_execution_policies (thread_id TEXT PRIMARY KEY, coordinator_only INTEGER NOT NULL)`;
  yield* sql`INSERT OR IGNORE INTO agent_execution_policies (thread_id, coordinator_only)
    SELECT json_extract(profile_json, '$.threadId'), CASE WHEN kind = 'project' AND json_extract(profile_json, '$.projectLinked') = 1 THEN 1 ELSE 0 END
    FROM assistants WHERE json_extract(profile_json, '$.threadId') IS NOT NULL`;
  yield* sql`INSERT OR IGNORE INTO agent_execution_policies (thread_id, coordinator_only)
    SELECT history.value, CASE
      WHEN assistants.kind = 'main' THEN 0
      WHEN project.project_id IS NOT NULL THEN
        CASE WHEN project.project_id IN (SELECT project_id FROM standalone_agent_projects) THEN 0 ELSE 1 END
      WHEN json_extract(profile_json, '$.projectLinked') = 1 THEN 1 ELSE 0 END
    FROM assistants, json_each(profile_json, '$.conversationThreadIds') history
    LEFT JOIN projection_threads thread ON thread.thread_id = history.value
    LEFT JOIN projection_projects project ON project.project_id = thread.project_id`;
  yield* sql`DROP TABLE standalone_agent_projects`;
});
