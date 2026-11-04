import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { JsonValue } from "../../shared/json";

/** Revalidate after externalization, inside the document transaction. SHARE
 * locks keep a cleanup worker from deleting a referenced image until save ends. */
export async function lockDocumentAssets(
  client: PoolClient,
  organizationId: string,
  document: JsonValue,
): Promise<void> {
  const ids = new Set<string>();
  const collect = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (value && typeof value === "object") {
      Object.values(value).forEach(collect);
      return;
    }
    if (typeof value !== "string") return;
    const match =
      /^\/api\/assets\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(
        value,
      );
    if (match?.[1]) ids.add(match[1].toLowerCase());
  };
  collect(document);
  if (!ids.size) return;
  const available = await client.query<{ id: string }>(
    "SELECT id FROM assets WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL ORDER BY id FOR SHARE",
    [organizationId, [...ids].sort()],
  );
  if (available.rows.length !== ids.size)
    throw new BadRequestException("Document refers to an unavailable asset.");
}
