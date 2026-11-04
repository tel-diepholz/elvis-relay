import { beforeEach, describe, expect, it } from 'vitest';
import { base64url, sha256Hex } from './http.js';
import { MAIL_SIGNATURE_HEADER, mailSignaturePayload } from './mailprotocol.js';
import type { Conversation, DirectoryEntry, MessagingEvent, MessagingEventBatch, MessagingProfileStatus } from './messagingprotocol.js';
import type { ElwRegistration } from './protocol.js';
import { cleanup, handle, type Env } from './relay.js';
import { children, region, regionLabel, search } from './regions.js';
import { fakeD1, fakeR2 } from './testing.js';

let env: Env;
let now: Date;
let pushed: { elwId: string; event: MessagingEvent }[];

beforeEach(() => {
  now = new Date('2026-11-04T10:00:00Z');
  pushed = [];
  env = {
    DB: fakeD1(),
    MAIL_DOMAIN: 'einsatzleitwagen.app',
    MESSAGING: fakeR2(),
    NOTIFY: async (elwId, event) => void pushed.push({ elwId, event }),
  };
});

/** ELVIS-Installation mit aktivem Postfach (direkt in der Datenbank, der Mail-Ablauf ist in mail.test.ts geprüft) */
async function installation(localpart: string, opts: { mailbox?: boolean } = {}) {
  const reg = (await (await handle(new Request('https://relay.test/v1/elws', { method: 'POST' }), env, now)).json()) as ElwRegistration;
  const sig = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const sigPublicKey = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', sig.publicKey)));
  if (opts.mailbox !== false) {
    await env.DB.prepare(
      "INSERT INTO mailboxes (localpart, elw_id, admin_email, public_key, fingerprint, wkd_hash, sig_public_key, status, created_at) VALUES (?, ?, 'admin@example.org', ?, ?, 'x', ?, 'active', ?)",
    )
      .bind(localpart, reg.elwId, `-----BEGIN PGP PUBLIC KEY BLOCK----- ${localpart}`, `FP-${localpart}`, sigPublicKey, now.toISOString())
      .run();
  }

  async function call(method: string, path: string, opts: { body?: unknown; raw?: Uint8Array; sign?: boolean; headers?: Record<string, string> } = {}) {
    const raw = opts.raw ?? (opts.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(opts.body)));
    const headers: Record<string, string> = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json', ...opts.headers };
    if (opts.sign !== false) {
      const t = now.getTime();
      const n = base64url(crypto.getRandomValues(new Uint8Array(16)));
      const payload = mailSignaturePayload(method, path, await sha256Hex(raw), t, n);
      const s = base64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sig.privateKey, new TextEncoder().encode(payload))));
      headers[MAIL_SIGNATURE_HEADER] = `t=${t},n=${n},s=${s}`;
    }
    const res = await handle(new Request(`https://relay.test${path}`, { method, headers, body: raw.byteLength || method !== 'GET' ? (raw as BodyInit) : undefined }), env, now);
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: (type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer())) as never };
  }

  const vehicle = (name: string) => ({ name, callsign: `Florian ${name}`, organization: 'FF Stuhr', contacts: [{ kind: 'phone', value: '+49 170 1', label: 'Primär-SIM' }] });
  const register = (regionArs: string, listed = true, name = localpart) => call('PUT', '/v1/elws/me/messaging/profile', { body: { regionArs, listed, vehicle: vehicle(name) } });
  return { elwId: reg.elwId, call, register };
}

describe('Kommunen-Katalog', () => {
  it('bildet Land › Kreis › Samtgemeinde › Gemeinde ab', () => {
    expect(children('')!.map((r) => r.name)).toContain('Niedersachsen');
    expect(children('03')!.find((r) => r.ars === '03251')).toMatchObject({ name: 'Landkreis Diepholz', kind: 'kreis', hasChildren: true });
    const diepholz = children('03251')!;
    expect(diepholz.find((r) => r.name === 'Stuhr')).toMatchObject({ ars: '032510037037', kind: 'gemeinde', hasChildren: false });
    expect(diepholz.find((r) => r.name === 'Samtgemeinde Barnstorf')).toMatchObject({ kind: 'verband', hasChildren: true });
    expect(children('032515402')!.map((r) => r.name)).toContain('Drebber');
    expect(regionLabel('032510037037')).toBe('Niedersachsen › Landkreis Diepholz › Stuhr');
    expect(regionLabel('')).toBe('Deutschland');
    expect(region('11')).toMatchObject({ name: 'Berlin', hasChildren: false });
  });

  it('findet Namen ohne Rücksicht auf Umlaute, größere Einheiten zuerst', () => {
    expect(search('stuhr')[0]).toMatchObject({ name: 'Stuhr', path: [{ name: 'Niedersachsen' }, { name: 'Landkreis Diepholz' }, { name: 'Stuhr' }] });
    expect(search('diepholz')[0]).toMatchObject({ name: 'Landkreis Diepholz' });
    expect(search('schwafoerden').length + search('schwaforden').length).toBeGreaterThan(0);
    expect(search('a')).toEqual([]);
  });

  it('ist öffentlich abrufbar', async () => {
    const res = await handle(new Request('https://relay.test/v1/regions?parent=03251'), env, now);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }[]).some((r) => r.name === 'Weyhe')).toBe(true);
    expect((await handle(new Request('https://relay.test/v1/regions/032510037037'), env, now)).status).toBe(200);
    expect((await handle(new Request('https://relay.test/v1/regions?parent=99'), env, now)).status).toBe(404);
  });
});

describe('Cloud Messaging', () => {
  it('braucht ein aktives Postfach und gültige Signaturen', async () => {
    const ohne = await installation('ohne', { mailbox: false });
    expect((await ohne.call('GET', '/v1/elws/me/messaging/profile')).body).toEqual({ status: 'mailbox-missing', profile: null });
    expect((await ohne.register('03')).status).toBe(409);

    const a = await installation('elw-stuhr');
    expect((await a.call('GET', '/v1/elws/me/messaging/profile', { sign: false })).status).toBe(401);
    expect((await a.call('GET', '/v1/elws/me/messaging/directory')).status).toBe(409);
    expect((await a.register('99')).status).toBe(400);
  });

  it('Verzeichnis: Eintrag, Suche nach Name und Region, nicht gelistete bleiben verborgen', async () => {
    const a = await installation('elw-stuhr');
    const b = await installation('elw-weyhe');
    const c = await installation('elw-hannover');
    const d = await installation('elw-geheim');
    const reg = await a.register('032510037037');
    expect(reg.status).toBe(200);
    expect((reg.body as MessagingProfileStatus).profile).toMatchObject({ regionLabel: 'Niedersachsen › Landkreis Diepholz › Stuhr', address: 'elw-stuhr@einsatzleitwagen.app', listed: true });
    await b.register('032510047047');
    await c.register('03241');
    await d.register('03251', false);

    const names = (r: { body: never }) => (r.body as DirectoryEntry[]).map((e) => e.vehicle.name).sort();
    expect(names(await a.call('GET', '/v1/elws/me/messaging/directory'))).toEqual(['elw-hannover', 'elw-weyhe']);
    expect(names(await a.call('GET', '/v1/elws/me/messaging/directory?region=03251'))).toEqual(['elw-weyhe']);
    expect(names(await c.call('GET', '/v1/elws/me/messaging/directory?region=03251'))).toEqual(['elw-stuhr', 'elw-weyhe']);
    expect(names(await c.call('GET', '/v1/elws/me/messaging/directory?q=WEYHE'))).toEqual(['elw-weyhe']);
    expect(names(await c.call('GET', '/v1/elws/me/messaging/directory?q=100%25'))).toEqual([]);
    const entry = (await c.call('GET', '/v1/elws/me/messaging/directory?q=weyhe')).body as DirectoryEntry[];
    expect(entry[0]).toMatchObject({ publicKey: expect.stringContaining('elw-weyhe'), fingerprint: 'FP-elw-weyhe', vehicle: { contacts: [{ label: 'Primär-SIM' }] } });
    expect((await a.call('GET', `/v1/elws/me/messaging/directory/${d.elwId}`)).status).toBe(404);
  });

  it('Anfrage, Annahme, Nachrichten mit Anhang, Zustellung und Quittung', async () => {
    const a = await installation('elw-stuhr');
    const b = await installation('elw-weyhe');
    await a.register('032510037037');
    await b.register('032510047047', false);

    // Anfrage an eine nicht gelistete Installation geht, wenn man ihre ID kennt (z. B. aus einem früheren Chat)
    const req = await a.call('POST', '/v1/elws/me/messaging/conversations', { body: { to: b.elwId, ciphertext: 'PGP(Anfrage)' } });
    expect(req.status).toBe(201);
    const conv = req.body as Conversation;
    expect(conv).toMatchObject({ peer: b.elwId, direction: 'out', state: 'requested' });
    expect(pushed).toEqual([{ elwId: b.elwId, event: expect.objectContaining({ type: 'request', from: a.elwId, ciphertext: 'PGP(Anfrage)', conversationId: conv.id }) }]);
    // Jetzt kennt b die Anfragende und a b
    expect((await a.call('GET', `/v1/elws/me/messaging/directory/${b.elwId}`)).status).toBe(200);

    // Vor der Annahme keine Nachrichten; nur die angefragte Seite nimmt an
    expect((await a.call('POST', '/v1/elws/me/messaging/messages', { body: { conversationId: conv.id, ciphertext: 'x' } })).status).toBe(409);
    expect((await a.call('POST', `/v1/elws/me/messaging/conversations/${conv.id}/accept`)).status).toBe(403);
    const acc = await b.call('POST', `/v1/elws/me/messaging/conversations/${conv.id}/accept`);
    expect(acc.body).toMatchObject({ state: 'accepted', direction: 'in', peer: a.elwId });
    expect((await b.call('POST', `/v1/elws/me/messaging/conversations/${conv.id}/decline`)).status).toBe(409);
    expect(pushed.at(-1)).toMatchObject({ elwId: a.elwId, event: { type: 'state', state: 'accepted' } });

    // Anhang hochladen, mit einer Nachricht verschicken, nur der Empfänger lädt ihn
    const file = new Uint8Array([1, 2, 3, 4]);
    const up = await a.call('POST', '/v1/elws/me/messaging/attachments', { raw: file, headers: { 'content-type': 'application/octet-stream' } });
    expect(up.status).toBe(201);
    const attachmentId = (up.body as { id: string }).id;
    expect((await b.call('POST', '/v1/elws/me/messaging/messages', { body: { conversationId: conv.id, ciphertext: 'y', attachmentId } })).status).toBe(404);
    expect((await a.call('POST', '/v1/elws/me/messaging/messages', { body: { conversationId: conv.id, ciphertext: 'PGP(Lagemeldung)', attachmentId } })).status).toBe(201);
    expect((await a.call('GET', `/v1/elws/me/messaging/attachments/${attachmentId}`)).status).toBe(404);
    expect(Array.from((await b.call('GET', `/v1/elws/me/messaging/attachments/${attachmentId}`)).body as Uint8Array)).toEqual([1, 2, 3, 4]);

    // b war offline: holt ab (Anfrage + Nachricht), quittiert per Cursor – danach ist alles weg, auch der Anhang
    const batch = (await b.call('GET', '/v1/elws/me/messaging/events')).body as MessagingEventBatch;
    expect(batch.items.map((e) => e.type)).toEqual(['request', 'message']);
    expect(batch.items[1]).toMatchObject({ ciphertext: 'PGP(Lagemeldung)', attachment: { id: attachmentId, size: 4 } });
    const after = (await b.call('GET', `/v1/elws/me/messaging/events?after=${batch.next}`)).body as MessagingEventBatch;
    expect(after.items).toEqual([]);
    expect((await b.call('GET', `/v1/elws/me/messaging/attachments/${attachmentId}`)).status).toBe(404);

    const ev = ((await a.call('GET', '/v1/elws/me/messaging/events')).body as MessagingEventBatch).items;
    expect(ev.map((e) => e.state)).toEqual(['accepted']);

    // Beenden kann jede Seite; danach keine Nachrichten mehr
    expect((await b.call('POST', `/v1/elws/me/messaging/conversations/${conv.id}/close`)).body).toMatchObject({ state: 'closed' });
    expect((await a.call('POST', '/v1/elws/me/messaging/messages', { body: { conversationId: conv.id, ciphertext: 'z' } })).status).toBe(409);
    expect(((await a.call('GET', '/v1/elws/me/messaging/conversations')).body as Conversation[])[0]).toMatchObject({ state: 'closed' });
  });

  it('Fremde sehen Konversationen nicht; Anfragen sind begrenzt', async () => {
    const a = await installation('elw-a');
    const b = await installation('elw-b');
    const x = await installation('elw-x');
    for (const i of [a, b, x]) await i.register('03');
    const conv = (await a.call('POST', '/v1/elws/me/messaging/conversations', { body: { to: b.elwId, ciphertext: 'c' } })).body as Conversation;
    expect((await x.call('POST', `/v1/elws/me/messaging/conversations/${conv.id}/accept`)).status).toBe(404);
    expect((await a.call('POST', '/v1/elws/me/messaging/conversations', { body: { to: a.elwId, ciphertext: 'c' } })).status).toBe(400);
    for (let i = 1; i < 30; i++) expect((await a.call('POST', '/v1/elws/me/messaging/conversations', { body: { to: b.elwId, ciphertext: 'c' } })).status).toBe(201);
    expect((await a.call('POST', '/v1/elws/me/messaging/conversations', { body: { to: b.elwId, ciphertext: 'c' } })).status).toBe(429);
  });

  it('Abmelden beendet offene Chats; Aufräumen löscht Altes und Einträge ohne Postfach', async () => {
    const a = await installation('elw-a');
    const b = await installation('elw-b');
    await a.register('03');
    await b.register('03');
    const conv = (await a.call('POST', '/v1/elws/me/messaging/conversations', { body: { to: b.elwId, ciphertext: 'c' } })).body as Conversation;
    expect((await b.call('DELETE', '/v1/elws/me/messaging/profile')).body).toEqual({ status: 'none', profile: null });
    expect(pushed.at(-1)).toMatchObject({ elwId: a.elwId, event: { type: 'state', state: 'closed', conversationId: conv.id } });
    expect(((await a.call('GET', '/v1/elws/me/messaging/directory')).body as DirectoryEntry[]).length).toBe(0);

    await env.DB.prepare("UPDATE mailboxes SET status = 'closed' WHERE localpart = 'elw-a'").run();
    now = new Date(now.getTime() + 15 * 24 * 3600_000);
    await cleanup(env, now);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM msg_directory').first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM msg_events').first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM msg_conversations').first()).toEqual({ n: 0 });
  });

  it('WebSocket-Upgrade geht an das Durable Object der eigenen Installation', async () => {
    const a = await installation('elw-a');
    await a.register('03');
    let connected: string | null = null;
    env.CONNECT = async (elwId) => ((connected = elwId), new Response('ok'));
    expect((await a.call('GET', '/v1/elws/me/messaging/socket')).status).toBe(426);
    expect((await a.call('GET', '/v1/elws/me/messaging/socket', { headers: { upgrade: 'websocket' } })).status).toBe(200);
    expect(connected).toBe(a.elwId);
  });
});
