CREATE TABLE campaign_edit_presence (
  organization_id uuid NOT NULL,
  campaign_id text NOT NULL,
  session_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  mode text NOT NULL CHECK (mode IN ('edit','preview')),
  page_label text NOT NULL DEFAULT '',
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,campaign_id,session_id),
  FOREIGN KEY (organization_id,campaign_id) REFERENCES campaigns(organization_id,id)
);
CREATE INDEX campaign_presence_active_idx ON campaign_edit_presence(organization_id,campaign_id,last_seen_at);
