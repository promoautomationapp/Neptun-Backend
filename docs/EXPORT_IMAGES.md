# Brochure image export

`GET /api/export-image?url=<encoded source>` supplies the legacy Neptun photographs needed by the browser's brochure renderer without relying on the remote website's canvas CORS headers. The endpoint requires a valid organization session and respects the forced password change gate. It returns the original validated image bytes from owned storage rather than redirecting the browser to an external or R2 signed image URL. This endpoint does not render a PDF/page and does not perform an AI request.

Only `https://www.neptun-ks.com/...` and `https://neptun-ks.com/...` are accepted. Other subdomains, lookalike hosts, HTTP URLs, credentials, alternate ports, private addresses and local file/asset paths are rejected. The shared public downloader pins validated public DNS addresses and checks both public-address safety and the explicit Neptun host allowlist on every redirect. It limits redirects, applies DNS/connection timeouts, caps downloads at 12 MB and rejects compressed or misleading responses. The existing ingest path checks image bytes, MIME and pixel limits; accepted formats are PNG/JPEG/WebP/GIF/AVIF, with AVIF normalized to portable PNG.

Imported source aliases are reused before any network request. Concurrent requests for the same organization/source serialize one cache fill, and subsequent exports use its owned immutable asset. Different source URLs containing identical bytes share the same SHA-256 asset within an organization. A different organization gets its own asset/cache record. Removed assets stay unavailable. Caching is server-side; responses send `Cache-Control: private, no-store`, `Vary: Cookie, Origin`, the correct image content type, `nosniff` and cross-origin resource policy. Configured credentialed CORS is preserved without allowing arbitrary origins.

Frontend images must resolve `/api/export-image` through the configured API base when the frontend and backend use different hosts. Existing owned `/api/assets/:id` images remain on their normal asset path. Manual replacement remains the fallback if the original site is unavailable.

Nine focused tests cover authentication/password gates, concurrent reuse, tenant isolation, content deduplication, binary/MIME/CORS/private headers, invalid inputs, redirected hosts and private DNS addresses using mocked downloads. No external photograph or AI request was made for verification.

## Catalog data for the brochure editor

`GET /api/products` accepts `q`, `code`, `category`, `subcategory`, `brand`, `limit` and `offset`. `limit` defaults to 60 and has a maximum of 100. Responses are `{ products, total, count, limit, offset, nextOffset }`; `nextOffset` is `null` at the end. Clients should follow that cursor to load the full catalog rather than assume a single response contains it.

`POST /api/products/batch` accepts `{ codes: string[] }` with up to 2,000 codes and returns `{ products }`. Batch results include each product's complete ordered `images` array. List results include the primary image, preview and thumbnail but do not load all alternate photos. `GET /api/products/facets` returns `{ categories, brands, paths }`, where each path is `{ category, subcategory, brand }`.

Product records expose `id`, `code`, `name`, `brand`, `model`, `ean`, `category`, `subcategory`, `categoryPath`, `description`, `warranty`, `regular` (number or null), `currency`, `specs`, `availability`, `url`, `image`, `localImage`, `imageUrl`, `thumbnail`, `preview` and `images`. All catalog routes are authenticated and organization-scoped. Excel-only products can stay in saved campaign snapshots without being inserted into this catalog.
