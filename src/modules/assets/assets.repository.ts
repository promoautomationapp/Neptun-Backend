import { Inject, Injectable } from "@nestjs/common";
import { Database } from "../../database/database";
import type { JsonObject } from "../../shared/json";
export interface AssetRow {
  id: string;
  organization_id: string;
  storage_key: string;
  sha256: string;
  size: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  kind: string;
  metadata: JsonObject;
}
@Injectable()
export class AssetsRepository {
  constructor(@Inject(Database) readonly db: Database) {}
  async find(organizationId: string, id: string): Promise<AssetRow | null> {
    return (
      (
        await this.db.query<AssetRow>(
          "SELECT * FROM assets WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL",
          [organizationId, id],
        )
      )[0] ?? null
    );
  }
  async appAsset(path: string): Promise<AssetRow | null> {
    return (
      (
        await this.db.query<AssetRow>(
          "SELECT a.* FROM assets a JOIN asset_aliases aa ON aa.organization_id=a.organization_id AND aa.asset_id=a.id JOIN organizations o ON o.id=a.organization_id WHERE o.slug='neptun' AND aa.source_path=$1 AND a.kind='design' AND a.deleted_at IS NULL",
          [path],
        )
      )[0] ?? null
    );
  }
  async byAlias(
    organizationId: string,
    path: string,
  ): Promise<AssetRow | null> {
    return (
      (
        await this.db.query<AssetRow>(
          "SELECT a.* FROM assets a JOIN asset_aliases x ON x.organization_id=a.organization_id AND x.asset_id=a.id WHERE x.organization_id=$1 AND x.source_path=$2 AND a.deleted_at IS NULL",
          [organizationId, path],
        )
      )[0] ?? null
    );
  }
  async alias(
    organizationId: string,
    path: string,
    assetId: string,
  ): Promise<void> {
    await this.db.query(
      "INSERT INTO asset_aliases(organization_id,source_path,asset_id) VALUES($1,$2,$3) ON CONFLICT(organization_id,source_path) DO NOTHING",
      [organizationId, path, assetId],
    );
  }
}
