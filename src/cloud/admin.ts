import type { AdminAccount, AdminAction, AdminLogEntry, CloudNodeRef, CloudRole } from '../cloudprotocol.js';
import { ROOT_ID } from './nodes.js';

/**
 * Verwaltung durch Betreiber: alle Konten der Plattform mit Status und Rollen, alle Knoten (für die Rollenvergabe),
 * Protokoll der Verwaltungsaktionen. Die Aktionen selbst stehen in portal.ts (sie brauchen Mail und Einmal-Links).
 */

interface AccountRow {
  id: string;
  email: string;
  name: string;
  operator: number;
  created_at: string;
  last_login_at: string | null;
  email_verified_at: string | null;
  password_hash: string | null;
  disabled_at: string | null;
  disabled_by: string | null;
  locked_until: string | null;
  sessions: number;
}

/** Alle Knoten mit Pfad, in einer Abfrage (statt Lineage je Knoten) */
export async function allNodes(db: D1Database): Promise<CloudNodeRef[]> {
  const rows = (await db.prepare('SELECT id, parent_id, name FROM nodes').all<{ id: string; parent_id: string | null; name: string }>()).results;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pathOf = (id: string): string[] => {
    const out: string[] = [];
    for (let n = byId.get(id), depth = 0; n && n.id !== ROOT_ID && depth < 20; n = n.parent_id ? byId.get(n.parent_id) : undefined, depth++) out.unshift(n.name);
    return out;
  };
  return rows
    .map((r) => ({ id: r.id, name: r.id === ROOT_ID ? 'Deutschland' : r.name, path: pathOf(r.id) }))
    .sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' '), 'de'));
}

export async function adminAccounts(db: D1Database, now: Date, q = ''): Promise<AdminAccount[]> {
  const like = `%${q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = (
    await db
      .prepare(
        `SELECT a.id, a.email, a.name, a.operator, a.created_at, a.last_login_at, a.email_verified_at, a.password_hash, a.disabled_at, a.disabled_by, a.locked_until,
           (SELECT COUNT(*) FROM account_sessions s WHERE s.account_id = a.id AND s.expires_at > ?) AS sessions
         FROM accounts a WHERE lower(a.email) LIKE ? ESCAPE '\\' OR lower(a.name) LIKE ? ESCAPE '\\'
         ORDER BY a.operator DESC, lower(a.name), a.email LIMIT 500`,
      )
      .bind(now.toISOString(), like, like)
      .all<AccountRow>()
  ).results;
  const nodes = new Map((await allNodes(db)).map((n) => [n.id, n]));
  const memberships = (await db.prepare('SELECT account_id, node_id, role FROM memberships').all<{ account_id: string; node_id: string; role: CloudRole }>()).results;
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    operator: r.operator === 1,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    emailVerified: r.email_verified_at !== null,
    hasPassword: !!r.password_hash,
    disabledAt: r.disabled_at,
    disabledBy: r.disabled_by,
    lockedUntil: r.locked_until && r.locked_until > now.toISOString() ? r.locked_until : null,
    sessions: r.sessions,
    memberships: memberships
      .filter((m) => m.account_id === r.id)
      .map((m) => ({ node: nodes.get(m.node_id) ?? { id: m.node_id, name: '?', path: [] }, role: m.role }))
      .sort((a, b) => a.node.path.join(' ').localeCompare(b.node.path.join(' '), 'de')),
  }));
}

export async function adminLog(db: D1Database, limit = 200): Promise<AdminLogEntry[]> {
  const rows = (await db.prepare('SELECT at, by_email, target_email, action, detail FROM admin_log ORDER BY seq DESC LIMIT ?').bind(limit).all<{ at: string; by_email: string; target_email: string; action: AdminAction; detail: string }>()).results;
  return rows.map((r) => ({ at: r.at, by: r.by_email, target: r.target_email, action: r.action, detail: r.detail }));
}

export async function logAdmin(db: D1Database, at: string, by: string, target: string, action: AdminAction, detail = ''): Promise<void> {
  await db.prepare('INSERT INTO admin_log (at, by_email, target_email, action, detail) VALUES (?, ?, ?, ?, ?)').bind(at, by, target, action, detail).run();
}
