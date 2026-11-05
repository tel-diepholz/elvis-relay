-- Aufruf: npx wrangler d1 execute elvis-relay --remote --file scripts/sql/objekte-loeschen.sql
-- Nur ein Bereich: in der inneren Abfrage AND node_id = 'ars:<ARS>' ergänzen.
-- Nie mit DELETE löschen – verknüpfte Installationen erfahren davon nichts, und die laufenden Nummern (seq) brechen.
--
-- Alle Objekte und Dateien der Objektbibliothek löschen (wie das Portal: als gelöscht markiert, neue seq je Datensatz,
-- damit verknüpfte ELVIS-Installationen die Löschung beim Abgleich übernehmen). Typen bleiben.
UPDATE md_records
SET rev = rev + 1, deleted = 1, data = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_by = 'Betreiber (Massenlöschung)',
    seq = t.base + t.rn
FROM (
  SELECT uid, ROW_NUMBER() OVER (ORDER BY seq) AS rn, (SELECT MAX(seq) FROM md_records) AS base
  FROM md_records WHERE kind IN ('object', 'objectFile') AND deleted = 0
) AS t
WHERE md_records.uid = t.uid;
