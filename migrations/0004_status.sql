-- Statusseite: Prüfergebnisse je Komponente (Rohdaten 2 Tage), Tageswerte (90 Tage), Störungsmeldungen

CREATE TABLE status_checks (
  component TEXT NOT NULL,
  ok INTEGER NOT NULL,
  latency_ms INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL
);
CREATE INDEX status_checks_component ON status_checks (component, checked_at);

CREATE TABLE status_daily (
  component TEXT NOT NULL,
  day TEXT NOT NULL,
  checks INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  PRIMARY KEY (component, day)
);

-- Fehler im echten Betrieb (Annahme, Versand), zählen in die nächste Prüfung
CREATE TABLE status_events (
  component TEXT NOT NULL,
  ok INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX status_events_at ON status_events (component, at);

-- Testmail an probe@: gesendet beim einen Lauf, beim nächsten muss sie angekommen sein
CREATE TABLE status_probes (
  id TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL,
  received_at TEXT
);

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL,
  components TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  resolved_at TEXT
);

-- Zuletzt gemeldeter Gesamtstatus (für die Alarm-Mail an den Betreiber)
CREATE TABLE status_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
