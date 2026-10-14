-- A completed check with no suggested correction is also reusable. Scope every
-- lookup and foreign key to the organization; keep explicit regenerations separate.
CREATE TABLE ai_proofread_checks (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  cache_key text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  input_json jsonb NOT NULL,
  result_id uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','completed','failed','uncertain')),
  suggestion jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(organization_id,cache_key),
  FOREIGN KEY(organization_id,result_id) REFERENCES ai_results(organization_id,id),
  CHECK(suggestion IS NULL OR status='completed')
);
