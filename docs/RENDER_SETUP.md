# Render backend setup

The database is Neon and media is in private Cloudflare R2. The existing Render web service runs the API and background worker together. This keeps the initial deployment on one 512 MB service. The local migration report is [R2 verification](import-reports/r2-media-migration.json).

## API web service

Connect the `Neptun-Backend` repository and choose the intended `main` branch. The backend is already at the repository root.

| Setting            | Value                                                                |
| ------------------ | -------------------------------------------------------------------- |
| Name               | `neptun-backend`                                                     |
| Language           | Node                                                                 |
| Region             | Frankfurt                                                            |
| Root directory     | Leave empty                                                          |
| Build command      | `npm ci --include=dev && npm run build`                              |
| Start command      | `npm run start:combined` after the owner pushes the combined runtime |
| Health check path  | `/ready`                                                             |
| Pre-deploy command | `node dist/scripts/migrate.js`                                       |
| Persistent disk    | None; media is in R2                                                 |

The build explicitly includes development tools because TypeScript is needed during compilation even with `NODE_ENV=production`. Start and migration use compiled JavaScript. Existing applied migrations are checked and skipped safely; do not run demo seeding against the populated Neon database.

Render supplies `PORT`. Production configuration binds to `0.0.0.0`; do not import the local loopback host or a fixed local port. The health endpoint checks database connectivity.

## Bulk environment import

Use **Environment Variables → Add from .env**. A private production file is prepared outside both repositories at `~/.local/share/neptun-broshura/render-backend.env`. It contains the Neon/R2/OpenAI connection settings and separate generated production session/upload secrets. It is intentionally not committed. Copy its complete contents into Render's importer, not into Git, issue comments, screenshots or chat.

Production uses `CORS_ORIGIN=https://neptun.promoautomation.app` and `PUBLIC_APP_URL=https://neptun.promoautomation.app`. The frontend Cloudflare Worker uses `API_ORIGIN=https://neptun-backend.onrender.com`. Keep `VITE_API_URL` empty so browser API requests go through the frontend's same-origin `/api/*` proxy. Database, R2 and OpenAI secrets belong only in Render. Keep the local backend `.env` for local development; do not replace it with the production file.

Ensure the local code changes have been committed and pushed by the repository owner before starting Render's deploy. The deploy uses Git, not this machine's uncommitted files.

## Combined API and worker

`npm run start:combined` starts the worker, waits for its PostgreSQL readiness message, then starts the API. A startup failure or either child exiting fails the whole service so Render can restart it. SIGTERM drains both processes, with a 35-second shutdown deadline. The API receives a 192 MB JavaScript heap limit and the worker 160 MB; image processing uses one native thread and a 16 MB Sharp cache. These are heap/cache limits, not a guarantee of total process memory use. Watch Render memory under real workloads and move the worker to a separate service if usage requires it.

Until the owner pushes this source, the Render Start Command contains the same tested standalone supervisor inline as `exec node -e '…'`, using the API and worker already compiled in the deployed commit. A local copy is in the ignored `artifacts/render-combined-start-command.txt`. After pushing the source, replace the inline command with `npm run start:combined`. Do not switch commands before that source is available to Render.

The worker registers `0 3 * * *` in `Europe/Belgrade` in PostgreSQL-backed PgBoss. It catches up on startup if no successful catalog refresh exists within 24 hours. Queues handle catalog/category updates, cached media variants, and AI work requested for new content. Run one worker and stop any local production worker before activating the hosted replacement. A separate paid Background Worker is optional, not required for this initial deployment.

## Frontend and media

The Cloudflare frontend proxy preserves the existing Secure, HttpOnly, SameSite=Lax session cookies. R2 stays private; authenticated API access and signed uploads provide media access. R2 upload CORS includes the exact production frontend origin, GET/HEAD/PUT, the configured checksum headers and exposed ETag. No public R2 development URL is needed.

Verify `/ready`, frontend `/api/team/session`, both administrator roles, protected brochure access and the worker startup logs after deployment. Default operator-approved administrator accounts use regular password login; new team members use working-email invitations. See [account access](ACCOUNT_ACCESS.md) for sender configuration. Invitation delivery remains unavailable while `MAIL_DRIVER=disabled`.

References: [Render environment variables](https://render.com/docs/configure-environment-variables), [web services](https://render.com/docs/web-services), [health checks](https://render.com/docs/health-checks), [background workers](https://render.com/docs/background-workers).
