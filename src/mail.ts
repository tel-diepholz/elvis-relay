import * as openpgp from 'openpgp';
import type { z } from 'zod';
import { base64url, escapeHtml, fail, fromBase64url, hash, json, newToken, sha256Hex } from './http.js';
import {
  MAIL_LIMITS,
  MAIL_SIGNATURE_HEADER,
  MAIL_SIGNATURE_WINDOW_MS,
  mailboxRequestSchema,
  mailOutboxSchema,
  mailSignaturePayload,
  type MailboxStatus,
  type MailOutboxResult,
  type RelayMailBatch,
  type RelayMailItem,
} from './mailprotocol.js';
import { addressOf, buildMime, headerValue, type MimeMail } from './mime.js';
import type { Env } from './relay.js';
import { isQuotaError, PROBE_LOCALPART, recordEvent, recordProbe, setQuotaExhausted } from './status.js';

/**
 * Postfach je ELW. Eingehende Mails nimmt Cloudflare Email Routing an und gibt sie an `receiveMail`; das Relay
 * verschlüsselt jede Rohmail sofort mit dem öffentlichen Schlüssel des ELW und legt sie bis zur Abholung in R2.
 * ELVIS signiert jeden Mail-Abruf mit seinem Ed25519-Schlüssel – das Bearer-Token allein genügt nicht.
 */

/** Versand einer Rohmail an einen Empfänger (index.ts verdrahtet das send_email-Binding) */
export type Sender = (from: string, to: string, raw: string) => Promise<void>;

const CONFIRM_TTL_MS = 24 * 3600_000;
const PENDING_TTL_MS = 24 * 3600_000;
/** Gekündigte Adressen bleiben so lange gesperrt */
const CLOSED_TTL_MS = 90 * 24 * 3600_000;
const INBOX_TTL_MS = 30 * 24 * 3600_000;
const REBINDS_PER_DAY = 3;
const MAIL_BATCH = 100;
const BAD_SIG_MAIL_EVERY_MS = 24 * 3600_000;

export interface MailboxRow {
  localpart: string;
  elw_id: string | null;
  previous_elw_id: string | null;
  admin_email: string;
  public_key: string;
  fingerprint: string;
  wkd_hash: string;
  sig_public_key: string;
  revocation_cert: string | null;
  status: 'pending' | 'approval' | 'active' | 'closed';
  created_at: string;
  activated_at: string | null;
  closed_at: string | null;
  keys_mailed_at: string | null;
  last_fetch_at: string | null;
  last_fetch_country: string | null;
  bad_sig_mailed_at: string | null;
}

interface ConfirmationRow {
  token_hash: string;
  kind: 'activate' | 'rebind' | 'rebind-miss';
  localpart: string;
  elw_id: string;
  public_key: string;
  fingerprint: string;
  sig_public_key: string;
  revocation_cert: string | null;
  created_at: string;
  expires_at: string;
}

export const mailDomain = (env: Env) => env.MAIL_DOMAIN ?? 'einsatzleitwagen.app';
const relayUrl = (env: Env) => (env.RELAY_URL ?? 'https://relay.einsatzleitwagen.app').replace(/\/$/, '');
const addressFor = (env: Env, localpart: string) => `${localpart}@${mailDomain(env)}`;
const before = (now: Date, ms: number) => new Date(now.getTime() - ms).toISOString();
const after = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();

// --- WKD (Web Key Directory) ---

const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';
function zbase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ZBASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ZBASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** WKD-Hash des Adressteils: z-base-32(SHA-1(lowercase(localpart))) */
export async function wkdHash(localpart: string): Promise<string> {
  return zbase32(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(localpart.toLowerCase()))));
}

/** WKD advanced method: openpgpkey.<domain>/.well-known/openpgpkey/<domain>/hu/<hash>; direct method ebenso */
export async function handleWkd(path: string, env: Env): Promise<Response | null> {
  const domain = mailDomain(env).replace(/\./g, '\\.');
  const m = new RegExp(`^/\\.well-known/openpgpkey(?:/${domain})?/(hu/([a-z0-9]{32})|policy)$`).exec(path);
  if (!m) return null;
  const headers = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' };
  if (m[1] === 'policy') return new Response('', { headers: { ...headers, 'content-type': 'text/plain' } });
  const row = await env.DB.prepare("SELECT public_key FROM mailboxes WHERE wkd_hash = ? AND status = 'active'").bind(m[2]).first<{ public_key: string }>();
  if (!row) return new Response('Nicht gefunden\n', { status: 404, headers });
  const key = await openpgp.readKey({ armoredKey: row.public_key });
  return new Response(key.write() as BodyInit, { headers: { ...headers, 'content-type': 'application/octet-stream' } });
}

// --- Schlüssel prüfen ---

async function checkPublicKey(armored: string, address: string): Promise<{ fingerprint: string } | string> {
  let key: openpgp.Key;
  try {
    key = await openpgp.readKey({ armoredKey: armored });
  } catch {
    return 'Öffentlicher Schlüssel ungültig';
  }
  if (key.isPrivate()) return 'Nur den öffentlichen Schlüssel senden';
  if (!key.users.some((u) => u.userID?.email.toLowerCase() === address)) return `Schlüssel gehört nicht zu ${address}`;
  try {
    await key.getEncryptionKey();
  } catch {
    return 'Schlüssel kann nicht verschlüsseln';
  }
  return { fingerprint: key.getFingerprint().toUpperCase() };
}

async function checkRevocation(armored: string, publicKey: string): Promise<boolean> {
  try {
    const key = await openpgp.readKey({ armoredKey: publicKey });
    const revoked = await openpgp.revokeKey({ key, revocationCertificate: armored, format: 'object' });
    return await revoked.publicKey.isRevoked();
  } catch {
    return false;
  }
}

// --- Signierte Abrufe ---

async function verifySignature(req: Request, raw: Uint8Array, mailbox: MailboxRow, db: D1Database, now: Date): Promise<boolean> {
  const header = req.headers.get(MAIL_SIGNATURE_HEADER) ?? '';
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const t = Number(parts.t);
  const nonce = parts.n ?? '';
  const sig = parts.s ?? '';
  if (!Number.isFinite(t) || Math.abs(now.getTime() - t) > MAIL_SIGNATURE_WINDOW_MS) return false;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return false;
  const url = new URL(req.url);
  const payload = mailSignaturePayload(req.method, url.pathname + url.search, await sha256Hex(raw), t, nonce);
  let ok = false;
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64url(mailbox.sig_public_key), { name: 'Ed25519' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64url(sig), new TextEncoder().encode(payload));
  } catch {
    return false;
  }
  if (!ok) return false;
  // Jede Nonce nur einmal (das Zeitfenster begrenzt, wie lange sie aufgehoben wird)
  const r = await db.prepare('INSERT OR IGNORE INTO mail_nonces (nonce, expires_at) VALUES (?, ?)').bind(nonce, after(now, 2 * MAIL_SIGNATURE_WINDOW_MS)).run();
  return r.meta.changes === 1;
}

// --- Mails des Relays ---

async function sendSystemMail(env: Env, mail: Omit<MimeMail, 'from'>): Promise<void> {
  if (!env.SEND) throw new Error('Kein Mailversand konfiguriert');
  const from = `ELVIS Relay <noreply@${mailDomain(env)}>`;
  await env.SEND(addressOf(from), mail.to, buildMime({ ...mail, from }));
}

const confirmText = (env: Env, kind: 'activate' | 'rebind', localpart: string, link: string) =>
  kind === 'activate'
    ? `Hallo,

für einen Einsatzleitwagen wurde in ELVIS das Postfach

  ${addressFor(env, localpart)}

beantragt und diese Adresse als Kontakt des Administrators angegeben. Zum Bestätigen bitte den Link öffnen
(gültig 24 Stunden):

  ${link}

Danach bekommen Sie einmalig den öffentlichen Schlüssel und das Widerrufszertifikat des Postfachs.
Wenn Sie nichts beantragt haben, ignorieren Sie diese Mail – das Postfach wird dann nicht eingerichtet.

ELVIS Relay`
    : `Hallo,

das ELW-Postfach

  ${addressFor(env, localpart)}

soll auf eine neue ELVIS-Installation übertragen werden. Die bisherige Installation kann danach keine Mails
mehr abrufen. Noch nicht abgeholte Mails gehen verloren, weil sie mit dem alten Schlüssel verschlüsselt sind.

Zum Bestätigen bitte den Link öffnen (gültig 24 Stunden):

  ${link}

Wenn Sie das nicht veranlasst haben, ignorieren Sie diese Mail – das Postfach bleibt dann unverändert.

ELVIS Relay`;

/** Schlüssel-Mail an den Admin: genau einmal je Schlüssel, danach ist das Widerrufszertifikat im Relay gelöscht */
export async function deliverKeyMails(env: Env, now: Date): Promise<void> {
  const rows = await env.DB.prepare("SELECT * FROM mailboxes WHERE status = 'active' AND keys_mailed_at IS NULL").all<MailboxRow>();
  for (const m of rows.results) {
    const address = addressFor(env, m.localpart);
    const fp = m.fingerprint.replace(/(.{4})/g, '$1 ').trim();
    try {
      await sendSystemMail(env, {
        to: m.admin_email,
        subject: `Schlüssel für ${address}`,
        text: `Hallo,

das ELW-Postfach ${address} ist eingerichtet.

Fingerprint des OpenPGP-Schlüssels:

  ${fp}

Im Anhang:
- publickey.asc: der öffentliche Schlüssel. Er wird auch automatisch per WKD veröffentlicht, damit Gegenstellen
  verschlüsselt an den ELW schreiben können.
- revocation.asc: das Widerrufszertifikat. Bitte sicher aufbewahren (z. B. ausgedruckt beim Fahrzeugordner).
  Damit lässt sich der Schlüssel für ungültig erklären, falls der ELW verloren geht oder neu installiert wird.
  Das Relay hat danach keine Kopie mehr.

Der private Schlüssel verlässt den ELW nie. Nach einer Neuinstallation von ELVIS lässt sich die Adresse unter
Einstellungen → Dienste → Mail übernehmen; ältere Mails sind dann nicht mehr lesbar.

Diese Mail wird nur einmal verschickt.

ELVIS Relay`,
        attachments: [
          { filename: 'publickey.asc', contentType: 'application/pgp-keys', content: m.public_key },
          ...(m.revocation_cert ? [{ filename: 'revocation.asc', contentType: 'application/pgp-keys', content: m.revocation_cert }] : []),
        ],
      });
    } catch (e) {
      console.error('Schlüssel-Mail', m.localpart, e);
      continue;
    }
    await env.DB.prepare('UPDATE mailboxes SET keys_mailed_at = ?, revocation_cert = NULL WHERE localpart = ? AND fingerprint = ?')
      .bind(now.toISOString(), m.localpart, m.fingerprint)
      .run();
  }
}

// --- Bestätigungslink (öffentlich, der Link ist der Zugang) ---

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
};
const page = (title: string, html: string, status = 200) =>
  new Response(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;color:#222}h1{font-size:1.4rem}button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:0;background:#c00;color:#fff;cursor:pointer}code{background:#f3f3f3;padding:0 .2rem}</style>
</head><body><h1>${escapeHtml(title)}</h1>${html}</body></html>`,
    { status, headers: PAGE_HEADERS },
  );

export async function handleConfirm(req: Request, env: Env, token: string, now: Date): Promise<Response> {
  const db = env.DB;
  const conf = await db
    .prepare("SELECT * FROM mail_confirmations WHERE token_hash = ? AND expires_at > ? AND kind IN ('activate', 'rebind')")
    .bind(await hash(token), now.toISOString())
    .first<ConfirmationRow>();
  if (!conf) return page('Link ungültig', '<p>Dieser Link ist abgelaufen oder wurde schon verwendet.</p>', 410);
  const address = escapeHtml(addressFor(env, conf.localpart));

  // Erst POST ändert etwas: Linkvorschauen und Virenscanner öffnen Links in Mails oft von selbst
  if (req.method === 'GET') {
    const what = conf.kind === 'activate' ? `das Postfach <code>${address}</code> einrichten` : `das Postfach <code>${address}</code> auf die neue ELVIS-Installation übertragen. Nicht abgeholte Mails gehen dabei verloren`;
    return page('Bestätigen', `<p>Hiermit ${what}.</p><form method="post"><button type="submit">Bestätigen</button></form>`);
  }
  if (req.method !== 'POST') return fail(405, 'Nicht erlaubt');

  const mailbox = await db.prepare('SELECT * FROM mailboxes WHERE localpart = ?').bind(conf.localpart).first<MailboxRow>();
  await db.prepare('DELETE FROM mail_confirmations WHERE token_hash = ?').bind(conf.token_hash).run();
  const ts = now.toISOString();

  if (conf.kind === 'activate') {
    if (!mailbox || mailbox.status !== 'pending' || mailbox.elw_id !== conf.elw_id) return page('Link ungültig', '<p>Der Antrag wurde inzwischen zurückgezogen.</p>', 410);
    const next = env.MAIL_APPROVAL === 'manual' ? 'approval' : 'active';
    await db.prepare('UPDATE mailboxes SET status = ?, activated_at = ? WHERE localpart = ?').bind(next, ts, conf.localpart).run();
    if (next === 'approval') return page('Bestätigt', `<p>Danke. <code>${address}</code> wird eingerichtet, sobald der Betreiber des Relays den Antrag freigegeben hat. Die Schlüssel kommen dann per Mail.</p>`);
    await deliverKeyMails(env, now);
    return page('Postfach eingerichtet', `<p><code>${address}</code> ist aktiv. Der öffentliche Schlüssel und das Widerrufszertifikat kommen gleich per Mail.</p>`);
  }

  // Übernahme durch eine neue Installation
  if (!mailbox || mailbox.status !== 'active') return page('Link ungültig', '<p>Das Postfach gibt es nicht mehr.</p>', 410);
  const busy = await db.prepare("SELECT localpart FROM mailboxes WHERE elw_id = ? AND status != 'closed'").bind(conf.elw_id).first();
  if (busy) return page('Nicht möglich', '<p>Die neue Installation hat inzwischen ein anderes Postfach.</p>', 409);
  await dropInbox(env, conf.localpart);
  await db
    .prepare(
      'UPDATE mailboxes SET previous_elw_id = elw_id, elw_id = ?, public_key = ?, fingerprint = ?, sig_public_key = ?, revocation_cert = ?, keys_mailed_at = NULL, last_fetch_at = NULL, last_fetch_country = NULL, activated_at = ? WHERE localpart = ?',
    )
    .bind(conf.elw_id, conf.public_key, conf.fingerprint, conf.sig_public_key, conf.revocation_cert, ts, conf.localpart)
    .run();
  await db.prepare('DELETE FROM mail_confirmations WHERE localpart = ?').bind(conf.localpart).run();
  await deliverKeyMails(env, now);
  return page('Postfach übertragen', `<p><code>${address}</code> gehört jetzt zur neuen ELVIS-Installation. Die neuen Schlüssel kommen gleich per Mail.</p>`);
}

async function dropInbox(env: Env, localpart: string, upTo?: number): Promise<void> {
  const rows = await env.DB.prepare(`SELECT seq, r2_key FROM mail_inbox WHERE localpart = ?${upTo === undefined ? '' : ' AND seq <= ?'}`)
    .bind(...(upTo === undefined ? [localpart] : [localpart, upTo]))
    .all<{ seq: number; r2_key: string }>();
  if (!rows.results.length) return;
  await env.MAIL?.delete(rows.results.map((r) => r.r2_key));
  await env.DB.prepare(`DELETE FROM mail_inbox WHERE localpart = ?${upTo === undefined ? '' : ' AND seq <= ?'}`)
    .bind(...(upTo === undefined ? [localpart] : [localpart, upTo]))
    .run();
}

// --- ELW: /v1/elws/me/mailbox, /v1/elws/me/mail* ---

function statusOf(env: Env, m: MailboxRow | null, state?: MailboxStatus['status']): MailboxStatus {
  return {
    status: state ?? (m ? (m.status === 'closed' ? 'none' : m.status) : 'none'),
    address: m ? addressFor(env, m.localpart) : null,
    fingerprint: m?.fingerprint ?? null,
    adminEmail: m?.admin_email ?? null,
    activatedAt: m?.activated_at ?? null,
    keysMailedAt: m?.keys_mailed_at ?? null,
    lastFetchAt: m?.last_fetch_at ?? null,
    lastFetchCountry: m?.last_fetch_country ?? null,
  };
}

async function newConfirmation(env: Env, kind: ConfirmationRow['kind'], elwId: string, req: z.output<typeof mailboxRequestSchema>, fingerprint: string, now: Date): Promise<string> {
  const token = newToken();
  await env.DB.prepare(
    'INSERT INTO mail_confirmations (token_hash, kind, localpart, elw_id, public_key, fingerprint, sig_public_key, revocation_cert, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(await hash(token), kind, req.localpart, elwId, req.publicKey, fingerprint, req.sigPublicKey, req.revocationCert, now.toISOString(), after(now, CONFIRM_TTL_MS))
    .run();
  return token;
}

export async function handleMail(req: Request, env: Env, elwId: string, path: string, now: Date): Promise<Response> {
  const db = env.DB;
  const ts = now.toISOString();
  if (!env.MAIL || !env.SEND) return fail(503, 'Mail ist auf diesem Relay nicht eingerichtet');
  const raw = new Uint8Array(await req.arrayBuffer());
  const parseBody = () => {
    try {
      return JSON.parse(new TextDecoder().decode(raw)) as unknown;
    } catch {
      return null;
    }
  };

  const mailbox = await db.prepare("SELECT * FROM mailboxes WHERE elw_id = ? AND status != 'closed'").bind(elwId).first<MailboxRow>();

  if (!mailbox) {
    const moved = await db.prepare("SELECT * FROM mailboxes WHERE previous_elw_id = ? AND status = 'active'").bind(elwId).first<MailboxRow>();
    if (req.method === 'GET' && path === '/v1/elws/me/mailbox') {
      if (moved) return json(200, statusOf(env, moved, 'moved'));
      const rebind = await db.prepare("SELECT localpart FROM mail_confirmations WHERE elw_id = ? AND kind LIKE 'rebind%' AND expires_at > ?").bind(elwId, ts).first<{ localpart: string }>();
      if (rebind) return json(200, { ...statusOf(env, null, 'rebind-pending'), address: addressFor(env, rebind.localpart) } satisfies MailboxStatus);
      return json(200, statusOf(env, null));
    }

    if (req.method === 'POST' && (path === '/v1/elws/me/mailbox' || path === '/v1/elws/me/mailbox/rebind')) {
      const parsed = mailboxRequestSchema.safeParse(parseBody());
      if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Antrag ungültig');
      const r = parsed.data;
      if (r.adminEmail.endsWith(`@${mailDomain(env)}`)) return fail(400, 'Die Admin-Adresse muss außerhalb von ELVIS-Mail liegen');
      const address = addressFor(env, r.localpart);
      const key = await checkPublicKey(r.publicKey, address);
      if (typeof key === 'string') return fail(400, key);
      if (!(await checkRevocation(r.revocationCert, r.publicKey))) return fail(400, 'Widerrufszertifikat passt nicht zum Schlüssel');
      const existing = await db.prepare('SELECT * FROM mailboxes WHERE localpart = ?').bind(r.localpart).first<MailboxRow>();
      // Eigene offene Übernahmen ersetzt ein neuer Antrag
      await db.prepare("DELETE FROM mail_confirmations WHERE elw_id = ? AND kind != 'rebind-miss'").bind(elwId).run();

      if (path === '/v1/elws/me/mailbox') {
        if (existing && (existing.status !== 'closed' || (existing.closed_at ?? '') > before(now, CLOSED_TTL_MS))) return fail(409, 'Diese Adresse ist vergeben');
        if (existing) await db.prepare('DELETE FROM mailboxes WHERE localpart = ?').bind(r.localpart).run();
        await db
          .prepare(
            "INSERT INTO mailboxes (localpart, elw_id, admin_email, public_key, fingerprint, wkd_hash, sig_public_key, revocation_cert, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
          )
          .bind(r.localpart, elwId, r.adminEmail, r.publicKey, key.fingerprint, await wkdHash(r.localpart), r.sigPublicKey, r.revocationCert, ts)
          .run();
        const token = await newConfirmation(env, 'activate', elwId, r, key.fingerprint, now);
        try {
          await sendSystemMail(env, { to: r.adminEmail, subject: `Postfach ${address} bestätigen`, text: confirmText(env, 'activate', r.localpart, `${relayUrl(env)}/m/confirm/${token}`) });
        } catch (e) {
          console.error('Bestätigungsmail', e);
          await db.prepare('DELETE FROM mailboxes WHERE localpart = ?').bind(r.localpart).run();
          await db.prepare('DELETE FROM mail_confirmations WHERE elw_id = ?').bind(elwId).run();
          return fail(502, 'Bestätigungsmail konnte nicht verschickt werden');
        }
        const created = await db.prepare('SELECT * FROM mailboxes WHERE localpart = ?').bind(r.localpart).first<MailboxRow>();
        return json(201, statusOf(env, created));
      }

      // Übernahme: Antwort hängt nicht davon ab, ob die Admin-Adresse stimmt
      if (!existing || existing.status !== 'active') return fail(404, 'Kein aktives Postfach mit dieser Adresse');
      const attempts = await db
        .prepare("SELECT COUNT(*) AS n FROM mail_confirmations WHERE localpart = ? AND kind LIKE 'rebind%' AND created_at > ?")
        .bind(r.localpart, before(now, 24 * 3600_000))
        .first<{ n: number }>();
      if ((attempts?.n ?? 0) >= REBINDS_PER_DAY) return fail(429, 'Zu viele Versuche, bitte morgen erneut');
      const matches = existing.admin_email.toLowerCase() === r.adminEmail;
      const token = await newConfirmation(env, matches ? 'rebind' : 'rebind-miss', elwId, r, key.fingerprint, now);
      if (matches) {
        try {
          await sendSystemMail(env, { to: existing.admin_email, subject: `Postfach ${address} übertragen?`, text: confirmText(env, 'rebind', r.localpart, `${relayUrl(env)}/m/confirm/${token}`) });
        } catch (e) {
          console.error('Übernahme-Mail', e);
        }
      }
      return json(202, { ...statusOf(env, null, 'rebind-pending'), address } satisfies MailboxStatus);
    }

    if (moved) return fail(403, 'Postfach wurde an eine andere Installation übertragen');
    return fail(404, 'Kein Postfach');
  }

  // Ab hier gehört das Postfach diesem ELW: jeder Aufruf muss signiert sein
  if (!(await verifySignature(req, raw, mailbox, db, now))) {
    if (mailbox.status === 'active' && (mailbox.bad_sig_mailed_at ?? '') < before(now, BAD_SIG_MAIL_EVERY_MS)) {
      await db.prepare('UPDATE mailboxes SET bad_sig_mailed_at = ? WHERE localpart = ?').bind(ts, mailbox.localpart).run();
      await sendSystemMail(env, {
        to: mailbox.admin_email,
        subject: `Abgelehnter Zugriff auf ${addressFor(env, mailbox.localpart)}`,
        text: `Hallo,\n\nauf das ELW-Postfach ${addressFor(env, mailbox.localpart)} wurde mit gültigem Zugangsschlüssel, aber ohne gültige Signatur zugegriffen (${ts}, Land: ${countryOf(req) ?? 'unbekannt'}). Der Zugriff wurde abgelehnt.\n\nStammt das nicht von einer Uhrabweichung des ELW, ist der Zugangsschlüssel des ELW womöglich in fremden Händen. Mails bleiben trotzdem geschützt: sie sind nur mit dem privaten Schlüssel im ELW lesbar.\n\nELVIS Relay`,
      }).catch((e) => console.error('Warnmail', e));
    }
    return fail(401, 'Signatur ungültig');
  }

  if (req.method === 'GET' && path === '/v1/elws/me/mailbox') return json(200, statusOf(env, mailbox));

  if (req.method === 'DELETE' && path === '/v1/elws/me/mailbox') {
    await dropInbox(env, mailbox.localpart);
    await db.prepare('DELETE FROM mail_confirmations WHERE localpart = ?').bind(mailbox.localpart).run();
    if (mailbox.status === 'active') {
      await db.prepare("UPDATE mailboxes SET status = 'closed', closed_at = ?, elw_id = NULL, previous_elw_id = NULL, revocation_cert = NULL WHERE localpart = ?").bind(ts, mailbox.localpart).run();
    } else {
      await db.prepare('DELETE FROM mailboxes WHERE localpart = ?').bind(mailbox.localpart).run();
    }
    return json(204, null);
  }

  if (mailbox.status !== 'active') return fail(409, 'Postfach ist noch nicht aktiv');

  if (req.method === 'GET' && path === '/v1/elws/me/mail') {
    const url = new URL(req.url);
    const cursor = Math.max(0, Math.floor(Number(url.searchParams.get('after') ?? 0)) || 0);
    // Was der ELW mit diesem Cursor bestätigt, ist abgeholt und wird gelöscht
    await dropInbox(env, mailbox.localpart, cursor);
    await db.prepare('UPDATE mailboxes SET last_fetch_at = ?, last_fetch_country = ? WHERE localpart = ?').bind(ts, countryOf(req), mailbox.localpart).run();
    const rows = await db
      .prepare('SELECT seq, size, received_at FROM mail_inbox WHERE localpart = ? AND seq > ? ORDER BY seq LIMIT ?')
      .bind(mailbox.localpart, cursor, MAIL_BATCH)
      .all<{ seq: number; size: number; received_at: string }>();
    const items: RelayMailItem[] = rows.results.map((r) => ({ seq: r.seq, size: r.size, receivedAt: r.received_at }));
    return json(200, { items, next: items.at(-1)?.seq ?? cursor } satisfies RelayMailBatch);
  }

  const one = /^\/v1\/elws\/me\/mail\/(\d+)$/.exec(path);
  if (req.method === 'GET' && one) {
    const row = await db.prepare('SELECT r2_key FROM mail_inbox WHERE localpart = ? AND seq = ?').bind(mailbox.localpart, Number(one[1])).first<{ r2_key: string }>();
    const obj = row ? await env.MAIL.get(row.r2_key) : null;
    if (!obj) return fail(404, 'Mail nicht gefunden');
    return new Response(obj.body, { headers: { 'content-type': 'application/pgp-encrypted' } });
  }

  if (req.method === 'POST' && path === '/v1/elws/me/mail/outbox') {
    const parsed = mailOutboxSchema.safeParse(parseBody());
    if (!parsed.success) return fail(400, 'Mail ungültig');
    let message: string;
    try {
      message = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(atob(parsed.data.raw), (c) => c.charCodeAt(0)));
    } catch {
      return fail(400, 'Mail ungültig');
    }
    if (message.length > MAIL_LIMITS.maxBytes) return fail(413, 'Mail zu groß');
    const from = headerValue(message, 'From');
    const address = addressFor(env, mailbox.localpart);
    if (!from || addressOf(from) !== address) return fail(400, `Absender muss ${address} sein`);
    if (headerValue(message, 'Bcc') !== null) return fail(400, 'Bcc gehört nicht in die Rohmail');
    const recipients = [...new Set(parsed.data.to)];
    const sent = async (ms: number) =>
      (await db.prepare('SELECT COALESCE(SUM(recipients), 0) AS n FROM mail_sent WHERE localpart = ? AND sent_at > ?').bind(mailbox.localpart, before(now, ms)).first<{ n: number }>())?.n ?? 0;
    if ((await sent(3600_000)) + recipients.length > MAIL_LIMITS.perHour || (await sent(24 * 3600_000)) + recipients.length > MAIL_LIMITS.perDay) {
      return fail(429, 'Versandlimit erreicht, bitte später erneut');
    }
    let count = 0;
    let lastError = '';
    let quota = false;
    for (const to of recipients) {
      try {
        await env.SEND(address, to, message);
        count++;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        console.error('Versand', to, e);
        if (isQuotaError(e)) {
          quota = true;
          break;
        }
      }
    }
    await recordEvent(env, 'outbound', count === recipients.length, now);
    if (quota || count) await setQuotaExhausted(env, quota, now);
    if (quota && !count) return fail(429, 'Das Tageskontingent für den Mailversand des Relays ist erschöpft, Versand erst morgen wieder möglich');
    if (count) await db.prepare('INSERT INTO mail_sent (localpart, recipients, sent_at) VALUES (?, ?, ?)').bind(mailbox.localpart, count, ts).run();
    if (!count) return fail(502, `Versand fehlgeschlagen${lastError ? `: ${lastError}` : ''}`);
    return json(count === recipients.length ? 200 : 207, { sent: count } satisfies MailOutboxResult);
  }

  return fail(404, 'Nicht gefunden');
}

const countryOf = (req: Request) => ((req as Request & { cf?: { country?: string } }).cf?.country ?? null);

// --- Eingehende Mails (Email Routing) ---

/** Was der Worker von einer eingehenden Mail braucht (ForwardableEmailMessage) */
export interface IncomingMail {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  headers: Headers;
  setReject(reason: string): void;
}

export async function receiveMail(message: IncomingMail, env: Env, now = new Date()): Promise<void> {
  const [local = '', domain = ''] = message.to.toLowerCase().split('@');
  const localpart = local.split('+')[0] ?? '';
  if (domain !== mailDomain(env)) return message.setReject('Unbekannte Domain');
  if (localpart === PROBE_LOCALPART) return recordProbe(env, message.headers.get('x-elvis-probe'), now);
  if (message.rawSize > MAIL_LIMITS.maxBytes) return message.setReject('Mail zu groß');
  const mailbox = await env.DB.prepare("SELECT localpart, public_key FROM mailboxes WHERE localpart = ? AND status = 'active'").bind(localpart).first<{ localpart: string; public_key: string }>();
  if (!mailbox) return message.setReject('Unbekannter Empfänger');
  if (!env.MAIL) throw new Error('Kein R2-Speicher für Mail');
  try {
    const original = new Uint8Array(await new Response(message.raw).arrayBuffer());
    // Umschlag-Daten voranstellen, dann die ganze Mail inklusive Kopf verschlüsseln
    const envelope = new TextEncoder().encode(`Return-Path: <${message.from}>\r\nDelivered-To: ${message.to}\r\nX-Elvis-Received: ${now.toISOString()}\r\n`);
    const plain = new Uint8Array(envelope.length + original.length);
    plain.set(envelope);
    plain.set(original, envelope.length);
    const encryptionKeys = await openpgp.readKey({ armoredKey: mailbox.public_key });
    const encrypted = (await openpgp.encrypt({ message: await openpgp.createMessage({ binary: plain }), encryptionKeys, format: 'binary' })) as Uint8Array;
    const r2Key = `inbox/${mailbox.localpart}/${now.getTime()}-${base64url(crypto.getRandomValues(new Uint8Array(9)))}`;
    await env.MAIL.put(r2Key, encrypted);
    await env.DB.prepare('INSERT INTO mail_inbox (localpart, r2_key, size, received_at) VALUES (?, ?, ?, ?)').bind(mailbox.localpart, r2Key, encrypted.length, now.toISOString()).run();
    await recordEvent(env, 'inbound', true, now);
  } catch (e) {
    await recordEvent(env, 'inbound', false, now);
    throw e;
  }
}

/** Stündlich: Schlüssel-Mails nachholen (z. B. nach Freigabe), Abgelaufenes löschen */
export async function mailCleanup(env: Env, now = new Date()): Promise<void> {
  const db = env.DB;
  const ts = now.toISOString();
  if (env.SEND) await deliverKeyMails(env, now);
  await db.prepare('DELETE FROM mail_confirmations WHERE expires_at < ?').bind(before(now, 24 * 3600_000)).run();
  await db.prepare('DELETE FROM mail_nonces WHERE expires_at < ?').bind(ts).run();
  await db.prepare('DELETE FROM mail_sent WHERE sent_at < ?').bind(before(now, 2 * 24 * 3600_000)).run();
  await db.prepare("DELETE FROM mailboxes WHERE status = 'pending' AND created_at < ?").bind(before(now, PENDING_TTL_MS)).run();
  await db.prepare("DELETE FROM mailboxes WHERE status = 'closed' AND closed_at < ?").bind(before(now, CLOSED_TTL_MS)).run();
  const old = await db.prepare('SELECT r2_key FROM mail_inbox WHERE received_at < ?').bind(before(now, INBOX_TTL_MS)).all<{ r2_key: string }>();
  if (old.results.length) {
    await env.MAIL?.delete(old.results.map((r) => r.r2_key));
    await db.prepare('DELETE FROM mail_inbox WHERE received_at < ?').bind(before(now, INBOX_TTL_MS)).run();
  }
}
