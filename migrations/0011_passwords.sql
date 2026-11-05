-- Cloud-Portal: Konten mit E-Mail und Passwort statt Anmeldecode per Mail.
-- Bisherige Konten (per Code angemeldet) gelten als bestätigt und setzen ihr Passwort einmal über „Passwort vergessen“.
ALTER TABLE accounts ADD COLUMN password_hash TEXT;
ALTER TABLE accounts ADD COLUMN email_verified_at TEXT;
ALTER TABLE accounts ADD COLUMN password_changed_at TEXT;
-- Fehlversuche in Folge und Sperre bis (gegen Durchprobieren)
ALTER TABLE accounts ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN locked_until TEXT;
UPDATE accounts SET email_verified_at = created_at;

-- Einmal-Links per Mail (nur der Hash): verify = Adresse bestätigen, reset = Passwort zurücksetzen,
-- email = neue Adresse bestätigen (new_email)
CREATE TABLE account_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset', 'email')),
  new_email TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX account_tokens_account ON account_tokens (account_id, purpose);

DROP TABLE login_codes;
