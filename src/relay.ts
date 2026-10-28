import {
  encryptedSheetSchema,
  relayFormRequestSchema,
  type RelayForm,
  type RelaySubmission,
  type RelaySubmissionBatch,
  DEVICE_ID_ALPHABET,
  DEVICE_ID_LENGTH,
  PAIR_CODE_LENGTH,
  relayLabelSchema,
  relayPairSchema,
  relayPositionSchema,
  type DeviceRegistration,
  type DeviceStatus,
  type ElwPositionBatch,
  type ElwRegistration,
  type RelayPositionItem,
} from './protocol.js';
import { closedPage, formHeaders, formPage } from './form.js';
import { base64url, bearer, body, fail, hash, json, newToken, random, sameCode } from './http.js';
import { handleConfirm, handleMail, handleWkd, mailCleanup, type Sender } from './mail.js';
import { PRIVACY_HTML } from './privacy.js';
import { handleStatus } from './status.js';

/**
 * Cloud-Relay der ELVIS-App. Apps melden sich an und senden ihre Position; ein ELW (ELVIS-Server) koppelt
 * eine App mit ID und Code und holt die Positionen ab. Außerdem stellt es Online-Formulare für Personalbögen
 * bereit, die der Browser für den ELW verschlüsselt. Es wird nur gespeichert, was dafür nötig ist:
 * Positionen werden mit der Abholung gelöscht, spätestens nach 24 Stunden; Personalbögen spätestens nach 7 Tagen.
 * Dazu kommt ein Postfach je ELW (mail.ts) und die Statusseite (status.ts).
 */
export interface Env {
  DB: D1Database;
  /** Verschlüsselte Mails bis zur Abholung */
  MAIL?: R2Bucket;
  /** Domain der Postfächer, Vorgabe einsatzleitwagen.app */
  MAIL_DOMAIN?: string;
  /** "manual": Postfächer brauchen nach der Bestätigung die Freigabe des Betreibers */
  MAIL_APPROVAL?: string;
  /** Öffentliche Adresse des Relays für Links in Mails */
  RELAY_URL?: string;
  /** Secret für Störungsmeldungen auf der Statusseite */
  STATUS_ADMIN_TOKEN?: string;
  /** Betreiber-Adresse für Statusalarme */
  STATUS_ALERT_EMAIL?: string;
  /** Mailversand, von index.ts aus dem send_email-Binding gebaut */
  SEND?: Sender;
}

/** Fehlversuche beim Code, danach bekommt die App einen neuen */
export const MAX_CODE_ATTEMPTS = 5;
const BATCH = 500;
const POSITION_TTL_MS = 24 * 3600_000;
const DEVICE_TTL_MS = 90 * 24 * 3600_000;
const ELW_TTL_MS = 365 * 24 * 3600_000;
const SUBMISSION_TTL_MS = 7 * 24 * 3600_000;
/** Ein Formular-Link gilt höchstens so lange */
const FORM_MAX_MS = 7 * 24 * 3600_000;
/** Bögen je Formular – genug für einen Verband, bremst Missbrauch */
export const MAX_FORM_SUBMISSIONS = 200;
const MAX_SUBMISSION_BYTES = 300 * 1024;
const SUBMISSION_BATCH = 100;

interface FormRow {
  id: string;
  elw_id: string;
  title: string;
  public_key: string;
  expires_at: string;
  submissions: number;
}

interface DeviceRow {
  id: string;
  code: string;
  code_attempts: number;
  elw_id: string | null;
  label: string;
}

/** Formular-ID: steht in der Adresse und ist zugleich der Zugang (128 Bit) */
const newFormId = () => base64url(random(16));
const newDeviceId = () => [...random(DEVICE_ID_LENGTH)].map((b) => DEVICE_ID_ALPHABET[b & 31]).join('');
const newCode = () => String(new DataView(random(4).buffer).getUint32(0) % 10 ** PAIR_CODE_LENGTH).padStart(PAIR_CODE_LENGTH, '0');

const status = (d: DeviceRow): DeviceStatus => ({ paired: d.elw_id !== null, label: d.elw_id ? d.label : '', code: d.elw_id ? null : d.code });

export async function handle(req: Request, env: Env, now = new Date()): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const ts = now.toISOString();
  const db = env.DB;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE', 'access-control-allow-headers': 'authorization, content-type, x-elvis-signature' },
    });
  }
  if (req.method === 'GET' && path === '/') return new Response('ELVIS App-Relay\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (req.method === 'GET' && path === '/datenschutz') return new Response(PRIVACY_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });

  // --- Mail: Schlüsselverzeichnis, Bestätigungslinks, Statusseite (öffentlich) ---

  if (req.method === 'GET' && path.startsWith('/.well-known/openpgpkey/')) return (await handleWkd(path, env)) ?? fail(404, 'Nicht gefunden');
  const confirm = /^\/m\/confirm\/([A-Za-z0-9_-]{43})$/.exec(path);
  if (confirm) return handleConfirm(req, env, confirm[1]!, now);
  if (path.startsWith('/v1/status')) return (await handleStatus(req, env, path, now)) ?? fail(404, 'Nicht gefunden');

  // --- Online-Formular (öffentlich, die Adresse ist der Zugang) ---

  const page = /^\/p\/([A-Za-z0-9_-]{22})$/.exec(path);
  if (page) {
    const form = await db.prepare('SELECT * FROM forms WHERE id = ? AND expires_at > ?').bind(page[1], ts).first<FormRow>();
    if (req.method === 'GET') {
      const nonce = newToken();
      if (!form) return new Response(closedPage(nonce), { status: 410, headers: formHeaders(nonce) });
      return new Response(formPage({ nonce, formId: form.id, title: form.title, expiresAt: form.expires_at, publicKey: JSON.parse(form.public_key) }), { headers: formHeaders(nonce) });
    }
    if (req.method === 'POST') {
      if (!form) return fail(410, 'Dieser Link ist abgelaufen oder wurde beendet');
      if (form.submissions >= MAX_FORM_SUBMISSIONS) return fail(429, 'Für diesen Link sind keine weiteren Bögen möglich');
      const raw = await req.text();
      if (raw.length > MAX_SUBMISSION_BYTES) return fail(413, 'Personalbogen zu groß');
      let parsed: ReturnType<typeof encryptedSheetSchema.safeParse>;
      try {
        parsed = encryptedSheetSchema.safeParse(JSON.parse(raw));
      } catch {
        return fail(400, 'Personalbogen ungültig');
      }
      if (!parsed.success) return fail(400, 'Personalbogen ungültig');
      await db.prepare('UPDATE forms SET submissions = submissions + 1 WHERE id = ?').bind(form.id).run();
      await db
        .prepare('INSERT INTO submissions (form_id, elw_id, payload, received_at) VALUES (?, ?, ?, ?)')
        .bind(form.id, form.elw_id, JSON.stringify(parsed.data), ts)
        .run();
      return json(201, { ok: true });
    }
    return fail(405, 'Nicht erlaubt');
  }

  // --- App ---

  if (req.method === 'POST' && path === '/v1/devices') {
    const token = newToken();
    const code = newCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newDeviceId();
      const r = await db
        .prepare('INSERT OR IGNORE INTO devices (id, token_hash, code, created_at, last_seen) VALUES (?, ?, ?, ?, ?)')
        .bind(id, await hash(token), code, ts, ts)
        .run();
      if (r.meta.changes === 1) return json(201, { deviceId: id, token, code } satisfies DeviceRegistration);
    }
    return fail(503, 'Keine freie App-ID gefunden, bitte erneut versuchen');
  }

  if (path.startsWith('/v1/devices/me')) {
    const token = bearer(req);
    const device = token ? await db.prepare('SELECT * FROM devices WHERE token_hash = ?').bind(await hash(token)).first<DeviceRow>() : null;
    if (!device) return fail(401, 'App nicht angemeldet');
    await db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').bind(ts, device.id).run();

    if (req.method === 'GET' && path === '/v1/devices/me') return json(200, status(device));
    if (req.method === 'DELETE' && path === '/v1/devices/me') {
      await db.prepare('DELETE FROM positions WHERE device_id = ?').bind(device.id).run();
      await db.prepare('DELETE FROM devices WHERE id = ?').bind(device.id).run();
      return json(204, null);
    }
    if (req.method === 'POST' && path === '/v1/devices/me/positions') {
      const parsed = relayPositionSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, 'Position ungültig');
      const p = parsed.data;
      if (device.elw_id) {
        await db
          .prepare('INSERT INTO positions (device_id, elw_id, lat, lon, accuracy_m, battery, ts, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(device.id, device.elw_id, p.lat, p.lon, p.accuracyM, p.battery, p.ts, ts)
          .run();
      }
      return json(200, status(device));
    }
    return fail(404, 'Nicht gefunden');
  }

  // --- ELW ---

  if (req.method === 'POST' && path === '/v1/elws') {
    const id = crypto.randomUUID();
    const token = newToken();
    await db.prepare('INSERT INTO elws (id, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?)').bind(id, await hash(token), ts, ts).run();
    return json(201, { elwId: id, token } satisfies ElwRegistration);
  }

  if (path.startsWith('/v1/elws/me')) {
    const token = bearer(req);
    const elw = token ? await db.prepare('SELECT id FROM elws WHERE token_hash = ?').bind(await hash(token)).first<{ id: string }>() : null;
    if (!elw) return fail(401, 'ELW nicht angemeldet');
    await db.prepare('UPDATE elws SET last_seen = ? WHERE id = ?').bind(ts, elw.id).run();

    if (path.startsWith('/v1/elws/me/mail')) return handleMail(req, env, elw.id, path, now);

    if (req.method === 'POST' && path === '/v1/elws/me/pairings') {
      const parsed = relayPairSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, 'App-ID oder Code ungültig');
      const { deviceId, code, label } = parsed.data;
      const device = await db.prepare('SELECT * FROM devices WHERE id = ?').bind(deviceId).first<DeviceRow>();
      if (!device) return fail(404, 'App-ID unbekannt');
      if (device.elw_id && device.elw_id !== elw.id) return fail(409, 'App ist mit einem anderen ELW gekoppelt');
      if (!sameCode(device.code, code)) {
        if (device.code_attempts + 1 >= MAX_CODE_ATTEMPTS) {
          await db.prepare('UPDATE devices SET code = ?, code_attempts = 0 WHERE id = ?').bind(newCode(), deviceId).run();
          return fail(429, 'Zu viele Fehlversuche, neuer Code in der App');
        }
        await db.prepare('UPDATE devices SET code_attempts = code_attempts + 1 WHERE id = ?').bind(deviceId).run();
        return fail(403, 'Code falsch');
      }
      // Code gilt nur einmal: nach dem Koppeln gibt es einen neuen (für die nächste Kopplung)
      await db
        .prepare('UPDATE devices SET elw_id = ?, label = ?, paired_at = ?, code = ?, code_attempts = 0 WHERE id = ?')
        .bind(elw.id, label, ts, newCode(), deviceId)
        .run();
      return json(201, { paired: true, label, code: null } satisfies DeviceStatus);
    }

    const pairing = /^\/v1\/elws\/me\/pairings\/([0-9A-Z]+)$/.exec(path);
    if (pairing) {
      const device = await db.prepare('SELECT * FROM devices WHERE id = ? AND elw_id = ?').bind(pairing[1], elw.id).first<DeviceRow>();
      if (!device) return fail(404, 'App nicht mit diesem ELW gekoppelt');
      if (req.method === 'PUT') {
        const parsed = relayLabelSchema.safeParse(await body(req));
        if (!parsed.success) return fail(400, 'Bezeichnung ungültig');
        await db.prepare('UPDATE devices SET label = ? WHERE id = ?').bind(parsed.data.label, device.id).run();
        return json(200, { paired: true, label: parsed.data.label, code: null } satisfies DeviceStatus);
      }
      if (req.method === 'DELETE') {
        await db.prepare("UPDATE devices SET elw_id = NULL, label = '', paired_at = NULL, code = ?, code_attempts = 0 WHERE id = ?").bind(newCode(), device.id).run();
        await db.prepare('DELETE FROM positions WHERE device_id = ?').bind(device.id).run();
        return json(204, null);
      }
    }

    if (req.method === 'POST' && path === '/v1/elws/me/forms') {
      const parsed = relayFormRequestSchema.safeParse(await body(req));
      if (!parsed.success) return fail(400, 'Formular ungültig');
      const { title, publicKey, expiresAt } = parsed.data;
      if (expiresAt <= ts || new Date(expiresAt).getTime() - now.getTime() > FORM_MAX_MS) return fail(400, 'Gültigkeit höchstens 7 Tage');
      const formId = newFormId();
      await db
        .prepare('INSERT INTO forms (id, elw_id, title, public_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(formId, elw.id, title, JSON.stringify(publicKey), ts, new Date(expiresAt).toISOString())
        .run();
      return json(201, { formId, url: `${url.origin}/p/${formId}` } satisfies RelayForm);
    }

    const formPath = /^\/v1\/elws\/me\/forms\/([A-Za-z0-9_-]+)$/.exec(path);
    if (req.method === 'DELETE' && formPath) {
      // Eingereichte, noch nicht abgeholte Bögen bleiben bis zur Abholung
      const r = await db.prepare('DELETE FROM forms WHERE id = ? AND elw_id = ?').bind(formPath[1], elw.id).run();
      return r.meta.changes ? json(204, null) : fail(404, 'Formular nicht gefunden');
    }

    if (req.method === 'GET' && path === '/v1/elws/me/submissions') {
      const after = Math.max(0, Math.floor(Number(url.searchParams.get('after') ?? 0)) || 0);
      await db.prepare('DELETE FROM submissions WHERE elw_id = ? AND seq <= ?').bind(elw.id, after).run();
      const rows = await db
        .prepare('SELECT seq, form_id, payload, received_at FROM submissions WHERE elw_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .bind(elw.id, after, SUBMISSION_BATCH)
        .all<{ seq: number; form_id: string; payload: string; received_at: string }>();
      const items: RelaySubmission[] = rows.results.map((r) => ({ seq: r.seq, formId: r.form_id, submittedAt: r.received_at, payload: JSON.parse(r.payload) }));
      return json(200, { items, next: items.at(-1)?.seq ?? after } satisfies RelaySubmissionBatch);
    }

    if (req.method === 'GET' && path === '/v1/elws/me/positions') {
      const after = Math.max(0, Math.floor(Number(url.searchParams.get('after') ?? 0)) || 0);
      // Was der ELW mit diesem Cursor bestätigt, wird nicht mehr gebraucht
      await db.prepare('DELETE FROM positions WHERE elw_id = ? AND seq <= ?').bind(elw.id, after).run();
      const rows = await db
        .prepare('SELECT seq, device_id, lat, lon, accuracy_m, battery, ts FROM positions WHERE elw_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .bind(elw.id, after, BATCH)
        .all<{ seq: number; device_id: string; lat: number; lon: number; accuracy_m: number | null; battery: number | null; ts: string }>();
      const items: RelayPositionItem[] = rows.results.map((r) => ({
        seq: r.seq,
        deviceId: r.device_id,
        lat: r.lat,
        lon: r.lon,
        accuracyM: r.accuracy_m,
        battery: r.battery,
        ts: r.ts,
      }));
      return json(200, { items, next: items.at(-1)?.seq ?? after } satisfies ElwPositionBatch);
    }
    return fail(404, 'Nicht gefunden');
  }

  return fail(404, 'Nicht gefunden');
}

/** Stündlich: alte Positionen und Personalbögen, abgelaufene Formulare, verwaiste Apps und ELWs löschen */
export async function cleanup(env: Env, now = new Date()): Promise<void> {
  const before = (ms: number) => new Date(now.getTime() - ms).toISOString();
  await env.DB.prepare('DELETE FROM submissions WHERE received_at < ?').bind(before(SUBMISSION_TTL_MS)).run();
  await env.DB.prepare('DELETE FROM forms WHERE expires_at < ?').bind(now.toISOString()).run();
  await env.DB.prepare('DELETE FROM submissions WHERE elw_id IN (SELECT id FROM elws WHERE last_seen < ?)').bind(before(ELW_TTL_MS)).run();
  await env.DB.prepare('DELETE FROM forms WHERE elw_id IN (SELECT id FROM elws WHERE last_seen < ?)').bind(before(ELW_TTL_MS)).run();
  await env.DB.prepare('DELETE FROM positions WHERE received_at < ?').bind(before(POSITION_TTL_MS)).run();
  await env.DB.prepare('DELETE FROM positions WHERE device_id IN (SELECT id FROM devices WHERE last_seen < ?)').bind(before(DEVICE_TTL_MS)).run();
  await env.DB.prepare('DELETE FROM devices WHERE last_seen < ?').bind(before(DEVICE_TTL_MS)).run();
  await env.DB.prepare('UPDATE devices SET elw_id = NULL WHERE elw_id IN (SELECT id FROM elws WHERE last_seen < ?)').bind(before(ELW_TTL_MS)).run();
  await env.DB.prepare('DELETE FROM elws WHERE last_seen < ?').bind(before(ELW_TTL_MS)).run();
  await mailCleanup(env, now);
}

/** Fehlerantwort für den Worker (index.ts) */
export const internalError = () => fail(500, 'Interner Fehler');
