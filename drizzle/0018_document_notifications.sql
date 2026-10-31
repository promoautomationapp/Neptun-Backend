ALTER TABLE workspace_notifications ALTER COLUMN campaign_id DROP NOT NULL;
ALTER TABLE workspace_notifications ADD COLUMN post_id text;
ALTER TABLE workspace_notifications ADD CONSTRAINT workspace_notifications_post_fk
  FOREIGN KEY(organization_id,post_id) REFERENCES social_posts(organization_id,id);
ALTER TABLE workspace_notifications ADD CONSTRAINT workspace_notifications_one_document
  CHECK(num_nonnulls(campaign_id,post_id)=1);
ALTER TABLE workspace_notifications DROP CONSTRAINT workspace_notifications_type_check;
ALTER TABLE workspace_notifications ADD CONSTRAINT workspace_notifications_type_check
  CHECK(type IN ('review_submitted','mention','review_comment','review_reply','review_resolved','review_completed','review_reopened'));
