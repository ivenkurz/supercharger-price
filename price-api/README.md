# suc-price-api

Collaborative Supercharger price feed — Cloudflare Worker + D1.

Apps load GET /v1/europe.json (same schema as the static Pages feed), then POST refreshed stations via POST /v1/stations/upsert. Newer lastSuccessfulAt wins. This Worker never calls Tesla.

## Endpoints

- GET /v1/health → { ok, stations, priced, generatedAt }
- GET /v1/europe.json → full document: meta + stations
- POST /v1/stations/upsert → body { stations: Station[] } max 80; light IP rate limit (~30/min)
- OPTIONS * → CORS preflight (all origins)

## Prerequisites

- Node 20+
- Cloudflare account + wrangler login (npx wrangler login)

## Deploy

Detailed steps:

1. Install package dependencies.
2. Create D1 database named suc-price; paste database_id into wrangler.toml.
3. Apply migrations (migrate:remote or migrate:local).
4. Generate seed-data.sql (seed:sql), then apply (seed:remote or seed:local).
5. Publish with deploy; for local use the dev script (http://127.0.0.1:8787).

## Curl examples

Set BASE to your Worker URL.

- Health: GET $BASE/v1/health
- Feed: GET $BASE/v1/europe.json
- Upsert: POST $BASE/v1/stations/upsert body { stations: Station[] } max 80

## App configuration

SUC_PRICE_API_BASE=https://suc-price-api.ACCOUNT.workers.dev

Fallback order: API base, device cache, then static Pages europe.json.

## Schema notes

- Stations stored opaque in stations.json; GET assembles meta plus parsed rows.
- Upsert skips when existing lastSuccessfulAt is equal or newer.
- Meta keys: generatedAt, environment, exchangeRates, schemaVersion, stats.

## Seed

scripts/seed.mjs prefers /workspace/ladar-collector/data/europe.json else Pages URL.
Use --sql-only by default; --local or --remote to apply via wrangler; --file to override path.
Package scripts include seed:sql seed:local seed:remote migrate:local migrate:remote deploy dev.

## Layout

package.json wrangler.toml tsconfig.json src/index.ts migrations/0001_init.sql scripts/seed.mjs README.md
