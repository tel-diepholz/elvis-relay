/**
 * Import der Einsatzbibliothek aus Fireboard (login.fireboard.net) in die Objektbibliothek. Das Relay meldet sich mit den
 * Zugangsdaten aus dem Portal einmal an, holt den Kartenbaum und liefert ihn aufbereitet zurück; gespeichert wird nichts.
 * Die Zuordnung zu Objekttypen und das Anlegen der Objekte macht das Portal (über /v1/cloud/records).
 */
// Ohne zod: das Portal bindet diese Datei ein (Login-Schema in src/cloud/fireboard.ts)

/** Vorschlag je Kategorie: vordefinierte Typen der Bibliothek oder ein neuer Typ */
export type FireboardSuggestion = 'water' | 'site' | 'new';

export interface FireboardCategory {
  id: number;
  /** Pfad von oben, z. B. ["Löschwasserversorgung LKO", "Hydranten", "Unterflurhydranten", "H 150"] */
  path: string[];
  /** Objekte direkt in dieser Kategorie */
  count: number;
  suggestion: FireboardSuggestion;
}

export interface FireboardItem {
  /** Kennung in Fireboard (poi_id) – als Herkunft „fireboard:<id>“ gegen doppelten Import */
  id: number;
  categoryId: number;
  name: string;
  lat: number;
  lon: number;
  address: string;
  /** Beschreibung als Text (HTML entfernt), mit Gültigkeit und Kategorie */
  notes: string;
  /** Art der Wasserentnahmestelle (Feld „art“ des vordefinierten Typs), aus Symbol bzw. Kategorie */
  art: string | null;
  /** Nennweite (DN), aus Symbol bzw. Kategorie */
  dn: number | null;
  /** Dateien am Objekt in Fireboard (werden nicht übernommen) */
  attachments: number;
}

export interface FireboardLibrary {
  categories: FireboardCategory[];
  items: FireboardItem[];
  /** Einträge ohne Ort (Dokumente) – nicht importierbar */
  documents: number;
  /** Objekte ohne Koordinaten in Fireboard (0/0) – nicht importierbar */
  withoutPosition: number;
}

/** Herkunft eines importierten Objekts */
export const fireboardSource = (id: number) => `fireboard:${id}`;
