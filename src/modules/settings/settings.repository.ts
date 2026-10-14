import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { Database } from "../../database/database";
import { resolveSettings } from "./domain/settings.schema";
import type { WorkspaceSettings } from "./domain/settings.schema";
import type { JsonObject } from "../../shared/json";
export interface SettingsSnapshot {
  settings: WorkspaceSettings | null;
  version: number;
  updatedAt: string | null;
}
@Injectable()
export class SettingsRepository {
  constructor(@Inject(Database) private readonly db: Database) {}
  async get(organizationId: string): Promise<SettingsSnapshot> {
    const row = (
      await this.db.query<{
        value: JsonObject;
        version: number;
        updated_at: Date;
      }>(
        "SELECT value,version,updated_at FROM settings WHERE organization_id=$1",
        [organizationId],
      )
    )[0];
    return row
      ? {
          settings: resolveSettings(row.value),
          version: row.version,
          updatedAt: row.updated_at.toISOString(),
        }
      : { settings: null, version: 0, updatedAt: null };
  }
  async save(
    organizationId: string,
    value: WorkspaceSettings,
    expectedVersion: number,
  ): Promise<SettingsSnapshot> {
    return this.db.transaction(async (client) => {
      // This lock also serializes the first save, before a settings row exists.
      await client.query(
        "SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
        [organizationId],
      );
      const current = await client.query<{ version: number }>(
        "SELECT version FROM settings WHERE organization_id=$1",
        [organizationId],
      );
      const version = current.rows[0]?.version ?? 0;
      if (expectedVersion !== version)
        throw new ConflictException({
          error:
            "Someone else updated Settings. Reload the latest settings before saving your changes.",
          code: "SETTINGS_VERSION_CONFLICT",
        });
      const result = await client.query<{ version: number; updated_at: Date }>(
        "INSERT INTO settings(organization_id,value) VALUES($1,$2) ON CONFLICT(organization_id) DO UPDATE SET value=EXCLUDED.value,version=settings.version+1,updated_at=now() RETURNING version,updated_at",
        [organizationId, value],
      );
      const saved = result.rows[0];
      if (!saved) throw new Error("Settings were not saved.");
      return {
        settings: value,
        version: saved.version,
        updatedAt: saved.updated_at.toISOString(),
      };
    });
  }
}
