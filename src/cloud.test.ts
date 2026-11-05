import { beforeEach, describe, expect, it } from 'vitest';
import type { CloudLinkStatus, InstallationStatus, InvitationInfo, Me, NodeDetail } from './cloudprotocol.js';
import { base64url, sha256Hex } from './http.js';
import { MAIL_SIGNATURE_HEADER, mailSignaturePayload } from './mailprotocol.js';
import type { ElwRegistration } from './protocol.js';
import { cleanup, handle, type Env } from './relay.js';
import { fakeD1, fakeR2 } from './testing.js';
import type { FireboardLibrary } from './fireboardprotocol.js';
import { FIREBOARD_TREE } from './fireboard.test.js';

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
  env = { DB: fakeD1(), LIBRARY: fakeR2(), MAIL_DOMAIN: 'einsatzleitwagen.app', CLOUD_URL: ORIGIN, SEND: async (_from, to, raw) => void mails.push({ to, raw }) };
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

const PASSWORD = 'lange-geheime-Phrase';
/** Link aus der letzten Mail an die Adresse, z. B. /bestaetigen/<token> */
const linkIn = (to: string, path: string) => new RegExp(`/${path}/([A-Za-z0-9_-]{43})`).exec(decoded(mails.filter((m) => m.to === to).at(-1)!.raw))![1]!;

/** Konto anlegen (registrieren, Link aus der Mail bestätigen) bzw. mit Passwort anmelden */
async function login(email: string, name = 'Test') {
  const lower = email.toLowerCase();
  const known = await env.DB.prepare('SELECT 1 FROM accounts WHERE email = ?').bind(lower).first();
  if (!known) {
    expect((await portal('POST', '/v1/cloud/register', { body: { email, name, password: PASSWORD } })).status).toBe(202);
    const res = await portal<Me>('POST', '/v1/cloud/verify', { body: { token: linkIn(lower, 'bestaetigen') } });
    expect(res.status).toBe(200);
    return { cookie: res.cookie!.split(';')[0]!, me: res.body };
  }
  const res = await portal<Me>('POST', '/v1/cloud/login', { body: { email, password: PASSWORD } });
  expect(res.status).toBe(200);
  return { cookie: res.cookie!.split(';')[0]!, me: res.body };
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
    const raw = body instanceof Uint8Array ? body : body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const headers: Record<string, string> = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json', 'x-elvis-version': '1.4.0' };
    if (sign) {
      const t = now.getTime();
      const n = base64url(crypto.getRandomValues(new Uint8Array(16)));
      const s = base64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, new TextEncoder().encode(mailSignaturePayload(method, path, await sha256Hex(raw), t, n)))));
      headers[MAIL_SIGNATURE_HEADER] = `t=${t},n=${n},s=${s}`;
    }
    const res = await handle(new Request(`https://relay.test${path}`, { method, headers, body: raw.byteLength ? (raw as BodyInit) : undefined }), env, now);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* Dateiinhalt */
    }
    return { status: res.status, body: parsed as T };
  }
  return { elwId: reg.elwId, sigPublicKey, call };
}

describe('Konto und Anmeldung', () => {
  it('Registrieren, Adresse bestätigen, mit Passwort anmelden, abmelden', async () => {
    const reg = await portal('POST', '/v1/cloud/register', { body: { email: 'Anna@Example.org', name: 'Anna Admin', password: PASSWORD } });
    expect(reg.status).toBe(202);
    expect(reg.cookie).toBeNull();
    // Vor der Bestätigung keine Anmeldung
    expect((await portal('POST', '/v1/cloud/login', { body: { email: 'anna@example.org', password: PASSWORD } })).status).toBe(403);
    const verified = await portal<Me>('POST', '/v1/cloud/verify', { body: { token: linkIn('anna@example.org', 'bestaetigen') } });
    expect(verified.body).toMatchObject({ email: 'anna@example.org', name: 'Anna Admin', operator: false, memberships: [] });
    const cookie = verified.cookie!.split(';')[0]!;
    expect((await portal<Me>('GET', '/v1/cloud/me', { cookie })).body.email).toBe('anna@example.org');
    expect((await portal('GET', '/v1/cloud/me')).status).toBe(401);
    expect(await env.DB.prepare('SELECT password_hash FROM accounts').first()).toEqual({ password_hash: expect.stringMatching(/^pbkdf2-sha256\$100000\$/) });
    // Link gilt nur einmal
    expect((await portal('POST', '/v1/cloud/verify', { body: { token: linkIn('anna@example.org', 'bestaetigen') } })).status).toBe(410);

    expect((await portal('POST', '/v1/cloud/login', { body: { email: 'anna@example.org', password: 'falsch-falsch' } })).status).toBe(401);
    const again = await portal<Me>('POST', '/v1/cloud/login', { body: { email: 'ANNA@example.org', password: PASSWORD } });
    expect(again.body.id).toBe(verified.body.id);
    expect((await portal('POST', '/v1/cloud/logout', { cookie, body: {} })).status).toBe(204);
    expect((await portal('GET', '/v1/cloud/me', { cookie })).status).toBe(401);
  });

  it('verrät nicht, ob es eine Adresse schon gibt; Passwortregeln', async () => {
    await login('anna@example.org');
    const dup = await portal('POST', '/v1/cloud/register', { body: { email: 'anna@example.org', name: 'X', password: 'anderes-Passwort' } });
    expect(dup.status).toBe(202);
    expect(decoded(mails.at(-1)!.raw)).toContain('gibt es schon ein Konto');
    expect((await portal('POST', '/v1/cloud/login', { body: { email: 'anna@example.org', password: 'anderes-Passwort' } })).status).toBe(401);
    expect((await portal('POST', '/v1/cloud/login', { body: { email: 'niemand@example.org', password: PASSWORD } })).body).toEqual({ error: 'E-Mail-Adresse oder Passwort falsch' });
    expect((await portal<{ error: string }>('POST', '/v1/cloud/register', { body: { email: 'b@example.org', name: 'B', password: 'kurz' } })).body.error).toMatch(/mindestens 10/);
    expect((await portal('POST', '/v1/cloud/register', { body: { email: 'b@example.org', name: 'B', password: 'b@example.org' } })).status).toBe(400);
    // Neuer Bestätigungslink auf Anfrage
    await portal('POST', '/v1/cloud/register', { body: { email: 'c@example.org', name: 'C', password: PASSWORD } });
    const first = linkIn('c@example.org', 'bestaetigen');
    expect((await portal('POST', '/v1/cloud/verify/resend', { body: { email: 'c@example.org' } })).status).toBe(202);
    expect((await portal('POST', '/v1/cloud/verify', { body: { token: first } })).status).toBe(410);
    expect((await portal('POST', '/v1/cloud/verify', { body: { token: linkIn('c@example.org', 'bestaetigen') } })).status).toBe(200);
  });

  it('sperrt nach fünf falschen Passwörtern für 15 Minuten', async () => {
    await login('anna@example.org');
    for (let i = 0; i < 5; i++) expect((await portal('POST', '/v1/cloud/login', { body: { email: 'anna@example.org', password: 'falsch-falsch' } })).status).toBe(401);
    expect((await portal('POST', '/v1/cloud/login', { body: { email: 'anna@example.org', password: PASSWORD } })).status).toBe(429);
    now = new Date(now.getTime() + 16 * 60_000);
    expect((await portal('POST', '/v1/cloud/login', { body: { email: 'anna@example.org', password: PASSWORD } })).status).toBe(200);
  });

  it('Passwort vergessen: Link per Mail, neues Passwort, überall abgemeldet; bisherige Konten ohne Passwort', async () => {
    const a = await login('anna@example.org');
    expect((await portal('POST', '/v1/cloud/password/forgot', { body: { email: 'niemand@example.org' } })).status).toBe(202);
    const before = mails.length;
    expect((await portal('POST', '/v1/cloud/password/forgot', { body: { email: 'anna@example.org' } })).status).toBe(202);
    expect(mails.length).toBe(before + 1);
    const token = linkIn('anna@example.org', 'passwort-zuruecksetzen');
    expect((await portal('POST', '/v1/cloud/password/reset', { body: { token, password: 'kurz' } })).status).toBe(400);
    const reset = await portal<Me>('POST', '/v1/cloud/password/reset', { body: { token, password: 'ganz-neues-Passwort' } });
    expect(reset.status).toBe(200);
    expect((await portal('GET', '/v1/cloud/me', { cookie: a.cookie })).status).toBe(401);
    expect((await portal('POST', '/v1/cloud/password/reset', { body: { token, password: 'noch-ein-Passwort' } })).status).toBe(410);
    expect((await portal('POST', '/v1/cloud/login', { body: { email: 'anna@example.org', password: 'ganz-neues-Passwort' } })).status).toBe(200);
    // Link verfällt nach einer Stunde
    await portal('POST', '/v1/cloud/password/forgot', { body: { email: 'anna@example.org' } });
    const late = linkIn('anna@example.org', 'passwort-zuruecksetzen');
    now = new Date(now.getTime() + 61 * 60_000);
    expect((await portal('POST', '/v1/cloud/password/reset', { body: { token: late, password: 'zu-spaet-Passwort' } })).status).toBe(410);

    // Konto aus der Zeit der Anmeldecodes: kein Passwort, setzt es über „Passwort vergessen“
    await env.DB.prepare("INSERT INTO accounts (id, email, name, created_at, email_verified_at) VALUES ('alt', 'alt@example.org', 'Alt', 'x', 'x')").run();
    expect((await portal('POST', '/v1/cloud/login', { body: { email: 'alt@example.org', password: PASSWORD } })).status).toBe(401);
    await portal('POST', '/v1/cloud/password/forgot', { body: { email: 'alt@example.org' } });
    expect((await portal<Me>('POST', '/v1/cloud/password/reset', { body: { token: linkIn('alt@example.org', 'passwort-zuruecksetzen'), password: PASSWORD } })).body.id).toBe('alt');
  });

  it('Passwort und E-Mail-Adresse ändern, andere Sitzungen beenden, Konto löschen', async () => {
    const a = await login('anna@example.org');
    const b = await login('anna@example.org');
    expect((await portal('POST', '/v1/cloud/password', { cookie: a.cookie, body: { current: 'falsch', password: 'neues-Passwort-1' } })).status).toBe(403);
    expect((await portal('POST', '/v1/cloud/password', { cookie: a.cookie, body: { current: PASSWORD, password: 'neues-Passwort-1' } })).status).toBe(200);
    expect((await portal('GET', '/v1/cloud/me', { cookie: a.cookie })).status).toBe(200);
    expect((await portal('GET', '/v1/cloud/me', { cookie: b.cookie })).status).toBe(401);
    expect(decoded(mails.at(-1)!.raw)).toContain('Passwort Ihres Kontos bei ELVIS Cloud wurde geändert');

    // Neue Adresse: erst nach Bestätigung, Hinweis an die alte
    expect((await portal('POST', '/v1/cloud/email', { cookie: a.cookie, body: { email: 'anna@neu.example', password: 'falsch' } })).status).toBe(403);
    expect((await portal('POST', '/v1/cloud/email', { cookie: a.cookie, body: { email: 'anna@neu.example', password: 'neues-Passwort-1' } })).status).toBe(202);
    expect((await portal<Me>('GET', '/v1/cloud/me', { cookie: a.cookie })).body.email).toBe('anna@example.org');
    expect((await portal<{ email: string }>('POST', '/v1/cloud/email/confirm', { body: { token: linkIn('anna@neu.example', 'email-bestaetigen') } })).body.email).toBe('anna@neu.example');
    expect((await portal<Me>('GET', '/v1/cloud/me', { cookie: a.cookie })).body.email).toBe('anna@neu.example');
    expect(mails.at(-1)!.to).toBe('anna@example.org');

    const cRes = await portal('POST', '/v1/cloud/login', { body: { email: 'anna@neu.example', password: 'neues-Passwort-1' } });
    const c = { cookie: cRes.cookie!.split(';')[0]! };
    expect((await portal<{ ended: number }>('POST', '/v1/cloud/logout/others', { cookie: c.cookie, body: {} })).body.ended).toBe(1);
    expect((await portal('GET', '/v1/cloud/me', { cookie: a.cookie })).status).toBe(401);

    expect((await portal('DELETE', '/v1/cloud/me', { cookie: c.cookie, body: { password: 'falsch' } })).status).toBe(403);
    expect((await portal('DELETE', '/v1/cloud/me', { cookie: c.cookie, body: { password: 'neues-Passwort-1' } })).status).toBe(204);
    expect((await portal('POST', '/v1/cloud/login', { body: { email: 'anna@neu.example', password: 'neues-Passwort-1' } })).status).toBe(401);
  });

  it('einziger Admin eines Bereichs kann sein Konto nicht löschen', async () => {
    const op = await operator();
    const kreis = await invite(op.cookie, KREIS, 'kbm@lk-diepholz.de', 'admin');
    const r = await portal<{ error: string }>('DELETE', '/v1/cloud/me', { cookie: kreis.cookie, body: { password: PASSWORD } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/allein/);
  });

  it('mit Einladung registriert: Adresse gilt sofort als bestätigt', async () => {
    const op = await operator();
    expect((await portal('POST', '/v1/cloud/invitations', { cookie: op.cookie, body: { nodeId: KREIS, email: 'neu@lk-diepholz.de', role: 'editor' } })).status).toBe(201);
    const token = linkIn('neu@lk-diepholz.de', 'einladung');
    const reg = await portal<Me>('POST', '/v1/cloud/register', { body: { email: 'neu@lk-diepholz.de', name: 'Neu', password: PASSWORD, invitation: token } });
    expect(reg.status).toBe(200);
    const accepted = await portal<Me>('POST', `/v1/cloud/invitations/token/${token}/accept`, { cookie: reg.cookie!.split(';')[0]!, body: {} });
    expect(accepted.body.memberships).toHaveLength(1);
    // Mit fremder Adresse hilft die Einladung nicht
    expect((await portal('POST', '/v1/cloud/register', { body: { email: 'anders@example.org', name: 'A', password: PASSWORD, invitation: token } })).status).toBe(202);
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

describe('Stammdaten', () => {
  /** Kreis- und Weyhe-Verwalter, je eine verknüpfte Installation (Kreis-ELW, ELW Weyhe) */
  async function setup() {
    const op = await operator();
    const kreis = await invite(op.cookie, KREIS, 'kbm@lk-diepholz.de', 'admin');
    const weyhe = await invite(kreis.cookie, WEYHE, 'wf@weyhe.de', 'editor');
    const link = async (nodeId: string, name: string) => {
      const elw = await installation();
      const p = await elw.call<{ code: string }>('POST', '/v1/elws/me/cloud/link', { name, sigPublicKey: elw.sigPublicKey });
      expect((await portal('POST', '/v1/cloud/installations', { cookie: kreis.cookie, body: { code: p.body.code, nodeId } })).status).toBe(201);
      return elw;
    };
    return { kreis, weyhe, elwKreis: await link(KREIS, 'ELW Kreis'), elwWeyhe: await link(WEYHE, 'ELW 1 Weyhe') };
  }
  type Pull = { items: { uid: string; kind: string; nodeId: string; nodeName: string; rev: number; deleted: boolean; data: Record<string, unknown> | null }[]; next: number; more: boolean; nodeId: string };
  type Result = { results: { uid: string; status: string; record: { rev: number; nodeId: string } | null; reason?: string }[] };

  it('Kreis-Fahrzeuge sehen alle, Weyhe-Fahrzeuge auch der Kreis; Rollen nur nach unten', async () => {
    const { kreis, weyhe, elwKreis, elwWeyhe } = await setup();
    const elw = await portal<{ uid: string; rev: number }>('POST', '/v1/cloud/records', { cookie: kreis.cookie, body: { kind: 'force', nodeId: KREIS, data: { name: 'ELW 2 Kreis', callsign: 'Florian Diepholz 11-2' } } });
    expect(elw.status).toBe(201);
    // Pflegen in Weyhe, aber nicht am Kreis
    expect((await portal('POST', '/v1/cloud/records', { cookie: weyhe.cookie, body: { kind: 'force', nodeId: KREIS, data: { name: 'x' } } })).status).toBe(403);
    expect((await portal('POST', '/v1/cloud/records', { cookie: weyhe.cookie, body: { kind: 'role', nodeId: WEYHE, data: { name: 'Fernmelder Weyhe' } } })).status).toBe(201);
    expect((await portal('POST', '/v1/cloud/records', { cookie: kreis.cookie, body: { kind: 'role', nodeId: KREIS, data: { name: 'Einsatzleiter' } } })).status).toBe(201);
    expect((await portal('POST', '/v1/cloud/records', { cookie: kreis.cookie, body: { kind: 'keyword', nodeId: KREIS, data: { name: '' } } })).status).toBe(400);

    // ELW Weyhe legt ein eigenes Fahrzeug an
    const lf = crypto.randomUUID();
    const push = await elwWeyhe.call<Result>('POST', '/v1/elws/me/cloud/sync', { changes: [{ uid: lf, kind: 'force', baseRev: 0, data: { name: 'HLF 20 Leeste', members: [] } }] });
    expect(push.body.results[0]).toMatchObject({ status: 'ok', record: { rev: 1, nodeId: WEYHE } });

    const weyhePull = await elwWeyhe.call<Pull>('GET', '/v1/elws/me/cloud/sync?after=0');
    expect(weyhePull.body.nodeId).toBe(WEYHE);
    expect(weyhePull.body.items.filter((i) => i.kind !== 'objectType').map((i) => [i.kind, i.data?.name, i.nodeName])).toEqual([
      ['force', 'ELW 2 Kreis', 'Landkreis Diepholz'],
      ['role', 'Fernmelder Weyhe', 'Weyhe'],
      ['role', 'Einsatzleiter', 'Landkreis Diepholz'],
      ['force', 'HLF 20 Leeste', 'Weyhe'],
    ]);
    const kreisPull = await elwKreis.call<Pull>('GET', '/v1/elws/me/cloud/sync?after=0');
    expect(kreisPull.body.items.filter((i) => i.kind !== 'objectType').map((i) => i.data?.name)).toEqual(['ELW 2 Kreis', 'Einsatzleiter', 'HLF 20 Leeste']);

    // Cursor: nur Neues
    expect((await elwWeyhe.call<Pull>('GET', `/v1/elws/me/cloud/sync?after=${weyhePull.body.next}`)).body.items).toEqual([]);

    // Weyhe darf das Kreis-Fahrzeug nicht ändern, der Kreis-ELW das Weyhe-Fahrzeug nicht
    const foreign = await elwWeyhe.call<Result>('POST', '/v1/elws/me/cloud/sync', { changes: [{ uid: elw.body.uid, kind: 'force', baseRev: 1, data: { name: 'umbenannt' } }] });
    expect(foreign.body.results[0]).toMatchObject({ status: 'conflict', record: { nodeId: KREIS } });
    expect((await elwKreis.call<Result>('POST', '/v1/elws/me/cloud/sync', { changes: [{ uid: lf, kind: 'force', baseRev: 1, deleted: true }] })).body.results[0]!.status).toBe('conflict');
  });

  it('erkennt Konflikte und verteilt Löschungen als Tombstone', async () => {
    const { weyhe, elwWeyhe } = await setup();
    const uid = crypto.randomUUID();
    await elwWeyhe.call('POST', '/v1/elws/me/cloud/sync', { changes: [{ uid, kind: 'keyword', baseRev: 0, data: { name: 'TH 1', sort: 0 } }] });
    // Portal ändert, ELVIS schickt dann eine veraltete Änderung
    expect((await portal('PUT', `/v1/cloud/records/${uid}`, { cookie: weyhe.cookie, body: { baseRev: 1, data: { name: 'TH Klein', sort: 0 } } })).status).toBe(200);
    const stale = await elwWeyhe.call<Result>('POST', '/v1/elws/me/cloud/sync', { changes: [{ uid, kind: 'keyword', baseRev: 1, data: { name: 'TH 1 neu' } }] });
    expect(stale.body.results[0]).toMatchObject({ status: 'conflict', record: { rev: 2 } });
    expect((await portal('PUT', `/v1/cloud/records/${uid}`, { cookie: weyhe.cookie, body: { baseRev: 1, data: { name: 'x' } } })).status).toBe(409);

    const before = (await elwWeyhe.call<Pull>('GET', '/v1/elws/me/cloud/sync?after=0')).body.next;
    expect((await portal('DELETE', `/v1/cloud/records/${uid}?rev=2`, { cookie: weyhe.cookie })).status).toBe(204);
    const after = await elwWeyhe.call<Pull>('GET', `/v1/elws/me/cloud/sync?after=${before}`);
    expect(after.body.items).toMatchObject([{ uid, deleted: true, data: null, rev: 3 }]);

    // Portalliste: sichtbar mit Bearbeitungsrecht und Lage
    await portal('POST', '/v1/cloud/records', { cookie: weyhe.cookie, body: { kind: 'keyword', nodeId: WEYHE, data: { name: 'B 2' } } });
    const list = await portal<{ data: { name: string }; editable: boolean; position: string }[]>('GET', `/v1/cloud/nodes/${encodeURIComponent(KREIS)}/records?kind=keyword`, { cookie: weyhe.cookie });
    expect(list.status).toBe(403);
    const here = await portal<{ data: { name: string }; editable: boolean; position: string }[]>('GET', `/v1/cloud/nodes/${encodeURIComponent(WEYHE)}/records?kind=keyword`, { cookie: weyhe.cookie });
    expect(here.body.map((r) => [r.data.name, r.editable, r.position])).toEqual([['B 2', true, 'here']]);
  });

  it('Abruf nur verknüpft und signiert', async () => {
    const elw = await installation();
    expect((await elw.call('GET', '/v1/elws/me/cloud/sync?after=0')).status).toBe(409);
  });
});

describe('Objektbibliothek in der Cloud', () => {
  const WATER = '00000000-0000-4000-8000-000000000001';
  type Pull = { items: { uid: string; kind: string; deleted: boolean; data: Record<string, unknown> | null }[]; next: number };
  type Result = { results: { uid: string; status: string; reason?: string }[] };

  async function setup() {
    const op = await operator();
    const kreis = await invite(op.cookie, KREIS, 'kbm@lk-diepholz.de', 'admin');
    const link = async (nodeId: string, name: string) => {
      const elw = await installation();
      const p = await elw.call<{ code: string }>('POST', '/v1/elws/me/cloud/link', { name, sigPublicKey: elw.sigPublicKey });
      await portal('POST', '/v1/cloud/installations', { cookie: kreis.cookie, body: { code: p.body.code, nodeId } });
      return elw;
    };
    return { op, kreis, elwKreis: await link(KREIS, 'ELW Kreis'), elwWeyhe: await link(WEYHE, 'ELW Weyhe') };
  }
  const names = async (elw: Awaited<ReturnType<typeof installation>>, kind: string) =>
    (await elw.call<Pull>('GET', '/v1/elws/me/cloud/sync?after=0')).body.items.filter((i) => i.kind === kind && !i.deleted).map((i) => i.data!.name);

  it('vordefinierte Typen für alle, Sichtbarkeit je Typ', async () => {
    const { op, kreis, elwKreis, elwWeyhe } = await setup();
    expect(await names(elwWeyhe, 'objectType')).toEqual(['Wasserentnahmestelle', 'Einsatzobjekt']);
    // Nur Betreiber pflegen die vordefinierten
    expect((await portal('PUT', `/v1/cloud/records/${WATER}`, { cookie: kreis.cookie, body: { baseRev: 1, data: { name: 'x', icon: 'Droplet', color: '#000000' } } })).status).toBe(409);

    // Kreis-Hydrant: in Weyhe sichtbar (both)
    expect((await portal('POST', '/v1/cloud/records', { cookie: kreis.cookie, body: { kind: 'object', nodeId: KREIS, data: { typeUid: WATER, name: 'H Kreisstraße', lat: 52.9, lon: 8.8, props: { dn: 100 } } } })).status).toBe(201);
    // Weyhe-eigener Typ „Sammelplatz“, nur für Weyhe
    const t = await elwWeyhe.call<Result>('POST', '/v1/elws/me/cloud/sync', { changes: [{ uid: crypto.randomUUID(), kind: 'objectType', baseRev: 0, data: { name: 'Sammelplatz', icon: 'Users', color: '#16a34a', visibility: 'own' } }] });
    const typeUid = t.body.results[0]!.uid;
    const obj = crypto.randomUUID();
    expect((await elwWeyhe.call<Result>('POST', '/v1/elws/me/cloud/sync', { changes: [{ uid: obj, kind: 'object', baseRev: 0, data: { typeUid, name: 'Turnhalle Leeste', lat: 52.95, lon: 8.85 } }] })).body.results[0]!.status).toBe('ok');
    expect(await names(elwWeyhe, 'object')).toEqual(['H Kreisstraße', 'Turnhalle Leeste']);
    expect(await names(elwKreis, 'object')).toEqual(['H Kreisstraße']);

    // Sichtbarkeit nach oben: jetzt sieht der Kreis die Turnhalle
    const rec = (await portal<{ rev: number; data: Record<string, unknown> }[]>('GET', `/v1/cloud/nodes/${encodeURIComponent(WEYHE)}/records?kind=objectType`, { cookie: kreis.cookie })).body.find((r) => r.data.name === 'Sammelplatz')!;
    expect((await portal('PUT', `/v1/cloud/records/${typeUid}`, { cookie: kreis.cookie, body: { baseRev: rec.rev, data: { ...rec.data, visibility: 'up' } } })).status).toBe(200);
    expect(await names(elwKreis, 'object')).toEqual(['H Kreisstraße', 'Turnhalle Leeste']);

    // Objekt mit unbekanntem Typ geht nicht
    expect((await elwWeyhe.call<Result>('POST', '/v1/elws/me/cloud/sync', { changes: [{ uid: crypto.randomUUID(), kind: 'object', baseRev: 0, data: { typeUid: crypto.randomUUID(), name: 'x', lat: 1, lon: 1 } }] })).body.results[0]!.status).toBe('invalid');
    void op;
  });

  it('Dateien: erst hochladen, dann der Datensatz; sichtbar wie das Objekt; mit dem Objekt gelöscht', async () => {
    const { kreis, elwKreis, elwWeyhe } = await setup();
    const obj = crypto.randomUUID();
    await elwWeyhe.call('POST', '/v1/elws/me/cloud/sync', { changes: [{ uid: obj, kind: 'object', baseRev: 0, data: { typeUid: '00000000-0000-4000-8000-000000000002', name: 'Klinikum', lat: 52.95, lon: 8.85 } }] });
    const fileUid = crypto.randomUUID();
    const bytes = new TextEncoder().encode('%PDF-1.4 Feuerwehrplan');
    const meta = (sha256: string) => ({ objectUid: obj, filename: 'Feuerwehrplan.pdf', mimeType: 'application/pdf', sizeBytes: bytes.byteLength, sha256 });
    // ohne Datei kein Datensatz
    expect((await elwWeyhe.call<Result>('POST', '/v1/elws/me/cloud/sync', { changes: [{ uid: fileUid, kind: 'objectFile', baseRev: 0, data: meta('0'.repeat(64)) }] })).body.results[0]!.status).toBe('invalid');
    const up = await elwWeyhe.call<{ sha256: string }>('PUT', `/v1/elws/me/cloud/files/${fileUid}`, bytes);
    expect(up.status).toBe(201);
    expect((await elwWeyhe.call<Result>('POST', '/v1/elws/me/cloud/sync', { changes: [{ uid: fileUid, kind: 'objectFile', baseRev: 0, data: meta(up.body.sha256) }] })).body.results[0]!.status).toBe('ok');

    // Kreis-ELW (Einsatzobjekte: both) holt die Datei, das Portal auch
    expect((await elwKreis.call<string>('GET', `/v1/elws/me/cloud/files/${fileUid}`)).body).toBe('%PDF-1.4 Feuerwehrplan');
    const res = await handle(new Request(`${ORIGIN}/v1/cloud/files/${fileUid}`, { headers: { cookie: kreis.cookie } }), env, now);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(await res.text()).toBe('%PDF-1.4 Feuerwehrplan');

    // Objekt löschen: Datei als Tombstone, Inhalt weg
    const before = (await elwKreis.call<Pull>('GET', '/v1/elws/me/cloud/sync?after=0')).body.next;
    await elwWeyhe.call('POST', '/v1/elws/me/cloud/sync', { changes: [{ uid: obj, kind: 'object', baseRev: 1, deleted: true }] });
    const after = (await elwKreis.call<Pull>('GET', `/v1/elws/me/cloud/sync?after=${before}`)).body.items;
    expect(after.map((i) => [i.kind, i.deleted])).toEqual([
      ['object', true],
      ['objectFile', true],
    ]);
    expect((await elwKreis.call('GET', `/v1/elws/me/cloud/files/${fileUid}`)).status).toBe(404);
  });

  it('Import vieler Objekte im Portal', async () => {
    const { kreis } = await setup();
    const items = [
      { typeUid: WATER, name: 'H 1', lat: 52.6, lon: 8.37, props: { dn: 100 } },
      { typeUid: WATER, name: '', lat: 52.6, lon: 8.37 },
      { typeUid: WATER, name: 'H 3', lat: 52.61, lon: 8.38 },
    ];
    const r = await portal<{ created: number; errors: { index: number }[] }>('POST', '/v1/cloud/records/batch', { cookie: kreis.cookie, body: { kind: 'object', nodeId: KREIS, items } });
    expect(r.body).toMatchObject({ created: 2, errors: [{ index: 1 }] });
  });

  it('Import aus Fireboard: nur mit Pflegerecht, Zugangsdaten gehen nur an Fireboard', async () => {
    const { kreis } = await setup();
    const weyhe = await invite(kreis.cookie, WEYHE, 'wf@weyhe.de', 'editor');
    const seen: string[] = [];
    env.FIREBOARD_FETCH = (async (url: string, init: RequestInit = {}) => {
      seen.push(`${init.method ?? 'GET'} ${url}`);
      const path = new URL(url).pathname;
      if (path === '/' && !init.method) return new Response('<input type="hidden" name="_csrf" value="t">');
      if (path === '/') return new URLSearchParams(String(init.body)).get('LoginForm[password]') === 'geheim' ? new Response(null, { status: 302, headers: { location: '/dashboard' } }) : new Response('Fehler');
      return Response.json(FIREBOARD_TREE);
    }) as typeof fetch;
    const body = { nodeId: KREIS, email: 'kbm@lk-diepholz.de', password: 'geheim' };
    // Weyhe pflegt nur den eigenen Bereich
    expect((await portal('POST', '/v1/cloud/import/fireboard', { cookie: weyhe.cookie, body })).status).toBe(403);
    expect(seen).toEqual([]);
    expect((await portal('POST', '/v1/cloud/import/fireboard', { cookie: kreis.cookie, body: { ...body, password: 'falsch' } })).status).toBe(400);
    const r = await portal<FireboardLibrary>('POST', '/v1/cloud/import/fireboard', { cookie: kreis.cookie, body });
    expect(r.status).toBe(200);
    expect(r.body.categories.find((c) => c.suggestion === 'water')).toBeTruthy();
    expect(r.body.items).toHaveLength(5);
    expect(seen.every((s) => s.includes('https://login.fireboard.net/'))).toBe(true);
    // Mit Herkunft importiert, wie es das Portal tut
    const item = r.body.items[0]!;
    const imp = await portal<{ created: number }>('POST', '/v1/cloud/records/batch', {
      cookie: kreis.cookie,
      body: { kind: 'object', nodeId: KREIS, items: [{ typeUid: WATER, name: item.name, lat: item.lat, lon: item.lon, notes: item.notes, props: { art: item.art, dn: item.dn }, source: `fireboard:${item.id}` }] },
    });
    expect(imp.body.created).toBe(1);
  });
});
