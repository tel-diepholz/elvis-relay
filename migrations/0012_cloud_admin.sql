-- Verwaltung durch Betreiber: Konten sperren und ein Protokoll der Verwaltungsaktionen
ALTER TABLE accounts ADD COLUMN disabled_at TEXT;
ALTER TABLE accounts ADD COLUMN disabled_by TEXT;

CREATE TABLE admin_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  -- Betreiber (E-Mail) und betroffenes Konto (E-Mail zum Zeitpunkt der Aktion)
  by_email TEXT NOT NULL,
  target_email TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX admin_log_at ON admin_log (at);
