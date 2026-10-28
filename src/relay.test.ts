import { webcrypto, generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DeviceRegistration, DeviceStatus, ElwPositionBatch, ElwRegistration, RelayForm, RelaySubmissionBatch } from './protocol.js';
import { cleanup, handle, MAX_CODE_ATTEMPTS, MAX_FORM_SUBMISSIONS, type Env } from './relay.js';
import { fakeD1 } from './testing.js';

let env: Env;
let now = new Date('2026-10-25T10:00:00Z');

async function call<T = unknown>(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await handle(
    new Request(`https://relay.test${path}`, {
      method,
      headers: { ...(opts.token && { authorization: `Bearer ${opts.token}` }), 'content-type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    env,
    now,
  );
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

const position = (lat: number, ts = now.toISOString()) => ({ lat, lon: 8.37, accuracyM: 5, ts, battery: 0.5 });

beforeEach(() => {
  env = { DB: fakeD1() };
  now = new Date('2026-10-25T10:00:00Z');
});

async function registered() {
  const app = (await call<DeviceRegistration>('POST', '/v1/devices')).body;
  const elw = (await call<ElwRegistration>('POST', '/v1/elws')).body;
  return { app, elw };
}

describe('App-Relay', () => {
  it('meldet eine App an und zeigt ID und Code', async () => {
    const { status, body } = await call<DeviceRegistration>('POST', '/v1/devices');
    expect(status).toBe(201);
    expect(body.deviceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(body.code).toMatch(/^\d{6}$/);
    const me = await call<DeviceStatus>('GET', '/v1/devices/me', { token: body.token });
    expect(me.body).toEqual({ paired: false, label: '', code: body.code });
    expect((await call('GET', '/v1/devices/me', { token: 'falsch' })).status).toBe(401);
  });

  it('koppelt mit ID und Code und reicht Positionen an den ELW weiter', async () => {
    const { app, elw } = await registered();
    // ungekoppelt wird nichts gespeichert
    await call('POST', '/v1/devices/me/positions', { token: app.token, body: position(52.5) });

    const pair = await call<DeviceStatus>('POST', '/v1/elws/me/pairings', { token: elw.token, body: { deviceId: app.deviceId.toLowerCase(), code: app.code, label: 'HLF 20/1 · B3' } });
    expect(pair.status).toBe(201);
    const status = await call<DeviceStatus>('POST', '/v1/devices/me/positions', { token: app.token, body: position(52.6) });
    expect(status.body).toEqual({ paired: true, label: 'HLF 20/1 · B3', code: null });
    await call('POST', '/v1/devices/me/positions', { token: app.token, body: position(52.7) });

    const batch = (await call<ElwPositionBatch>('GET', '/v1/elws/me/positions?after=0', { token: elw.token })).body;
    expect(batch.items.map((i) => i.lat)).toEqual([52.6, 52.7]);
    expect(batch.items[0]).toMatchObject({ deviceId: app.deviceId, accuracyM: 5, battery: 0.5 });
    // Bestätigte Positionen sind weg, neue kommen danach
    await call('POST', '/v1/devices/me/positions', { token: app.token, body: position(52.8) });
    const next = (await call<ElwPositionBatch>('GET', `/v1/elws/me/positions?after=${batch.next}`, { token: elw.token })).body;
    expect(next.items.map((i) => i.lat)).toEqual([52.8]);
    const again = (await call<ElwPositionBatch>('GET', `/v1/elws/me/positions?after=${next.next}`, { token: elw.token })).body;
    expect(again).toEqual({ items: [], next: next.next });

    // Code gilt nur einmal
    expect((await call('POST', '/v1/elws/me/pairings', { token: elw.token, body: { deviceId: app.deviceId, code: app.code } })).status).toBe(403);
  });

  it('lehnt falsche Codes ab und erneuert den Code nach zu vielen Versuchen', async () => {
    const { app, elw } = await registered();
    const wrong = app.code === '000000' ? '111111' : '000000';
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
      expect((await call('POST', '/v1/elws/me/pairings', { token: elw.token, body: { deviceId: app.deviceId, code: wrong } })).status).toBe(403);
    }
    expect((await call('POST', '/v1/elws/me/pairings', { token: elw.token, body: { deviceId: app.deviceId, code: wrong } })).status).toBe(429);
    const me = (await call<DeviceStatus>('GET', '/v1/devices/me', { token: app.token })).body;
    expect(me.code).not.toBe(app.code);
    expect((await call('POST', '/v1/elws/me/pairings', { token: elw.token, body: { deviceId: app.deviceId, code: me.code } })).status).toBe(201);
    expect((await call('POST', '/v1/elws/me/pairings', { token: elw.token, body: { deviceId: 'AAAAAAAA', code: '123456' } })).status).toBe(404);
  });

  it('lässt keinen zweiten ELW eine gekoppelte App übernehmen', async () => {
    const { app, elw } = await registered();
    await call('POST', '/v1/elws/me/pairings', { token: elw.token, body: { deviceId: app.deviceId, code: app.code } });
    const other = (await call<ElwRegistration>('POST', '/v1/elws')).body;
    const code = (await call<DeviceStatus>('GET', '/v1/devices/me', { token: app.token })).body.code;
    expect(code).toBeNull();
    expect((await call('POST', '/v1/elws/me/pairings', { token: other.token, body: { deviceId: app.deviceId, code: '123456' } })).status).toBe(409);
    expect((await call('DELETE', `/v1/elws/me/pairings/${app.deviceId}`, { token: other.token })).status).toBe(404);
  });

  it('entkoppelt: App erfährt es mit der nächsten Meldung und bekommt einen neuen Code', async () => {
    const { app, elw } = await registered();
    await call('POST', '/v1/elws/me/pairings', { token: elw.token, body: { deviceId: app.deviceId, code: app.code } });
    await call('POST', '/v1/devices/me/positions', { token: app.token, body: position(52.6) });
    expect((await call('PUT', `/v1/elws/me/pairings/${app.deviceId}`, { token: elw.token, body: { label: 'LF 10' } })).status).toBe(200);
    expect((await call('DELETE', `/v1/elws/me/pairings/${app.deviceId}`, { token: elw.token })).status).toBe(204);
    const status = (await call<DeviceStatus>('POST', '/v1/devices/me/positions', { token: app.token, body: position(52.7) })).body;
    expect(status.paired).toBe(false);
    expect(status.code).toMatch(/^\d{6}$/);
    expect((await call<ElwPositionBatch>('GET', '/v1/elws/me/positions?after=0', { token: elw.token })).body.items).toEqual([]);
  });

  it('prüft Positionen und räumt alte Daten auf', async () => {
    const { app, elw } = await registered();
    await call('POST', '/v1/elws/me/pairings', { token: elw.token, body: { deviceId: app.deviceId, code: app.code } });
    expect((await call('POST', '/v1/devices/me/positions', { token: app.token, body: { lat: 200, lon: 0 } })).status).toBe(400);
    await call('POST', '/v1/devices/me/positions', { token: app.token, body: position(52.6) });
    now = new Date(now.getTime() + 25 * 3600_000);
    await cleanup(env, now);
    expect((await call<ElwPositionBatch>('GET', '/v1/elws/me/positions?after=0', { token: elw.token })).body.items).toEqual([]);
    now = new Date(now.getTime() + 91 * 24 * 3600_000);
    await call('GET', '/v1/elws/me/positions?after=0', { token: elw.token });
    await cleanup(env, now);
    expect((await call('GET', '/v1/devices/me', { token: app.token })).status).toBe(401);
  });

  it('zeigt die Datenschutzhinweise', async () => {
    const res = await handle(new Request('https://relay.test/datenschutz'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Datenschutz');
  });
});

const publicKey = () => {
  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RSA-OAEP-256', ext: true, key_ops: ['encrypt'] };
};
const sealed = () => ({ alg: 'RSA-OAEP-256+A256GCM', key: 'a2V5', iv: 'aXY=', data: Buffer.from(webcrypto.getRandomValues(new Uint8Array(64))).toString('base64') });

async function page(path: string, init: RequestInit = {}) {
  const res = await handle(new Request(`https://relay.test${path}`, init), env, now);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('Online-Formular', () => {
  async function form(hours = 24) {
    const { elw } = await registered();
    const expiresAt = new Date(now.getTime() + hours * 3600_000).toISOString();
    const res = await call<RelayForm>('POST', '/v1/elws/me/forms', { token: elw.token, body: { title: 'ELW 1 · B3 <Brand>', publicKey: publicKey(), expiresAt } });
    return { elw, res };
  }

  it('stellt das Formular bereit und reicht verschlüsselte Bögen an den ELW weiter', async () => {
    const { elw, res } = await form();
    expect(res.status).toBe(201);
    expect(res.body.url).toBe(`https://relay.test/p/${res.body.formId}`);
    expect(res.body.formId).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const html = await page(`/p/${res.body.formId}`);
    expect(html.status).toBe(200);
    expect(html.text).toContain('Einheit / Fahrzeug');
    expect(html.text).toContain('ELW 1 · B3 &lt;Brand&gt;');
    expect(html.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");

    const post = (body: unknown) => page(`/p/${res.body.formId}`, { method: 'POST', body: JSON.stringify(body) });
    expect((await post(sealed())).status).toBe(201);
    expect((await post({ unitLabel: 'Klartext' })).status).toBe(400);
    const batch = await call<RelaySubmissionBatch>('GET', '/v1/elws/me/submissions?after=0', { token: elw.token });
    expect(batch.body.items).toHaveLength(1);
    expect(batch.body.items[0]).toMatchObject({ formId: res.body.formId, payload: { alg: 'RSA-OAEP-256+A256GCM' } });

    // Mit dem Cursor bestätigt: gelöscht
    const next = await call<RelaySubmissionBatch>('GET', `/v1/elws/me/submissions?after=${batch.body.next}`, { token: elw.token });
    expect(next.body.items).toHaveLength(0);
    const other = (await call<ElwRegistration>('POST', '/v1/elws')).body;
    expect((await call<RelaySubmissionBatch>('GET', '/v1/elws/me/submissions?after=0', { token: other.token })).body.items).toHaveLength(0);
  });

  it('beendet Links: gelöscht, abgelaufen, unbekannt', async () => {
    const { elw, res } = await form(1);
    const { formId } = res.body;
    await page(`/p/${formId}`, { method: 'POST', body: JSON.stringify(sealed()) });
    expect((await call('DELETE', `/v1/elws/me/forms/${formId}`, { token: elw.token })).status).toBe(204);
    expect((await page(`/p/${formId}`)).status).toBe(410);
    expect((await page(`/p/${formId}`, { method: 'POST', body: JSON.stringify(sealed()) })).status).toBe(410);
    // Vor dem Beenden eingereicht: bleibt bis zur Abholung
    expect((await call<RelaySubmissionBatch>('GET', '/v1/elws/me/submissions?after=0', { token: elw.token })).body.items).toHaveLength(1);

    const second = (await form(1)).res.body;
    now = new Date(now.getTime() + 2 * 3600_000);
    expect((await page(`/p/${second.formId}`)).status).toBe(410);
    expect((await page('/p/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(410);

    now = new Date(now.getTime() + 8 * 24 * 3600_000);
    await cleanup(env, now);
    // Nach 7 Tagen nicht abgeholt: gelöscht
    expect((await call<RelaySubmissionBatch>('GET', '/v1/elws/me/submissions?after=0', { token: elw.token })).body.items).toHaveLength(0);
  });

  it('prüft Gültigkeit, Schlüssel und Anzahl', async () => {
    const { elw } = await registered();
    const create = (body: unknown) => call('POST', '/v1/elws/me/forms', { token: elw.token, body });
    expect((await create({ title: '', publicKey: publicKey(), expiresAt: new Date(now.getTime() + 8 * 24 * 3600_000).toISOString() })).status).toBe(400);
    expect((await create({ title: '', publicKey: { kty: 'RSA', n: 'x', e: 'AQAB', alg: 'RSA-OAEP-256' }, expiresAt: new Date(now.getTime() + 3600_000).toISOString() })).status).toBe(400);
    expect((await call('POST', '/v1/elws/me/forms', { body: {} })).status).toBe(401);

    const { res } = await form();
    expect((await page(`/p/${res.body.formId}`, { method: 'POST', body: 'x'.repeat(400 * 1024) })).status).toBe(413);
    for (let i = 0; i < MAX_FORM_SUBMISSIONS; i++) await page(`/p/${res.body.formId}`, { method: 'POST', body: JSON.stringify(sealed()) });
    expect((await page(`/p/${res.body.formId}`, { method: 'POST', body: JSON.stringify(sealed()) })).status).toBe(429);
  });
});
