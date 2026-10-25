-- ELWs (ELVIS-Installationen), die Apps koppeln und Positionen abholen
CREATE TABLE elws (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

-- Apps; code ist der aktuelle Kopplungscode, elw_id der gekoppelte ELW
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  elw_id TEXT REFERENCES elws(id) ON DELETE SET NULL,
  label TEXT NOT NULL DEFAULT '',
  paired_at TEXT,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX devices_elw ON devices (elw_id);

-- Positionen bis zur Abholung durch den ELW (höchstens 24 h)
CREATE TABLE positions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  elw_id TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  accuracy_m REAL,
  battery REAL,
  ts TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX positions_elw ON positions (elw_id, seq);
