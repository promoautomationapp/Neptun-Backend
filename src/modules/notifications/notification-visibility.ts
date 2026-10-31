/** Rechecked on inbox reads and immediately before queued email delivery. */
export const notificationJoins = `
 LEFT JOIN campaigns c ON c.organization_id=n.organization_id AND c.id=n.campaign_id
 LEFT JOIN social_posts p ON p.organization_id=n.organization_id AND p.id=n.post_id
 JOIN memberships m ON m.organization_id=n.organization_id AND m.user_id=n.recipient_id
 JOIN users u ON u.id=m.user_id`;
export const notificationEligibility = `
 ((n.campaign_id IS NOT NULL AND c.id IS NOT NULL AND c.deleted_at IS NULL)
  OR (n.post_id IS NOT NULL AND p.id IS NOT NULL AND p.deleted_at IS NULL))
 AND n.actor_role<>'superadmin'
 AND NOT EXISTS (SELECT 1 FROM memberships sender WHERE sender.organization_id=n.organization_id
  AND sender.user_id=n.actor_id AND (sender.account_role='superadmin' OR sender.status='disabled'))
 AND m.status='active' AND m.account_role<>'superadmin' AND u.email_verified_at IS NOT NULL
 AND (n.post_id IS NULL OR m.account_role='admin' OR m.workspace_access IS NULL
  OR m.workspace_access->>'mode' IS DISTINCT FROM 'custom'
  OR coalesce(m.workspace_access->'canViewSocialPosts','true'::jsonb)='true'::jsonb)`;
