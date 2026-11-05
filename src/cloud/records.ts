import {
  RECORD_KINDS,
  RECORD_SCHEMAS,
  SYNC_BATCH,
  VISIBLE_BELOW,
  type PortalRecord,
  type RecordKind,
  type SyncRecord,
  type SyncResult,
} from '../syncprotocol.js';
import type { CloudRole } from '../cloudprotocol.js';
import { atLeast, descendantIds, lineage } from './nodes.js';

interface RecordRow {
  uid: string;
  kind: RecordKind;
  node_id: string;
  rev: number;
  deleted: number;
  data: string | null;
  updated_at: string;
  updated_by: string;
  seq: number;
  scope: string | null;
}

const NEXT_SEQ = '(SELECT COALESCE(MAX(seq), 0) + 1 FROM md_records)';

/**
 * Liste als ein einziger Parameter (JSON-Array): D1 erlaubt höchstens 100 Parameter je Abfrage, eine Installation am
 * Landkreis oder an „Deutschland“ sieht aber Hunderte Knoten
 */
const IN_LIST = 'IN (SELECT value FROM json_each(?))';

async function nodeNames(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await db.prepare(`SELECT id, name FROM nodes WHERE id ${IN_LIST}`).bind(JSON.stringify(unique)).all<{ id: string; name: string }>();
  return new Map(rows.results.map((r) => [r.id, r.name]));
}

const toRecord = (r: RecordRow, names: Map<string, string>): SyncRecord => ({
  uid: r.uid,
  kind: r.kind,
  nodeId: r.node_id,
  nodeName: names.get(r.node_id) ?? '',
  rev: r.rev,
  deleted: r.deleted === 1,
  data: r.data === null ? null : JSON.parse(r.data),
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
  seq: r.seq,
});

export async function getRecord(db: D1Database, uid: string): Promise<SyncRecord | null> {
  const row = await db.prepare('SELECT * FROM md_records WHERE uid = ?').bind(uid).first<RecordRow>();
  return row ? toRecord(row, await nodeNames(db, [row.node_id])) : null;
}

/** Knoten, deren Datensätze ein Knoten sieht: darüber (inkl. selbst) und darunter */
export async function scopeOf(db: D1Database, nodeId: string): Promise<{ up: string[]; down: string[] }> {
  return { up: (await lineage(db, nodeId)).map((n) => n.id), down: await descendantIds(db, nodeId) };
}

const SCOPED: RecordKind[] = ['object', 'objectFile'];
/** Bedingung „sichtbar für den Knoten“ je Art (siehe VISIBLE_BELOW; Objekte und Dateien nach scope ihres Typs) */
function visibleWhere(scope: { up: string[]; down: string[] }, kinds: readonly RecordKind[] = RECORD_KINDS): { sql: string; args: string[] } {
  const parts: string[] = [];
  const args: string[] = [];
  const scoped = kinds.filter((k) => SCOPED.includes(k));
  if (scoped.length) {
    // up[0] ist der Knoten selbst
    parts.push(`(kind ${IN_LIST} AND (node_id = ? OR (scope IN ('down', 'both') AND node_id ${IN_LIST}) OR (scope IN ('up', 'both') AND node_id ${IN_LIST})))`);
    args.push(JSON.stringify(scoped), scope.up[0] ?? '', JSON.stringify(scope.up), JSON.stringify(scope.down));
  }
  for (const kind of kinds) {
    if (SCOPED.includes(kind)) continue;
    const nodes = VISIBLE_BELOW[kind] ? [...scope.up, ...scope.down] : scope.up;
    if (!nodes.length) continue;
    parts.push(`(kind = ? AND node_id ${IN_LIST})`);
    args.push(kind, JSON.stringify(nodes));
  }
  return { sql: parts.length ? `(${parts.join(' OR ')})` : '0', args };
}

/** Abruf einer Installation: alle sichtbaren Änderungen nach dem Cursor */
export async function pull(db: D1Database, nodeId: string, after: number): Promise<{ items: SyncRecord[]; next: number; more: boolean }> {
  const where = visibleWhere(await scopeOf(db, nodeId));
  const rows = await db
    .prepare(`SELECT * FROM md_records WHERE seq > ? AND ${where.sql} ORDER BY seq LIMIT ?`)
    .bind(after, ...where.args, SYNC_BATCH + 1)
    .all<RecordRow>();
  const page = rows.results.slice(0, SYNC_BATCH);
  const names = await nodeNames(db, page.map((r) => r.node_id));
  // Ohne Treffer springt der Cursor ans Ende, damit unsichtbare Änderungen nicht immer wieder durchsucht werden
  const end = page.at(-1)?.seq ?? (await db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM md_records').first<{ n: number }>())?.n ?? after;
  return { items: page.map((r) => toRecord(r, names)), next: Math.max(after, end), more: rows.results.length > SYNC_BATCH };
}

/** Datensätze, die ein Knoten sieht (Portal) */
export async function listForNode(db: D1Database, nodeId: string, kind: RecordKind, roleOf: (nodeId: string) => Promise<CloudRole | null>): Promise<PortalRecord[]> {
  const scope = await scopeOf(db, nodeId);
  const where = visibleWhere(scope, [kind]);
  const rows = await db.prepare(`SELECT * FROM md_records WHERE deleted = 0 AND ${where.sql} ORDER BY seq`).bind(...where.args).all<RecordRow>();
  const names = await nodeNames(db, rows.results.map((r) => r.node_id));
  const roles = new Map<string, CloudRole | null>();
  const out: PortalRecord[] = [];
  for (const r of rows.results) {
    if (!roles.has(r.node_id)) roles.set(r.node_id, await roleOf(r.node_id));
    out.push({
      ...toRecord(r, names),
      editable: atLeast(roles.get(r.node_id) ?? null, 'editor'),
      position: r.node_id === nodeId ? 'here' : scope.up.includes(r.node_id) ? 'above' : 'below',
    });
  }
  return out;
}

export interface WriteInput {
  uid: string;
  kind: RecordKind;
  /** Knoten für neue Datensätze */
  nodeId: string;
  baseRev: number;
  deleted: boolean;
  data: unknown;
  by: string;
  /** Darf an diesem Knoten schreiben (Installation: nur der eigene, Portal: Rolle Pflegen) */
  mayWrite: (nodeId: string) => Promise<boolean>;
  /** Dateien der Objektbibliothek (R2) */
  blobs?: R2Bucket;
}

export const blobKey = (uid: string) => `lib/${uid}`;

/** Sichtbarkeit eines Objekts bzw. einer Datei aus Typ bzw. Objekt; Fehlertext, wenn der Verweis fehlt */
async function scopeFor(db: D1Database, kind: RecordKind, data: Record<string, unknown>): Promise<{ scope: string | null; node?: string } | string> {
  if (kind === 'object') {
    const t = await db.prepare("SELECT data FROM md_records WHERE uid = ? AND kind = 'objectType' AND deleted = 0").bind(data.typeUid).first<{ data: string }>();
    if (!t) return 'Objekttyp unbekannt';
    return { scope: (JSON.parse(t.data) as { visibility?: string }).visibility ?? 'both' };
  }
  if (kind === 'objectFile') {
    const o = await db.prepare("SELECT node_id, scope FROM md_records WHERE uid = ? AND kind = 'object' AND deleted = 0").bind(data.objectUid).first<{ node_id: string; scope: string | null }>();
    if (!o) return 'Objekt unbekannt';
    // Dateien gehören dem Bereich des Objekts
    return { scope: o.scope, node: o.node_id };
  }
  return { scope: null };
}

/**
 * Anlegen, Ändern oder Löschen mit optimistischer Sperre: baseRev muss der aktuellen Revision entsprechen (0 = neu).
 * Sonst bekommt der Schreibende den aktuellen Stand zurück.
 */
export async function writeRecord(db: D1Database, w: WriteInput, now: Date): Promise<SyncResult> {
  const ts = now.toISOString();
  const current = await db.prepare('SELECT * FROM md_records WHERE uid = ?').bind(w.uid).first<RecordRow>();
  const currentRecord = async () => (current ? toRecord(current, await nodeNames(db, [current.node_id])) : null);
  if (current && current.kind !== w.kind) return { uid: w.uid, status: 'invalid', reason: 'Art passt nicht zum vorhandenen Datensatz' };
  const node = current?.node_id ?? w.nodeId;
  if (!(await w.mayWrite(node))) return { uid: w.uid, status: 'conflict', record: await currentRecord(), reason: 'Gepflegt von einem anderen Knoten' };
  if ((current?.rev ?? 0) !== w.baseRev) return { uid: w.uid, status: 'conflict', record: await currentRecord(), reason: 'In der Cloud zwischenzeitlich geändert' };

  let data: string | null = null;
  let scope = current?.scope ?? null;
  if (!w.deleted) {
    const parsed = RECORD_SCHEMAS[w.kind].safeParse(w.data);
    if (!parsed.success) return { uid: w.uid, status: 'invalid', reason: parsed.error.issues.map((i) => `${i.path.join('.') || 'Daten'}: ${i.message}`).join('; ') };
    data = JSON.stringify(parsed.data);
    const ref = await scopeFor(db, w.kind, parsed.data as Record<string, unknown>);
    if (typeof ref === 'string') return { uid: w.uid, status: 'invalid', reason: ref };
    scope = ref.scope;
    if (w.kind === 'objectFile') {
      if (current && current.data !== data) return { uid: w.uid, status: 'invalid', reason: 'Dateien lassen sich nicht ändern, nur löschen und neu hochladen' };
      if (!current && ref.node && ref.node !== node) return { uid: w.uid, status: 'invalid', reason: 'Datei gehört zum Bereich des Objekts' };
      const head = w.blobs ? await w.blobs.head(blobKey(w.uid)) : null;
      const f = parsed.data as { sizeBytes: number };
      if (!current && (!head || head.size !== f.sizeBytes)) return { uid: w.uid, status: 'invalid', reason: 'Datei fehlt – erst hochladen' };
    }
  } else if (!current) {
    return { uid: w.uid, status: 'invalid', reason: 'Unbekannter Datensatz' };
  }

  if (!current) {
    await db
      .prepare(`INSERT INTO md_records (uid, kind, node_id, rev, deleted, data, updated_at, updated_by, seq, scope) VALUES (?, ?, ?, 1, 0, ?, ?, ?, ${NEXT_SEQ}, ?)`)
      .bind(w.uid, w.kind, node, data, ts, w.by, scope)
      .run();
    if (w.kind === 'objectFile') await db.prepare('DELETE FROM library_uploads WHERE uid = ?').bind(w.uid).run();
  } else {
    const res = await db
      .prepare(`UPDATE md_records SET rev = rev + 1, deleted = ?, data = ?, updated_at = ?, updated_by = ?, seq = ${NEXT_SEQ}, scope = ? WHERE uid = ? AND rev = ?`)
      .bind(w.deleted ? 1 : 0, data, ts, w.by, scope, w.uid, w.baseRev)
      .run();
    if (!res.meta.changes) return { uid: w.uid, status: 'conflict', record: await getRecord(db, w.uid), reason: 'In der Cloud zwischenzeitlich geändert' };
  }
  if (w.kind === 'objectFile' && w.deleted) await w.blobs?.delete(blobKey(w.uid));
  if (w.kind === 'object' && w.deleted) await removeFilesOf(db, w.uid, w.blobs, ts, w.by);
  // Sichtbarkeit eines Typs geändert: Objekte und Dateien neu einordnen (neue seq, damit Installationen sie bekommen)
  if (w.kind === 'objectType' && !w.deleted && current?.data) {
    const before = (JSON.parse(current.data) as { visibility?: string }).visibility;
    const after = (JSON.parse(data!) as { visibility?: string }).visibility;
    if (before !== after) await rescope(db, w.uid, after ?? 'both');
  }
  return { uid: w.uid, status: 'ok', record: (await getRecord(db, w.uid))! };
}

/** Objekte eines Typs und deren Dateien bekommen die neue Sichtbarkeit */
async function rescope(db: D1Database, typeUid: string, scope: string): Promise<void> {
  const objects = (await db.prepare("SELECT uid, data FROM md_records WHERE kind = 'object' AND deleted = 0").all<{ uid: string; data: string }>()).results.filter(
    (o) => (JSON.parse(o.data) as { typeUid?: string }).typeUid === typeUid,
  );
  const ids = new Set(objects.map((o) => o.uid));
  const files = (await db.prepare("SELECT uid, data FROM md_records WHERE kind = 'objectFile' AND deleted = 0").all<{ uid: string; data: string }>()).results.filter((f) =>
    ids.has((JSON.parse(f.data) as { objectUid?: string }).objectUid ?? ''),
  );
  for (const r of [...objects, ...files]) await db.prepare(`UPDATE md_records SET scope = ?, seq = ${NEXT_SEQ} WHERE uid = ?`).bind(scope, r.uid).run();
}

/** Objekt gelöscht: seine Dateien als Tombstone, die Inhalte weg */
async function removeFilesOf(db: D1Database, objectUid: string, blobs: R2Bucket | undefined, ts: string, by: string): Promise<void> {
  const files = (await db.prepare("SELECT uid, data FROM md_records WHERE kind = 'objectFile' AND deleted = 0").all<{ uid: string; data: string }>()).results.filter(
    (f) => (JSON.parse(f.data) as { objectUid?: string }).objectUid === objectUid,
  );
  for (const f of files) {
    await db.prepare(`UPDATE md_records SET rev = rev + 1, deleted = 1, data = NULL, updated_at = ?, updated_by = ?, seq = ${NEXT_SEQ} WHERE uid = ?`).bind(ts, by, f.uid).run();
    await blobs?.delete(blobKey(f.uid));
  }
}

/** Datei-Datensatz, wenn er für den Knoten sichtbar ist */
export async function visibleFile(db: D1Database, nodeId: string, uid: string): Promise<boolean> {
  const where = visibleWhere(await scopeOf(db, nodeId), ['objectFile']);
  return !!(await db.prepare(`SELECT 1 FROM md_records WHERE uid = ? AND deleted = 0 AND ${where.sql}`).bind(uid, ...where.args).first());
}
