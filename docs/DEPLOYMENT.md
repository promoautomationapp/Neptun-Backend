# Production deployment

The frontend is a Cloudflare Worker at `https://neptun.promoautomation.app`, with React/Vite static assets and a same-origin `/api/*` proxy to `https://neptun-backend.onrender.com`. The backend uses Neon PostgreSQL and private Cloudflare R2. The initial Render deployment runs the API and background worker together in the existing service; an additional paid worker is optional. See [Render setup](RENDER_SETUP.md) for commands and environment configuration.

Keep frontend `VITE_API_URL` empty and set the Cloudflare runtime `API_ORIGIN` to the Render backend. Set backend `CORS_ORIGIN` and `PUBLIC_APP_URL` to the exact frontend HTTPS origin. Session cookies remain Secure, HttpOnly and SameSite=Lax. Backend database, R2, OpenAI and session secrets must never be included in the frontend build or committed to Git.

The worker handles PostgreSQL-backed queues for catalog refreshes, media variants and requested AI work. Daily catalog refresh is scheduled for 03:00 Europe/Belgrade, with startup catch-up when the last successful refresh is older than 24 hours. Run one worker initially. The combined supervisor makes startup and process failures visible to Render instead of leaving a healthy API alongside a stopped worker. Monitor memory and CPU under real workloads before increasing concurrency.

The API can use a pooled `DATABASE_URL`. Set `DIRECT_DATABASE_URL` to the matching unpooled database for the worker, migrations and backups; the worker's session locks require it. A known Neon pooler endpoint is rejected for these processes. Frequent queue polling can prevent Neon from suspending, so account for database usage as well as the Render service cost. See [Neon connection pooling](https://neon.com/docs/connect/connection-pooling).

After deployment, verify API readiness, production sign-in and roles, protected product and brochure access, private media reads, original-byte preservation, and actual queue progress. Tests use an isolated local test database and disabled mail/AI providers. Invitation and password recovery emails require a configured, verified sender; the two default operator-provisioned administrators can log in before delivery is enabled. See [account access](ACCOUNT_ACCESS.md).

Repository source changes are left for the owner to commit and push. Render builds from its configured Git revision, not from this machine's uncommitted files. Keep backups outside Git and use additive catalog updates; products missing from the website remain stored.
