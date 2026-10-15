# Implementation status

Updated 15 October 2026.

The application now runs from `Neptun-Front` and `Neptun-Backend`. The original campaign project remains unchanged. The frontend is deployed on Cloudflare at `neptun.promoautomation.app`, backed by the Render API/worker, Neon PostgreSQL and private R2 media. Previous notes about an unrouted editor and thousands of TypeScript errors are obsolete.

Implemented: full brochure and social editors; original fonts/design controls; Excel imports including unmatched offers and incomplete drafts; shared settings/stores/brands; private uploads and prepared-media reuse; durable AI/text reuse; automatic document saves, version conflict protection and team presence; PDF/image browser exports; category/subcategory catalog synchronization without deletion; manual and daily scheduled refresh; invitation-based staff/PM/admin management; preserved default accounts; support identity privacy; superadmin AI/R2/database insights.

The Render service uses `npm run start:combined`, which checks migrations and starts the API/worker with bounded memory. The pre-deploy command is empty. The 15 October privacy typing fix deployed successfully as `3211569`. SMTP is configured through private Render variables; no credentials are committed. Gmail authentication was verified without sending an email. Custom From addresses require a controlled, authenticated domain; a display name alone cannot provide this.

Backend verification: 189 tests across 34 suites, typecheck and build pass. Live health/readiness, default logins, email configuration and role restrictions were checked. New team frontend copy and an appliance detail-selection parity fix still need a frontend push. See the frontend `docs/IMPLEMENTATION_CHECK.md` for the source comparison and its visual-acceptance limits.

Historical AI records without usage remain unknown, not free. Imported history dates reflect import time. Read-only reporting does not regenerate prepared images or text. A provider request interrupted during deployment is retained as uncertain for explicit review, avoiding automatic duplicate charges.
