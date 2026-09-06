# Deploy suc-price-api (Cloudflare Worker + D1)

Short CoS deploy steps:

1. Login: from price-api, run npm ci, then wrangler login (via npx).
2. Create D1 database named suc-price; paste database_id into wrangler.toml (replace the placeholder UUID).
3. Migrate: npm run migrate:remote.
4. Seed: npm run seed:remote (builds scripts/seed-data.sql from europe.json and applies it; do not commit seed-data.sql).
5. Deploy: npm run deploy; note the Worker URL (e.g. https://suc-price-api.ACCOUNT.workers.dev).
6. App config: set SUC_PRICE_API_BASE to that Worker URL in the Supercharger / CoS app environment.

Fallback order: API base, then device cache, then static Pages europe.json.

Verify with a GET to SUC_PRICE_API_BASE/v1/health.
