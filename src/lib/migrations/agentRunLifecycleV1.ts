import type { Knex } from "knex";

export async function repairDuplicateRunningAgentRuns(knex: Knex) {
  if (!(await knex.schema.hasTable("o_agentRun")) || !(await knex.schema.hasTable("o_agentRunEvent"))) return 0;

  let interrupted = 0;
  await knex.transaction(async (trx) => {
    const duplicateScopes = await trx("o_agentRun")
      .where({ status: "running" })
      .select("agentKey", "projectId", "scriptId")
      .groupBy("agentKey", "projectId", "scriptId")
      .havingRaw("COUNT(*) > 1");
    const timestamp = Date.now();
    for (const scope of duplicateScopes) {
      const runs = await trx("o_agentRun")
        .where({ ...scope, status: "running" })
        .orderBy("heartbeatAt", "desc")
        .orderBy("startedAt", "desc")
        .orderBy("id", "desc")
        .select("runId");
      for (const duplicate of runs.slice(1)) {
        await trx("o_agentRun").where({ runId: duplicate.runId, status: "running" }).update({
          status: "interrupted",
          reason: "Duplicate active Agent Run scope was interrupted during database recovery.",
          finishedAt: timestamp,
          updatedAt: timestamp,
        });
        await trx("o_agentRunEvent").insert({
          runId: duplicate.runId,
          eventType: "active_scope_deduplicated",
          payloadJson: JSON.stringify({ reason: "duplicate_running_scope", keptRunId: runs[0]?.runId ?? null }),
          createdAt: timestamp,
        });
        interrupted += 1;
      }
    }
  });
  return interrupted;
}
