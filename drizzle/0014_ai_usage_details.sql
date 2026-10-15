ALTER TABLE ai_usage ADD COLUMN usage_json jsonb NOT NULL DEFAULT '{}';
CREATE INDEX ai_usage_dates_idx ON ai_usage(organization_id,created_at);
CREATE UNIQUE INDEX ai_usage_job_idx ON ai_usage(organization_id,job_id) WHERE job_id IS NOT NULL;
