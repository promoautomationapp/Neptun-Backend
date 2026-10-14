import type { PoolClient } from "pg";
import type { Database } from "../../database/database";
import type { AiResultRow } from "../../modules/ai/domain/request";
import {
  assembleProofread,
  proofreadFields,
  suggestionSchema,
} from "../../modules/ai/domain/proofread";
import type {
  FieldCheck,
  ProofreadCheckRow,
} from "../../modules/ai/domain/proofread";
import type { JsonObject } from "../../shared/json";
import type { ProviderOutput } from "./provider";
import { ProviderHttpError, ProviderUncertainError } from "./provider";
import { z } from "zod";
const changesSchema = z.object({
  changes: z.array(
    z.object({ id: z.string(), suggested: z.string(), reason: z.string() }),
  ),
});
/** Session locks cover overlapping fields across different batches, including the
 * provider call and result persistence. Durable claims survive worker termination. */
export class ProofreadReuse {
  private constructor(
    private readonly client: PoolClient,
    private readonly result: AiResultRow,
    private readonly fields: FieldCheck[],
    private readonly locks: string[],
  ) {}
  static async acquire(
    db: Database,
    result: AiResultRow,
    regenerate: boolean,
  ): Promise<ProofreadReuse> {
    const fields = proofreadFields(
      result.organization_id,
      result.params_json,
      result.model,
      result.prompt_version,
      regenerate ? result.cache_key : undefined,
    );
    const client = await db.pool.connect();
    const locks = [
      ...new Set(
        fields.map(
          (field) => `${result.organization_id}:proofread:${field.key}`,
        ),
      ),
    ].sort();
    const acquired: string[] = [];
    try {
      for (const lock of locks) {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
          lock,
        ]);
        acquired.push(lock);
      }
      return new ProofreadReuse(client, result, fields, locks);
    } catch (error) {
      for (const lock of acquired.reverse())
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [lock],
        );
      client.release();
      throw error;
    }
  }
  async release(): Promise<void> {
    try {
      for (const lock of [...this.locks].reverse())
        await this.client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [lock],
        );
    } finally {
      this.client.release();
    }
  }
  private async checks(): Promise<Map<string, ProofreadCheckRow>> {
    const rows = (
      await this.client.query<ProofreadCheckRow>(
        "SELECT cache_key,status,result_id,suggestion FROM ai_proofread_checks WHERE organization_id=$1 AND cache_key=ANY($2::text[])",
        [this.result.organization_id, this.fields.map((field) => field.key)],
      )
    ).rows;
    return new Map(
      rows.map((row) => [
        row.cache_key,
        {
          ...row,
          suggestion: row.suggestion
            ? suggestionSchema.parse(row.suggestion)
            : null,
        },
      ]),
    );
  }
  async prepare(): Promise<{
    params: JsonObject;
    missing: FieldCheck[];
    cached: JsonObject | null;
  }> {
    const checks = await this.checks();
    const missing = [
      ...new Map(
        this.fields
          .filter((field) => checks.get(field.key)?.status !== "completed")
          .map((field) => [field.key, field]),
      ).values(),
    ];
    for (const field of missing) {
      const check = checks.get(field.key);
      if (check && check.result_id !== this.result.id) {
        // An interrupted or failed check must not silently incur another charge.
        if (check.status === "failed") throw new ProviderHttpError(400, 0);
        throw new ProviderUncertainError();
      }
    }
    if (!missing.length)
      return {
        params: this.result.params_json,
        missing,
        cached: assembleProofread(this.fields, checks),
      };
    await this.client.query("BEGIN");
    try {
      for (const field of missing)
        await this.client.query(
          "INSERT INTO ai_proofread_checks(organization_id,cache_key,model,prompt_version,input_json,result_id,status) VALUES($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT(organization_id,cache_key) DO UPDATE SET status='pending' WHERE ai_proofread_checks.result_id=EXCLUDED.result_id",
          [
            this.result.organization_id,
            field.key,
            this.result.model,
            this.result.prompt_version,
            field.input,
            this.result.id,
          ],
        );
      await this.client.query("COMMIT");
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
    return {
      params: {
        ...this.result.params_json,
        items: missing.map((field) => ({ ...field.item })),
      },
      missing,
      cached: null,
    };
  }
  async complete(
    missing: FieldCheck[],
    output: ProviderOutput,
  ): Promise<JsonObject> {
    const changes = changesSchema.parse(output.json);
    const byId = new Map(changes.changes.map((change) => [change.id, change]));
    await this.client.query("BEGIN");
    try {
      for (const field of missing) {
        const change = byId.get(field.item.id);
        const suggestion = change
          ? { suggested: change.suggested, reason: change.reason }
          : null;
        await this.client.query(
          "UPDATE ai_proofread_checks SET status='completed',suggestion=$3,completed_at=now() WHERE organization_id=$1 AND cache_key=$2 AND result_id=$4",
          [this.result.organization_id, field.key, suggestion, this.result.id],
        );
      }
      await this.client.query("COMMIT");
    } catch {
      await this.client.query("ROLLBACK");
      throw new ProviderUncertainError();
    }
    return assembleProofread(this.fields, await this.checks());
  }
  async fail(uncertain: boolean): Promise<void> {
    await this.client.query(
      "UPDATE ai_proofread_checks SET status=$3 WHERE organization_id=$1 AND result_id=$2 AND status='pending'",
      [
        this.result.organization_id,
        this.result.id,
        uncertain ? "uncertain" : "failed",
      ],
    );
  }
}
