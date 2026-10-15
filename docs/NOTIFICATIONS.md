# Review notifications

Run normal migrations before starting this version. `0016_notifications.sql` adds persistent, recipient-scoped workspace notifications, links mention emails to the existing encrypted outbox, and gives notification audit events stable deduplication keys. No additional service is needed: the existing email dispatcher delivers mention emails.

Review writes, notifications, creation audit entries and mention email jobs commit in the same database transaction. A failed review or stale version creates none of them. Each review event has at most one notification per recipient. New email jobs do not replace older mention emails.

| Review action                                | In-app recipients                                                                          | Email recipients       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------- |
| Staff/admin submits a brochure               | All active PMs in the organization, including legacy staff memberships with PM review role | None                   |
| Comment or reply explicitly mentions members | Every mentioned active organization member                                                 | Every mentioned member |
| PM comments without mentions                 | All active staff                                                                           | None                   |
| Staff replies to a thread                    | Its PM author and PM participants                                                          | Explicit mentions only |

Recipients exclude the actor, support superadmins, invited/disabled accounts, unverified accounts and members of other organizations. A mentioned recipient who is also a workflow recipient gets one notification, classified as `mention`. Email delivery rechecks account access and brochure visibility immediately before sending. Support-authored notifications use `Workspace team`, no actor email, and redact support email addresses from the campaign name and quoted comment.

`POST /api/team/campaigns/:id/review` accepts `mentions: string[]` (up to 20) as canonical member emails. The legacy `mention` string remains accepted. Both are normalized and deduplicated; any invalid target rejects the complete action. Saved comments/replies contain the full `mentions` array and retain its first value in `mention` for older clients. `GET /api/team/members` returns active verified non-support members to every caller, including support callers: `{id,name,email,role,username}`. Username currently falls back to the email prefix.

`GET /api/notifications` returns the newest 50 visible items and an `unreadCount` across all visible items. `?filter=unread` returns the newest 50 unread items, so an older unread notification remains reachable. Each item has `id`, `type` (`review_submitted`, `mention`, `review_comment`, `review_reply`), `campaignId`, `campaignName`, nullable `pageIndex` and `commentId`, `actorName`, nullable `actorEmail`, `message`, `createdAt` and nullable `readAt`.

`POST /api/notifications/:id/read` and `POST /api/notifications/read-all` return `{read:true}`. A notification cannot be read on behalf of another recipient or tenant. Repeated acknowledgements create no extra audit events. Disabled brochures disappear from notifications and unread counts. There is no notification hard-delete endpoint.

Mention emails link to `/?campaign=<id>&page=<zero-based index>&comment=<thread id>` on `PUBLIC_APP_URL`. The HTML and text variants include the campaign, page and safely escaped comment. Creation, reading and delivered/terminally failed email events enter the activity ledger. Read events retain the request IP. The original review request is also audited with its actor and IP. Ordinary admin activity visibility continues to hide support operations.

The encrypted outbox, retries, provider idempotency and SMTP tracing follow [account email operations](ACCOUNT_ACCESS.md). A successful review means the notification and email are queued, not that an external mailbox has delivered the email. Tests use the isolated test database and a disabled or mocked sender; they send no real emails.
