# Project usage

The workspace's **Usage & storage** section is visible only to `superadmin` accounts. Each `/api/insights/*` endpoint checks that role and scopes its data to the signed-in organization. The legacy `/api/ai/usage` endpoint uses the same role restriction.

AI reports support all time, one day, a month, or an inclusive date range in Europe/Belgrade, with operation/model filters, daily/monthly totals, and paginated individual records. TV wallpaper generation is separated from other background images. All monetary values are USD estimates from standard provider rates; they are not invoices or account-wide billing totals.

The worker records provider token usage before validating or storing the returned media, with one ledger entry per job. Cached results do not add a ledger entry. Known token modalities and web-search calls are retained in `ai_usage.usage_json`. A versioned rate schedule calculates cost estimates without contacting AI. Older aggregate image tokens produce a cost range; historical searches without tool counts show a partial lower bound. Imported prepared results without token/cost history remain explicitly unknown. They are never treated as free, and reporting does not regenerate them to recover usage.

The R2 tab lists the current organization's `org/<organization-id>/` prefix and caches that read-only scan for one minute. It also shows active registered media, prepared results, product photos, brand logos, aliases, and variants. R2 object totals include retained objects; active database asset totals may differ. Transfer/request billing remains in Cloudflare.

Database counts are organization-scoped. Physical database/table sizes include retained history, indexes, and infrastructure and are not Neon billing totals. Credentials, connection strings, API keys, prompts, and private image URLs are not included in usage reports.
