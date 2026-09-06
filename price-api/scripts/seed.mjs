#!/usr/bin/env node
/**
 * Seed D1 from europe.json
 *
 * Prefer local: /workspace/ladar-collector/data/europe.json
 * Fallback:     https://ivenkurz.github.io/supercharger-price/europe.json
 *
 * Usage:
 *   node scripts/seed.mjs --sql-only
 *   node scripts/seed.mjs --local
 *   node scripts/seed.mjs --remote
 *   node scripts/seed.mjs --file path.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEFAULT_LOCAL = "/workspace/ladar-collector/data/europe.json";
const PAGES_URL = "https://ivenkurz.github.io/supercharger-price/europe.json";
const OUT_SQL = join(__dirname, "seed-data.sql");
const DB_NAME = "suc-price";
const BATCH_SIZE = 50;

function sqlEscape(value) {
  if (value === null || value === undefined) return "NULL";
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function isPriced(station) {
  if (station && station.pricingStatus === "available") return true;
  return Array.isArray(station && station.prices) && station.prices.length > 0;
}

async function loadEurope(fileArg) {
  if (fileArg) {
    const p = resolve(fileArg);
    if (!existsSync(p)) throw new Error("File not found: " + p);
    console.log("Reading " + p);
    return JSON.parse(readFileSync(p, "utf8"));
  }
  if (existsSync(DEFAULT_LOCAL)) {
    console.log("Reading " + DEFAULT_LOCAL);
    return JSON.parse(readFileSync(DEFAULT_LOCAL, "utf8"));
  }
  console.log("Fetching " + PAGES_URL);
  const res = await fetch(PAGES_URL);
  if (!res.ok) throw new Error("Fetch failed: " + res.status + " " + res.statusText);
  return await res.json();
}

function buildStatements(doc) {
  const stmts = [];
  stmts.push("DELETE FROM stations;");
  stmts.push("DELETE FROM meta;");

  const schemaVersion = doc.schemaVersion ?? 1;
  const generatedAt = doc.generatedAt ?? new Date().toISOString();
  const environment = doc.environment ?? "production";
  const exchangeRates = JSON.stringify(doc.exchangeRates ?? null);
  const stats = JSON.stringify(
    doc.stats ?? {
      countries: new Set((doc.stations ?? []).map((s) => s.country).filter(Boolean)).size,
      stations: (doc.stations ?? []).length,
    }
  );

  stmts.push("INSERT INTO meta (key, value) VALUES ('schemaVersion', " + sqlEscape(String(schemaVersion)) + ");");
  stmts.push("INSERT INTO meta (key, value) VALUES ('generatedAt', " + sqlEscape(generatedAt) + ");");
  stmts.push("INSERT INTO meta (key, value) VALUES ('environment', " + sqlEscape(environment) + ");");
  stmts.push("INSERT INTO meta (key, value) VALUES ('exchangeRates', " + sqlEscape(exchangeRates) + ");");
  stmts.push("INSERT INTO meta (key, value) VALUES ('stats', " + sqlEscape(stats) + ");");

  const stations = doc.stations ?? [];
  for (const s of stations) {
    if (!s || !s.id) continue;
    const json = JSON.stringify(s);
    const last = s.lastSuccessfulAt ?? null;
    const country = s.country ?? null;
    const priced = isPriced(s) ? 1 : 0;
    stmts.push(
      "INSERT INTO stations (id, json, last_successful_at, country, priced) VALUES (" +
        sqlEscape(s.id) + ", " +
        sqlEscape(json) + ", " +
        sqlEscape(last) + ", " +
        sqlEscape(country) + ", " +
        priced + ");"
    );
  }
  return stmts;
}

function writeSqlFile(stmts) {
  mkdirSync(dirname(OUT_SQL), { recursive: true });
  const body = stmts.join("\n") + "\n";
  writeFileSync(OUT_SQL, body, "utf8");
  console.log("Wrote " + OUT_SQL + " (" + stmts.length + " statements, " + (body.length / 1e6).toFixed(2) + " MB)");
  return OUT_SQL;
}

function runWranglerBatches(stmts, remote) {
  const flag = remote ? "--remote" : "--local";
  console.log("Applying " + stmts.length + " statements via wrangler d1 execute " + flag + " ...");

  const metaEnd = stmts.findIndex((s) => s.startsWith("INSERT INTO stations"));
  const head = metaEnd === -1 ? stmts : stmts.slice(0, metaEnd);
  const stationStmts = metaEnd === -1 ? [] : stmts.slice(metaEnd);

  const batches = [];
  if (head.length) batches.push(head);
  for (let i = 0; i < stationStmts.length; i += BATCH_SIZE) {
    batches.push(stationStmts.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    const command = batches[i].join("\n");
    const args = ["wrangler", "d1", "execute", DB_NAME, flag, "--command", command];
    process.stdout.write("  batch " + (i + 1) + "/" + batches.length + " (" + batches[i].length + " stmts)... ");
    const r = spawnSync("npx", args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      shell: false,
    });
    if (r.status !== 0) {
      console.error("FAILED");
      console.error(r.stderr || r.stdout);
      process.exit(r.status ?? 1);
    }
    console.log("ok");
  }
  console.log("Seed applied.");
}

function parseArgs(argv) {
  const opts = { sqlOnly: false, local: false, remote: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sql-only") opts.sqlOnly = true;
    else if (a === "--local") opts.local = true;
    else if (a === "--remote") opts.remote = true;
    else if (a === "--file") opts.file = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/seed.mjs [--sql-only|--local|--remote] [--file path.json]");
      process.exit(0);
    }
  }
  if (!opts.sqlOnly && !opts.local && !opts.remote) {
    opts.sqlOnly = true;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const doc = await loadEurope(opts.file);
console.log(
  "Loaded europe.json: " + (doc.stations?.length ?? 0) + " stations, generatedAt=" + doc.generatedAt
);
const stmts = buildStatements(doc);
writeSqlFile(stmts);

if (opts.local || opts.remote) {
  const flag = opts.remote ? "--remote" : "--local";
  console.log("Trying wrangler d1 execute " + flag + " --file=scripts/seed-data.sql ...");
  const r = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", DB_NAME, flag, "--file=" + OUT_SQL],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      shell: false,
    }
  );
  if (r.status === 0) {
    console.log(r.stdout);
    console.log("Seed applied via --file.");
  } else {
    console.warn("wrangler --file failed; falling back to batched --command");
    console.warn(r.stderr || r.stdout);
    runWranglerBatches(stmts, opts.remote);
  }
} else {
  console.log("\nNext (local):  npx wrangler d1 execute " + DB_NAME + " --local --file=scripts/seed-data.sql");
  console.log("Next (remote): npx wrangler d1 execute " + DB_NAME + " --remote --file=scripts/seed-data.sql");
}
