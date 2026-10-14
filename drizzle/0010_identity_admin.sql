ALTER TABLE users ADD COLUMN name text NOT NULL DEFAULT '', ADD COLUMN email_verified_at timestamptz DEFAULT now(), ADD COLUMN last_login_at timestamptz;
UPDATE users SET email_verified_at=now();
ALTER TABLE memberships ADD COLUMN account_role text NOT NULL DEFAULT 'staff' CHECK(account_role IN ('staff','pm','admin','superadmin')), ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','invited','disabled')), ADD COLUMN invited_at timestamptz;
UPDATE memberships SET account_role=CASE WHEN review_role='pm' THEN 'pm' ELSE 'staff' END;
CREATE TABLE account_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id), purpose text NOT NULL CHECK(purpose IN ('invite','password-reset')), token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, consumed_at timestamptz, code_hash text, code_expires_at timestamptz, attempts integer NOT NULL DEFAULT 0, pending_password_hash text, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,user_id) REFERENCES memberships(organization_id,user_id)
);
CREATE INDEX account_tokens_user_idx ON account_tokens(user_id,purpose) WHERE consumed_at IS NULL;
CREATE TABLE identity_rate_limits (key_hash text PRIMARY KEY, attempts integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE account_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id), actor_id uuid REFERENCES users(id), user_id uuid REFERENCES users(id), action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE email_outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), recipient text NOT NULL, kind text NOT NULL, encrypted_payload text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed')), attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, provider_id text, error text);
CREATE INDEX email_outbox_pending_idx ON email_outbox(next_attempt_at) WHERE status IN ('pending','sending');
