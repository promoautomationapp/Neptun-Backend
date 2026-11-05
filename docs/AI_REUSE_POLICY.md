# AI photo reuse and failure cooldowns

Validated finished cutouts are reused by organization and original source bytes, independent of brochure names, gradients, positions, orientation, and model setting changes. Screen geometry is also reused for the same source bytes. A deleted/rejected cutout or a photo without the validation and editable-annotation receipts is not a finished image.

A completed exact-product photo search that definitively returns `found:false` is reused for **14 days from completion**. Reimporting the Excel file, changing category placement, or passing retry/regenerate flags does not purchase another identical search. Changed product identity/model/edition or a different supplied source URL has a separate identity. A matching available successful photo takes precedence over a previous missing result.

Search download/verification infrastructure failures are marked `searchOutcome: verification_unavailable` and `retryable:true`, rather than becoming a 14-day missing result. A 30-second admission cooldown prevents immediate repeated calls. Afterwards a fresh attempt may be requested; concurrent requests share a durable job key.

A background-removal response rejected by the transparency validator, with a recorded provider usage event, blocks **automatic** attempts for the same source for 14 days. The response is HTTP 409, code `AI_CUTOUT_COOLDOWN`, with `cached`, `resultId`, `cooldownUntil`, and `retryAfterSeconds`. The original stays unchanged. A deliberate background-removal regeneration remains available. Reset invalidations, source-loading failures and unrelated infrastructure failures are not classified as definitive invalid output. A later finished validated cutout takes precedence over a failed attempt.

New ordinary cutout keys use the source plus cleanup instructions, so two brochures importing the same photo concurrently share pending work. Page backgrounds and Excel display text do not create another paid job. These checks happen before billable admission and outbox insertion. Expiry permits a new request; it does not schedule background AI work.

Failed validation can still have provider cost: usage is recorded when the provider response arrives, before transparency validation. A failed status or empty application cost field does not by itself prove whether an external charge occurred.

Tests use mocked providers and an isolated test database. No paid AI calls or production image deletions are needed to verify this policy.
