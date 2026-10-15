import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Actor } from "../auth/domain/actor";
import { requireSocialContextAccess } from "../auth/domain/workspace-access";
import { Database } from "../../database/database";
import { env } from "../../config/environment";
import { belgradeMonth } from "./domain/request";
interface QuotaRow {
  attempts: number;
  accepted: number;
  attempt_limit: number;
  accepted_limit: number;
}
@Injectable()
export class LifestyleRepository {
  constructor(@Inject(Database) private readonly db: Database) {}
  async lock(
    client: PoolClient,
    org: string,
    month: string,
  ): Promise<QuotaRow> {
    await client.query(
      "INSERT INTO lifestyle_quota(organization_id,month,attempt_limit,accepted_limit) SELECT id,$2,coalesce((settings->>'lifestyleMonthlyAttempts')::integer,$3),coalesce((settings->>'lifestyleMonthlyLimit')::integer,$4) FROM organizations WHERE id=$1 ON CONFLICT DO NOTHING",
      [org, month, env.LIFESTYLE_MONTHLY_ATTEMPTS, env.LIFESTYLE_MONTHLY_LIMIT],
    );
    const row = (
      await client.query<QuotaRow>(
        "SELECT attempts,accepted,attempt_limit,accepted_limit FROM lifestyle_quota WHERE organization_id=$1 AND month=$2 FOR UPDATE",
        [org, month],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("Organization not found.");
    return row;
  }
  async reserveAttempt(client: PoolClient, org: string): Promise<void> {
    const month = belgradeMonth();
    const row = await this.lock(client, org, month);
    if (row.attempts >= row.attempt_limit || row.accepted >= row.accepted_limit)
      throw this.exceeded(row);
    await client.query(
      "UPDATE lifestyle_quota SET attempts=attempts+1 WHERE organization_id=$1 AND month=$2",
      [org, month],
    );
  }
  async quota(org: string) {
    const row = (
      await this.db.query<QuotaRow>(
        "SELECT attempts,accepted,attempt_limit,accepted_limit FROM lifestyle_quota WHERE organization_id=$1 AND month=$2",
        [org, belgradeMonth()],
      )
    )[0];
    if (row) return this.view(row);
    const organization = (
      await this.db.query<{
        settings: {
          lifestyleMonthlyLimit?: number;
          lifestyleMonthlyAttempts?: number;
        };
      }>("SELECT settings FROM organizations WHERE id=$1", [org])
    )[0];
    return this.view({
      attempts: 0,
      accepted: 0,
      attempt_limit:
        organization?.settings.lifestyleMonthlyAttempts ??
        env.LIFESTYLE_MONTHLY_ATTEMPTS,
      accepted_limit:
        organization?.settings.lifestyleMonthlyLimit ??
        env.LIFESTYLE_MONTHLY_LIMIT,
    });
  }
  async accept(org: string, resultId: string, actor?: Actor) {
    return this.db.transaction(async (client) => {
      const result = (
        await client.query<{
          status: string;
          operation: string;
          params_json: { context?: unknown };
        }>(
          "SELECT status,operation,params_json FROM ai_results WHERE organization_id=$1 AND id=$2",
          [org, resultId],
        )
      ).rows[0];
      if (
        !result ||
        result.operation !== "lifestyle" ||
        result.status !== "completed"
      )
        throw new NotFoundException("A completed lifestyle image is required.");
      if (actor) requireSocialContextAccess(actor, result.params_json.context);
      // Lock before checking acceptance, so repeated concurrent acceptance is idempotent.
      const month = belgradeMonth();
      const row = await this.lock(client, org, month);
      const existing =
        (
          await client.query(
            "SELECT result_id FROM lifestyle_acceptances WHERE organization_id=$1 AND result_id=$2",
            [org, resultId],
          )
        ).rows.length > 0;
      if (existing) return { accepted: true, reused: true, ...this.view(row) };
      if (row.accepted >= row.accepted_limit) throw this.exceeded(row);
      await client.query(
        "INSERT INTO lifestyle_acceptances(organization_id,result_id,month) VALUES($1,$2,$3)",
        [org, resultId, month],
      );
      await client.query(
        "UPDATE lifestyle_quota SET accepted=accepted+1 WHERE organization_id=$1 AND month=$2",
        [org, month],
      );
      return {
        accepted: true,
        reused: false,
        ...this.view({ ...row, accepted: row.accepted + 1 }),
      };
    });
  }
  private view(row: QuotaRow) {
    return {
      month: belgradeMonth(),
      used: row.accepted,
      limit: row.accepted_limit,
      attempts: row.attempts,
      attemptLimit: row.attempt_limit,
    };
  }
  private exceeded(row: QuotaRow) {
    return new ConflictException({
      error: "The monthly lifestyle image limit has been reached.",
      code: "LIFESTYLE_QUOTA_EXCEEDED",
      ...this.view(row),
    });
  }
}
