# Render backend setup

The database is Neon and media is in private Cloudflare R2. Render runs the Node API and, separately, its background worker. The local migration report is [R2 verification](import-reports/r2-media-migration.json). No Render deployment has been performed by the coding task.

## API web service

Connect the `Neptun-Backend` repository and choose the intended `main` branch. The backend is already at the repository root.

| Setting | Value |
| --- | --- |
| Name | `neptun-backend` |
| Language | Node |
| Region | Frankfurt |
| Root directory | Leave empty |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Health check path | `/ready` |
| Pre-deploy command | `node dist/scripts/migrate.js` |
| Persistent disk | None; media is in R2 |

The build explicitly includes development tools because TypeScript is needed during compilation even with `NODE_ENV=production`. Start and migration use compiled JavaScript. Existing applied migrations are checked and skipped safely; do not run demo seeding against the populated Neon database.

Render supplies `PORT`. Production configuration binds to `0.0.0.0`; do not import the local loopback host or a fixed local port. The health endpoint checks database connectivity.

## Bulk environment import

Use **Environment Variables → Add from .env**. A private production file is prepared outside both repositories at `~/.local/share/neptun-broshura/render-backend.env`. It contains the Neon/R2/OpenAI connection settings and separate generated production session/upload secrets. It is intentionally not committed. Copy its complete contents into Render's importer, not into Git, issue comments, screenshots or chat.

The frontend host has not been chosen. `CORS_ORIGIN` and `PUBLIC_APP_URL` currently use an explicit `.invalid` placeholder. The API can start with this setting, but browser sign-in and account links require the real frontend origin before opening the workspace to users. Replace both values once the frontend URL is known. Add that exact origin to R2's upload CORS policy as well. Keep the local backend `.env` for local development; do not replace it with the production file.

Ensure the local code changes have been committed and pushed by the repository owner before starting Render's deploy. The deploy uses Git, not this machine's uncommitted files.

## Background worker after the API

Create a separate Render **Background Worker** from the same repository/branch and Frankfurt region. Use the same build command and `npm run start:worker` as its start command. Share the private environment through a Render environment group. Run one worker initially and stop the local worker once the hosted replacement is verified. The worker runs catalog refreshes at 03:00 Europe/Belgrade, cached media processing and queued AI only for requested new work.

Frontend login needs a same-origin API proxy or same-site custom domains with the existing secure, HttpOnly, SameSite=Lax cookies. Choose the frontend hosting route before changing cookie protections. If the frontend is a Render static site, verify `/api/*` is rewritten to the API before the SPA fallback, with `VITE_API_URL` empty. Test the final production sign-in, image inspection, upload and export on the actual domains.

References: [Render environment variables](https://render.com/docs/configure-environment-variables), [web services](https://render.com/docs/web-services), [health checks](https://render.com/docs/health-checks), [background workers](https://render.com/docs/background-workers).
