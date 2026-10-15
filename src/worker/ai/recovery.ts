import type { Database } from "../../database/database";

/** Do not replay an ambiguous provider call. A live queue job is never recovered
 * by age alone, and the running grace exceeds the queue's 15 minute expiry. */
export async function recoverInterruptedAiJobs(db: Database) {
  return db.transaction(async (client) => {
    const rows = await client.query<{
      id: string;
      organization_id: string;
      result_id: string;
      status: "queued" | "running";
    }>(
      `SELECT a.id,a.organization_id,a.result_id,a.status
       FROM ai_jobs a
       JOIN job_outbox o ON o.organization_id=a.organization_id
         AND o.payload->>'organizationId'=a.organization_id::text
         AND o.payload->>'jobId'=a.id::text
         AND o.queue IN ('ai-image','ai-text')
       LEFT JOIN pgboss.job q ON q.id=o.id AND q.name=o.queue
       WHERE a.status IN ('queued','running') AND o.dispatched_at IS NOT NULL
         AND (q.id IS NULL OR q.state IN ('completed','cancelled','failed'))
         AND ((a.status='queued' AND o.dispatched_at<now()-interval '2 minutes')
           OR (a.status='running' AND a.started_at<now()-interval '16 minutes'))
       ORDER BY a.created_at
       FOR UPDATE OF a SKIP LOCKED LIMIT 100`,
    );
    let failed = 0;
    let uncertain = 0;
    for (const row of rows.rows) {
      const status = row.status === "running" ? "uncertain" : "failed";
      await client.query(
        "UPDATE ai_jobs SET status=$3,last_error=$4,finished_at=now() WHERE organization_id=$1 AND id=$2",
        [
          row.organization_id,
          row.id,
          status,
          status === "uncertain"
            ? "The worker was interrupted after preparation started. Check the result before explicitly retrying."
            : "The queued preparation could not start. Use Retry to request a new version.",
        ],
      );
      await client.query(
        "UPDATE ai_results SET status=$3 WHERE organization_id=$1 AND id=$2 AND status='pending'",
        [row.organization_id, row.result_id, status],
      );
      if (status === "uncertain") uncertain++;
      else failed++;
    }
    return { failed, uncertain };
  });
}
