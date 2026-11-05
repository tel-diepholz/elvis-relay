import { beforeEach, describe, expect, it } from 'vitest';
import type { CloudLinkStatus, InstallationStatus, InvitationInfo, Me, NodeDetail } from './cloudprotocol.js';
import { base64url, sha256Hex } from './http.js';
import { MAIL_SIGNATURE_HEADER, mailSignaturePayload } from './mailprotocol.js';
import type { ElwRegistration } from './protocol.js';
import { cleanup, handle, type Env } from './relay.js';
import { fakeD1 } from './testing.js';

let env: Env;
let now: Date;
let mails: { to: string; raw: string }[];

const ORIGIN = 'https://cloud.test';
/** Kreis Diepholz und Gemeinde Weyhe (ARS) */
const KREIS = 'ars:03251';
const WEYHE = 'ars:032510047047';

beforeEach(() => {
  now = new Date('2026-11-05T10:00:00Z');
  mails = [];
  env = { DB: fakeD1(), MAIL_DOMAIN: 'einsatzleitwagen.app', CLOUD_URL: ORIGIN, SEND: async (_from, to, raw) => void mails.push({ to, raw }) };
});

const decoded = (raw: string) => {
  const b64 = raw.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, '');
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
};

/** Portal-Aufruf mit Sitzungs-Cookie */
async function portal<T = unknown>(method: string, path: string, opts: { body?: unknown; cookie?: string; origin?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin) headers.origin = opts.origin;
  const res = await handle(new Request(`${ORIGIN}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), env, now);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, cookie: res.headers.get('set-cookie') };
}

/** Anmelden: Code anfordern, aus der Mail lesen, bestätigen */
async function login(email: string, name = '') {
  expect((await portal('POST', '/v1/cloud/login', { body: { email } })).status).toBe(202);
  const code = /Anmeldecode (\d{6})/.exec(decoded(mails.at(-1)!.raw))?.[1] ?? /\n {2}(\d{6})\n/.exec(decoded(mails.at(-1)!.raw))![1]!;
  const res = await portal<Me>('POST', '/v1/cloud/login/verify', { body: { email, code, name } });
  expect(res.status).toBe(200);
  const cookie = res.cookie!.split(';')[0]!;
  return { cookie, me: res.body };
}

async function operator(email = 'betrieb@example.org') {
  const a = await login(email);
  await env.DB.prepare('UPDATE accounts SET operator = 1 WHERE email = ?').bind(email).run();
  return a;
}

/** Einladung anlegen und mit dem eingeladenen Konto annehmen */
async function invite(by: string, nodeId: string, email: string, role: 'viewer' | 'editor' | 'admin') {
  expect((await portal('POST', '/v1/cloud/invitations', { cookie: by, body: { nodeId, email, role } })).status).toBe(201);
  const token = /\/einladung\/([A-Za-z0-9_-]{43})/.exec(decoded(mails.at(-1)!.raw))![1]!;
  const info = await portal<InvitationInfo>('GET', `/v1/cloud/invitations/token/${token}`);
  expect(info.body).toMatchObject({ email, role, accepted: false });
  const user = await login(email);
  const accepted = await portal<Me>('POST', `/v1/cloud/invitations/token/${token}/accept`, { cookie: user.cookie, body: {} });
  expect(accepted.status).toBe(200);
  return { cookie: user.cookie, me: accepted.body };
}

/** ELVIS-Installation: Bearer-Token und signierte Aufrufe mit dem Schlüssel der Cloud-Verknüpfung */
async function installation() {
  const reg = (await (await handle(new Request('https://relay.test/v1/elws', { method: 'POST' }), env, now)).json()) as ElwRegistration;
  const key = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const sigPublicKey = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey)));
  async function call<T = unknown>(method: string, path: string, body?: unknown, sign = true) {
    const raw = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const headers: Record<string, string> = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json', 'x-elvis-version': '1.4.0' };
    if (sign) {
      const t = now.getTime();
      const n = base64url(crypto.getRandomValues(new Uint8Array(16)));
      const s = base64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, new TextEncoder().encode(mailSignaturePayload(method, path, await sha256Hex(raw), t, n)))));
      headers[MAIL_SIGNATURE_HEADER] = `t=${t},n=${n},s=${s}`;
    }
    const res = await handle(new Request(`https://relay.test${path}`, { method, headers, body: raw.byteLength ? (raw as BodyInit) : undefined }), env, now);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }
  return { elwId: reg.elwId, sigPublicKey, call };
}

describe('Anmeldung', () => {
  it('legt beim ersten Code das Konto an und hält die Sitzung im Cookie', async () => {
    const { cookie, me } = await login('Anna@Example.org', 'Anna Admin');
    expect(me).toMatchObject({ email: 'anna@example.org', name: 'Anna Admin', operator: false, memberships: [] });
    expect((await portal('GET', '/v1/cloud/me')).status).toBe(401);
    expect((await portal<Me>('GET', '/v1/cloud/me', { cookie })).body.email).toBe('anna@example.org');
    // Zweites Anmelden: gleiches Konto
    expect((await login('anna@example.org')).me.id).toBe(me.id);
    expect((await portal('POST', '/v1/cloud/logout', { cookie, body: {} })).status).toBe(204);
    expect((await portal('GET', '/v1/cloud/me', { cookie })).status).toBe(401);
  });

  it('begrenzt Fehlversuche und Codes je Stunde', async () => {
    await portal('POST', '/v1/cloud/login', { body: { email: 'x@example.org' } });
    for (let i = 0; i < 5; i++) expect((await portal('POST', '/v1/cloud/login/verify', { body: { email: 'x@example.org', code: '000000' } })).status).toBeGreaterThanOrEqual(401);
    expect((await portal('POST', '/v1/cloud/login/verify', { body: { email: 'x@example.org', code: '000000' } })).status).toBe(429);
    for (let i = 0; i < 4; i++) await portal('POST', '/v1/cloud/login', { body: { email: 'x@example.org' } });
    expect((await portal('POST', '/v1/cloud/login', { body: { email: 'x@example.org' } })).status).toBe(429);
  });

  it('lehnt fremde Origin und Formulare ab', async () => {
    const { cookie } = await login('a@example.org');
    expect((await portal('POST', '/v1/cloud/nodes', { cookie, origin: 'https://evil.example', body: { parentId: WEYHE, name: 'x' } })).status).toBe(403);
    const form = await handle(new Request(`${ORIGIN}/v1/cloud/nodes`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' }), env, now);
    expect(form.status).toBe(415);
  });
});

describe('Baustruktur und Rechte', () => {
  it('Betreiber setzt den Kreis-Admin ein, der Rechte nach unten vergibt', async () => {
    const op = await operator();
    const kreis = await invite(op.cookie, KREIS, 'kbm@lk-diepholz.de', 'admin');
    expect(kreis.me.memberships).toEqual([{ node: { id: KREIS, name: 'Landkreis Diepholz', path: ['Niedersachsen', 'Landkreis Diepholz'] }, role: 'admin' }]);

    // Kreis-Admin ist auch in Weyhe Admin (Knoten entsteht bei Bedarf) und lädt den Gemeindeverwalter ein
    const weyhe = await portal<NodeDetail>('GET', `/v1/cloud/nodes/${encodeURIComponent(WEYHE)}`, { cookie: kreis.cookie });
    expect(weyhe.body).toMatchObject({ name: 'Weyhe', kind: 'gemeinde', role: 'admin', path: ['Niedersachsen', 'Landkreis Diepholz', 'Weyhe'] });
    const gemeinde = await invite(kreis.cookie, WEYHE, 'wehrfuehrer@weyhe.de', 'admin');

    // Gemeinde-Admin legt eine Ortsfeuerwehr an, sieht den Kreis aber nicht
    const of = await portal<NodeDetail>('POST', '/v1/cloud/nodes', { cookie: gemeinde.cookie, body: { parentId: WEYHE, name: 'OF Leeste' } });
    expect(of.status).toBe(201);
    expect(of.body).toMatchObject({ kind: 'free', path: ['Niedersachsen', 'Landkreis Diepholz', 'Weyhe', 'OF Leeste'] });
    expect((await portal('GET', `/v1/cloud/nodes/${encodeURIComponent(KREIS)}`, { cookie: gemeinde.cookie })).status).toBe(403);
    expect((await portal('POST', '/v1/cloud/nodes', { cookie: gemeinde.cookie, body: { parentId: KREIS, name: 'Kreisfeuerwehr' } })).status).toBe(403);

    // Mitglieder in OF Leeste: geerbt von Weyhe und Kreis
    const members = await portal<NodeDetail>('GET', `/v1/cloud/nodes/${of.body.id}`, { cookie: gemeinde.cookie });
    expect(members.body.members.map((m) => [m.email, m.role, m.inherited, m.nodeName])).toEqual([
      ['kbm@lk-diepholz.de', 'admin', true, 'Landkreis Diepholz'],
      ['wehrfuehrer@weyhe.de', 'admin', true, 'Weyhe'],
    ]);
    // Weyhe-Kinder: freie Knoten zuerst
    expect(weyhe.body.children).toEqual([]);
    expect((await portal<NodeDetail>('GET', `/v1/cloud/nodes/${encodeURIComponent(WEYHE)}`, { cookie: kreis.cookie })).body.children[0]).toMatchObject({ name: 'OF Leeste', kind: 'free' });

    // Leser darf nichts anlegen; eigene Rolle nicht änderbar
    const leser = await invite(gemeinde.cookie, of.body.id, 'leser@weyhe.de', 'viewer');
    expect((await portal('POST', '/v1/cloud/nodes', { cookie: leser.cookie, body: { parentId: of.body.id, name: 'Zug 1' } })).status).toBe(403);
    expect((await portal('PUT', `/v1/cloud/nodes/${of.body.id}/members/${gemeinde.me.id}`, { cookie: gemeinde.cookie, body: { role: 'viewer' } })).status).toBe(400);
    expect((await portal('PUT', `/v1/cloud/nodes/${of.body.id}/members/${leser.me.id}`, { cookie: gemeinde.cookie, body: { role: 'editor' } })).status).toBe(200);
  });

  it('nimmt Einladungen nur mit der eingeladenen Adresse an', async () => {
    const op = await operator();
    await portal('POST', '/v1/cloud/invitations', { cookie: op.cookie, body: { nodeId: KREIS, email: 'kbm@lk-diepholz.de', role: 'admin' } });
    const token = /\/einladung\/([A-Za-z0-9_-]{43})/.exec(decoded(mails.at(-1)!.raw))![1]!;
    const other = await login('fremd@example.org');
    expect((await portal('POST', `/v1/cloud/invitations/token/${token}/accept`, { cookie: other.cookie, body: {} })).status).toBe(403);
    // Gebietskörperschaften lassen sich nicht umbenennen oder löschen
    expect((await portal('DELETE', `/v1/cloud/nodes/${encodeURIComponent(KREIS)}`, { cookie: op.cookie })).status).toBe(400);
  });
});

describe('Installationen', () => {
  it('verknüpft per Code, zeigt den Status der Cloud-Module und lässt sich trennen', async () => {
    const op = await operator();
    const kreis = await invite(op.cookie, KREIS, 'kbm@lk-diepholz.de', 'admin');
    const elw = await installation();

    expect((await elw.call<CloudLinkStatus>('GET', '/v1/elws/me/cloud')).body).toEqual({ state: 'none' });
    // Anfrage muss mit dem mitgeschickten Schlüssel signiert sein
    expect((await elw.call('POST', '/v1/elws/me/cloud/link', { name: 'ELW 1 Weyhe', sigPublicKey: elw.sigPublicKey }, false)).status).toBe(401);
    const pending = await elw.call<CloudLinkStatus & { code: string }>('POST', '/v1/elws/me/cloud/link', { name: 'ELW 1 Weyhe', sigPublicKey: elw.sigPublicKey, version: '1.4.0' });
    expect(pending.status).toBe(201);
    expect(pending.body.code).toMatch(/^[A-Z2-9]{8}$/);

    // Ein Leser darf nicht verknüpfen, falsche Codes zählen
    const leser = await invite(kreis.cookie, KREIS, 'leser@lk-diepholz.de', 'viewer');
    expect((await portal('POST', '/v1/cloud/installations', { cookie: leser.cookie, body: { code: pending.body.code, nodeId: WEYHE } })).status).toBe(403);
    expect((await portal('POST', '/v1/cloud/installations', { cookie: kreis.cookie, body: { code: 'AAAA-AAAA', nodeId: WEYHE } })).status).toBe(404);

    // Mails warten im Postfach (Status kommt aus den Tabellen der Dienste)
    await env.DB.prepare("INSERT INTO mailboxes (localpart, elw_id, admin_email, public_key, fingerprint, wkd_hash, sig_public_key, status, created_at, last_fetch_at, last_fetch_country) VALUES ('elw1.weyhe', ?, 'a@b.de', 'k', 'f', 'w', 's', 'active', ?, ?, 'DE')")
      .bind(elw.elwId, now.toISOString(), now.toISOString())
      .run();
    for (const size of [1200, 3400]) await env.DB.prepare("INSERT INTO mail_inbox (localpart, r2_key, size, received_at) VALUES ('elw1.weyhe', 'x', ?, ?)").bind(size, now.toISOString()).run();

    const code = `${pending.body.code.slice(0, 4)}-${pending.body.code.slice(4).toLowerCase()}`;
    const linked = await portal<InstallationStatus>('POST', '/v1/cloud/installations', { cookie: kreis.cookie, body: { code, nodeId: WEYHE } });
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({
      name: 'ELW 1 Weyhe',
      version: '1.4.0',
      node: { id: WEYHE, path: ['Niedersachsen', 'Landkreis Diepholz', 'Weyhe'] },
      linkedBy: 'kbm@lk-diepholz.de',
      mail: { address: 'elw1.weyhe@einsatzleitwagen.app', state: 'active', waiting: 2, waitingBytes: 4600, lastFetchCountry: 'DE' },
      messaging: null,
      app: { pairedDevices: 0, pendingPositions: 0, openForms: 0, pendingSheets: 0 },
      backup: null,
    });

    // ELVIS sieht die Verknüpfung; der Code ist verbraucht
    expect((await elw.call<CloudLinkStatus>('GET', '/v1/elws/me/cloud')).body).toMatchObject({ state: 'linked', node: { id: WEYHE, name: 'Weyhe' }, linkedBy: 'kbm@lk-diepholz.de' });
    expect((await elw.call('GET', '/v1/elws/me/cloud', undefined, false)).status).toBe(401);
    expect((await portal('POST', '/v1/cloud/installations', { cookie: kreis.cookie, body: { code: pending.body.code, nodeId: WEYHE } })).status).toBe(404);

    // Leser sieht den Status, die Gemeinde ohne Rolle nicht
    expect((await portal<InstallationStatus[]>('GET', '/v1/cloud/installations', { cookie: leser.cookie })).body).toHaveLength(1);
    const fremd = await login('fremd@example.org');
    expect((await portal<InstallationStatus[]>('GET', '/v1/cloud/installations', { cookie: fremd.cookie })).body).toHaveLength(0);
    expect((await portal('GET', `/v1/cloud/installations/${elw.elwId}`, { cookie: fremd.cookie })).status).toBe(403);

    // Trennen aus ELVIS
    expect((await elw.call('DELETE', '/v1/elws/me/cloud')).status).toBe(204);
    expect((await elw.call<CloudLinkStatus>('GET', '/v1/elws/me/cloud')).body).toEqual({ state: 'none' });
  });

  it('Codes laufen ab', async () => {
    const elw = await installation();
    await elw.call('POST', '/v1/elws/me/cloud/link', { name: 'ELW', sigPublicKey: elw.sigPublicKey });
    now = new Date(now.getTime() + 2 * 3600_000);
    expect((await elw.call<CloudLinkStatus>('GET', '/v1/elws/me/cloud')).body).toEqual({ state: 'none' });
    await cleanup(env, now);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM link_requests').first()).toEqual({ n: 0 });
  });
});
