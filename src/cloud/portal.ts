import {
  INVITATION_TTL_MS,
  LOGIN_CODE_TTL_MS,
  LOGIN_MAILS_PER_HOUR,
  LOGIN_MAX_ATTEMPTS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  CLOUD_ROLE_LABELS,
  freeNodeSchema,
  invitationSchema,
  linkInstallationSchema,
  loginRequestSchema,
  loginVerifySchema,
  memberRoleSchema,
  moveInstallationSchema,
  renameNodeSchema,
  roleRank,
  type CloudRole,
  type InvitationInfo,
  type Me,
  type NodeDetail,
} from '../cloudprotocol.js';
import { body, fail, hash, json, newToken, random, sameCode } from '../http.js';
import { mailDomain, sendSystemMail } from '../mail.js';
import type { Env } from '../relay.js';
import { ROOT_ID, atLeast, childNodes, getNode, lineage, nodeRef, roleAt, toCloudNode } from './nodes.js';
import { installationStatus, type InstallationRow } from './status.js';

interface AccountRow {
  id: string;
  email: string;
  name: string;
  operator: number;
}
interface Account {
  id: string;
  email: string;
  name: string;
  operator: boolean;
}

/** Fehlversuche beim Verknüpfungscode je Konto und Stunde */
const LINK_ATTEMPTS_PER_HOUR = 10;

const toAccount = (r: AccountRow): Account => ({ id: r.id, email: r.email, name: r.name, operator: r.operator === 1 });
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms).toISOString();
const later = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();
const newLoginCode = () => String(new DataView(random(4).buffer).getUint32(0) % 1_000_000).padStart(6, '0');
export const cloudUrl = (env: Env) => (env.CLOUD_URL ?? 'https://cloud.einsatzleitwagen.app').replace(/\/$/, '');
const displayName = (a: Account) => a.name || a.email;

function sessionCookie(token: string, maxAgeS: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeS}`;
}

function cookieToken(req: Request): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === SESSION_COOKIE && v && /^[A-Za-z0-9_-]{43}$/.test(v)) return v;
  }
  return null;
}

async function currentAccount(req: Request, db: D1Database, now: Date): Promise<Account | null> {
  const token = cookieToken(req);
  if (!token) return null;
  const row = await db
    .prepare('SELECT a.id, a.email, a.name, a.operator FROM account_sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .bind(await hash(token), now.toISOString())
    .first<AccountRow>();
  return row ? toAccount(row) : null;
}

/** Codes und Einladungen per Mail; mit CLOUD_DEV (lokal, wrangler dev) stattdessen ins Log */
async function mail(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  if (env.CLOUD_DEV === '1') {
    console.log(`[cloud] Mail an ${to}: ${subject}\n${text}`);
    return true;
  }
  if (!env.SEND) return false;
  await sendSystemMail(env, { to, subject, text });
  return true;
}

async function me(db: D1Database, a: Account): Promise<Me> {
  const rows = await db.prepare('SELECT node_id, role FROM memberships WHERE account_id = ? ORDER BY created_at').bind(a.id).all<{ node_id: string; role: CloudRole }>();
  const memberships = [];
  for (const r of rows.results) {
    const node = await nodeRef(db, r.node_id);
    if (node) memberships.push({ node, role: r.role });
  }
  if (a.operator && !memberships.some((m) => m.node.id === ROOT_ID)) memberships.unshift({ node: { id: ROOT_ID, name: 'Deutschland', path: [] }, role: 'admin' as const });
  return { ...a, memberships };
}

async function nodeDetail(db: D1Database, a: Account, nodeId: string, role: CloudRole): Promise<NodeDetail> {
  const line = await lineage(db, nodeId);
  const node = line[0]!;
  const ids = line.map((n) => n.id);
  const names = new Map(line.map((n) => [n.id, n.name]));
  const rows = await db
    .prepare(
      `SELECT m.account_id, m.node_id, m.role, a.email, a.name FROM memberships m JOIN accounts a ON a.id = m.account_id
       WHERE m.node_id IN (${ids.map(() => '?').join(',')}) ORDER BY a.email`,
    )
    .bind(...ids)
    .all<{ account_id: string; node_id: string; role: CloudRole; email: string; name: string }>();
  const members = rows.results.map((r) => ({ accountId: r.account_id, email: r.email, name: r.name, role: r.role, inherited: r.node_id !== nodeId, nodeName: names.get(r.node_id) ?? '' }));
  const invitations = atLeast(role, 'admin')
    ? (
        await db
          .prepare('SELECT id, email, role, invited_by, expires_at FROM invitations WHERE node_id = ? AND accepted_at IS NULL ORDER BY created_at')
          .bind(nodeId)
          .all<{ id: string; email: string; role: CloudRole; invited_by: string; expires_at: string }>()
      ).results.map((i) => ({ id: i.id, email: i.email, role: i.role, invitedBy: i.invited_by, expiresAt: i.expires_at }))
    : [];
  return { ...(await toCloudNode(db, node, role)), children: await childNodes(db, node, role), members, invitations };
}

/** Rolle am Knoten mindestens `min`, sonst Fehlerantwort */
async function need(db: D1Database, a: Account, nodeId: string, min: CloudRole): Promise<{ role: CloudRole } | Response> {
  if (!(await getNode(db, nodeId))) return fail(404, 'Knoten nicht gefunden');
  const role = await roleAt(db, a, nodeId);
  if (!atLeast(role, min)) return fail(403, min === 'admin' ? 'Nur für Verwalter dieses Knotens' : 'Kein Zugriff auf diesen Knoten');
  return { role: role! };
}

async function invitationInfo(db: D1Database, row: { email: string; node_id: string; role: CloudRole; invited_by: string; expires_at: string; accepted_at: string | null }, now: Date): Promise<InvitationInfo> {
  return {
    email: row.email,
    node: (await nodeRef(db, row.node_id)) ?? { id: row.node_id, name: '?', path: [] },
    role: row.role,
    invitedBy: row.invited_by,
    expired: row.expires_at <= now.toISOString(),
    accepted: row.accepted_at !== null,
  };
}

/**
 * Portal-API unter /v1/cloud. Anmeldung per Code an die E-Mail-Adresse (legt beim ersten Mal das Konto an), Sitzung als
 * HttpOnly-Cookie (SameSite=Strict). Ändernde Aufrufe verlangen JSON und, falls der Browser sie schickt, die eigene Origin.
 */
export async function handlePortal(req: Request, env: Env, path: string, url: URL, now: Date): Promise<Response> {
  const db = env.DB;
  const ts = now.toISOString();
  const write = req.method !== 'GET' && req.method !== 'HEAD';
  if (write) {
    const origin = req.headers.get('origin');
    // wrangler dev schreibt den Origin-Kopf um (ohne Port) – lokal (CLOUD_DEV) nicht prüfen
    if (origin && env.CLOUD_DEV !== '1' && origin !== url.origin && origin !== new URL(cloudUrl(env)).origin) return fail(403, 'Fremde Herkunft');
    if (req.method !== 'DELETE' && !(req.headers.get('content-type') ?? '').includes('application/json')) return fail(415, 'JSON erwartet');
  }

  // --- Anmeldung ---

  if (req.method === 'POST' && path === '/v1/cloud/login') {
    const parsed = loginRequestSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, 'E-Mail-Adresse ungültig');
    const email = parsed.data.email;
    const sent = await db.prepare('SELECT COUNT(*) AS n FROM login_mails WHERE email = ? AND sent_at > ?').bind(email, ago(now, 3600_000)).first<{ n: number }>();
    if ((sent?.n ?? 0) >= LOGIN_MAILS_PER_HOUR) return fail(429, 'Zu viele Codes angefordert, bitte später erneut versuchen');
    const code = newLoginCode();
    await db
      .prepare('INSERT INTO login_codes (email, code_hash, attempts, expires_at) VALUES (?, ?, 0, ?) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at')
      .bind(email, await hash(`${email}:${code}`), later(now, LOGIN_CODE_TTL_MS))
      .run();
    await db.prepare('INSERT INTO login_mails (email, sent_at) VALUES (?, ?)').bind(email, ts).run();
    const ok = await mail(
      env,
      email,
      `ELVIS Cloud: Anmeldecode ${code}`,
      `Hallo,\n\nIhr Code für die Anmeldung bei ELVIS Cloud (${cloudUrl(env)}):\n\n  ${code}\n\nEr gilt 15 Minuten. Wenn Sie sich nicht anmelden wollten, ignorieren Sie diese Mail.\n\nELVIS Cloud`,
    );
    if (!ok) return fail(503, 'Mailversand ist auf diesem Relay nicht eingerichtet');
    return json(202, { ok: true });
  }

  if (req.method === 'POST' && path === '/v1/cloud/login/verify') {
    const parsed = loginVerifySchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Eingabe ungültig');
    const { email, code, name } = parsed.data;
    const row = await db.prepare('SELECT code_hash, attempts, expires_at FROM login_codes WHERE email = ?').bind(email).first<{ code_hash: string; attempts: number; expires_at: string }>();
    if (!row || row.expires_at <= ts) return fail(401, 'Code abgelaufen, bitte neu anfordern');
    if (row.attempts >= LOGIN_MAX_ATTEMPTS) return fail(429, 'Zu viele Fehlversuche, bitte neuen Code anfordern');
    if (!sameCode(row.code_hash, await hash(`${email}:${code}`))) {
      await db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
      return fail(401, 'Code falsch');
    }
    await db.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run();
    let account = await db.prepare('SELECT id, email, name, operator FROM accounts WHERE email = ?').bind(email).first<AccountRow>();
    if (!account) {
      const id = crypto.randomUUID();
      await db.prepare('INSERT INTO accounts (id, email, name, created_at) VALUES (?, ?, ?, ?)').bind(id, email, name ?? '', ts).run();
      account = { id, email, name: name ?? '', operator: 0 };
    }
    await db.prepare('UPDATE accounts SET last_login_at = ? WHERE id = ?').bind(ts, account.id).run();
    const token = newToken();
    await db.prepare('INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await hash(token), account.id, ts, later(now, SESSION_TTL_MS)).run();
    return json(200, await me(db, toAccount(account)), { 'set-cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
  }

  // Einladung ansehen geht ohne Anmeldung (der Link ist der Zugang)
  const invite = /^\/v1\/cloud\/invitations\/token\/([A-Za-z0-9_-]{43})(\/accept)?$/.exec(path);
  if (invite && req.method === 'GET') {
    const row = await db.prepare('SELECT * FROM invitations WHERE token_hash = ?').bind(await hash(invite[1]!)).first<{ email: string; node_id: string; role: CloudRole; invited_by: string; expires_at: string; accepted_at: string | null }>();
    return row ? json(200, await invitationInfo(db, row, now)) : fail(404, 'Einladung nicht gefunden');
  }

  const account = await currentAccount(req, db, now);
  if (!account) return fail(401, 'Bitte anmelden');

  if (req.method === 'POST' && path === '/v1/cloud/logout') {
    const token = cookieToken(req);
    if (token) await db.prepare('DELETE FROM account_sessions WHERE token_hash = ?').bind(await hash(token)).run();
    return json(204, null, { 'set-cookie': sessionCookie('', 0) });
  }
  if (path === '/v1/cloud/me') {
    if (req.method === 'GET') return json(200, await me(db, account));
    if (req.method === 'PATCH') {
      const parsed = renameNodeSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, 'Name ungültig');
      await db.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind(parsed.data.name, account.id).run();
      return json(200, await me(db, { ...account, name: parsed.data.name }));
    }
  }

  if (invite && req.method === 'POST' && invite[2]) {
    const row = await db.prepare('SELECT * FROM invitations WHERE token_hash = ?').bind(await hash(invite[1]!)).first<{ id: string; email: string; node_id: string; role: CloudRole; invited_by: string; expires_at: string; accepted_at: string | null }>();
    if (!row) return fail(404, 'Einladung nicht gefunden');
    if (row.accepted_at) return fail(409, 'Einladung wurde schon angenommen');
    if (row.expires_at <= ts) return fail(410, 'Einladung abgelaufen');
    if (row.email !== account.email) return fail(403, `Die Einladung gilt für ${row.email} – bitte mit dieser Adresse anmelden`);
    const existing = await db.prepare('SELECT role FROM memberships WHERE account_id = ? AND node_id = ?').bind(account.id, row.node_id).first<{ role: CloudRole }>();
    if (roleRank(row.role) > roleRank(existing?.role ?? null)) {
      await db
        .prepare('INSERT INTO memberships (account_id, node_id, role, created_at, created_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, node_id) DO UPDATE SET role = excluded.role')
        .bind(account.id, row.node_id, row.role, ts, row.invited_by)
        .run();
    }
    await db.prepare('UPDATE invitations SET accepted_at = ? WHERE id = ?').bind(ts, row.id).run();
    return json(200, await me(db, account));
  }

  // --- Baustruktur ---

  const nodePath = /^\/v1\/cloud\/nodes\/([^/]+)(\/members(?:\/([0-9a-f-]{36}))?)?$/.exec(path);
  if (nodePath) {
    const nodeId = decodeURIComponent(nodePath[1]!);
    const [, , members, memberId] = nodePath;
    if (!members) {
      if (req.method === 'GET') {
        const r = await need(db, account, nodeId, 'viewer');
        return r instanceof Response ? r : json(200, await nodeDetail(db, account, nodeId, r.role));
      }
      if (req.method === 'PATCH' || req.method === 'DELETE') {
        const node = await getNode(db, nodeId);
        if (!node) return fail(404, 'Knoten nicht gefunden');
        if (node.ars !== null) return fail(400, 'Gebietskörperschaften lassen sich nicht ändern');
        const r = await need(db, account, nodeId, 'admin');
        if (r instanceof Response) return r;
        if (req.method === 'PATCH') {
          const parsed = renameNodeSchema.safeParse(await body(req));
          if (!parsed.success) return fail(400, 'Name ungültig');
          await db.prepare('UPDATE nodes SET name = ? WHERE id = ?').bind(parsed.data.name, nodeId).run();
          return json(200, await nodeDetail(db, account, nodeId, r.role));
        }
        if (await db.prepare('SELECT 1 FROM nodes WHERE parent_id = ?').bind(nodeId).first()) return fail(409, 'Knoten hat Unterknoten');
        if (await db.prepare('SELECT 1 FROM installations WHERE node_id = ?').bind(nodeId).first()) return fail(409, 'Am Knoten hängen Installationen');
        await db.prepare('DELETE FROM memberships WHERE node_id = ?').bind(nodeId).run();
        await db.prepare('DELETE FROM invitations WHERE node_id = ?').bind(nodeId).run();
        await db.prepare('DELETE FROM nodes WHERE id = ?').bind(nodeId).run();
        return json(204, null);
      }
      return fail(405, 'Nicht erlaubt');
    }
    const r = await need(db, account, nodeId, memberId ? 'admin' : 'viewer');
    if (r instanceof Response) return r;
    if (!memberId) return req.method === 'GET' ? json(200, (await nodeDetail(db, account, nodeId, r.role)).members) : fail(405, 'Nicht erlaubt');
    if (memberId === account.id) return fail(400, 'Die eigene Rolle ändert ein anderer Verwalter');
    if (req.method === 'PUT') {
      const parsed = memberRoleSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, 'Rolle ungültig');
      const res = await db.prepare('UPDATE memberships SET role = ? WHERE account_id = ? AND node_id = ?').bind(parsed.data.role, memberId, nodeId).run();
      return res.meta.changes ? json(200, (await nodeDetail(db, account, nodeId, r.role)).members) : fail(404, 'Mitglied nicht gefunden (geerbte Rollen am oberen Knoten ändern)');
    }
    if (req.method === 'DELETE') {
      const res = await db.prepare('DELETE FROM memberships WHERE account_id = ? AND node_id = ?').bind(memberId, nodeId).run();
      return res.meta.changes ? json(204, null) : fail(404, 'Mitglied nicht gefunden');
    }
    return fail(405, 'Nicht erlaubt');
  }

  if (req.method === 'POST' && path === '/v1/cloud/nodes') {
    const parsed = freeNodeSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Eingabe ungültig');
    const r = await need(db, account, parsed.data.parentId, 'admin');
    if (r instanceof Response) return r;
    if (parsed.data.parentId === ROOT_ID) return fail(400, 'Freie Knoten hängen unter einer Gebietskörperschaft');
    const id = crypto.randomUUID();
    await db.prepare('INSERT INTO nodes (id, parent_id, ars, name, created_at, created_by) VALUES (?, ?, NULL, ?, ?, ?)').bind(id, parsed.data.parentId, parsed.data.name, ts, account.email).run();
    return json(201, await nodeDetail(db, account, id, r.role));
  }

  // --- Einladungen ---

  if (req.method === 'POST' && path === '/v1/cloud/invitations') {
    const parsed = invitationSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Eingabe ungültig');
    const { nodeId, email, role } = parsed.data;
    const r = await need(db, account, nodeId, 'admin');
    if (r instanceof Response) return r;
    const recent = await db.prepare('SELECT COUNT(*) AS n FROM invitations WHERE invited_by = ? AND created_at > ?').bind(account.email, ago(now, 24 * 3600_000)).first<{ n: number }>();
    if ((recent?.n ?? 0) >= 50) return fail(429, 'Zu viele Einladungen heute');
    const token = newToken();
    const id = crypto.randomUUID();
    await db.prepare('DELETE FROM invitations WHERE node_id = ? AND email = ? AND accepted_at IS NULL').bind(nodeId, email).run();
    await db
      .prepare('INSERT INTO invitations (id, token_hash, email, node_id, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, await hash(token), email, nodeId, role, account.email, ts, later(now, INVITATION_TTL_MS))
      .run();
    const node = await nodeRef(db, nodeId);
    const link = `${cloudUrl(env)}/einladung/${token}`;
    const ok = await mail(
      env,
      email,
      `Einladung zur Datenpflege: ${node?.name ?? ''}`,
      `Hallo,\n\n${displayName(account)} lädt Sie ein, in ELVIS Cloud die Stammdaten von\n\n  ${node?.path.join(' › ') ?? ''}\n\nmitzupflegen (Rolle: ${CLOUD_ROLE_LABELS[role]}). Zum Annehmen den Link öffnen und mit dieser Adresse anmelden\n(gültig 14 Tage):\n\n  ${link}\n\nWenn Sie damit nichts anfangen können, ignorieren Sie diese Mail.\n\nELVIS Cloud`,
    );
    if (!ok) return fail(503, 'Mailversand ist auf diesem Relay nicht eingerichtet');
    return json(201, { id, email, role, invitedBy: account.email, expiresAt: later(now, INVITATION_TTL_MS) });
  }

  const invitationId = /^\/v1\/cloud\/invitations\/([0-9a-f-]{36})$/.exec(path);
  if (invitationId && req.method === 'DELETE') {
    const row = await db.prepare('SELECT node_id FROM invitations WHERE id = ?').bind(invitationId[1]).first<{ node_id: string }>();
    if (!row) return fail(404, 'Einladung nicht gefunden');
    const r = await need(db, account, row.node_id, 'admin');
    if (r instanceof Response) return r;
    await db.prepare('DELETE FROM invitations WHERE id = ?').bind(invitationId[1]).run();
    return json(204, null);
  }

  // --- Installationen ---

  if (path === '/v1/cloud/installations') {
    if (req.method === 'GET') {
      const rows = await db.prepare('SELECT * FROM installations ORDER BY name').all<InstallationRow>();
      const out = [];
      for (const i of rows.results) if (atLeast(await roleAt(db, account, i.node_id), 'viewer')) out.push(await installationStatus(db, i, mailDomain(env), now));
      return json(200, out);
    }
    if (req.method === 'POST') {
      const failed = await db.prepare('SELECT COUNT(*) AS n FROM link_attempts WHERE account_id = ? AND at > ?').bind(account.id, ago(now, 3600_000)).first<{ n: number }>();
      if ((failed?.n ?? 0) >= LINK_ATTEMPTS_PER_HOUR) return fail(429, 'Zu viele falsche Codes, bitte später erneut versuchen');
      const parsed = linkInstallationSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Eingabe ungültig');
      const r = await need(db, account, parsed.data.nodeId, 'admin');
      if (r instanceof Response) return r;
      const request = await db
        .prepare('SELECT * FROM link_requests WHERE code = ? AND expires_at > ?')
        .bind(parsed.data.code, ts)
        .first<{ elw_id: string; name: string; sig_public_key: string; version: string }>();
      if (!request) {
        await db.prepare('INSERT INTO link_attempts (account_id, at) VALUES (?, ?)').bind(account.id, ts).run();
        return fail(404, 'Code unbekannt oder abgelaufen');
      }
      await db
        .prepare('INSERT OR REPLACE INTO installations (elw_id, node_id, name, sig_public_key, version, linked_by, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(request.elw_id, parsed.data.nodeId, request.name, request.sig_public_key, request.version, account.email, ts)
        .run();
      await db.prepare('DELETE FROM link_requests WHERE elw_id = ?').bind(request.elw_id).run();
      const row = (await db.prepare('SELECT * FROM installations WHERE elw_id = ?').bind(request.elw_id).first<InstallationRow>())!;
      return json(201, await installationStatus(db, row, mailDomain(env), now));
    }
    return fail(405, 'Nicht erlaubt');
  }

  const inst = /^\/v1\/cloud\/installations\/([0-9a-f-]{36})$/.exec(path);
  if (inst) {
    const row = await db.prepare('SELECT * FROM installations WHERE elw_id = ?').bind(inst[1]).first<InstallationRow>();
    if (!row) return fail(404, 'Installation nicht gefunden');
    const r = await need(db, account, row.node_id, req.method === 'GET' ? 'viewer' : 'admin');
    if (r instanceof Response) return r;
    if (req.method === 'GET') return json(200, await installationStatus(db, row, mailDomain(env), now));
    if (req.method === 'PUT') {
      const parsed = moveInstallationSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, 'Eingabe ungültig');
      const target = await need(db, account, parsed.data.nodeId, 'admin');
      if (target instanceof Response) return target;
      await db.prepare('UPDATE installations SET node_id = ?, name = ? WHERE elw_id = ?').bind(parsed.data.nodeId, parsed.data.name ?? row.name, row.elw_id).run();
      const updated = (await db.prepare('SELECT * FROM installations WHERE elw_id = ?').bind(row.elw_id).first<InstallationRow>())!;
      return json(200, await installationStatus(db, updated, mailDomain(env), now));
    }
    if (req.method === 'DELETE') {
      await db.prepare('DELETE FROM installations WHERE elw_id = ?').bind(row.elw_id).run();
      return json(204, null);
    }
    return fail(405, 'Nicht erlaubt');
  }

  return fail(404, 'Nicht gefunden');
}

/** Stündlich: abgelaufene Codes, Sitzungen, Einladungen und Verknüpfungsanfragen */
export async function cloudCleanup(env: Env, now: Date): Promise<void> {
  const ts = now.toISOString();
  await env.DB.prepare('DELETE FROM login_codes WHERE expires_at < ?').bind(ts).run();
  await env.DB.prepare('DELETE FROM login_mails WHERE sent_at < ?').bind(ago(now, 3600_000)).run();
  await env.DB.prepare('DELETE FROM account_sessions WHERE expires_at < ?').bind(ts).run();
  await env.DB.prepare('DELETE FROM invitations WHERE expires_at < ? AND accepted_at IS NULL').bind(ago(now, 30 * 24 * 3600_000)).run();
  await env.DB.prepare('DELETE FROM link_requests WHERE expires_at < ?').bind(ts).run();
  await env.DB.prepare('DELETE FROM link_attempts WHERE at < ?').bind(ago(now, 3600_000)).run();
}
