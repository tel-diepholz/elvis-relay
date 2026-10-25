import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DeviceRegistration, DeviceStatus, ElwPositionBatch, ElwRegistration } from './protocol.js';
import { cleanup, handle, MAX_CODE_ATTEMPTS, type Env } from './relay.js';

/** D1 im Speicher (nur das, was der Worker nutzt) */
function fakeD1(): D1Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const prepare = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => prepare(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } }),
  });
  return { prepare } as unknown as D1Database;
}

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
