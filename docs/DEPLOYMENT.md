# Deployment preparation

No deployment is authorized or performed. Production domains and credentials are not selected yet. Finish the frontend/parity and operational gates before creating a production service.

Proposed services: Cloudflare Pages for the React/Vite build; Render API and a separate worker from this backend; one Neon PostgreSQL database; private R2 object storage. No Redis, Kafka or Docker database is required.

Build the frontend with its production `VITE_API_URL`. Configure SPA routing including `/classic`. Build the backend with `npm ci && npm run build`; API command `npm start`, worker command `npm run start:worker`; release migration `npm run db:migrate`. Supply secrets through provider environment settings, never through committed config files. Production requires `NODE_ENV=production`, `STORAGE_DRIVER=r2`, valid R2 variables, database URL, generated session/upload secrets and exact allowed CORS origins.

Prefer same-site custom domains such as `studio.example.com` and `api.example.com` for session cookies. Generic Pages/Render domains are cross-site and can encounter third-party-cookie restrictions. Test cookie, origin validation, asset CORS and image/font exports on the final domains. Set production API and worker to one instance initially; configured AI concurrency assumes one worker.

The export worker will need the matching frontend render artifact. Packaging that artifact and binding its revision to the API/worker is still in progress; do not assume the local sibling frontend directory will exist on Render. Production CI must build and validate both artifacts together, and must not automatically deploy without a separate authorized release.

Neon autosuspend is incompatible with perpetual frequent Postgres queue polling. Choose deliberate worker hours and polling frequency for actual latency requirements; a larger interval reduces query frequency but does not guarantee database sleep. The API can use a pooled `DATABASE_URL`. Set `DIRECT_DATABASE_URL` to the matching unpooled connection for the worker, migrations and backups; the worker's field-deduplication session locks require it. A known Neon pooler endpoint is rejected for these processes. See [Neon connection pooling](https://neon.com/docs/connect/connection-pooling).

Required gates: full frontend/backend strict builds, meaningful tests, F01–F72 parity sign-off, original font verification, 10,000-product search benchmark, mocked AI reuse/concurrency tests, backup/restore test, migration rerun safety, worker restart recovery and an R2 upload/read check.
