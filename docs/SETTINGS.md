# Shared brochure defaults

Implemented in the new sibling applications. The original project is unchanged. The full editor migration is still incomplete; these checks cover the Settings feature and its creation/rendering integration points.

## What teammates can manage

Six Settings tabs manage cover styles and backgrounds; NEPTUN, award, service, manufacturer and contact artwork; uploads and a reusable artwork library; stores, their order and visible information; prices and category/subcategory savings rules; brochure formats and layouts; and campaign types such as Black Friday and Happy Hour.

The initial choices preserve the original creator: 1080 × 1350, six offers, blue UUU cover, the original cover logo, haPPy symbol, current price design, Kurse (€), twelve installments, a separate stores page and online store. The 17 stores, their ordering, addresses, phones and original contact/terms text remain intact. Existing cover element visibility is preserved. Brochure font binaries and bindings are unchanged.

Uploads use private storage intents and confirmation, with the existing image type, size, checksum and ownership checks. A confirmed upload is selected in the draft; Save settings commits that default. Saving and navigation are disabled during pending uploads. Removing artwork from the library does not delete images used by existing brochures.

## How defaults apply

New brochures copy a complete independent settings snapshot, including stores, visible fields, contact visibility, category/subcategory savings, colors, logos and icons. Later Settings changes do not rewrite saved brochures. Existing brochures keep their saved design and can change their own format, cover, price design, store visibility/order, colors, artwork and category rules. Explicit product artwork edits and empty artwork lists take priority over inherited icon defaults.

Savings precedence remains: product override, subcategory rule, category rule, brochure default. Manufacturer overrides use normalized uppercase names; an empty string hides a logo and deleting the override restores the current artwork. Campaign type deletion affects creation choices; historical brochures retain their own type/name. An explicit “No default” choice remains custom even after list changes.

## Persistence and concurrency

Settings remain organization-scoped JSONB in PostgreSQL. Nest CQRS queries and commands use a validated, versioned contract that preserves unknown reference fields. GET `/api/team/settings` returns `settings`, `version` and `updatedAt`. PUT requires `settings` and `expectedVersion`; it returns the saved snapshot and incremented version. Missing versions return 400 and stale versions return 409. The draft survives failed saves. Saving validates every UUID asset reference against the organization and canonicalizes uploaded URLs.

Migration `0004_settings_defaults.sql` adds defaults without overwriting existing values or brochure snapshots. Existing store order, hidden flags, explicit empty lists, custom settings and unknown fields are retained. The seed creates the complete baseline for new installations. No extra database service is needed.

## Verification

- Backend: 42 tests, strict typecheck/build, lint and formatting pass. Settings coverage includes concurrent writers, stale/missing versions, invalid defaults, same-team sharing and cross-organization artwork rejection.
- Frontend: 51 unit/component/policy tests pass. Settings coverage includes baseline preservation, snapshot independence, category precedence, type management, uploaded logos, draft retention, manufacturer defaults and footer logos. The scoped Settings TypeScript and lint gates pass.
- Chromium: Settings save/reload, rejected navigation away from an unsaved draft, desktop/mobile layout and delivery of the original SkolaSans font pass. This browser test uses isolated API fixtures; PostgreSQL and storage behavior are tested separately through the real integration API.
- Source/storage audit: all 14,289 audited original files remain unchanged; all 14 font binaries and 15,779 immutable storage objects verify. The real Neptun row has the defaults stored, 17 stores, 12 campaign types and zero paid AI jobs.

Frontend `npm run typecheck` / `npm run build` still fail in the broader editor port. The scoped check does not waive those gates. Full brochure/social/classic integration, exports and final UX/font/visual parity remain required before replacement or deployment.
