# Automatic AI reuse

AI reuse is server-side and organization-scoped. The existing AI controls remain the entry points; no cache switches, cache-hit badges or cache-management steps were added to the user interface. The replacement editor is still being ported, so these checks do not establish complete end-to-end UI parity.

## Stored images and job deduplication

Cutouts, prepared brands, generated backgrounds, placement and screen-detection results are saved in PostgreSQL. Image bytes are immutable storage objects referenced by the saved result. Source identity uses SHA-256 of the image bytes, so an upload/alias/URL change cannot by itself charge for the same photograph again. Model, quality, prompt revision and meaningful operation parameters remain part of the result identity.

Completed results return immediately before checking for an API key. Queued/running identical requests attach to the existing job. Database locks and uniqueness constraints protect simultaneous requests from different team members. Requests for genuinely changed inputs create another result; an explicit re-cut/retry creates a separate version and preserves the earlier one. An ambiguous provider response is marked uncertain and is never silently dispatched again.

Background generation identities contain only the prompt, relevant product names/categories, context and orientation used by the provider. Changing sale prices, image choices or editor coordinates does not invalidate a background. Brand preparation, placement and screen detection likewise ignore editor fields that their prompts never consume.

## Real product image discovery for Excel-only offers

`POST /api/ai-find-product-image` accepts `{ code, name, brand?, details?: string[], category?, retry? }`. It creates a durable `product_image_search` command and returns the existing asynchronous job ticket; clients poll `/api/ai/jobs/:id`. A completed result is either `{ found: false, reason }` or `{ found: true, image, sourceUrl, imageUrl, matchedName, matchedModel }`. `image` is an organization-owned `/api/assets/:id` reference. The original source page/photo URLs and matching identity remain stored with the result and asset.

The worker uses Responses API web search with consulted source URLs, as described in [OpenAI's web search documentation](https://developers.openai.com/api/docs/guides/tools-web-search). `OPENAI_SEARCH_MODEL` defaults to `gpt-4.1-mini` separately from existing text/image model settings. The operation searches for existing photographs and never generates or cuts out a product photo. A candidate must identify a specific model already supplied by Excel, preserve known phone-family suffixes and supplied capacity/color variants, and come from a consulted product page. The photograph must be declared as that product's main image by its matching title/heading with social image metadata or by matching Product JSON-LD. A related product image elsewhere on a page does not qualify. Ambiguous matches, blocked pages, unsupported/small photos and failed downloads complete as `found: false`; the Excel offer can remain usable with manual upload.

Downloads allow public HTTPS only, validate all DNS answers, pin the selected public address for the connection, and revalidate each of at most three redirects. Loopback/private/link-local/metadata/reserved addresses, credentials and alternate ports are blocked. Page downloads are capped at 2 MB, photographs at 12 MB, with DNS/request timeouts and existing MIME/pixel validation. Accepted photos are ingested through the same immutable asset ownership path as uploads.

Search cache identity contains only supplied product identity/facts, model and its own prompt revision. Prices, editor coordinates, temporary UI IDs and manual photo choices do not trigger a new lookup. Both verified photos and no-match results are reusable; explicit Retry creates a new version. Existing image-generation prompt revisions and saved results are unchanged. Provider, download, ambiguous match, SSRF and durable reuse tests use mocks; implementation verification made no paid AI requests.

## Individual text fields

`ai_proofread_checks` stores every successful field check, including a successful check with no correction. A field identity includes its text, brand, field role, meaningful campaign context, model and prompt revision. Temporary IDs, product position numbers, UI field keys and unrelated fields in the batch are excluded.

Reordered batches and repeated fields reuse saved checks and return suggestions with the current field IDs. A batch containing some saved fields sends only the remaining fields to the provider. Overlapping batches lock their shared field identities in sorted order; a shared field is processed once. Durable pending claims protect against a worker dying after provider dispatch. Explicit regenerations have separate identities and leave earlier results intact. Fully reused jobs create no provider-usage charge record.

The editor stores review history with the document. It remembers checked originals, accepted suggestions and declined suggestions. Text edited while a review is running remains unchecked unless that exact text was successfully reviewed. The modal subscribes to progress; opening it does not start an AI job. Initial work starts from the existing AI button's click handler. Image dialogs reuse approved cutouts directly, including legacy cutouts without preparation metadata.

## Reference data and deployment

All 33 original cached cutouts and eight prepared-brand files have been retained in storage and registered as completed legacy results. Their original request metadata is unavailable, so those legacy records are not falsely assigned modern request identities. Approved cutouts already saved in imported documents remain available without regeneration.

The worker uses `DIRECT_DATABASE_URL` when supplied, falling back to the local/direct `DATABASE_URL`. Migrations and backup tools use the same direct connection selection. A known Neon pooler hostname is rejected for these processes. The API can use the pooled URL independently. Session-level locks require a direct connection; see [Neon connection pooling](https://neon.com/docs/connect/connection-pooling). For other transaction poolers, also provide their direct PostgreSQL endpoint. `AI_TEXT_CONCURRENCY` is limited to four with the current ten-connection worker pool; the default is two.

## Validation

Backend tests use real isolated PostgreSQL fixtures and mocked providers. They cover concurrent identical requests, stored-image reuse after a new repository/session, overlapping and reordered text batches, partial/no-correction reuse, changed-context invalidation, explicit regeneration, tenant isolation, uncertain responses, irrelevant editor metadata and quota enforcement.

Frontend tests cover saved cutout restoration, checked/declined/edited text, opening/rerendering/reopening dialogs without AI commands, immediate cached replies, GET-only job polling and failure handling without automatic command retries. An AST policy test checks mount effects and print/export handlers for calls to AI commands. No paid OpenAI call was made for these checks.

Run `npm test` in each new folder. The backend also passes its strict build and lint. The full frontend still fails its strict build because the broader brochure/social/classic port remains unfinished; AI-specific files and tests have no TypeScript diagnostics. Visual parity, all control integration and full export acceptance remain required before replacement or deployment.
