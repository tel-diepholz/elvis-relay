-- Cloud Messaging: Verzeichnis der Installationen, Chat-Anfragen und eine Ereignis-Warteschlange je Installation.
-- Inhalte (Anfrage, Nachrichten, Anhänge) sind mit OpenPGP für die Gegenseite verschlüsselt; das Relay kennt nur,
-- wer wann wem schreibt. Voraussetzung ist ein aktives ELVIS-Postfach (Schlüssel aus mailboxes).

-- Eintrag im Verzeichnis; vehicle = Name, Funkrufname, Organisation, Kontaktdaten (JSON)
CREATE TABLE msg_directory (
  elw_id TEXT PRIMARY KEY REFERENCES elws(id) ON DELETE CASCADE,
  region_ars TEXT NOT NULL,
  vehicle TEXT NOT NULL,
  -- Suchtext (Name, Funkrufname, Organisation in Kleinbuchstaben)
  search TEXT NOT NULL,
  listed INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX msg_directory_region ON msg_directory (region_ars);

-- Chat zwischen zwei Installationen; from_elw hat angefragt
-- state: requested | accepted | declined | closed
CREATE TABLE msg_conversations (
  id TEXT PRIMARY KEY,
  from_elw TEXT NOT NULL,
  to_elw TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX msg_conversations_from ON msg_conversations (from_elw, created_at);
CREATE INDEX msg_conversations_to ON msg_conversations (to_elw);

-- Ereignisse bis zur Abholung (Anfrage, Statuswechsel, Nachricht); ciphertext ist verschlüsselt
CREATE TABLE msg_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  to_elw TEXT NOT NULL,
  from_elw TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  ciphertext TEXT,
  attachment_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX msg_events_to ON msg_events (to_elw, seq);

-- Hochgeladene, verschlüsselte Anhänge (Inhalt in R2 unter msg/<id>)
CREATE TABLE msg_attachments (
  id TEXT PRIMARY KEY,
  from_elw TEXT NOT NULL,
  to_elw TEXT,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
