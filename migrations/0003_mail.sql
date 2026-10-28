-- Postfach je ELW (<localpart>@MAIL_DOMAIN). Der private Schlüssel liegt nur im ELW; das Relay kennt den
-- öffentlichen OpenPGP-Schlüssel (zum Verschlüsseln eingehender Mails, für WKD) und den Ed25519-Schlüssel,
-- mit dem ELVIS jeden Mail-Abruf signiert.
-- status: pending (Bestätigung offen) | approval (wartet auf Freigabe des Betreibers) | active | closed
CREATE TABLE mailboxes (
  localpart TEXT PRIMARY KEY,
  elw_id TEXT UNIQUE REFERENCES elws(id) ON DELETE SET NULL,
  -- Installation vor der letzten Übernahme; sie erfährt so, dass das Postfach umgezogen ist
  previous_elw_id TEXT,
  admin_email TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  wkd_hash TEXT NOT NULL,
  sig_public_key TEXT NOT NULL,
  revocation_cert TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  closed_at TEXT,
  keys_mailed_at TEXT,
  last_fetch_at TEXT,
  last_fetch_country TEXT,
  bad_sig_mailed_at TEXT
);
CREATE INDEX mailboxes_wkd ON mailboxes (wkd_hash);

-- Offene Bestätigungen (Aktivieren oder Übernahme durch eine neue Installation); nur der Hash des Links
CREATE TABLE mail_confirmations (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  localpart TEXT NOT NULL,
  elw_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  sig_public_key TEXT NOT NULL,
  revocation_cert TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX mail_confirmations_elw ON mail_confirmations (elw_id);
CREATE INDEX mail_confirmations_localpart ON mail_confirmations (localpart, created_at);

-- Eingegangene Mails bis zur Abholung (verschlüsselte Rohmail in R2, hier nur Verwaltungsdaten)
CREATE TABLE mail_inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  localpart TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX mail_inbox_localpart ON mail_inbox (localpart, seq);

-- Versand je Postfach für das Rate-Limit
CREATE TABLE mail_sent (
  localpart TEXT NOT NULL,
  recipients INTEGER NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE INDEX mail_sent_localpart ON mail_sent (localpart, sent_at);

-- Verbrauchte Nonces signierter Abrufe (gegen Wiederholung)
CREATE TABLE mail_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
