-- Stammdaten der Baustruktur (Kräfte, Einsatzstichworte, Rollen, Benutzer, Aufgabenvorlagen). Jeder Datensatz gehört
-- einem Knoten; seq ist der Änderungszähler für den Abruf der Installationen (jede Änderung bekommt den nächsten Wert),
-- gelöschte bleiben als Tombstone (deleted = 1, data NULL) stehen, damit Installationen sie entfernen.
CREATE TABLE md_records (
  uid TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  rev INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  data TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE UNIQUE INDEX md_records_seq ON md_records (seq);
CREATE INDEX md_records_node ON md_records (node_id, kind);
