import { CLOUD_ROLES, roleRank, type CloudNode, type CloudNodeRef, type CloudRole, type NodeKind } from '../cloudprotocol.js';
import { children as regionChildren, region } from '../regions.js';

/**
 * Baustruktur: Gebietskörperschaften nach dem Amtlichen Regionalschlüssel (Knoten-ID `ars:<ARS>`, entstehen bei Bedarf
 * samt Eltern) und frei angelegte Knoten darunter (UUID). Rollen gelten für den Knoten und alles darunter.
 */

export interface NodeRow {
  id: string;
  parent_id: string | null;
  ars: string | null;
  name: string;
}

export const ROOT_ID = 'ars:';
const MAX_DEPTH = 30;

export const arsId = (ars: string) => `ars:${ars}`;
/** Übergeordneter Regionalschlüssel (Pfad aus dem Katalog), '' = Deutschland */
const parentArs = (ars: string) => region(ars)?.path.at(-2)?.ars ?? '';

/** Knoten lesen; ARS-Knoten werden samt fehlender Eltern angelegt, sobald sie gebraucht werden */
export async function getNode(db: D1Database, id: string): Promise<NodeRow | null> {
  const row = await db.prepare('SELECT id, parent_id, ars, name FROM nodes WHERE id = ?').bind(id).first<NodeRow>();
  if (row || !id.startsWith('ars:')) return row;
  const ars = id.slice(4);
  const r = region(ars);
  if (!r) return null;
  const parent = await getNode(db, arsId(parentArs(ars)));
  if (!parent) return null;
  await db.prepare('INSERT OR IGNORE INTO nodes (id, parent_id, ars, name, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, parent.id, ars, r.name, new Date().toISOString()).run();
  return { id, parent_id: parent.id, ars, name: r.name };
}

/** Knoten und alle darüber, vom Knoten aus nach oben */
export async function lineage(db: D1Database, id: string): Promise<NodeRow[]> {
  const out: NodeRow[] = [];
  let next: string | null = id;
  while (next && out.length < MAX_DEPTH) {
    const n = await getNode(db, next);
    if (!n) break;
    out.push(n);
    next = n.parent_id;
  }
  return out;
}

export const kindOf = (n: NodeRow): NodeKind => (n.ars === null ? 'free' : n.ars === '' ? 'country' : (region(n.ars)?.kind ?? 'gemeinde'));

export async function nodeRef(db: D1Database, id: string): Promise<CloudNodeRef | null> {
  const line = await lineage(db, id);
  if (!line.length) return null;
  return { id, name: line[0]!.name, path: line.filter((n) => n.id !== ROOT_ID).map((n) => n.name).reverse() };
}

/** Rolle eines Kontos am Knoten: die höchste auf dem Knoten oder darüber; Betreiber sind überall Admin */
export async function roleAt(db: D1Database, account: { id: string; operator: boolean }, nodeId: string): Promise<CloudRole | null> {
  if (account.operator) return 'admin';
  const line = await lineage(db, nodeId);
  if (!line.length) return null;
  const rows = await db
    .prepare(`SELECT role FROM memberships WHERE account_id = ? AND node_id IN (${line.map(() => '?').join(',')})`)
    .bind(account.id, ...line.map((n) => n.id))
    .all<{ role: CloudRole }>();
  let best: CloudRole | null = null;
  for (const r of rows.results) if (roleRank(r.role) > roleRank(best)) best = r.role;
  return best;
}

export const atLeast = (role: CloudRole | null, min: CloudRole) => roleRank(role) >= roleRank(min);

export async function toCloudNode(db: D1Database, n: NodeRow, role: CloudRole | null): Promise<CloudNode> {
  const line = (await lineage(db, n.id)).filter((x) => x.id !== ROOT_ID).reverse();
  return { id: n.id, parentId: n.parent_id, name: n.name, kind: kindOf(n), ars: n.ars, path: line.map((x) => x.name), pathIds: line.map((x) => x.id), role };
}

/** Unterknoten: bei Gebietskörperschaften die Gebiete darunter aus dem Katalog, dazu die freien Knoten */
export async function childNodes(db: D1Database, n: NodeRow, role: CloudRole | null): Promise<CloudNode[]> {
  const free = await db.prepare('SELECT id, parent_id, ars, name FROM nodes WHERE parent_id = ? AND ars IS NULL ORDER BY name').bind(n.id).all<NodeRow>();
  const self = await toCloudNode(db, n, role);
  const child = (id: string, name: string, kind: NodeKind, ars: string | null): CloudNode => ({ id, parentId: n.id, name, kind, ars, path: [...self.path, name], pathIds: [...self.pathIds, id], role });
  const regions = n.ars === null ? [] : (regionChildren(n.ars) ?? []).map((r) => child(arsId(r.ars), r.name, r.kind, r.ars));
  return [...free.results.map((f) => child(f.id, f.name, 'free', null)), ...regions];
}

/** Alle Knoten-IDs unterhalb (nur angelegte; ARS-Knoten ohne Daten gibt es nicht in der Tabelle) */
export async function descendantIds(db: D1Database, id: string): Promise<string[]> {
  // Eine rekursive Abfrage statt IN-Listen: D1 erlaubt höchstens 100 Parameter je Abfrage (unter „Deutschland“ liegen viele Knoten)
  const rows = await db
    .prepare(
      `WITH RECURSIVE d(id, depth) AS (
         SELECT id, 1 FROM nodes WHERE parent_id = ?
         UNION ALL SELECT n.id, d.depth + 1 FROM nodes n JOIN d ON n.parent_id = d.id WHERE d.depth < ?
       ) SELECT id FROM d ORDER BY depth`,
    )
    .bind(id, MAX_DEPTH)
    .all<{ id: string }>();
  return rows.results.map((r) => r.id);
}

export { CLOUD_ROLES };
