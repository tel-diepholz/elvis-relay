-- Objektbibliothek in der Cloud: Objekte und ihre Dateien erben die Sichtbarkeit ihres Typs (scope: both, down, up,
-- own); NULL = Regel der Art (VISIBLE_BELOW). Die vordefinierten Typen liegen mit fester uid an der Wurzel.
ALTER TABLE md_records ADD COLUMN scope TEXT;
CREATE INDEX md_records_kind_data ON md_records (kind);

INSERT INTO md_records (uid, kind, node_id, rev, deleted, data, updated_at, updated_by, seq) VALUES
  ('00000000-0000-4000-8000-000000000001', 'objectType', 'ars:', 1, 0,
   '{"name":"Wasserentnahmestelle","icon":"Droplet","color":"#2563eb","fields":[{"key":"art","label":"Art","type":"select","options":["Hydrant Unterflur","Hydrant Überflur","Hydrant Wand","Löschwasserbrunnen","Löschteich","Löschwasserbehälter / Zisterne","Saugstelle","Offenes Gewässer"],"unit":"","badge":false},{"key":"dn","label":"Nennweite (DN)","type":"number","options":[],"unit":"","badge":true},{"key":"leistung","label":"Leistung","type":"number","options":[],"unit":"l/min","badge":false},{"key":"volumen","label":"Volumen","type":"number","options":[],"unit":"m³","badge":false},{"key":"druck","label":"Druck","type":"number","options":[],"unit":"bar","badge":false}],"builtin":"water","visibility":"both","sort":0}',
   '2026-11-05T00:00:00.000Z', 'ELVIS', (SELECT COALESCE(MAX(seq), 0) + 1 FROM md_records)),
  ('00000000-0000-4000-8000-000000000002', 'objectType', 'ars:', 1, 0,
   '{"name":"Einsatzobjekt","icon":"Building2","color":"#dc2626","fields":[{"key":"objektnummer","label":"Objektnummer","type":"text","options":[],"unit":"","badge":true},{"key":"bma","label":"Brandmeldeanlage","type":"bool","options":[],"unit":"","badge":false},{"key":"fsd","label":"FSD / FBF-Standort","type":"text","options":[],"unit":"","badge":false},{"key":"ansprechpartner","label":"Ansprechpartner","type":"text","options":[],"unit":"","badge":false},{"key":"telefon","label":"Telefon","type":"phone","options":[],"unit":"","badge":false},{"key":"gefahren","label":"Gefahren","type":"longtext","options":[],"unit":"","badge":false},{"key":"zufahrt","label":"Zufahrt","type":"longtext","options":[],"unit":"","badge":false}],"builtin":"site","visibility":"both","sort":1}',
   '2026-11-05T00:00:00.000Z', 'ELVIS', (SELECT COALESCE(MAX(seq), 0) + 2 FROM md_records));

-- Hochgeladene Dateien, deren Datensatz noch fehlt (Aufräumen nach einem Tag)
CREATE TABLE library_uploads (
  uid TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
