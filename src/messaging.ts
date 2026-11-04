import { fail, json } from './http.js';
import { verifySignature, type MailboxRow } from './mail.js';
import {
  MESSAGING_LIMITS,
  conversationRequestSchema,
  messageRequestSchema,
  messagingProfileSchema,
  regionArsSchema,
  type Conversation,
  type ConversationState,
  type DirectoryEntry,
  type MessagingEvent,
  type MessagingEventBatch,
  type MessagingProfile,
  type MessagingProfileStatus,
  type MessagingVehicle,
} from './messagingprotocol.js';
import { region, regionLabel } from './regions.js';
import type { Env } from './relay.js';

/**
 * Cloud Messaging: Verzeichnis, Chat-Anfragen und Zustellung zwischen ELVIS-Installationen. Jede Installation hat eine
 * Ereignis-Warteschlange (msg_events). Neue Ereignisse schiebt das Relay sofort über den WebSocket der Installation
 * (socket.ts, Durable Object); ist sie offline, holt sie sie später mit GET …/events ab. Erst die Quittung löscht.
 */

const RETENTION_MS = MESSAGING_LIMITS.retentionDays * 24 * 3600_000;
const EVENT_BATCH = 100;

interface DirectoryRow {
  elw_id: string;
  region_ars: string;
  vehicle: string;
  listed: number;
  updated_at: string;
  localpart: string;
  public_key: string;
  fingerprint: string;
}

interface ConversationRow {
  id: string;
  from_elw: string;
  to_elw: string;
  state: ConversationState;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  seq: number;
  to_elw: string;
  from_elw: string;
  conversation_id: string;
  type: MessagingEvent['type'];
  state: ConversationState;
  ciphertext: string | null;
  attachment_id: string | null;
  attachment_size: number | null;
  created_at: string;
}

const DIRECTORY_SELECT =
  "SELECT d.*, m.localpart, m.public_key, m.fingerprint FROM msg_directory d JOIN mailboxes m ON m.elw_id = d.elw_id AND m.status = 'active'";
const EVENT_SELECT = 'SELECT e.*, a.size AS attachment_size FROM msg_events e LEFT JOIN msg_attachments a ON a.id = e.attachment_id';

const entryOf = (env: Env, r: DirectoryRow): DirectoryEntry => ({
  elwId: r.elw_id,
  vehicle: JSON.parse(r.vehicle) as MessagingVehicle,
  regionArs: r.region_ars,
  regionLabel: regionLabel(r.region_ars),
  address: `${r.localpart}@${env.MAIL_DOMAIN ?? 'einsatzleitwagen.app'}`,
  publicKey: r.public_key,
  fingerprint: r.fingerprint,
  updatedAt: r.updated_at,
});

const conversationOf = (elwId: string, r: ConversationRow): Conversation => ({
  id: r.id,
  peer: r.from_elw === elwId ? r.to_elw : r.from_elw,
  direction: r.from_elw === elwId ? 'out' : 'in',
  state: r.state,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const eventOf = (r: EventRow): MessagingEvent => ({
  seq: r.seq,
  type: r.type,
  conversationId: r.conversation_id,
  from: r.from_elw,
  state: r.state,
  ciphertext: r.ciphertext,
  attachment: r.attachment_id ? { id: r.attachment_id, size: r.attachment_size ?? 0 } : null,
  at: r.created_at,
});

const searchText = (v: MessagingVehicle) => [v.name, v.callsign, v.organization].join(' ').toLocaleLowerCase('de');
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Ereignis in die Warteschlange der Gegenseite legen und, wenn sie verbunden ist, sofort zustellen */
async function enqueue(env: Env, e: Omit<EventRow, 'seq' | 'attachment_size'>): Promise<void> {
  const row = await env.DB.prepare(
    'INSERT INTO msg_events (to_elw, from_elw, conversation_id, type, state, ciphertext, attachment_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq',
  )
    .bind(e.to_elw, e.from_elw, e.conversation_id, e.type, e.state, e.ciphertext, e.attachment_id, e.created_at)
    .first<{ seq: number }>();
  const full = await env.DB.prepare(`${EVENT_SELECT} WHERE e.seq = ?`).bind(row!.seq).first<EventRow>();
  if (!env.NOTIFY || !full) return;
  try {
    await env.NOTIFY(e.to_elw, eventOf(full));
  } catch (err) {
    // Die Gegenseite holt das Ereignis spätestens beim nächsten Abruf
    console.warn('Messaging: Zustellung über WebSocket fehlgeschlagen', err);
  }
}

/** Abgeholte Ereignisse (bis seq) und ihre Anhänge löschen */
export async function ackEvents(env: Pick<Env, 'DB' | 'MESSAGING'>, elwId: string, seq: number): Promise<void> {
  const done = await env.DB.prepare('SELECT attachment_id FROM msg_events WHERE to_elw = ? AND seq <= ? AND attachment_id IS NOT NULL').bind(elwId, seq).all<{ attachment_id: string }>();
  await env.DB.prepare('DELETE FROM msg_events WHERE to_elw = ? AND seq <= ?').bind(elwId, seq).run();
  for (const { attachment_id: id } of done.results) {
    await env.DB.prepare('DELETE FROM msg_attachments WHERE id = ?').bind(id).run();
    await env.MESSAGING?.delete(`msg/${id}`);
  }
}

export async function handleMessaging(req: Request, env: Env, elwId: string, path: string, url: URL, now: Date): Promise<Response> {
  const db = env.DB;
  const ts = now.toISOString();
  const raw = new Uint8Array(await req.arrayBuffer());
  const parseBody = () => {
    try {
      return JSON.parse(new TextDecoder().decode(raw)) as unknown;
    } catch {
      return null;
    }
  };

  // Ohne aktives Postfach gibt es keinen Schlüssel – nur den Status kann ELVIS abfragen
  const mailbox = await db.prepare("SELECT * FROM mailboxes WHERE elw_id = ? AND status = 'active'").bind(elwId).first<MailboxRow>();
  if (!mailbox) {
    if (req.method === 'GET' && path === '/v1/elws/me/messaging/profile') return json(200, { status: 'mailbox-missing', profile: null } satisfies MessagingProfileStatus);
    return fail(409, 'Cloud Messaging braucht ein aktives ELVIS-Postfach');
  }
  if (!(await verifySignature(req, raw, mailbox, db, now))) return fail(401, 'Signatur ungültig');

  const own = () => db.prepare(`${DIRECTORY_SELECT} WHERE d.elw_id = ?`).bind(elwId).first<DirectoryRow>();
  const registered = async () => !!(await db.prepare('SELECT 1 FROM msg_directory WHERE elw_id = ?').bind(elwId).first());

  // --- Verzeichniseintrag ---

  if (path === '/v1/elws/me/messaging/profile') {
    if (req.method === 'PUT') {
      const parsed = messagingProfileSchema.safeParse(parseBody());
      if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Eintrag ungültig');
      const p = parsed.data;
      if (p.regionArs !== '' && !region(p.regionArs)) return fail(400, 'Region unbekannt');
      await db
        .prepare(
          'INSERT INTO msg_directory (elw_id, region_ars, vehicle, search, listed, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(elw_id) DO UPDATE SET region_ars = excluded.region_ars, vehicle = excluded.vehicle, search = excluded.search, listed = excluded.listed, updated_at = excluded.updated_at',
        )
        .bind(elwId, p.regionArs, JSON.stringify(p.vehicle), searchText(p.vehicle), p.listed ? 1 : 0, ts)
        .run();
    }
    if (req.method === 'DELETE') {
      // Offene Chats enden; nicht abgeholte Ereignisse an diese Installation werden gelöscht
      const open = await db.prepare("SELECT * FROM msg_conversations WHERE (from_elw = ? OR to_elw = ?) AND state IN ('requested', 'accepted')").bind(elwId, elwId).all<ConversationRow>();
      for (const c of open.results) {
        await db.prepare("UPDATE msg_conversations SET state = 'closed', updated_at = ? WHERE id = ?").bind(ts, c.id).run();
        const peer = c.from_elw === elwId ? c.to_elw : c.from_elw;
        await enqueue(env, { to_elw: peer, from_elw: elwId, conversation_id: c.id, type: 'state', state: 'closed', ciphertext: null, attachment_id: null, created_at: ts });
      }
      await ackEvents(env, elwId, Number.MAX_SAFE_INTEGER);
      await db.prepare('DELETE FROM msg_directory WHERE elw_id = ?').bind(elwId).run();
      return json(200, { status: 'none', profile: null } satisfies MessagingProfileStatus);
    }
    if (req.method === 'GET' || req.method === 'PUT') {
      const row = await own();
      return json(200, (row ? { status: 'registered', profile: { ...entryOf(env, row), listed: row.listed === 1 } satisfies MessagingProfile } : { status: 'none', profile: null }) satisfies MessagingProfileStatus);
    }
  }

  if (!(await registered())) return fail(409, 'Erst im Verzeichnis registrieren');

  // --- Verzeichnis ---

  if (req.method === 'GET' && path === '/v1/elws/me/messaging/directory') {
    const q = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase('de');
    const ars = url.searchParams.get('region') ?? '';
    if (!regionArsSchema.safeParse(ars).success) return fail(400, 'Regionalschlüssel ungültig');
    const rows = await db
      .prepare(`${DIRECTORY_SELECT} WHERE d.listed = 1 AND d.elw_id != ? AND d.region_ars LIKE ? ESCAPE '\\' AND d.search LIKE ? ESCAPE '\\' ORDER BY d.search LIMIT ?`)
      .bind(elwId, `${ars}%`, `%${likeEscape(q)}%`, MESSAGING_LIMITS.maxSearchResults)
      .all<DirectoryRow>();
    return json(200, rows.results.map((r) => entryOf(env, r)));
  }

  const entry = /^\/v1\/elws\/me\/messaging\/directory\/([0-9a-f-]{36})$/.exec(path);
  if (req.method === 'GET' && entry) {
    const row = await db.prepare(`${DIRECTORY_SELECT} WHERE d.elw_id = ?`).bind(entry[1]).first<DirectoryRow>();
    // Nicht gelistete Installationen nur für bekannte Gegenstellen (mit gemeinsamer Konversation)
    const known = row && (row.listed === 1 || (await db.prepare('SELECT 1 FROM msg_conversations WHERE (from_elw = ? AND to_elw = ?) OR (from_elw = ? AND to_elw = ?)').bind(elwId, row.elw_id, row.elw_id, elwId).first()));
    return known ? json(200, entryOf(env, row)) : fail(404, 'Installation nicht im Verzeichnis');
  }

  // --- Konversationen ---

  if (path === '/v1/elws/me/messaging/conversations') {
    if (req.method === 'GET') {
      const rows = await db.prepare('SELECT * FROM msg_conversations WHERE from_elw = ? OR to_elw = ? ORDER BY updated_at DESC').bind(elwId, elwId).all<ConversationRow>();
      return json(200, rows.results.map((r) => conversationOf(elwId, r)));
    }
    if (req.method === 'POST') {
      const parsed = conversationRequestSchema.safeParse(parseBody());
      if (!parsed.success) return fail(400, 'Anfrage ungültig');
      const { to, ciphertext } = parsed.data;
      if (to === elwId) return fail(400, 'Keine Anfrage an sich selbst');
      const target = await db.prepare(`${DIRECTORY_SELECT} WHERE d.elw_id = ?`).bind(to).first<DirectoryRow>();
      if (!target) return fail(404, 'Installation nicht im Verzeichnis');
      const recent = await db.prepare('SELECT COUNT(*) AS n FROM msg_conversations WHERE from_elw = ? AND created_at > ?').bind(elwId, new Date(now.getTime() - 3600_000).toISOString()).first<{ n: number }>();
      if ((recent?.n ?? 0) >= MESSAGING_LIMITS.requestsPerHour) return fail(429, 'Zu viele Anfragen, bitte später erneut versuchen');
      const id = crypto.randomUUID();
      await db.prepare("INSERT INTO msg_conversations (id, from_elw, to_elw, state, created_at, updated_at) VALUES (?, ?, ?, 'requested', ?, ?)").bind(id, elwId, to, ts, ts).run();
      await enqueue(env, { to_elw: to, from_elw: elwId, conversation_id: id, type: 'request', state: 'requested', ciphertext, attachment_id: null, created_at: ts });
      return json(201, conversationOf(elwId, { id, from_elw: elwId, to_elw: to, state: 'requested', created_at: ts, updated_at: ts }));
    }
  }

  const transition = /^\/v1\/elws\/me\/messaging\/conversations\/([0-9a-f-]{36})\/(accept|decline|close)$/.exec(path);
  if (req.method === 'POST' && transition) {
    const c = await db.prepare('SELECT * FROM msg_conversations WHERE id = ? AND (from_elw = ? OR to_elw = ?)').bind(transition[1], elwId, elwId).first<ConversationRow>();
    if (!c) return fail(404, 'Konversation unbekannt');
    const action = transition[2] as 'accept' | 'decline' | 'close';
    let next: ConversationState;
    if (action === 'close') {
      if (c.state === 'declined' || c.state === 'closed') return json(200, conversationOf(elwId, c));
      next = 'closed';
    } else {
      // Annehmen oder ablehnen kann nur die angefragte Seite, und nur solange die Anfrage offen ist
      if (c.to_elw !== elwId) return fail(403, 'Nur die angefragte Installation kann annehmen oder ablehnen');
      if (c.state !== 'requested') return fail(409, 'Anfrage ist nicht mehr offen');
      next = action === 'accept' ? 'accepted' : 'declined';
    }
    await db.prepare('UPDATE msg_conversations SET state = ?, updated_at = ? WHERE id = ?').bind(next, ts, c.id).run();
    const peer = c.from_elw === elwId ? c.to_elw : c.from_elw;
    await enqueue(env, { to_elw: peer, from_elw: elwId, conversation_id: c.id, type: 'state', state: next, ciphertext: null, attachment_id: null, created_at: ts });
    return json(200, conversationOf(elwId, { ...c, state: next, updated_at: ts }));
  }

  // --- Nachrichten und Anhänge ---

  if (req.method === 'POST' && path === '/v1/elws/me/messaging/messages') {
    const parsed = messageRequestSchema.safeParse(parseBody());
    if (!parsed.success) return fail(400, 'Nachricht ungültig');
    const { conversationId, ciphertext, attachmentId } = parsed.data;
    const c = await db.prepare('SELECT * FROM msg_conversations WHERE id = ? AND (from_elw = ? OR to_elw = ?)').bind(conversationId, elwId, elwId).first<ConversationRow>();
    if (!c) return fail(404, 'Konversation unbekannt');
    if (c.state !== 'accepted') return fail(409, 'Chat ist nicht aktiv');
    const peer = c.from_elw === elwId ? c.to_elw : c.from_elw;
    if (attachmentId) {
      const r = await db.prepare('UPDATE msg_attachments SET to_elw = ? WHERE id = ? AND from_elw = ? AND to_elw IS NULL').bind(peer, attachmentId, elwId).run();
      if (!r.meta.changes) return fail(404, 'Anhang unbekannt');
    }
    await db.prepare('UPDATE msg_conversations SET updated_at = ? WHERE id = ?').bind(ts, c.id).run();
    await enqueue(env, { to_elw: peer, from_elw: elwId, conversation_id: c.id, type: 'message', state: c.state, ciphertext, attachment_id: attachmentId, created_at: ts });
    return json(201, { ok: true });
  }

  if (req.method === 'POST' && path === '/v1/elws/me/messaging/attachments') {
    if (!env.MESSAGING) return fail(503, 'Anhänge sind auf diesem Relay nicht eingerichtet');
    if (raw.byteLength === 0) return fail(400, 'Anhang leer');
    if (raw.byteLength > MESSAGING_LIMITS.maxAttachmentBytes) return fail(413, 'Anhang zu groß');
    const id = crypto.randomUUID();
    await env.MESSAGING.put(`msg/${id}`, raw);
    await db.prepare('INSERT INTO msg_attachments (id, from_elw, size, created_at) VALUES (?, ?, ?, ?)').bind(id, elwId, raw.byteLength, ts).run();
    return json(201, { id });
  }

  const attachment = /^\/v1\/elws\/me\/messaging\/attachments\/([0-9a-f-]{36})$/.exec(path);
  if (req.method === 'GET' && attachment) {
    const row = await db.prepare('SELECT id FROM msg_attachments WHERE id = ? AND to_elw = ?').bind(attachment[1], elwId).first<{ id: string }>();
    const obj = row && env.MESSAGING ? await env.MESSAGING.get(`msg/${row.id}`) : null;
    if (!obj) return fail(404, 'Anhang nicht gefunden');
    return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' } });
  }

  // --- Ereignisse abholen (nach einem Verbindungsabbruch) und WebSocket ---

  if (req.method === 'GET' && path === '/v1/elws/me/messaging/events') {
    const after = Math.max(0, Math.floor(Number(url.searchParams.get('after') ?? 0)) || 0);
    if (after > 0) await ackEvents(env, elwId, after);
    const rows = await db.prepare(`${EVENT_SELECT} WHERE e.to_elw = ? AND e.seq > ? ORDER BY e.seq LIMIT ?`).bind(elwId, after, EVENT_BATCH).all<EventRow>();
    const items = rows.results.map(eventOf);
    return json(200, { items, next: items.at(-1)?.seq ?? after } satisfies MessagingEventBatch);
  }

  if (req.method === 'GET' && path === '/v1/elws/me/messaging/socket') {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fail(426, 'WebSocket erwartet');
    if (!env.CONNECT) return fail(503, 'WebSocket ist auf diesem Relay nicht eingerichtet');
    return env.CONNECT(elwId, req);
  }

  return fail(404, 'Nicht gefunden');
}

/** Stündlich: alte Ereignisse, nie versandte oder nie abgeholte Anhänge, verwaiste Einträge löschen */
export async function messagingCleanup(env: Env, now = new Date()): Promise<void> {
  const before = new Date(now.getTime() - RETENTION_MS).toISOString();
  await env.DB.prepare('DELETE FROM msg_events WHERE created_at < ?').bind(before).run();
  const old = await env.DB.prepare('SELECT id FROM msg_attachments WHERE created_at < ?').bind(before).all<{ id: string }>();
  for (const { id } of old.results) await env.MESSAGING?.delete(`msg/${id}`);
  await env.DB.prepare('DELETE FROM msg_attachments WHERE created_at < ?').bind(before).run();
  await env.DB.prepare("DELETE FROM msg_conversations WHERE state IN ('declined', 'closed') AND updated_at < ?").bind(before).run();
  // Installationen ohne aktives Postfach (gekündigt, übertragen, verfallen) verschwinden aus dem Verzeichnis
  await env.DB.prepare("DELETE FROM msg_directory WHERE elw_id NOT IN (SELECT elw_id FROM mailboxes WHERE status = 'active' AND elw_id IS NOT NULL)").run();
}
