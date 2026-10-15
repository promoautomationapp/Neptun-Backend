import type { Database } from "../database/database";

/** Heartbeats run every 15 seconds; Render drains old workers within 35 seconds. */
export async function recoverInterruptedCatalogJobs(db: Database) {
  return db.transaction(async (client) => {
    const stale = await client.query<{
      job_id: string;
      run_id: string;
      retry_count: number;
    }>(
      `SELECT j.id job_id,r.id run_id,j.retry_count
       FROM pgboss.job j JOIN catalog_sync_runs r
         ON j.data->>'runId'=r.id::text
         AND j.data->>'organizationId'=r.organization_id::text
       WHERE j.name='catalog-refresh' AND j.state IN ('active','failed')
         AND r.status='running' AND r.heartbeat_at<now()-interval '90 seconds'
       FOR UPDATE OF j,r SKIP LOCKED LIMIT 10`,
    );
    let requeued = 0;
    let failed = 0;
    for (const row of stale.rows) {
      if (row.retry_count >= 3) {
        await client.query(
          "UPDATE pgboss.job SET state='failed',completed_on=now() WHERE name='catalog-refresh' AND id=$1",
          [row.job_id],
        );
        await client.query(
          "UPDATE catalog_sync_runs SET status='failed',phase='finished',completed_at=now(),heartbeat_at=now(),error='The worker was interrupted repeatedly. Please start a new catalog refresh.' WHERE id=$1",
          [row.run_id],
        );
        failed++;
        continue;
      }
      await client.query(
        "UPDATE pgboss.job SET state='created',started_on=NULL,completed_on=NULL,start_after=now(),retry_count=retry_count+1,output=NULL WHERE name='catalog-refresh' AND id=$1",
        [row.job_id],
      );
      await client.query(
        "UPDATE catalog_sync_runs SET status='queued',phase='recovering',heartbeat_at=now(),error=NULL WHERE id=$1",
        [row.run_id],
      );
      requeued++;
    }
    return { requeued, failed };
  });
}
