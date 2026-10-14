-- Website source logos are separate from user/AI brochure brand_assets.
CREATE TABLE catalog_source_brands (
  organization_id uuid NOT NULL REFERENCES organizations(id), source_id integer NOT NULL,
  name text NOT NULL, source_url text NOT NULL, asset_id uuid,
  last_seen_at timestamptz NOT NULL DEFAULT now(), error text,
  PRIMARY KEY(organization_id,source_id),
  FOREIGN KEY(organization_id,asset_id) REFERENCES assets(organization_id,id)
);
CREATE INDEX catalog_source_brands_name_idx ON catalog_source_brands(organization_id,lower(name));
