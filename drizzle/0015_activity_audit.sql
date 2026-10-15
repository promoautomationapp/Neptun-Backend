-- Append-only application activity. Existing account_audit/document versions remain intact.
CREATE TABLE activity_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  actor_id uuid REFERENCES users(id),
  actor_role text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  method text NOT NULL,
  route text NOT NULL,
  source_ip inet,
  status_code integer NOT NULL,
  duration_ms integer NOT NULL,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_audit_org_created ON activity_audit(organization_id,created_at DESC,id DESC);
CREATE INDEX activity_audit_org_actor ON activity_audit(organization_id,actor_id,created_at DESC);
CREATE INDEX activity_audit_org_action ON activity_audit(organization_id,action,created_at DESC);
