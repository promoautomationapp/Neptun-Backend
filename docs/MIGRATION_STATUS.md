# Implementation status

Updated 8 October 2026. Final acceptance is pending.

## Implemented and locally checked

- New sibling frontend/backend folders; reference project remains read-only.
- NestJS CQRS handlers, PostgreSQL migrations and idempotent Neptun/three-user seed.
- Authenticated sessions, tenant-scoped queries, local storage and R2 storage interface.
- 2,238 distinct catalog products from 2,242 CSV rows; the reference's last-duplicate ordering is preserved.
- 14,090 original local media/font files imported with checksum verification; 5,247 distinct source objects after content deduplication.
- Eight remote-only primary images downloaded into storage successfully; 2,224 products have primary assets. Fourteen products had no original primary image. Ten source records named `Error` remain explicitly recorded rather than guessed or removed.
- Original 33 cutout/8 brand caches retained as completed legacy ai_results, with unavailable input metadata explicitly recorded. Four campaigns and five social posts imported, with embedded media externalized and original document versions retained.
- Persistent campaign/post save, soft delete, review transitions, optimistic version conflicts.
- Image variant worker, AI queues, content-based image reuse and persistent per-field text reuse across overlapping batches; usage records and transactionally enforced lifestyle quotas. See AI_REUSE.md.
- Sixty-three passing backend tests: sessions, private asset isolation, upload checksum/deduplication, SVG/AVIF conversion, complete brochure persistence, native font bytes, review permissions, four undo/redo restores with current save versions, unavailable nested artwork, AI reuse/concurrent jobs, quota limits, and read-path AI policy. Full backend typecheck/build/lint pass.

- Cumulative brochure fixes are synced into the sibling frontend: semantic grouped details, Pulla/Set-row shared offers, editable three-member panels, secondary TV/phone annotations, Apple clearance, canceled gestures and local wallpaper refitting. Every chosen color/gradient/image uses the same layout rules and contrast-aware ink/text surfaces. These fields, page backgrounds, cover layers, formats and store-footer layouts round-trip through JSONB, projections and immutable versions. Deleted legacy asset targets are rejected before saving. See [BROCHURE_FIXES.md](BROCHURE_FIXES.md) and the [frontend sync report](../../neptun-broshura-frontend/docs/BROCHURE_FIXES.md).

- Shared Settings now manage the original defaults through six tabs, with uploaded/manufacturer logos, icons, cover/colors, store and contact visibility/order, category savings, formats and campaign type management. PostgreSQL migration 0004 preserves existing settings and document snapshots. Same-team saves use optimistic versions and private asset validation. Settings-scoped typecheck/lint and desktop/mobile browser checks pass; see SETTINGS.md.

## In progress / required before replacement

- 228 frontend regression/component/policy tests across 41 files pass, including Set imports, independent bundle edits, all-format geometry, factual details, price artwork, Apple clearance, screen annotations, name alignment, four-step history and all chosen backgrounds. The isolated Settings browser workflow was not rerun during this work. These checks do not prove complete editor or visual/export parity.
- Finish strict TypeScript models and component ports for brochure, social and classic editors (2,508 diagnostics in the full frontend check). New typed helpers/artwork modules have zero diagnostics; Settings typechecking passes.
- Wire paginated catalog search, spreadsheet matching, uploaded assets and asynchronous AI into all existing controls.
- The ported AI controls now use asynchronous jobs and automatic reuse; mount/print/export policy tests pass. Full editor integration and browser end-to-end verification remain pending.
- Complete server-side export rendering and all existing PDF/PNG/JPG/ZIP output variants.
- Complete classic DB persistence and browser-backup intake.
- Complete frontend behavioral, visual, font, cross-browser and export parity checks against F01–F72.
- Product search: nine representative queries across 10,000 products meet the local p95 target (< 100 ms); see search-benchmark.json.
- Full local backup and isolated pg_restore verification pass for 15,779 immutable objects; frontend/export recovery acceptance and R2 connectivity remain pending.
- Finish lint, formatting, build/CI and deployment preparation checks.

Do not infer completion from a passing backend suite. The new frontend still contains work-in-progress component ports and does not currently pass its complete TypeScript/build gate. The main page currently exposes the foundation flow and shared Settings; the full editors are not yet connected. No production deployment has occurred.
