# Brochure persistence and asset compatibility

Verified 8 October 2026 against the sibling frontend and the read-only reference project. These checks validate the backend document contract; they do not mark the unfinished editor migration or server export worker ready for production.

## Preserved document data

Campaigns and social posts retain their full JSON layout through DTO validation and PostgreSQL persistence. Unknown nested artwork fields are preserved instead of reduced to a fixed list of product or layout properties. No additional database migration is required for these brochure additions.

The regression fixture includes independent non-blue page colors, mixed gradients and image backgrounds using the frontend's canonical field names, uploaded page layers, cover logo visibility and placement, blue/gray and orange price styles, factual mobile detail rows and movable detail blocks, Apple price and screen-size flags, compact stores/footer selection and placement, and recursively nested bundles. A bundle keeps one parent offer with its regular/sale prices; member photos, coordinates and TV wallpapers stay inside that offer's snapshot.

Three-member Set offers also preserve `setSourceRows`, member codes, one shared price, replaceable brand artwork, panel color, independently moved member photos and member-detail overrides. Nested TV/phone annotation coordinates and wallpaper source metadata survive the same save/version path. Frontend grouping and contrast rules apply to every selected background; the backend preserves those values without imposing a blue palette.

The latest layout feedback is also covered by that round-trip fixture: `autoProductLayout`, an explicit `duo4` page override (two products per row), `reviewPagePlacements` for reflowed review anchors, manual TV annotation coordinates/scale, and Apple photo/price/savings placements all survive save and reload. The frontend owns default grouping, product-name divider alignment and collision-free display; those rules require no new database migration and do not rewrite saved placement values.

The fixture also retains an Apple device inside a nested mixed-product offer. Its brand, member image and manual photo position remain available after reloading so the frontend can apply the same Apple clearance rule to combined and additional photos. Grouped detail text and catalog facts remain complete JSON values; automatic display grouping does not replace saved manual detail lists.

`campaigns.layout`, `brochures.layout`, `campaign_products.snapshot`, `brochure_pages.layout` and immutable `document_versions.snapshot` retain the same complete artwork data. Normalized numeric price columns are projections for querying; they do not replace the original product snapshot or its price text. Importing an already-existing document remains idempotent. Existing document versions and saved layouts are not rewritten by this change.

Uploaded assets are canonical `/api/assets/<uuid>` references. Recursive asset rewriting covers bundle members, screen wallpaper, page backgrounds, artwork layers, footer logos and every other nested JSON field. Repeated embedded image bytes deduplicate to one tenant-owned asset. Referenced UUIDs are checked in one batched tenant-scoped query.

## Asset validation correction

Known legacy aliases now join their target asset and reject deleted targets before saving a document. Previously, the alias lookup could normalize a deleted image to an apparently valid UUID reference. This guard also covers aliases nested inside bundle wallpapers or page layers. Unknown legacy paths remain unchanged for backward-compatible intake; references to known deleted assets return an unavailable-asset error.

No AI calls, cutout generation, external provider requests, application-database writes or production migrations were used for this audit.

## SVG and AVIF compatibility

Upload intents and the raw HTTP parser now accept SVG and AVIF. Actual input format and MIME are validated, then Sharp converts them to transparent PNG before hashing and storage. Embedded document media uses the same conversion path, including base64/percent-encoded SVG and base64 AVIF. These are deterministic conversions and do not use AI.

The existing 12 MB HTTP, 32 MB embedded-media and 67-million-pixel limits remain. Existing PNG/JPEG/WebP/GIF bytes and font/PDF handling are preserved. Tests cover real authenticated upload/confirmation/private retrieval and nested-document conversion/deduplication.

## Undo and optimistic versions

The frontend keeps the last four edit snapshots. Undo and redo restore full artwork snapshots while retaining the latest server version and review metadata, then use the normal campaign save endpoint. Every successful save advances the database version and writes a new immutable snapshot. The backend deliberately retains more than four historical versions; the four-step limit belongs to the editor's user-facing history.

The integration regression performs four edits followed by four undo saves and four redo saves, verifies all artwork fields after each restore and checks versions advance from 1 through 13. An outdated version returns `VERSION_CONFLICT` without overwriting the current layout. Existing workspace tests also cover same-team review transitions and concurrent saves.

## Native artwork fonts

The public, session-free brochure font route is `/api/assets/app/fonts/brochure/<filename>`. Its allowlist contains the original eight artwork font files:

- `SkolaSans-Light.otf`, `SkolaSans-Regular.otf`, `SkolaSans-Medium.otf`, `SkolaSans-Bold.otf`, `SkolaSans-Black.otf`
- `TSTAR-Regular.ttf`, `TSTAR-Bold.ttf`, `TSTAR-Headline.ttf`

Font delivery uses the imported design asset bytes without re-encoding. The integration test loads each native font from the read-only reference project's `public/fonts/brochure`, serves it anonymously through the public route and compares SHA-256 hashes. An unlisted font returns 404. `BROCHURE_REFERENCE_DIR` can point the test at another checkout containing those original files; its default is the sibling `../neptun-campaign-studio`.

## Verification and release limits

`STORAGE_DRIVER=local npm test` passed: **63 tests across 10 suites**, including real PostgreSQL brochure persistence, original font delivery and SVG/AVIF upload/document conversion. Backend `npm run typecheck`, `npm run build` and `npm run lint` also passed after these changes.

The test bootstrap requires `TEST_DATABASE_URL` to name an isolated database ending in `_test`, selects that URL for all test queries and applies schema migrations only there. Local storage is confined to `.test-storage`; the worker is not started.

To repeat the complete validation:

```sh
STORAGE_DRIVER=local npm test
npm run typecheck
npm run build
npm run lint
```

The backend currently has no completed server-side PDF/PNG/JPG/ZIP rendering pipeline. These tests prove preservation of the data needed by the frontend renderer and future worker, not visual export parity or production readiness. Complete editor wiring, strict frontend build gates, browser/visual acceptance, server export and deployment remain the release work described in [MIGRATION_STATUS.md](MIGRATION_STATUS.md).
