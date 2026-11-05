-- Cloud-Zugang für die Datenpflege: Konten (Anmeldung per E-Mail-Code), Baustruktur aus Gebietskörperschaften (ARS)
-- und freien Knoten darunter, Rollen je Knoten (gelten nach unten), Einladungen, verknüpfte ELVIS-Installationen.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  -- Betreiber (von Hand gesetzt): darf Admins für jede Gebietskörperschaft einsetzen
  operator INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);

-- Versendete Codes (Begrenzung je Adresse und Stunde)
CREATE TABLE login_mails (
  email TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE INDEX login_mails_email ON login_mails (email, sent_at);

CREATE TABLE account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX account_sessions_account ON account_sessions (account_id);

-- Knoten: ARS-Knoten mit id 'ars:<ARS>' (Deutschland 'ars:'), entstehen bei Bedarf samt ihrer Eltern;
-- freie Knoten (UUID) hängen unter einem ARS- oder freien Knoten, unter freien Knoten gibt es keine ARS-Knoten
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES nodes(id),
  ars TEXT UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX nodes_parent ON nodes (parent_id);

CREATE TABLE memberships (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
  created_at TEXT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (account_id, node_id)
);
CREATE INDEX memberships_node ON memberships (node_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);
CREATE INDEX invitations_node ON invitations (node_id);

-- Verknüpfte Installationen; sig_public_key signiert alle Aufrufe unter /v1/elws/me/cloud
CREATE TABLE installations (
  elw_id TEXT PRIMARY KEY REFERENCES elws(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  name TEXT NOT NULL,
  sig_public_key TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  linked_by TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  last_sync_at TEXT
);
CREATE INDEX installations_node ON installations (node_id);

-- Offene Verknüpfungsanfragen (eine je Installation, Code eine Stunde gültig)
CREATE TABLE link_requests (
  elw_id TEXT PRIMARY KEY REFERENCES elws(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sig_public_key TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Fehlversuche beim Eingeben von Verknüpfungscodes je Konto (gegen Durchprobieren)
CREATE TABLE link_attempts (
  account_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX link_attempts_account ON link_attempts (account_id, at);

INSERT INTO nodes (id, parent_id, ars, name, created_at) VALUES ('ars:', NULL, '', 'Deutschland', '2026-11-05T00:00:00.000Z');
