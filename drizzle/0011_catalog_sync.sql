CREATE TABLE catalog_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
  trigger text NOT NULL CHECK(trigger IN ('manual','daily')), created_by uuid REFERENCES users(id),
  processed integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 0,
  added integer NOT NULL DEFAULT 0, updated integer NOT NULL DEFAULT 0, missing integer NOT NULL DEFAULT 0,
  unchanged integer NOT NULL DEFAULT 0, failed_products integer NOT NULL DEFAULT 0,
  phase text NOT NULL DEFAULT 'queued', error text, hierarchy jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz,
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX catalog_sync_active_idx ON catalog_sync_runs(organization_id) WHERE status IN ('queued','running');
CREATE INDEX catalog_sync_latest_idx ON catalog_sync_runs(organization_id,created_at DESC);
ALTER TABLE products ADD COLUMN source_missing boolean NOT NULL DEFAULT false,
  ADD COLUMN source_last_seen_at timestamptz, ADD COLUMN source_missing_since timestamptz;
CREATE TABLE catalog_source_categories (
  organization_id uuid NOT NULL REFERENCES organizations(id), source_id integer NOT NULL,
  parent_source_id integer NOT NULL DEFAULT 0, name text NOT NULL, path text NOT NULL, source_url text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,source_id)
);
