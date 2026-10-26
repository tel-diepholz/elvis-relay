-- Online-Formulare für Personalbögen; der Inhalt ist für den ELW verschlüsselt
CREATE TABLE forms (
  id TEXT PRIMARY KEY,
  elw_id TEXT NOT NULL REFERENCES elws(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  submissions INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX forms_elw ON forms (elw_id);

-- Eingereichte Bögen bis zur Abholung durch den ELW (höchstens 7 Tage)
CREATE TABLE submissions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id TEXT NOT NULL,
  elw_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX submissions_elw ON submissions (elw_id, seq);
