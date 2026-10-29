-- Backups der ELVIS-Installationen. Ein Tresor gehört zu einem Wiederherstellungsschlüssel: ID und Zugang leitet
-- ELVIS aus dem Schlüssel ab, das Relay kennt nur den Hash des Zugangs. Die Backups selbst liegen verschlüsselt
-- in R2 (BACKUPS), aufgeteilt in Teile (<tresor>/<backup>/<n>).
-- max_backups / max_bytes: Kontingent je Tresor (NULL = Vorgabe aus BACKUP_MAX_COUNT / BACKUP_MAX_BYTES)
CREATE TABLE backup_vaults (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  elw_id TEXT,
  max_backups INTEGER,
  max_bytes INTEGER,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

-- status: uploading | complete; meta: von ELVIS verschlüsselte Angaben für die Auswahl beim Wiederherstellen
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES backup_vaults(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  parts INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX backups_vault ON backups (vault_id, created_at);

CREATE TABLE backup_parts (
  backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (backup_id, n)
);
