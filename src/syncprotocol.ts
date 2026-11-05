/**
 * Stammdaten in der Cloud: Kräfte, Einsatzstichworte, Rollen, Benutzer und Aufgabenvorlagen, je an einem Knoten der
 * Baustruktur. Portal und verknüpfte ELVIS-Installationen schreiben sie, Installationen holen sie per Cursor ab.
 *
 * Gegenstück in ELVIS: packages/shared/src/cloudsync.ts – Änderungen dort und hier gleich halten.
 */
import { z } from 'zod';

export const RECORD_KINDS = ['force', 'keyword', 'role', 'user', 'taskTemplate'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const RECORD_KIND_LABELS: Record<RecordKind, string> = {
  force: 'Kräfte',
  keyword: 'Einsatzstichworte',
  role: 'Rollen',
  user: 'Benutzer',
  taskTemplate: 'Aufgabenvorlagen',
};

/**
 * Sichtbarkeit für eine Installation bzw. einen Knoten: Kräfte und Stichworte von oben und von unten (der Kreis-ELW
 * kennt die Fahrzeuge der Gemeinden), alles andere nur von oben.
 */
export const VISIBLE_BELOW: Record<RecordKind, boolean> = { force: true, keyword: true, role: false, user: false, taskTemplate: false };

const text = (max: number) => z.string().trim().max(max);
const uid = z.string().uuid();

export const forceDataSchema = z.object({
  name: text(100).min(1, 'Name fehlt'),
  callsign: text(100).default(''),
  organization: text(100).default(''),
  notes: text(1000).default(''),
  email: text(200).default(''),
  mobile: text(40).default(''),
  /** Taktisches Zeichen wie in ELVIS (prüft ELVIS selbst); null = Vorgabe */
  sign: z.record(z.unknown()).nullable().default(null),
  strength: z
    .object({ leaders: z.number().int().min(0).max(999), subLeaders: z.number().int().min(0).max(999), crew: z.number().int().min(0).max(9999) })
    .default({ leaders: 0, subLeaders: 0, crew: 0 }),
  /** Untereinheiten in Reihenfolge (uid einer anderen Kraft) */
  members: z.array(z.object({ uid, role: text(60).default('') })).max(200).default([]),
});
export const keywordDataSchema = z.object({ name: text(40).min(1, 'Stichwort fehlt'), sort: z.number().int().default(0) });
export const roleDataSchema = z.object({ name: text(60).min(1, 'Name fehlt'), description: text(300).default(''), sort: z.number().int().default(0) });
/** Ohne PIN: die setzt ein Admin in der jeweiligen Installation */
export const userDataSchema = z.object({ firstName: text(60).min(1, 'Vorname fehlt'), lastName: text(60).min(1, 'Nachname fehlt'), isAdmin: z.boolean().default(false) });
export const taskTemplateDataSchema = z.object({
  summary: text(200).min(1, 'Aufgabe fehlt'),
  description: text(2000).default(''),
  roleUid: uid.nullable().default(null),
  /** Dokumentvorlage nach Dateiname; ELVIS löst sie lokal auf */
  documentTemplateName: text(200).nullable().default(null),
  /** Wiederkehrend alle n Minuten, sonst einmalig */
  intervalMinutes: z.number().int().min(1).max(100_000).nullable().default(null),
  /** Minuten nach Einsatzbeginn; null = ohne Termin */
  offsetMinutes: z.number().int().min(0).max(100_000).nullable().default(null),
  sort: z.number().int().default(0),
});

export const RECORD_SCHEMAS = {
  force: forceDataSchema,
  keyword: keywordDataSchema,
  role: roleDataSchema,
  user: userDataSchema,
  taskTemplate: taskTemplateDataSchema,
} as const;

export type ForceData = z.infer<typeof forceDataSchema>;
export type KeywordData = z.infer<typeof keywordDataSchema>;
export type RoleData = z.infer<typeof roleDataSchema>;
export type UserData = z.infer<typeof userDataSchema>;
export type TaskTemplateData = z.infer<typeof taskTemplateDataSchema>;
export interface RecordDataMap {
  force: ForceData;
  keyword: KeywordData;
  role: RoleData;
  user: UserData;
  taskTemplate: TaskTemplateData;
}

/** Datensatz, wie Relay und Installation ihn austauschen */
export interface SyncRecord<K extends RecordKind = RecordKind> {
  uid: string;
  kind: K;
  nodeId: string;
  /** Name des Knotens (Anzeige „gepflegt von …“) */
  nodeName: string;
  rev: number;
  deleted: boolean;
  /** null bei gelöschten */
  data: RecordDataMap[K] | null;
  updatedAt: string;
  updatedBy: string;
  seq: number;
}

export const SYNC_BATCH = 500;
export const SYNC_MAX_CHANGES = 200;

export interface SyncPull {
  items: SyncRecord[];
  /** Cursor für den nächsten Abruf */
  next: number;
  /** Es gibt noch mehr (gleich weiter abrufen) */
  more: boolean;
  /** Knoten der Installation (eigene Datensätze) */
  nodeId: string;
}

export const syncChangeSchema = z.object({
  uid,
  kind: z.enum(RECORD_KINDS),
  /** Bekannte Revision; 0 = neu */
  baseRev: z.number().int().min(0),
  deleted: z.boolean().default(false),
  data: z.unknown().optional(),
});
export const syncPushSchema = z.object({ changes: z.array(syncChangeSchema).max(SYNC_MAX_CHANGES) });
export type SyncChange = z.input<typeof syncChangeSchema>;

export type SyncResult =
  | { uid: string; status: 'ok'; record: SyncRecord }
  /** Cloud-Stand ist neuer oder der Datensatz gehört einem anderen Knoten: den mitgeschickten Stand übernehmen */
  | { uid: string; status: 'conflict'; record: SyncRecord | null; reason: string }
  | { uid: string; status: 'invalid'; reason: string };

// --- Portal ---

export const recordCreateSchema = z.object({ kind: z.enum(RECORD_KINDS), nodeId: z.string().min(1).max(60), data: z.unknown() });
export const recordUpdateSchema = z.object({ baseRev: z.number().int().min(1), data: z.unknown() });

/** Datensatz im Portal: mit Bearbeitungsrecht und Lage zum angezeigten Knoten */
export interface PortalRecord extends SyncRecord {
  editable: boolean;
  /** 'here' = am angezeigten Knoten, 'above' = geerbt, 'below' = von einem Unterknoten */
  position: 'here' | 'above' | 'below';
}
