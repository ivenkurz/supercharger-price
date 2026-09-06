-- Collaborative Supercharger price feed schema
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  last_successful_at TEXT,
  country TEXT,
  priced INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_stations_country ON stations(country);
CREATE INDEX IF NOT EXISTS idx_stations_priced ON stations(priced);
CREATE INDEX IF NOT EXISTS idx_stations_last_successful_at ON stations(last_successful_at);
