import {
  INVITATION_TTL_MS,
  ACCOUNT_MAILS_PER_HOUR,
  LOGIN_LOCK_MS,
  LOGIN_MAX_FAILURES,
  RESET_TTL_MS,
  VERIFY_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  CLOUD_ROLE_LABELS,
  adminAccountPatchSchema,
  adminMembershipSchema,
  type AdminAction,
  type AdminOverview,
  freeNodeSchema,
  invitationSchema,
  linkInstallationSchema,
  changeEmailSchema,
  changePasswordSchema,
  deleteAccountSchema,
  emailOnlySchema,
  linkTokenSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  memberRoleSchema,
  moveInstallationSchema,
  renameNodeSchema,
  roleRank,
  type CloudRole,
  type InvitationInfo,
  type Me,
  type NodeDetail,
} from '../cloudprotocol.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { adminAccounts, adminLog, allNodes, logAdmin } from './admin.js';
import { body, fail, hash, json, newToken } from '../http.js';
import { mailDomain, sendSystemMail } from '../mail.js';
import type { Env } from '../relay.js';
import { ROOT_ID, atLeast, childNodes, getNode, lineage, nodeRef, roleAt, toCloudNode } from './nodes.js';
import { installationStatus, type InstallationRow } from './status.js';
import { blobKey, getRecord, listForNode, visibleFile, writeRecord } from './records.js';
import { storeUpload } from './elw.js';
import { RECORD_KINDS, recordBatchSchema, recordCreateSchema, recordUpdateSchema, type RecordKind } from '../syncprotocol.js';

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
    .prepare('SELECT a.id, a.email, a.name, a.operator FROM account_sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ? AND a.disabled_at IS NULL')
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
/** Bereiche, die das Konto als einziger Admin verwaltet (auch über darüberliegende Knoten hat sonst niemand Verwalten) */
async function soleAdminOf(db: D1Database, accountId: string): Promise<string[]> {
  const own = await db.prepare("SELECT m.node_id, n.name FROM memberships m JOIN nodes n ON n.id = m.node_id WHERE m.account_id = ? AND m.role = 'admin'").bind(accountId).all<{ node_id: string; name: string }>();
  const out: string[] = [];
  for (const r of own.results) {
    let others = 0;
    for (let id: string | null = r.node_id; id && !others; ) {
      others = (await db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE node_id = ? AND role = 'admin' AND account_id != ?").bind(id, accountId).first<{ n: number }>())?.n ?? 0;
      id = (await db.prepare('SELECT parent_id FROM nodes WHERE id = ?').bind(id).first<{ parent_id: string | null }>())?.parent_id ?? null;
    }
    if (!others) out.push(r.name || 'Deutschland');
  }
  return out;
}

export async function handlePortal(req: Request, env: Env, path: string, url: URL, now: Date): Promise<Response> {
  const db = env.DB;
  const ts = now.toISOString();
  const write = req.method !== 'GET' && req.method !== 'HEAD';
  if (write) {
    const origin = req.headers.get('origin');
    // wrangler dev schreibt den Origin-Kopf um (ohne Port) – lokal (CLOUD_DEV) nicht prüfen
    if (origin && env.CLOUD_DEV !== '1' && origin !== url.origin && origin !== new URL(cloudUrl(env)).origin) return fail(403, 'Fremde Herkunft');
    const upload = path.startsWith('/v1/cloud/files/');
    if (req.method !== 'DELETE' && !upload && !(req.headers.get('content-type') ?? '').includes('application/json')) return fail(415, 'JSON erwartet');
  }

  // --- Konto: registrieren, bestätigen, anmelden, Passwort vergessen (ohne Sitzung) ---

  /** Mails je Adresse begrenzen (Bestätigung, Zurücksetzen); false = Kontingent erschöpft */
  const mailBudget = async (email: string) => {
    const sent = await db.prepare('SELECT COUNT(*) AS n FROM login_mails WHERE email = ? AND sent_at > ?').bind(email, ago(now, 3600_000)).first<{ n: number }>();
    if ((sent?.n ?? 0) >= ACCOUNT_MAILS_PER_HOUR) return false;
    await db.prepare('INSERT INTO login_mails (email, sent_at) VALUES (?, ?)').bind(email, ts).run();
    return true;
  };
  /** Einmal-Link anlegen (ersetzt offene Links desselben Zwecks) */
  const issueToken = async (accountId: string, purpose: 'verify' | 'reset' | 'email', ttlMs: number, newEmail: string | null = null) => {
    const token = newToken();
    await db.prepare('DELETE FROM account_tokens WHERE account_id = ? AND purpose = ?').bind(accountId, purpose).run();
    await db
      .prepare('INSERT INTO account_tokens (token_hash, account_id, purpose, new_email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(await hash(token), accountId, purpose, newEmail, ts, later(now, ttlMs))
      .run();
    return token;
  };
  /** Einmal-Link einlösen: gültig, Zweck passt; wird dabei verbraucht */
  const redeemToken = async (token: string, purpose: 'verify' | 'reset' | 'email') => {
    const h = await hash(token);
    const row = await db.prepare('SELECT * FROM account_tokens WHERE token_hash = ? AND purpose = ?').bind(h, purpose).first<{ account_id: string; new_email: string | null; expires_at: string }>();
    if (!row) return null;
    await db.prepare('DELETE FROM account_tokens WHERE token_hash = ?').bind(h).run();
    return row.expires_at > ts ? row : null;
  };
  const DISABLED = 'Dieses Konto ist gesperrt – bitte an den Betreiber von ELVIS Cloud wenden';
  const startSession = async (account: AccountRow, extra: Record<string, string> = {}) => {
    // Gesperrte Konten bekommen keine Sitzung (auch nicht über Bestätigungs- oder Passwort-Link)
    if (await db.prepare('SELECT 1 FROM accounts WHERE id = ? AND disabled_at IS NOT NULL').bind(account.id).first()) return fail(423, DISABLED);
    await db.prepare('UPDATE accounts SET last_login_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').bind(ts, account.id).run();
    const token = newToken();
    await db.prepare('INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await hash(token), account.id, ts, later(now, SESSION_TTL_MS)).run();
    return json(200, await me(db, toAccount(account)), { 'set-cookie': sessionCookie(token, SESSION_TTL_MS / 1000), ...extra });
  };
  const sendVerify = async (account: { id: string; email: string; name: string }) => {
    const token = await issueToken(account.id, 'verify', VERIFY_TTL_MS);
    return mail(
      env,
      account.email,
      'ELVIS Cloud: E-Mail-Adresse bestätigen',
      `Hallo${account.name ? ` ${account.name}` : ''},\n\nbitte bestätigen Sie Ihre E-Mail-Adresse für ELVIS Cloud (gültig 24 Stunden):\n\n  ${cloudUrl(env)}/bestaetigen/${token}\n\nWenn Sie kein Konto angelegt haben, ignorieren Sie diese Mail.\n\nELVIS Cloud`,
    );
  };
  const sendReset = async (account: { id: string; email: string; name: string }) => {
    const token = await issueToken(account.id, 'reset', RESET_TTL_MS);
    return mail(
      env,
      account.email,
      'ELVIS Cloud: Passwort zurücksetzen',
      `Hallo${account.name ? ` ${account.name}` : ''},\n\nüber diesen Link legen Sie ein neues Passwort für ELVIS Cloud fest (gültig 1 Stunde):\n\n  ${cloudUrl(env)}/passwort-zuruecksetzen/${token}\n\nDanach sind Sie überall abgemeldet. Wenn Sie das nicht angefordert haben, ignorieren Sie diese Mail – Ihr Passwort bleibt dann unverändert.\n\nELVIS Cloud`,
    );
  };
  const ACCOUNT_SELECT = 'SELECT id, email, name, operator, password_hash, email_verified_at, failed_logins, locked_until, disabled_at FROM accounts';
  type AuthRow = AccountRow & { password_hash: string | null; email_verified_at: string | null; failed_logins: number; locked_until: string | null; disabled_at: string | null };

  if (req.method === 'POST' && path === '/v1/cloud/register') {
    const parsed = registerSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Eingabe ungültig');
    const { email, name, password, invitation } = parsed.data;
    if (password.toLowerCase() === email) return fail(400, 'Passwort darf nicht die E-Mail-Adresse sein');
    // Mit Einladung an genau diese Adresse ist sie bestätigt (der Link kam per Mail an sie)
    const invited = invitation
      ? await db.prepare('SELECT email, expires_at, accepted_at FROM invitations WHERE token_hash = ?').bind(await hash(invitation)).first<{ email: string; expires_at: string; accepted_at: string | null }>()
      : null;
    const viaInvitation = !!invited && invited.email === email && !invited.accepted_at && invited.expires_at > ts;
    const existing = await db.prepare(`${ACCOUNT_SELECT} WHERE email = ?`).bind(email).first<AuthRow>();
    if (existing) {
      // Ob es die Adresse schon gibt, verrät die Antwort nicht – die Mail an die Adresse schon
      if (await mailBudget(email)) {
        await mail(
          env,
          email,
          'ELVIS Cloud: Konto besteht bereits',
          `Hallo,\n\nfür ${email} gibt es schon ein Konto bei ELVIS Cloud. Zum Anmelden: ${cloudUrl(env)}\nPasswort vergessen? Dort „Passwort vergessen“ wählen.\n\nWenn Sie das nicht waren, ignorieren Sie diese Mail.\n\nELVIS Cloud`,
        );
      }
      return json(202, { verify: true });
    }
    const id = crypto.randomUUID();
    await db
      .prepare('INSERT INTO accounts (id, email, name, created_at, password_hash, password_changed_at, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, email, name, ts, await hashPassword(password), ts, viaInvitation ? ts : null)
      .run();
    const account: AccountRow = { id, email, name, operator: 0 };
    if (viaInvitation) return startSession(account);
    if (!(await mailBudget(email)) || !(await sendVerify(account))) return fail(503, 'Bestätigungsmail konnte nicht gesendet werden, bitte später erneut versuchen');
    return json(202, { verify: true });
  }

  if (req.method === 'POST' && path === '/v1/cloud/verify') {
    const parsed = linkTokenSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, 'Link ungültig');
    const t = await redeemToken(parsed.data.token, 'verify');
    if (!t) return fail(410, 'Link abgelaufen oder schon benutzt – beim Anmelden lässt sich ein neuer anfordern');
    await db.prepare('UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').bind(ts, t.account_id).run();
    const account = await db.prepare(`${ACCOUNT_SELECT} WHERE id = ?`).bind(t.account_id).first<AuthRow>();
    return account ? startSession(account) : fail(404, 'Konto nicht gefunden');
  }

  if (req.method === 'POST' && path === '/v1/cloud/verify/resend') {
    const parsed = emailOnlySchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, 'E-Mail-Adresse ungültig');
    const account = await db.prepare(`${ACCOUNT_SELECT} WHERE email = ?`).bind(parsed.data.email).first<AuthRow>();
    if (account && !account.email_verified_at && (await mailBudget(account.email))) await sendVerify(account);
    return json(202, { ok: true });
  }

  if (req.method === 'POST' && path === '/v1/cloud/login') {
    const parsed = loginSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Eingabe ungültig');
    const { email, password } = parsed.data;
    const account = await db.prepare(`${ACCOUNT_SELECT} WHERE email = ?`).bind(email).first<AuthRow>();
    if (account?.locked_until && account.locked_until > ts) return fail(429, 'Zu viele Fehlversuche – bitte in 15 Minuten erneut versuchen oder das Passwort zurücksetzen');
    const ok = await verifyPassword(password, account?.password_hash ?? null);
    if (!account || !ok) {
      if (account) {
        const failures = account.failed_logins + 1;
        await db
          .prepare('UPDATE accounts SET failed_logins = ?, locked_until = ? WHERE id = ?')
          .bind(failures >= LOGIN_MAX_FAILURES ? 0 : failures, failures >= LOGIN_MAX_FAILURES ? later(now, LOGIN_LOCK_MS) : null, account.id)
          .run();
      }
      return fail(401, 'E-Mail-Adresse oder Passwort falsch');
    }
    if (account.disabled_at) return fail(423, DISABLED);
    if (!account.email_verified_at) return fail(403, 'Bitte zuerst die E-Mail-Adresse über den Link in der Bestätigungsmail bestätigen');
    return startSession(account);
  }

  if (req.method === 'POST' && path === '/v1/cloud/password/forgot') {
    const parsed = emailOnlySchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, 'E-Mail-Adresse ungültig');
    // Antwort immer gleich – ob es das Konto gibt, erfährt nur das Postfach
    const account = await db.prepare(`${ACCOUNT_SELECT} WHERE email = ?`).bind(parsed.data.email).first<AuthRow>();
    if (account && !account.disabled_at && (await mailBudget(account.email))) await sendReset(account);
    return json(202, { ok: true });
  }

  if (req.method === 'POST' && path === '/v1/cloud/password/reset') {
    const parsed = resetPasswordSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Eingabe ungültig');
    const t = await redeemToken(parsed.data.token, 'reset');
    if (!t) return fail(410, 'Link abgelaufen oder schon benutzt – bitte neu anfordern');
    const account = await db.prepare(`${ACCOUNT_SELECT} WHERE id = ?`).bind(t.account_id).first<AuthRow>();
    if (!account) return fail(404, 'Konto nicht gefunden');
    if (parsed.data.password.toLowerCase() === account.email) return fail(400, 'Passwort darf nicht die E-Mail-Adresse sein');
    // Neues Passwort: alle Sitzungen enden; der Link kam an die Adresse, sie gilt damit als bestätigt
    await db
      .prepare('UPDATE accounts SET password_hash = ?, password_changed_at = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?')
      .bind(await hashPassword(parsed.data.password), ts, ts, account.id)
      .run();
    await db.prepare('DELETE FROM account_sessions WHERE account_id = ?').bind(account.id).run();
    await db.prepare("DELETE FROM account_tokens WHERE account_id = ? AND purpose = 'reset'").bind(account.id).run();
    return startSession(account);
  }

  // Neue E-Mail-Adresse bestätigen (Link an die neue Adresse; geht auch ohne Sitzung)
  if (req.method === 'POST' && path === '/v1/cloud/email/confirm') {
    const parsed = linkTokenSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, 'Link ungültig');
    const t = await redeemToken(parsed.data.token, 'email');
    if (!t?.new_email) return fail(410, 'Link abgelaufen oder schon benutzt');
    if (await db.prepare('SELECT 1 FROM accounts WHERE email = ?').bind(t.new_email).first()) return fail(409, 'Diese Adresse gehört inzwischen zu einem anderen Konto');
    const before = await db.prepare(`${ACCOUNT_SELECT} WHERE id = ?`).bind(t.account_id).first<AuthRow>();
    if (!before) return fail(404, 'Konto nicht gefunden');
    await db.prepare('UPDATE accounts SET email = ?, email_verified_at = ? WHERE id = ?').bind(t.new_email, ts, before.id).run();
    await mail(env, before.email, 'ELVIS Cloud: E-Mail-Adresse geändert', `Hallo,\n\ndie Adresse Ihres Kontos bei ELVIS Cloud wurde von ${before.email} auf ${t.new_email} geändert.\nWaren Sie das nicht? Bitte wenden Sie sich an den Betreiber.\n\nELVIS Cloud`);
    return json(200, { email: t.new_email });
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
  // Überall abmelden außer hier (z. B. nach verlorenem Gerät)
  if (req.method === 'POST' && path === '/v1/cloud/logout/others') {
    const token = cookieToken(req);
    const r = await db.prepare('DELETE FROM account_sessions WHERE account_id = ? AND token_hash != ?').bind(account.id, await hash(token ?? '')).run();
    return json(200, { ended: r.meta.changes });
  }
  const checkPassword = async (password: string) => {
    const row = await db.prepare('SELECT password_hash FROM accounts WHERE id = ?').bind(account.id).first<{ password_hash: string | null }>();
    return verifyPassword(password, row?.password_hash ?? null);
  };
  if (req.method === 'POST' && path === '/v1/cloud/password') {
    const parsed = changePasswordSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Eingabe ungültig');
    if (!(await checkPassword(parsed.data.current))) return fail(403, 'Aktuelles Passwort falsch');
    if (parsed.data.password.toLowerCase() === account.email) return fail(400, 'Passwort darf nicht die E-Mail-Adresse sein');
    await db.prepare('UPDATE accounts SET password_hash = ?, password_changed_at = ? WHERE id = ?').bind(await hashPassword(parsed.data.password), ts, account.id).run();
    // Andere Sitzungen enden, diese bleibt
    await db.prepare('DELETE FROM account_sessions WHERE account_id = ? AND token_hash != ?').bind(account.id, await hash(cookieToken(req) ?? '')).run();
    await mail(env, account.email, 'ELVIS Cloud: Passwort geändert', `Hallo,

das Passwort Ihres Kontos bei ELVIS Cloud wurde geändert. Andere Anmeldungen wurden beendet.
Waren Sie das nicht? Setzen Sie es über „Passwort vergessen“ zurück: ${cloudUrl(env)}

ELVIS Cloud`);
    return json(200, { ok: true });
  }
  if (req.method === 'POST' && path === '/v1/cloud/email') {
    const parsed = changeEmailSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Eingabe ungültig');
    if (!(await checkPassword(parsed.data.password))) return fail(403, 'Passwort falsch');
    const next = parsed.data.email;
    if (next === account.email) return fail(400, 'Das ist schon Ihre Adresse');
    // Belegte Adressen verrät die Antwort nicht – der Bestätigungslink scheitert dann
    if (!(await mailBudget(next))) return fail(429, 'Zu viele Mails an diese Adresse, bitte später erneut versuchen');
    if (!(await db.prepare('SELECT 1 FROM accounts WHERE email = ?').bind(next).first())) {
      const token = await issueToken(account.id, 'email', VERIFY_TTL_MS, next);
      const sent = await mail(
        env,
        next,
        'ELVIS Cloud: neue E-Mail-Adresse bestätigen',
        `Hallo,

bitte bestätigen Sie ${next} als neue Adresse Ihres Kontos bei ELVIS Cloud (gültig 24 Stunden):

  ${cloudUrl(env)}/email-bestaetigen/${token}

Bis dahin gilt die bisherige Adresse. Wenn Sie das nicht angefordert haben, ignorieren Sie diese Mail.

ELVIS Cloud`,
      );
      if (!sent) return fail(503, 'Mail konnte nicht gesendet werden');
    }
    return json(202, { email: next });
  }
  if (path === '/v1/cloud/me') {
    if (req.method === 'GET') return json(200, await me(db, account));
    if (req.method === 'PATCH') {
      const parsed = renameNodeSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, 'Name ungültig');
      await db.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind(parsed.data.name, account.id).run();
      return json(200, await me(db, { ...account, name: parsed.data.name }));
    }
    if (req.method === 'DELETE') {
      const parsed = deleteAccountSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, 'Passwort fehlt');
      if (!(await checkPassword(parsed.data.password))) return fail(403, 'Passwort falsch');
      // Ein Bereich soll nicht ohne Verwaltung zurückbleiben
      const orphaned = await soleAdminOf(db, account.id);
      if (orphaned.length) return fail(409, `Sie verwalten ${orphaned.join(', ')} allein – bitte zuerst jemand anderen als Admin einsetzen`);
      await db.prepare('DELETE FROM accounts WHERE id = ?').bind(account.id).run();
      return json(204, null, { 'set-cookie': sessionCookie('', 0) });
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

  // --- Verwaltung: alle Konten der Plattform (nur Betreiber) ---

  if (path === '/v1/cloud/admin' || path.startsWith('/v1/cloud/admin/')) {
    if (!account.operator) return fail(403, 'Nur für Betreiber');
    const log = (target: string, action: AdminAction, detail = '') => logAdmin(db, ts, account.email, target, action, detail);
    if (req.method === 'GET' && path === '/v1/cloud/admin') {
      return json(200, { accounts: await adminAccounts(db, now, url.searchParams.get('q') ?? ''), nodes: await allNodes(db) } satisfies AdminOverview);
    }
    if (req.method === 'GET' && path === '/v1/cloud/admin/log') return json(200, await adminLog(db));

    const m = /^\/v1\/cloud\/admin\/accounts\/([0-9A-Za-z-]{1,40})(?:\/(reset-link|verify|unlock|logout|membership))?$/.exec(path);
    if (!m) return fail(404, 'Nicht gefunden');
    const target = await db.prepare('SELECT id, email, name, operator, disabled_at FROM accounts WHERE id = ?').bind(m[1]).first<AccountRow & { disabled_at: string | null }>();
    if (!target) return fail(404, 'Konto nicht gefunden');
    const self = target.id === account.id;
    const activeOperators = async () => (await db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE operator = 1 AND disabled_at IS NULL').first<{ n: number }>())?.n ?? 0;
    const result = async () => json(200, (await adminAccounts(db, now)).find((a) => a.id === target.id) ?? null);
    const action = m[2];

    if (!action && req.method === 'PATCH') {
      const parsed = adminAccountPatchSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Eingabe ungültig');
      const p = parsed.data;
      if (self && (p.operator === false || p.disabled === true)) return fail(409, 'Sich selbst sperren oder entmachten geht nicht');
      if (target.operator === 1 && (p.operator === false || p.disabled === true) && (await activeOperators()) <= 1) return fail(409, 'Es muss mindestens einen aktiven Betreiber geben');
      if (p.email && p.email !== target.email) {
        if (await db.prepare('SELECT 1 FROM accounts WHERE email = ?').bind(p.email).first()) return fail(409, 'Diese Adresse gehört schon zu einem anderen Konto');
        // Vom Betreiber gesetzt: gilt als bestätigt; die alte Adresse erfährt es
        await db.prepare('UPDATE accounts SET email = ?, email_verified_at = ? WHERE id = ?').bind(p.email, ts, target.id).run();
        await db.prepare("DELETE FROM account_tokens WHERE account_id = ? AND purpose = 'email'").bind(target.id).run();
        await mail(env, target.email, 'ELVIS Cloud: E-Mail-Adresse geändert', `Hallo,\n\nder Betreiber von ELVIS Cloud hat die Adresse Ihres Kontos von ${target.email} auf ${p.email} geändert.\n\nELVIS Cloud`);
        await log(target.email, 'edit', `E-Mail → ${p.email}`);
      }
      if (p.name !== undefined && p.name !== target.name) {
        await db.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind(p.name, target.id).run();
        await log(p.email ?? target.email, 'edit', `Name → ${p.name}`);
      }
      if (p.operator !== undefined && p.operator !== (target.operator === 1)) {
        await db.prepare('UPDATE accounts SET operator = ? WHERE id = ?').bind(p.operator ? 1 : 0, target.id).run();
        await log(p.email ?? target.email, 'operator', p.operator ? 'zum Betreiber ernannt' : 'Betreiber-Recht entzogen');
      }
      if (p.disabled !== undefined && p.disabled !== !!target.disabled_at) {
        if (p.disabled) {
          await db.prepare('UPDATE accounts SET disabled_at = ?, disabled_by = ? WHERE id = ?').bind(ts, account.email, target.id).run();
          await db.prepare('DELETE FROM account_sessions WHERE account_id = ?').bind(target.id).run();
          await log(p.email ?? target.email, 'disable', 'gesperrt, Anmeldungen beendet');
        } else {
          await db.prepare('UPDATE accounts SET disabled_at = NULL, disabled_by = NULL WHERE id = ?').bind(target.id).run();
          await log(p.email ?? target.email, 'enable', 'entsperrt');
        }
      }
      return result();
    }

    if (!action && req.method === 'DELETE') {
      if (self) return fail(409, 'Das eigene Konto unter „Mein Konto“ löschen');
      if (target.operator === 1 && (await activeOperators()) <= 1) return fail(409, 'Es muss mindestens einen aktiven Betreiber geben');
      const orphaned = await soleAdminOf(db, target.id);
      if (orphaned.length) return fail(409, `${target.email} verwaltet ${orphaned.join(', ')} allein – erst jemand anderen als Admin einsetzen`);
      await db.prepare('DELETE FROM accounts WHERE id = ?').bind(target.id).run();
      await log(target.email, 'delete', target.name);
      return json(204, null);
    }

    if (req.method === 'POST' && action === 'reset-link') {
      if (target.disabled_at) return fail(409, 'Konto ist gesperrt – erst entsperren');
      if (!(await sendReset(target))) return fail(503, 'Mail konnte nicht gesendet werden');
      await log(target.email, 'reset-link', 'Link zum Zurücksetzen gesendet');
      return result();
    }
    if (req.method === 'POST' && action === 'verify') {
      await db.prepare('UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').bind(ts, target.id).run();
      await db.prepare("DELETE FROM account_tokens WHERE account_id = ? AND purpose = 'verify'").bind(target.id).run();
      await log(target.email, 'verify', 'Adresse als bestätigt markiert');
      return result();
    }
    if (req.method === 'POST' && action === 'unlock') {
      await db.prepare('UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = ?').bind(target.id).run();
      await log(target.email, 'unlock', 'Sperre nach Fehlversuchen aufgehoben');
      return result();
    }
    if (req.method === 'POST' && action === 'logout') {
      const r = await db.prepare('DELETE FROM account_sessions WHERE account_id = ?').bind(target.id).run();
      await log(target.email, 'logout', `${r.meta.changes} Anmeldungen beendet`);
      return result();
    }
    if (req.method === 'PUT' && action === 'membership') {
      const parsed = adminMembershipSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, 'Eingabe ungültig');
      const { nodeId, role } = parsed.data;
      const node = await nodeRef(db, nodeId);
      if (!node) return fail(404, 'Knoten nicht gefunden');
      const where = node.path.join(' › ') || 'Deutschland';
      if (role === null) {
        // Der letzte Admin eines Bereichs bleibt (sonst verwaltet ihn nur noch der Betreiber)
        const res = await db.prepare('DELETE FROM memberships WHERE account_id = ? AND node_id = ?').bind(target.id, nodeId).run();
        if (!res.meta.changes) return fail(404, 'Keine Rolle an diesem Knoten');
        await log(target.email, 'role', `${where}: Rolle entzogen`);
      } else {
        await db
          .prepare('INSERT INTO memberships (account_id, node_id, role, created_at, created_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, node_id) DO UPDATE SET role = excluded.role')
          .bind(target.id, nodeId, role, ts, account.email)
          .run();
        await log(target.email, 'role', `${where}: ${CLOUD_ROLE_LABELS[role]}`);
      }
      return result();
    }
    return fail(405, 'Nicht erlaubt');
  }

  // --- Stammdaten ---

  const recordsAt = /^\/v1\/cloud\/nodes\/([^/]+)\/records$/.exec(path);
  if (recordsAt && req.method === 'GET') {
    const nodeId = decodeURIComponent(recordsAt[1]!);
    const kind = url.searchParams.get('kind') as RecordKind | null;
    if (!kind || !RECORD_KINDS.includes(kind)) return fail(400, 'Art fehlt');
    const r = await need(db, account, nodeId, 'viewer');
    if (r instanceof Response) return r;
    return json(200, await listForNode(db, nodeId, kind, (n) => roleAt(db, account, n)));
  }
  const mayEdit = async (nodeId: string) => atLeast(await roleAt(db, account, nodeId), 'editor');
  const by = account.name ? `${account.name} (${account.email})` : account.email;
  if (req.method === 'POST' && path === '/v1/cloud/records') {
    const parsed = recordCreateSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, 'Eingabe ungültig');
    if (!(await getNode(db, parsed.data.nodeId))) return fail(404, 'Knoten nicht gefunden');
    if (parsed.data.uid && (await getRecord(db, parsed.data.uid))) return fail(409, 'Datensatz gibt es schon');
    const res = await writeRecord(db, { uid: parsed.data.uid ?? crypto.randomUUID(), kind: parsed.data.kind, nodeId: parsed.data.nodeId, baseRev: 0, deleted: false, data: parsed.data.data, by, mayWrite: mayEdit, blobs: env.LIBRARY }, now);
    return res.status === 'ok' ? json(201, res.record) : fail(res.status === 'invalid' ? 400 : 403, res.reason);
  }
  if (req.method === 'POST' && path === '/v1/cloud/records/batch') {
    const parsed = recordBatchSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, 'Eingabe ungültig');
    const { kind, nodeId, items } = parsed.data;
    if (!(await getNode(db, nodeId))) return fail(404, 'Knoten nicht gefunden');
    if (!(await mayEdit(nodeId))) return fail(403, 'Kein Recht zum Pflegen an diesem Knoten');
    let created = 0;
    const errors: { index: number; reason: string }[] = [];
    for (const [index, data] of items.entries()) {
      const res = await writeRecord(db, { uid: crypto.randomUUID(), kind, nodeId, baseRev: 0, deleted: false, data, by, mayWrite: mayEdit, blobs: env.LIBRARY }, now);
      if (res.status === 'ok') created++;
      else errors.push({ index, reason: res.reason });
    }
    return json(200, { created, errors });
  }

  // --- Dateien der Objektbibliothek ---
  const filePath = /^\/v1\/cloud\/files\/([0-9a-f-]{36})$/.exec(path);
  if (filePath) {
    const uid = filePath[1]!;
    if (!env.LIBRARY) return fail(503, 'Dateien sind auf diesem Relay nicht eingerichtet');
    if (req.method === 'PUT') {
      const object = await getRecord(db, url.searchParams.get('object') ?? '');
      if (!object || object.kind !== 'object' || object.deleted) return fail(404, 'Objekt nicht gefunden');
      if (!(await mayEdit(object.nodeId))) return fail(403, 'Kein Recht zum Pflegen an diesem Knoten');
      return storeUpload(env, uid, object.nodeId, new Uint8Array(await req.arrayBuffer()), now);
    }
    if (req.method === 'GET') {
      const rec = await getRecord(db, uid);
      if (!rec || rec.kind !== 'objectFile' || rec.deleted) return fail(404, 'Datei nicht gefunden');
      // Lesen darf, wer an einem Knoten mit Sicht auf die Datei mindestens Lesen hat
      const own = atLeast(await roleAt(db, account, rec.nodeId), 'viewer');
      let ok = own;
      if (!ok) {
        const nodes = await db.prepare('SELECT node_id FROM memberships WHERE account_id = ?').bind(account.id).all<{ node_id: string }>();
        for (const n of nodes.results) if (!ok && (await visibleFile(db, n.node_id, uid))) ok = true;
      }
      if (!ok) return fail(403, 'Kein Zugriff');
      const obj = await env.LIBRARY.get(blobKey(uid));
      if (!obj) return fail(404, 'Datei nicht gefunden');
      const f = rec.data as { filename: string; mimeType: string };
      return new Response(obj.body, {
        headers: {
          'content-type': f.mimeType,
          'content-disposition': `${url.searchParams.get('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
        },
      });
    }
    return fail(405, 'Nicht erlaubt');
  }

  const recordPath = /^\/v1\/cloud\/records\/([0-9a-f-]{36})$/.exec(path);
  if (recordPath) {
    const current = await getRecord(db, recordPath[1]!);
    if (!current || current.deleted) return fail(404, 'Datensatz nicht gefunden');
    if (req.method === 'PUT' || req.method === 'DELETE') {
      let baseRev = Number(url.searchParams.get('rev'));
      let data: unknown = null;
      if (req.method === 'PUT') {
        const parsed = recordUpdateSchema.safeParse(await body(req));
        if (!parsed.success) return fail(400, 'Eingabe ungültig');
        baseRev = parsed.data.baseRev;
        data = parsed.data.data;
      }
      const res = await writeRecord(db, { uid: current.uid, kind: current.kind, nodeId: current.nodeId, baseRev, deleted: req.method === 'DELETE', data, by, mayWrite: mayEdit, blobs: env.LIBRARY }, now);
      if (res.status === 'ok') return req.method === 'DELETE' ? json(204, null) : json(200, res.record);
      return res.status === 'invalid' ? fail(400, res.reason) : json(409, { error: res.reason, record: res.record });
    }
    return fail(405, 'Nicht erlaubt');
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
  await env.DB.prepare('DELETE FROM account_tokens WHERE expires_at < ?').bind(ts).run();
  // Protokoll der Verwaltung: zwei Jahre
  await env.DB.prepare('DELETE FROM admin_log WHERE at < ?').bind(ago(now, 2 * 365 * 24 * 3600_000)).run();
  await env.DB.prepare('DELETE FROM login_mails WHERE sent_at < ?').bind(ago(now, 3600_000)).run();
  await env.DB.prepare('DELETE FROM account_sessions WHERE expires_at < ?').bind(ts).run();
  await env.DB.prepare('DELETE FROM invitations WHERE expires_at < ? AND accepted_at IS NULL').bind(ago(now, 30 * 24 * 3600_000)).run();
  await env.DB.prepare('DELETE FROM link_requests WHERE expires_at < ?').bind(ts).run();
  await env.DB.prepare('DELETE FROM link_attempts WHERE at < ?').bind(ago(now, 3600_000)).run();
  // Hochgeladene Dateien ohne Datensatz nach einem Tag weg
  const stale = await env.DB.prepare('SELECT uid FROM library_uploads WHERE created_at < ?').bind(ago(now, 24 * 3600_000)).all<{ uid: string }>();
  for (const u of stale.results) {
    if (!(await env.DB.prepare('SELECT 1 FROM md_records WHERE uid = ?').bind(u.uid).first())) await env.LIBRARY?.delete(blobKey(u.uid));
    await env.DB.prepare('DELETE FROM library_uploads WHERE uid = ?').bind(u.uid).run();
  }
}
