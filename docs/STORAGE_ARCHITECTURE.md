# Database and file storage

The brochure frontend contains application code and the Excel parser, not a copy of the product image library. It reads catalog data, campaigns, settings and edits through the authenticated API. PostgreSQL stores these records, document versions, asset ownership and immutable file keys. Uploads, originals, fonts, logos, generated images and their variants use the backend storage adapter; documents retain durable `/api/assets/<id>` references rather than embedded file bytes.

The browser keeps the current editor state in memory. Catalog startup loads the metadata/code index in bounded pages. Alternate photo lists are requested for a selected product only when its image editor opens. The browser may cache private HTTP responses and UI preferences; these are not the canonical campaign or file store.

## Development

With `STORAGE_DRIVER=local`, only the API and worker access files. Defaults are `~/.local/share/neptun-broshura/objects` and `~/.local/share/neptun-broshura/backups`, outside both source projects. Override them with absolute `LOCAL_STORAGE_DIR` and `BACKUP_DIR` values in the backend `.env`. Existing installations with `./storage` must move their objects and update the path together while the API/worker are stopped. Never point an existing database at an empty directory.

On 12 October 2026 this machine's objects and backups were moved intact to those defaults. All 15,779 registered objects passed SHA-256 verification after the move. Nothing was deleted. The API and worker were restarted with the updated private configuration.

## Deployment

Use PostgreSQL for records and private Cloudflare R2 for files. The existing R2 adapter uses backend-only credentials, tenant keys and presigned uploads/downloads. `NODE_ENV=production` rejects the local storage driver. Follow [R2 setup](R2_SETUP.md) to copy/checksum-verify existing files, switch the driver and restart API/worker. Cloudflare credentials are not configured on this machine yet; no remote migration or deployment has occurred.

A frontend can be hosted on Cloudflare Pages. The current NestJS API, PgBoss worker and Sharp image processing require a Node runtime; R2 is object storage, not a host for those processes or a PostgreSQL replacement. A Workers-only deployment would require a separate runtime/queue/image-processing migration. Do not ship development media, backups, `.env` or `node_modules` as frontend assets.
