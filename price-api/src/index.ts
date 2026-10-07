/**
 * suc-price-api — collaborative Supercharger price feed (Cloudflare Worker + D1)
 *
 * Does NOT call Tesla. Clients POST refreshed stations; GET serves the shared snapshot.
 */

export interface Env {
  DB: D1Database;
}

interface PriceBand {
  days: number;
  start: number;
  end: number;
  price: number;
}

interface Station {
  schemaVersion?: number;
  id: string;
  country?: string;
  name?: string;
  address?: unknown;
  lat?: number;
  lon?: number;
  timezone?: string;
  currency?: string;
  stallCount?: number;
  maxPowerKw?: number;
  pricingStatus?: string;
  prices?: PriceBand[];
  lifecycle?: string;
  lastCheckedAt?: string;
  lastSuccessfulAt?: string;
  [key: string]: unknown;
}

interface UpsertBody {
  stations?: Station[];
}

interface MetaMap {
  generatedAt?: string;
  environment?: string;
  exchangeRates?: string;
  schemaVersion?: string;
  stats?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const MAX_UPSERT = 80;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Light in-memory IP rate limit (per isolate; best-effort). */
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function jsonResponse(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(body), { status, headers });
}

function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  // Opportunistic prune when map grows large
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (now >= v.resetAt) rateBuckets.delete(k);
    }
  }
  return bucket.count <= RATE_LIMIT_MAX;
}

function isPriced(station: Station): boolean {
  if (station.pricingStatus === "available") return true;
  return Array.isArray(station.prices) && station.prices.length > 0;
}

function newerTimestamp(a?: string | null, b?: string | null): boolean {
  // true if a is strictly newer than b (missing b → a wins if present)
  if (!a) return false;
  if (!b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) return false;
  if (Number.isNaN(tb)) return true;
  return ta > tb;
}

async function loadMeta(db: D1Database): Promise<MetaMap> {
  const { results } = await db.prepare("SELECT key, value FROM meta").all<{
    key: string;
    value: string;
  }>();
  const map: MetaMap = {};
  for (const row of results ?? []) {
    (map as Record<string, string>)[row.key] = row.value;
  }
  return map;
}

async function handleHealth(env: Env): Promise<Response> {
  const meta = await loadMeta(env.DB);
  const counts = await env.DB.prepare(
    `SELECT
       COUNT(*) AS stations,
       SUM(CASE WHEN priced = 1 THEN 1 ELSE 0 END) AS priced
     FROM stations`
  ).first<{ stations: number; priced: number }>();

  return jsonResponse({
    ok: true,
    stations: counts?.stations ?? 0,
    priced: counts?.priced ?? 0,
    generatedAt: meta.generatedAt ?? null,
  });
}

async function handleEuropeJson(env: Env): Promise<Response> {
  const meta = await loadMeta(env.DB);
  const { results } = await env.DB.prepare(
    "SELECT json FROM stations ORDER BY country, id"
  ).all<{ json: string }>();

  const stations: Station[] = [];
  for (const row of results ?? []) {
    try {
      stations.push(JSON.parse(row.json) as Station);
    } catch {
      // skip corrupt row
    }
  }

  let exchangeRates: unknown = null;
  if (meta.exchangeRates) {
    try {
      exchangeRates = JSON.parse(meta.exchangeRates);
    } catch {
      exchangeRates = null;
    }
  }

  let stats: unknown = {
    countries: new Set(stations.map((s) => s.country).filter(Boolean)).size,
    stations: stations.length,
  };
  if (meta.stats) {
    try {
      stats = JSON.parse(meta.stats);
    } catch {
      /* keep computed */
    }
  }

  const schemaVersion = meta.schemaVersion ? Number(meta.schemaVersion) || 1 : 1;

  const doc = {
    schemaVersion,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    environment: meta.environment ?? "production",
    stats,
    exchangeRates,
    stations,
  };

  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "public, max-age=30");
  return new Response(JSON.stringify(doc), { status: 200, headers });
}

async function refreshMetaStats(db: D1Database, generatedAt: string): Promise<void> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS stations,
         COUNT(DISTINCT country) AS countries,
         SUM(CASE WHEN priced = 1 THEN 1 ELSE 0 END) AS priced
       FROM stations`
    )
    .first<{ stations: number; countries: number; priced: number }>();

  const stats = JSON.stringify({
    countries: row?.countries ?? 0,
    stations: row?.stations ?? 0,
  });

  await db.batch([
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('generatedAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(generatedAt),
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('stats', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(stats),
  ]);
}

async function handleUpsert(request: Request, env: Env): Promise<Response> {
  const ip = clientIp(request);
  if (!checkRateLimit(ip)) {
    return jsonResponse({ ok: false, error: "rate_limited" }, 429);
  }

  let body: UpsertBody;
  try {
    body = (await request.json()) as UpsertBody;
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  if (!body || !Array.isArray(body.stations)) {
    return jsonResponse({ ok: false, error: "stations_array_required" }, 400);
  }
  if (body.stations.length === 0) {
    return jsonResponse({ ok: true, upserted: 0, skipped: 0 });
  }
  if (body.stations.length > MAX_UPSERT) {
    return jsonResponse(
      { ok: false, error: "too_many_stations", max: MAX_UPSERT },
      400
    );
  }

  const ids = body.stations
    .map((s) => (s && typeof s.id === "string" ? s.id : null))
    .filter((id): id is string => !!id);

  if (ids.length === 0) {
    return jsonResponse({ ok: false, error: "no_valid_station_ids" }, 400);
  }

  // Load existing last_successful_at for conflict resolution
  const placeholders = ids.map(() => "?").join(",");
  const existing = await env.DB.prepare(
    `SELECT id, last_successful_at FROM stations WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all<{ id: string; last_successful_at: string | null }>();

  const existingMap = new Map<string, string | null>();
  for (const row of existing.results ?? []) {
    existingMap.set(row.id, row.last_successful_at);
  }

  const stmts: D1PreparedStatement[] = [];
  let upserted = 0;
  let skipped = 0;

  for (const station of body.stations) {
    if (!station || typeof station.id !== "string" || !station.id) {
      skipped += 1;
      continue;
    }

    const incomingAt =
      typeof station.lastSuccessfulAt === "string"
        ? station.lastSuccessfulAt
        : null;
    const currentAt = existingMap.get(station.id);

    // If row exists and incoming is not newer, skip
    if (existingMap.has(station.id) && !newerTimestamp(incomingAt, currentAt)) {
      skipped += 1;
      continue;
    }

    const priced = isPriced(station) ? 1 : 0;
    const country =
      typeof station.country === "string" ? station.country : null;
    const json = JSON.stringify(station);

    stmts.push(
      env.DB.prepare(
        `INSERT INTO stations (id, json, last_successful_at, country, priced)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           json = excluded.json,
           last_successful_at = excluded.last_successful_at,
           country = excluded.country,
           priced = excluded.priced`
      ).bind(station.id, json, incomingAt, country, priced)
    );
    upserted += 1;
  }

  if (stmts.length > 0) {
    await env.DB.batch(stmts);
    await refreshMetaStats(env.DB, new Date().toISOString());
  }

  return jsonResponse({ ok: true, upserted, skipped });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (request.method === "GET" && path === "/v1/health") {
        return await handleHealth(env);
      }
      if (request.method === "GET" && path === "/v1/europe.json") {
        return await handleEuropeJson(env);
      }
      if (request.method === "POST" && path === "/v1/stations/upsert") {
        return await handleUpsert(request, env);
      }

      return jsonResponse({ ok: false, error: "not_found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ ok: false, error: "internal", message }, 500);
    }
  },
};
