import {
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
import { PRIVACY_HTML } from './privacy.js';

/**
 * Cloud-Relay der ELVIS-App. Apps melden sich an und senden ihre Position; ein ELW (ELVIS-Server) koppelt
 * eine App mit ID und Code und holt die Positionen ab. Es wird nur gespeichert, was dafür nötig ist:
 * Positionen werden mit der Abholung gelöscht, spätestens nach 24 Stunden.
 */
export interface Env {
  DB: D1Database;
}

/** Fehlversuche beim Code, danach bekommt die App einen neuen */
export const MAX_CODE_ATTEMPTS = 5;
const BATCH = 500;
const POSITION_TTL_MS = 24 * 3600_000;
const DEVICE_TTL_MS = 90 * 24 * 3600_000;
const ELW_TTL_MS = 365 * 24 * 3600_000;

interface DeviceRow {
  id: string;
  code: string;
  code_attempts: number;
  elw_id: string | null;
  label: string;
}

const json = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
const fail = (status: number, error: string) => json(status, { error });

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const newToken = () => btoa(String.fromCharCode(...random(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const newDeviceId = () => [...random(DEVICE_ID_LENGTH)].map((b) => DEVICE_ID_ALPHABET[b & 31]).join('');
const newCode = () => String(new DataView(random(4).buffer).getUint32(0) % 10 ** PAIR_CODE_LENGTH).padStart(PAIR_CODE_LENGTH, '0');

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Gleichlange Zeichenketten in konstanter Zeit vergleichen */
function sameCode(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const bearer = (req: Request) => /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? null;

async function body(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

const status = (d: DeviceRow): DeviceStatus => ({ paired: d.elw_id !== null, label: d.elw_id ? d.label : '', code: d.elw_id ? null : d.code });

export async function handle(req: Request, env: Env, now = new Date()): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const ts = now.toISOString();
  const db = env.DB;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE', 'access-control-allow-headers': 'authorization, content-type' },
    });
  }
  if (req.method === 'GET' && path === '/') return new Response('ELVIS App-Relay\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (req.method === 'GET' && path === '/datenschutz') return new Response(PRIVACY_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });

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

/** Stündlich: alte Positionen, verwaiste Apps und ELWs löschen */
export async function cleanup(env: Env, now = new Date()): Promise<void> {
  const before = (ms: number) => new Date(now.getTime() - ms).toISOString();
  await env.DB.prepare('DELETE FROM positions WHERE received_at < ?').bind(before(POSITION_TTL_MS)).run();
  await env.DB.prepare('DELETE FROM positions WHERE device_id IN (SELECT id FROM devices WHERE last_seen < ?)').bind(before(DEVICE_TTL_MS)).run();
  await env.DB.prepare('DELETE FROM devices WHERE last_seen < ?').bind(before(DEVICE_TTL_MS)).run();
  await env.DB.prepare('UPDATE devices SET elw_id = NULL WHERE elw_id IN (SELECT id FROM elws WHERE last_seen < ?)').bind(before(ELW_TTL_MS)).run();
  await env.DB.prepare('DELETE FROM elws WHERE last_seen < ?').bind(before(ELW_TTL_MS)).run();
}

/** Fehlerantwort für den Worker (index.ts) */
export const internalError = () => fail(500, 'Interner Fehler');
