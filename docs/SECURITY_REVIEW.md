# Security review — 2 November 2026

## Production verification — 2 November

- Cloudflare's zone dashboard confirms network-layer and SSL/TLS DDoS rules are **Active**, and its HTTP DDoS managed ruleset is always enabled. These reduce attack traffic; they are not a guarantee of uninterrupted service under every attack.
- Added the available Free-plan rate limiting rule **Neptun API request flood protection** (`5a994cc07c7749c0a854281d15adf3ee`). It matches only `neptun.promoautomation.app` API paths, excluding `/api/assets/`, and blocks a client IP for 10 seconds after more than 300 matching requests in 10 seconds. The saved rule is **Active**. Media keeps its separate application limits so normal grids can load many photos. This does not add a paid subscription. No flood/load test was performed against production.
- There are no custom WAF rules or separately configured managed WAF rulesets in the zone dashboard. Application SQL parameterization and rich-text sanitization remain necessary; do not claim a managed SQL/XSS WAF ruleset is deployed.
- Bounded live probes returned: `/ready` 200; direct Render session request 403 `EDGE_REQUIRED`; the same request with a forged approved Origin 403 `EDGE_REQUIRED`; correctly signed private session probe 200. A 200 anonymous session envelope does not grant a user session or data access.
- A read-only PostgreSQL check found 11 `neptun_runtime` connections and one owner connection from the operator check itself. The runtime credential remains restricted. R2 still reports **Public Access: Disabled**.
- Both frontend and backend `npm audit --omit=dev` reports contain zero known vulnerabilities as of this check. This is dependency advisory coverage, not proof that application code is vulnerability-free.
- The reviewed query paths bind input values through PostgreSQL parameters, including product search, document/settings reads and writes, and account management. Tenant and role checks are server-side. No SQL injection or stored-script execution path was found in the reviewed code and focused regressions; this is not an exhaustive penetration test.
- The image admission update passes all 360 backend tests, including isolated database/API integration, plus lint and production build. HTTP media reads reserve at most 64 MiB across eight active responses, with at most 64 waiting requests and a 10-second queue timeout. Stored-image reads enforce both recorded and streamed size (maximum 32 MiB, preserving the existing 22 MiB asset). Reservations remain held until the response finishes/disconnects; stalled responses close after 120 seconds.
- Upload confirmations have two active slots before database/object work. Repeated confirmations of the same organization/upload share one in-flight result; this preserves idempotency without repeated decoding. SVG/AVIF canonical conversion has one active slot and four bounded waiters, so normal two-image batches still succeed. Busy responses use 429 and Retry-After. Background thumbnail processing has its existing separate queue and pixel cap; do not describe these new HTTP/canonical limits as a global limit on every image operation in every process.
- Public sign-in branding and the explicitly allowlisted brochure fonts are intentionally readable through the platform. Tenant asset IDs/legacy aliases require a session and tenant checks. Custom HTTPS image URLs are still permitted by the editor; do not claim that arbitrary user-added remote images can only load through R2.

## Shipped application controls

- Browser API calls use the frontend's same-origin `/api/*` Worker proxy. The fixed upstream cannot be replaced through a path or query. Production's approved frontend origin is `https://neptun.promoautomation.app`.
- Optional private edge authentication uses HMAC-SHA256, a dedicated server-only `EDGE_PROXY_SECRET`, a 60-second timestamp window and a signature bound to method, path/query, client address and frontend origin. All application routes reject direct calls when the secret is configured. Only GET/HEAD readiness/liveness and static browser metadata are exempt. Origin/CORS alone is not this authentication mechanism.
- Reserved edge/forwarding headers are replaced at Cloudflare. Backend IP-based controls trust the signed address only; Express trust proxy remains disabled. Backend forwarding secrets never belong in a `VITE_*` variable or browser bundle.
- Durable atomic limits default to 60 API requests/second and 600/minute per client, with a separate 120/second and 2,400/minute allowance for media reads. Existing login/account restrictions remain. A bounded in-process denial cache and admission cap prevent unlimited pending rate-limit SQL queries.
- New provider jobs are capped per organization at 240/15 minutes and 960/hour. Reused/cached jobs do not spend this allowance. These are job admission limits, not a guaranteed monetary budget; provider retries remain bounded separately.
- Password hashing/verification has two in-flight slots and no waiting queue. Request body buffering has four slots and a 32 MiB reservation budget, with parser byte caps, smaller account-request limits, compressed-body rejection and bounded HTTP header/request timeouts.
- Public readiness queries are coalesced and cached for five seconds (one second after failure). Liveness has no database query.
- Upload confirmation bounds R2/local object reads using both metadata and actual streamed bytes. Oversized reads stop and are not retried. Existing MIME/image/SVG validation, tenant ownership and SSRF protections remain in place.
- Shared rich text rejects scripts/events, arbitrary CSS/classes and unsafe link targets. The frontend adds a restrictive script CSP, anti-framing, MIME, referrer and permission headers while retaining inline layout styles needed by the editor.
- PostgreSQL client connections verify TLS certificates and enable channel binding. SQL-shaped inputs and cross-organization access are covered by regressions. This is evidence for the reviewed paths, not a guarantee that all future changes are safe.
- Both production dependency trees had zero reported production vulnerabilities after compatible patch updates. Development-only moderate advisories remain; no forced major tool migration was performed.

## Actual console checks

- The security release is deployed: Render backend `7a54486`, Cloudflare frontend `541f067`. The later runtime-only start command deployment also succeeded; `/ready` returned 200.
- R2 `neptun-studio-assets`: Public Access disabled, no public custom domain, public development URL disabled. Upload CORS lists only the production frontend and local development origin with GET/HEAD/PUT and checksum headers.
- R2 lifecycle contains the default incomplete multipart abort rule. It does **not** delete expired single-object staging uploads. Presigned upload URLs are temporary bearer capabilities; object confirmation limits do not cap the storage cost of an abandoned direct upload. Scope any future staging cleanup specifically to expired staging keys, never the final `org/` asset tree.
- Neon production: TLS 1.3 client connection authorized; no IP allowlist. The current Launch plan does not offer allowlisting/private networking in the console. Do not disable public networking without a working private path. History retention displayed six hours; current backup/restore operations need a separate operational review.
- The paired Cloudflare/Render edge secret is active. Live checks on 1 November returned 403 `EDGE_REQUIRED` for direct Render session requests, including a forged approved Origin; a correctly signed private probe returned 200. After the matching frontend deployment completed, the existing authenticated browser session loaded 17 campaigns and all 46 campaign-screen images. No bucket access was made public.
- Render's restricted `neptun_runtime` credential switch is active: the post-deployment database check found 10 runtime connections and `/ready` returned 200. The owner credential remains an operator rollback credential outside Git. All 42 application tables still have RLS disabled. See [the runtime role plan](DATABASE_SECURITY.md) for the full isolated API/queue checks and future migration prerequisites.

## Activate private Render admission

The code is backward compatible while this setting is absent, so deploying before the paired secret is installed does not interrupt the team. It also means direct Render calls remain possible until these steps finish. Production logs emit an explicit warning when the gate is absent.

1. Generate one dedicated random secret of at least 32 characters outside Git. Never reuse session, upload, database or R2 credentials.
2. On the Cloudflare **neptun-front Worker → Settings → Variables and Secrets**, add a runtime **Secret** named `EDGE_PROXY_SECRET`. Keep `PUBLIC_APP_ORIGIN=https://neptun.promoautomation.app`. Install the Worker side first and wait until its code/secret deployment is active.
3. On **Render → Neptun-Backend → Environment**, add the same `EDGE_PROXY_SECRET` and deploy/restart. Do not reveal it in logs, screenshots or chat.
4. Verify the frontend can read its own `/api/team/session` and authenticated media. Verify direct Render `/api/team/session` returns 403, including when a caller forges an approved Origin. `/ready` must still return its health status.
5. Confirm login and invitation/reset limits use different actual client addresses, not a common proxy address. No production load test is needed.

Entering new credentials through the browser requires the account owner to take over. The account owner completed entry and the production verification in step 4 passed on 1 November 2026. For future rotations, wait for the matching frontend deployment before checking the pair; an older Worker version can temporarily fail private admission after backend enforcement activates.

## Limits of this work

Application controls reduce abuse and bound several resource costs. They do not guarantee prevention of distributed denial of service or attacks against the hosting network. Edge/WAF policies, provider account access/MFA, staging cleanup and backup retention remain operational controls to review. Runtime credential reduction is now active; tenant RLS and Neon network allowlisting remain separate work. Do not present a hidden API hostname or an approved Origin as a substitute for authorization.
