-- Webhooks der Messenger (WhatsApp Cloud API, Threema Gateway) je ELW. Meta bzw. Threema rufen /h/<id> auf; das
-- Relay puffert den Aufruf unverändert samt Signatur, ELVIS holt ihn mit einem Cursor ab und prüft die Signatur
-- selbst (das Relay kennt keine Schlüssel). verify_token beantwortet die Prüfung beim Einrichten (Meta, GET).
CREATE TABLE hooks (
  id TEXT PRIMARY KEY,
  elw_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  verify_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (elw_id, kind)
);

CREATE TABLE hook_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  hook_id TEXT NOT NULL,
  elw_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_type TEXT NOT NULL,
  signature TEXT,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX hook_events_elw ON hook_events(elw_id, seq);
