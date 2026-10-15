-- Review notifications and the email outbox are committed with their review event.
CREATE TABLE workspace_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  recipient_id uuid NOT NULL REFERENCES users(id),
  event_id uuid NOT NULL,
  type text NOT NULL CHECK(type IN ('review_submitted','mention','review_comment','review_reply')),
  campaign_id text NOT NULL,
  campaign_name text NOT NULL,
  page_index integer,
  comment_id text,
  actor_id uuid REFERENCES users(id),
  actor_role text NOT NULL,
  actor_name text NOT NULL,
  actor_email text,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  FOREIGN KEY(organization_id,campaign_id) REFERENCES campaigns(organization_id,id),
  FOREIGN KEY(organization_id,recipient_id) REFERENCES memberships(organization_id,user_id),
  UNIQUE(organization_id,event_id,recipient_id)
);
CREATE INDEX workspace_notifications_recipient_created ON workspace_notifications(organization_id,recipient_id,created_at DESC,id DESC);
CREATE INDEX workspace_notifications_unread ON workspace_notifications(organization_id,recipient_id,created_at DESC) WHERE read_at IS NULL;
ALTER TABLE email_outbox ADD COLUMN notification_id uuid REFERENCES workspace_notifications(id);
CREATE UNIQUE INDEX email_outbox_notification ON email_outbox(notification_id) WHERE notification_id IS NOT NULL;
ALTER TABLE activity_audit ADD COLUMN event_key text;
CREATE UNIQUE INDEX activity_audit_event ON activity_audit(organization_id,event_key) WHERE event_key IS NOT NULL;
