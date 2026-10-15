# Render backend setup

The database is Neon and media is in private Cloudflare R2. The existing Render web service runs the API and background worker together. This keeps the initial deployment on one 512 MB service. The local migration report is [R2 verification](import-reports/r2-media-migration.json).

## API web service

Connect the `Neptun-Backend` repository and choose the intended `main` branch. The backend is already at the repository root.

| Setting            | Value                                      |
| ------------------ | ------------------------------------------ |
| Name               | `neptun-backend`                           |
| Language           | Node                                       |
| Region             | Frankfurt                                  |
| Root directory     | Leave empty                                |
| Build command      | `npm ci --include=dev && npm run build`    |
| Start command      | `npm run start:combined`                   |
| Health check path  | `/ready`                                   |
| Pre-deploy command | Leave empty; migrations run during startup |
| Persistent disk    | None; media is in R2                       |

The build explicitly includes development tools because TypeScript is needed during compilation even with `NODE_ENV=production`. Start and migration use compiled JavaScript. Existing applied migrations are checked and skipped safely; do not run demo seeding against the populated Neon database.

Render supplies `PORT`. Production configuration binds to `0.0.0.0`; do not import the local loopback host or a fixed local port. The health endpoint checks database connectivity.

## Bulk environment import

Use **Environment Variables → Add from .env**. A private production file is prepared outside both repositories at `~/.local/share/neptun-broshura/render-backend.env`. It contains the Neon/R2/OpenAI connection settings and separate generated production session/upload secrets. It is intentionally not committed. Copy its complete contents into Render's importer, not into Git, issue comments, screenshots or chat.

Production uses `CORS_ORIGIN=https://neptun.promoautomation.app` and `PUBLIC_APP_URL=https://neptun.promoautomation.app`. The frontend Cloudflare Worker uses `API_ORIGIN=https://neptun-backend.onrender.com`. Keep `VITE_API_URL` empty so browser API requests go through the frontend's same-origin `/api/*` proxy. Database, R2 and OpenAI secrets belong only in Render. Keep the local backend `.env` for local development; do not replace it with the production file.

Ensure the local code changes have been committed and pushed by the repository owner before starting Render's deploy. The deploy uses Git, not this machine's uncommitted files.

## Combined API and worker

`npm run start:combined` first checks and applies migrations, starts the worker, waits for its PostgreSQL readiness message, then starts the API. This avoids waiting for a separate Render pre-deploy container. A migration failure prevents either process from starting; connection, lock and statement waits have bounded timeouts. Existing applied migrations are checked by checksum and skipped. A startup failure or either child exiting fails the whole service so Render can restart it. SIGTERM drains both processes, with a 35-second shutdown deadline. The API receives a 192 MB JavaScript heap limit and the worker 160 MB; image processing uses one native thread and a 16 MB Sharp cache. These are heap/cache limits, not a guarantee of total process memory use. Watch Render memory under real workloads and move the worker to a separate service if usage requires it.

The Render Start Command is `npm run start:combined`, using the supervisor committed in this repository. Keep startup code in the repository so it is reviewed, tested and built with the application. Deploy the matching source before selecting a new package script in Render.

The worker registers `0 3 * * *` in `Europe/Belgrade` in PostgreSQL-backed PgBoss. New catalog runs start only on an explicit refresh click or that daily schedule. Restarting the worker does not create a catch-up refresh. The database allows at most one new daily run per Belgrade calendar date; manual refreshes remain available. Queues handle catalog/category updates, cached media variants, and AI work requested for new content. Run one worker and stop any local production worker before activating the hosted replacement. A separate paid Background Worker is optional, not required for this initial deployment.

Catalog runs send heartbeats every 15 seconds. On startup and every 30 seconds, the worker recovers interrupted catalog jobs whose heartbeat is over 90 seconds old. Recovery updates the existing queue job and run atomically, preserves their identities, and leaves healthy runs alone. Three interrupted retries are allowed; repeated interruptions fail visibly and release the active-run constraint so an operator can start a fresh refresh. Completed product updates and media caches survive a restart.

AI work uses independent consumer slots and polls/dispatches within two seconds, even when the general queue poll interval is longer. `AI_IMAGE_CONCURRENCY` still defaults to one; increasing it requires checking memory on the combined Render service. R2 requests and complete response bodies have a 30-second deadline, with bounded read retries. A provider cooldown longer than 30 seconds ends visibly instead of blocking the photo queue or retrying before the requested cooldown. On startup and every 30 seconds, dispatched AI jobs whose PgBoss entry has ended or disappeared are reconciled: queued jobs fail after a two-minute grace; started jobs become uncertain only after 16 minutes, beyond the 15-minute queue expiry. Live queued/active/retry entries are preserved, and recovery never calls AI or generates another image. Uncertain work requires explicit review/retry, preserving the existing protection against duplicate provider charges.

## Frontend and media

The Cloudflare frontend proxy preserves the existing Secure, HttpOnly, SameSite=Lax session cookies. R2 stays private; authenticated API access and signed uploads provide media access. R2 upload CORS includes the exact production frontend origin, GET/HEAD/PUT, the configured checksum headers and exposed ETag. No public R2 development URL is needed.

Verify `/ready`, frontend `/api/team/session`, both administrator roles, protected brochure access and the worker startup logs after deployment. Default operator-approved administrator accounts use regular password login; new team members use working-email invitations. See [account access](ACCOUNT_ACCESS.md) for sender configuration. Invitation delivery remains unavailable while `MAIL_DRIVER=disabled`.

References: [Render environment variables](https://render.com/docs/configure-environment-variables), [web services](https://render.com/docs/web-services), [health checks](https://render.com/docs/health-checks), [background workers](https://render.com/docs/background-workers).
