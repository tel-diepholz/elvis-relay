import { HOOK_KINDS, relayHookRequestSchema, type HookKind, type RelayHook, type RelayHookBatch, type RelayHookEvent } from './protocol.js';
import { base64url, body, fail, json, newToken, random, sameCode } from './http.js';

interface HookEnv {
  DB: D1Database;
  RELAY_URL?: string;
}

interface HookRow {
  id: string;
  elw_id: string;
  kind: HookKind;
  verify_token: string;
}

/** Größter Aufruf (Meta bündelt mehrere Nachrichten, Threema schickt verschlüsselte Boxen) */
export const MAX_HOOK_BYTES = 256 * 1024;
/** Höchstens so viele nicht abgeholte Aufrufe je Webhook – bremst Missbrauch, wenn der ELW lange offline ist */
export const MAX_PENDING_EVENTS = 5000;
const HOOK_TTL_MS = 7 * 24 * 3600_000;
const BATCH = 100;

/** Webhook-ID: steht in der Adresse und ist zugleich der Zugang (128 Bit) */
const newHookId = () => base64url(random(16));
const hookUrl = (env: HookEnv, id: string, req: Request) => `${(env.RELAY_URL ?? new URL(req.url).origin).replace(/\/$/, '')}/h/${id}`;

/**
 * Öffentlicher Eingang /h/<id>: GET beantwortet die Prüfung von Meta (hub.challenge), POST puffert den Aufruf. Die
 * Antwort kommt sofort – Meta und Threema wiederholen sonst.
 */
export async function handleHookCall(req: Request, env: HookEnv, id: string, now: Date): Promise<Response> {
  const hook = await env.DB.prepare('SELECT * FROM hooks WHERE id = ?').bind(id).first<HookRow>();
  if (!hook) return fail(404, 'Nicht gefunden');
  if (req.method === 'GET') {
    const q = new URL(req.url).searchParams;
    const token = q.get('hub.verify_token') ?? '';
    if (q.get('hub.mode') === 'subscribe' && sameCode(token, hook.verify_token)) {
      return new Response(q.get('hub.challenge') ?? '', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return fail(403, 'Prüf-Token falsch');
  }
  if (req.method !== 'POST') return fail(405, 'Nicht erlaubt');
  const raw = await req.text();
  if (raw.length > MAX_HOOK_BYTES) return fail(413, 'Zu groß');
  const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM hook_events WHERE hook_id = ?').bind(hook.id).first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_EVENTS) return fail(429, 'Zu viele nicht abgeholte Aufrufe');
  await env.DB.prepare('INSERT INTO hook_events (hook_id, elw_id, kind, content_type, signature, body, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(hook.id, hook.elw_id, hook.kind, (req.headers.get('content-type') ?? '').slice(0, 200), req.headers.get('x-hub-signature-256')?.slice(0, 200) ?? null, raw, now.toISOString())
    .run();
  return new Response('ok', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** /v1/elws/me/hooks…: Webhook anlegen bzw. abfragen, löschen, Aufrufe abholen */
export async function handleHooks(req: Request, env: HookEnv, elwId: string, path: string, url: URL): Promise<Response> {
  const db = env.DB;
  if (req.method === 'POST' && path === '/v1/elws/me/hooks') {
    const parsed = relayHookRequestSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, 'Art des Webhooks ungültig');
    const { kind } = parsed.data;
    let hook = await db.prepare('SELECT * FROM hooks WHERE elw_id = ? AND kind = ?').bind(elwId, kind).first<HookRow>();
    if (!hook) {
      const row = { id: newHookId(), verify_token: newToken() };
      await db.prepare('INSERT OR IGNORE INTO hooks (id, elw_id, kind, verify_token, created_at) VALUES (?, ?, ?, ?, ?)').bind(row.id, elwId, kind, row.verify_token, new Date().toISOString()).run();
      hook = await db.prepare('SELECT * FROM hooks WHERE elw_id = ? AND kind = ?').bind(elwId, kind).first<HookRow>();
    }
    return json(200, { kind, url: hookUrl(env, hook!.id, req), verifyToken: hook!.verify_token } satisfies RelayHook);
  }
  const del = /^\/v1\/elws\/me\/hooks\/([a-z]+)$/.exec(path);
  if (req.method === 'DELETE' && del && (HOOK_KINDS as readonly string[]).includes(del[1]!)) {
    const hook = await db.prepare('SELECT id FROM hooks WHERE elw_id = ? AND kind = ?').bind(elwId, del[1]).first<{ id: string }>();
    if (hook) {
      await db.prepare('DELETE FROM hook_events WHERE hook_id = ?').bind(hook.id).run();
      await db.prepare('DELETE FROM hooks WHERE id = ?').bind(hook.id).run();
    }
    return json(204, null);
  }
  if (req.method === 'GET' && path === '/v1/elws/me/hooks/events') {
    const after = Math.max(0, Math.floor(Number(url.searchParams.get('after') ?? 0)) || 0);
    // Was der ELW mit diesem Cursor bestätigt, wird nicht mehr gebraucht
    await db.prepare('DELETE FROM hook_events WHERE elw_id = ? AND seq <= ?').bind(elwId, after).run();
    const rows = await db
      .prepare('SELECT seq, kind, content_type, signature, body, received_at FROM hook_events WHERE elw_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .bind(elwId, after, BATCH)
      .all<{ seq: number; kind: HookKind; content_type: string; signature: string | null; body: string; received_at: string }>();
    const items: RelayHookEvent[] = rows.results.map((r) => ({ seq: r.seq, kind: r.kind, contentType: r.content_type, signature: r.signature, body: r.body, receivedAt: r.received_at }));
    return json(200, { items, next: items.at(-1)?.seq ?? after } satisfies RelayHookBatch);
  }
  return fail(404, 'Nicht gefunden');
}

/** Stündlich: Aufrufe nach 7 Tagen und Webhooks verschwundener ELWs löschen */
export async function hookCleanup(env: HookEnv, now: Date): Promise<void> {
  await env.DB.prepare('DELETE FROM hook_events WHERE received_at < ?').bind(new Date(now.getTime() - HOOK_TTL_MS).toISOString()).run();
  await env.DB.prepare('DELETE FROM hook_events WHERE elw_id NOT IN (SELECT id FROM elws)').run();
  await env.DB.prepare('DELETE FROM hooks WHERE elw_id NOT IN (SELECT id FROM elws)').run();
}
