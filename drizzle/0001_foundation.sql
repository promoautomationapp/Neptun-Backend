CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  slug text NOT NULL UNIQUE, settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE,
  password_hash text NOT NULL, must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin','editor','reviewer')),
  review_role text NOT NULL CHECK (review_role IN ('staff','pm')),
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL, role text NOT NULL, token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, accepted_at timestamptz
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, organization_id uuid NOT NULL,
  user_id uuid NOT NULL, expires_at timestamptz NOT NULL,
  FOREIGN KEY (organization_id,user_id) REFERENCES memberships(organization_id,user_id)
);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  storage_key text NOT NULL, sha256 text NOT NULL, size bigint NOT NULL, mime_type text NOT NULL,
  width integer, height integer, kind text NOT NULL DEFAULT 'original',
  source_asset_id uuid, version integer NOT NULL DEFAULT 1, metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE(organization_id,id), UNIQUE(organization_id,storage_key),
  FOREIGN KEY(organization_id,source_asset_id) REFERENCES assets(organization_id,id)
);
CREATE INDEX assets_content_idx ON assets(organization_id,sha256);
CREATE TABLE asset_variants (
  organization_id uuid NOT NULL, source_asset_id uuid NOT NULL, asset_id uuid NOT NULL,
  variant text NOT NULL, transform_version integer NOT NULL DEFAULT 1,
  PRIMARY KEY(organization_id,source_asset_id,variant,transform_version),
  FOREIGN KEY(organization_id,source_asset_id) REFERENCES assets(organization_id,id),
  FOREIGN KEY(organization_id,asset_id) REFERENCES assets(organization_id,id)
);
CREATE TABLE asset_aliases (
  organization_id uuid NOT NULL, source_path text NOT NULL, asset_id uuid NOT NULL,
  PRIMARY KEY(organization_id,source_path),
  FOREIGN KEY(organization_id,asset_id) REFERENCES assets(organization_id,id)
);
CREATE TABLE brand_assets (
  organization_id uuid NOT NULL, brand text NOT NULL, asset_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1, PRIMARY KEY(organization_id,brand,version),
  FOREIGN KEY(organization_id,asset_id) REFERENCES assets(organization_id,id)
);

CREATE FUNCTION neptun_normalize(value text) RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(lower(unaccent(coalesce(value,''))), '[^a-z0-9]+', '', 'g');
$$;
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL, name text NOT NULL, brand text NOT NULL DEFAULT '', model text NOT NULL DEFAULT '',
  ean text NOT NULL DEFAULT '', category text NOT NULL DEFAULT '', subcategory text NOT NULL DEFAULT '',
  category_path text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '', warranty text NOT NULL DEFAULT '',
  regular numeric(14,2), currency text NOT NULL DEFAULT 'EUR', specs jsonb NOT NULL DEFAULT '{}',
  availability text NOT NULL DEFAULT '', product_url text NOT NULL DEFAULT '', source jsonb NOT NULL DEFAULT '{}',
  primary_asset_id uuid, search_text text NOT NULL DEFAULT '', search_tokens text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz, UNIQUE(organization_id,id), UNIQUE(organization_id,code),
  FOREIGN KEY(organization_id,primary_asset_id) REFERENCES assets(organization_id,id)
);
CREATE FUNCTION neptun_product_search_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE value text;
BEGIN
  value := concat_ws(' ', NEW.name, NEW.brand, NEW.model, NEW.code, NEW.ean, NEW.category,
    NEW.subcategory, NEW.category_path, NEW.description, NEW.specs::text);
  NEW.search_text := neptun_normalize(value);
  NEW.search_tokens := regexp_replace(lower(unaccent(value)), '[^a-z0-9]+', ' ', 'g');
  RETURN NEW;
END;
$$;
CREATE TRIGGER products_search_trigger BEFORE INSERT OR UPDATE OF name,brand,model,code,ean,category,subcategory,category_path,description,specs
  ON products FOR EACH ROW EXECUTE FUNCTION neptun_product_search_update();
CREATE INDEX products_search_idx ON products USING gin(search_text gin_trgm_ops);
CREATE INDEX products_filters_idx ON products(organization_id,category,subcategory,brand) WHERE deleted_at IS NULL;
CREATE INDEX products_name_idx ON products(organization_id,name,id) WHERE deleted_at IS NULL;
CREATE INDEX products_ean_idx ON products(organization_id,ean) WHERE ean <> '';
CREATE TABLE product_images (
  organization_id uuid NOT NULL, product_id uuid NOT NULL, asset_id uuid NOT NULL, position integer NOT NULL,
  source_url text NOT NULL DEFAULT '', PRIMARY KEY(organization_id,product_id,asset_id),
  FOREIGN KEY(organization_id,product_id) REFERENCES products(organization_id,id),
  FOREIGN KEY(organization_id,asset_id) REFERENCES assets(organization_id,id)
);

CREATE TABLE campaigns (
  id text NOT NULL, organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL, type text NOT NULL DEFAULT '', start_date text NOT NULL DEFAULT '', end_date text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','in_review','changes_requested','completed')),
  layout jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  PRIMARY KEY(organization_id,id)
);
CREATE INDEX campaigns_list_idx ON campaigns(organization_id,updated_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE campaign_products (
  organization_id uuid NOT NULL, campaign_id text NOT NULL, code text NOT NULL, position integer NOT NULL,
  sale numeric(14,2), regular numeric(14,2), snapshot jsonb NOT NULL,
  PRIMARY KEY(organization_id,campaign_id,position),
  FOREIGN KEY(organization_id,campaign_id) REFERENCES campaigns(organization_id,id)
);
CREATE TABLE brochures (
  id text NOT NULL, organization_id uuid NOT NULL, campaign_id text NOT NULL,
  layout jsonb NOT NULL, version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,campaign_id) REFERENCES campaigns(organization_id,id)
);
CREATE TABLE brochure_pages (
  organization_id uuid NOT NULL, brochure_id text NOT NULL, page_key text NOT NULL, layout jsonb NOT NULL,
  PRIMARY KEY(organization_id,brochure_id,page_key),
  FOREIGN KEY(organization_id,brochure_id) REFERENCES brochures(organization_id,id)
);
CREATE TABLE social_posts (
  organization_id uuid NOT NULL REFERENCES organizations(id), id text NOT NULL, name text NOT NULL,
  layout jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id), deleted_at timestamptz,
  PRIMARY KEY(organization_id,id)
);
CREATE TABLE document_versions (
  organization_id uuid NOT NULL REFERENCES organizations(id), kind text NOT NULL, document_id text NOT NULL,
  version integer NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,kind,document_id,version)
);
CREATE TABLE review_threads (
  id text NOT NULL, organization_id uuid NOT NULL, campaign_id text NOT NULL, page_index integer NOT NULL,
  position jsonb, fixed boolean NOT NULL DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,campaign_id) REFERENCES campaigns(organization_id,id)
);
CREATE TABLE review_comments (
  id text NOT NULL, organization_id uuid NOT NULL, thread_id text NOT NULL, text text NOT NULL,
  author_email text NOT NULL, mention text, created_at timestamptz NOT NULL,
  PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,thread_id) REFERENCES review_threads(organization_id,id)
);
CREATE TABLE review_history (
  id text NOT NULL, organization_id uuid NOT NULL, campaign_id text NOT NULL, event jsonb NOT NULL,
  PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,campaign_id) REFERENCES campaigns(organization_id,id)
);
CREATE TABLE settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id), value jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  operation text NOT NULL, cache_key text NOT NULL, model text NOT NULL, quality text,
  params_json jsonb NOT NULL DEFAULT '{}', prompt_version text NOT NULL, source_sha256 text,
  output_asset_id uuid, output_text text, output_json jsonb,
  status text NOT NULL CHECK(status IN ('pending','completed','failed','uncertain')),
  cost_usd numeric(16,8), input_tokens bigint, output_tokens bigint,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(organization_id,id), UNIQUE(organization_id,cache_key),
  FOREIGN KEY(organization_id,output_asset_id) REFERENCES assets(organization_id,id)
);
CREATE TABLE ai_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, result_id uuid NOT NULL,
  cache_key text NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled','uncertain')),
  attempts integer NOT NULL DEFAULT 0, payload jsonb NOT NULL, last_error text, queue_id uuid,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  UNIQUE(organization_id,id), FOREIGN KEY(organization_id,result_id) REFERENCES ai_results(organization_id,id)
);
CREATE UNIQUE INDEX ai_jobs_active_key_idx ON ai_jobs(organization_id,cache_key) WHERE status IN ('queued','running');
CREATE TABLE job_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  queue text NOT NULL, job_key text NOT NULL UNIQUE, payload jsonb NOT NULL, dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, job_id uuid,
  operation text NOT NULL, model text NOT NULL, input_tokens bigint, output_tokens bigint,
  cost_usd numeric(16,8), pricing_version text, user_id uuid REFERENCES users(id), month text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,job_id) REFERENCES ai_jobs(organization_id,id)
);
CREATE INDEX ai_usage_month_idx ON ai_usage(organization_id,month);
CREATE TABLE lifestyle_quota (
  organization_id uuid NOT NULL REFERENCES organizations(id), month text NOT NULL,
  attempts integer NOT NULL DEFAULT 0, accepted integer NOT NULL DEFAULT 0,
  attempt_limit integer NOT NULL, accepted_limit integer NOT NULL,
  PRIMARY KEY(organization_id,month),
  CHECK(attempts >= 0 AND attempts <= attempt_limit), CHECK(accepted >= 0 AND accepted <= accepted_limit)
);
CREATE TABLE lifestyle_acceptances (
  organization_id uuid NOT NULL, result_id uuid NOT NULL, month text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,result_id),
  FOREIGN KEY(organization_id,result_id) REFERENCES ai_results(organization_id,id)
);
CREATE TABLE upload_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  storage_key text NOT NULL, max_size bigint NOT NULL, mime_type text NOT NULL,
  expires_at timestamptz NOT NULL, asset_id uuid, created_by uuid REFERENCES users(id),
  FOREIGN KEY(organization_id,asset_id) REFERENCES assets(organization_id,id)
);
CREATE TABLE exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
  document_id text NOT NULL, document_kind text NOT NULL, version integer NOT NULL,
  params jsonb NOT NULL, snapshot jsonb NOT NULL, status text NOT NULL DEFAULT 'queued',
  asset_id uuid, last_error text, created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  FOREIGN KEY(organization_id,asset_id) REFERENCES assets(organization_id,id)
);
CREATE TABLE import_sources (
  organization_id uuid NOT NULL REFERENCES organizations(id), source_key text NOT NULL,
  sha256 text NOT NULL, report jsonb NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,source_key,sha256)
);
