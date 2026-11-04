/** Shared eligibility for an asset aliased as `a`. A rejected receipt stops
 * reuse immediately; stored bytes remain available to history and saved assets. */
export const UNREFERENCED_CUTOUT_SQL = `NOT EXISTS (
  SELECT 1 FROM (
    SELECT a.id AS asset_id
    UNION SELECT v.asset_id FROM asset_variants v
      WHERE v.organization_id=a.organization_id AND v.source_asset_id=a.id
  ) refs WHERE
    EXISTS(SELECT 1 FROM campaigns c WHERE c.organization_id=a.organization_id AND c.layout::text LIKE '%'||refs.asset_id::text||'%')
    OR EXISTS(SELECT 1 FROM social_posts p WHERE p.organization_id=a.organization_id AND p.layout::text LIKE '%'||refs.asset_id::text||'%')
    OR EXISTS(SELECT 1 FROM document_versions h WHERE h.organization_id=a.organization_id AND h.snapshot::text LIKE '%'||refs.asset_id::text||'%')
    OR EXISTS(SELECT 1 FROM settings s WHERE s.organization_id=a.organization_id AND s.value::text LIKE '%'||refs.asset_id::text||'%')
    OR EXISTS(SELECT 1 FROM organizations o WHERE o.id=a.organization_id AND o.settings::text LIKE '%'||refs.asset_id::text||'%')
    OR EXISTS(SELECT 1 FROM assets other WHERE other.organization_id=a.organization_id AND other.deleted_at IS NULL AND other.id<>a.id AND other.id<>refs.asset_id AND other.metadata::text LIKE '%'||refs.asset_id::text||'%')
)`;
