-- Import mit Herkunft (z. B. fireboard:<id>): schnelle Prüfung, ob es das Objekt schon gibt
CREATE INDEX md_records_object_source ON md_records (json_extract(data, '$.source')) WHERE kind = 'object';
