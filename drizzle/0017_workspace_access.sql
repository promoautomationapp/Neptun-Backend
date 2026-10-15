-- Null retains the role's existing workspace access. Only staff/PM memberships use overrides.
ALTER TABLE memberships ADD COLUMN workspace_access jsonb;
ALTER TABLE memberships ADD CONSTRAINT membership_workspace_access_object CHECK(workspace_access IS NULL OR jsonb_typeof(workspace_access)='object');
