import { beforeEach, describe, expect, it } from 'vitest';
import type { BackupEntry, BackupVaultInfo, ElwRegistration } from './protocol.js';
import { cleanup, handle, type Env } from './relay.js';
import { fakeD1, fakeR2 } from './testing.js';

let env: Env;
let r2: ReturnType<typeof fakeR2>;
let now = new Date('2026-10-25T10:00:00Z');

const vault = 'ab'.repeat(16);
const vaultToken = 'tresor-zugang';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function call<T = unknown>(method: string, path: string, opts: { token?: string; body?: unknown; raw?: Uint8Array; headers?: Record<string, string> } = {}) {
  const res = await handle(
    new Request(`https://relay.test${path}`, {
      method,
      headers: { ...(opts.token && { authorization: `Bearer ${opts.token}` }), ...opts.headers },
      body: (opts.raw as BodyInit | undefined) ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    }),
    env,
    now,
  );
  const type = res.headers.get('content-type') ?? '';
  if (type.startsWith('application/octet-stream')) return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) as T };
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function openVault() {
  const elw = (await call<ElwRegistration>('POST', '/v1/elws')).body;
  return call<BackupVaultInfo>('PUT', `/v1/backups/${vault}`, { token: vaultToken, headers: { 'x-elvis-elw': elw.token } });
}

async function upload(id: string, parts: Uint8Array[]) {
  expect((await call('POST', `/v1/backups/${vault}/backups/${id}`, { token: vaultToken, body: { meta: 'verschlüsselt' } })).status).toBe(201);
  for (const [n, p] of parts.entries()) expect((await call('PUT', `/v1/backups/${vault}/backups/${id}/parts/${n}`, { token: vaultToken, raw: p })).status).toBe(204);
  return call<BackupEntry>('POST', `/v1/backups/${vault}/backups/${id}/complete`, { token: vaultToken, body: { parts: parts.length, size: parts.reduce((s, p) => s + p.length, 0) } });
}

beforeEach(() => {
  r2 = fakeR2();
  env = { DB: fakeD1(), BACKUPS: r2, BACKUP_MAX_COUNT: '3', BACKUP_MAX_BYTES: '100' };
  now = new Date('2026-10-25T10:00:00Z');
});

describe('Backups', () => {
  it('legt Tresore nur für angemeldete ELW an und öffnet sie mit dem Zugang', async () => {
    expect((await call('PUT', `/v1/backups/${vault}`, { token: vaultToken })).status).toBe(401);
    const created = await openVault();
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ quota: { maxBackups: 3, maxBytes: 100 }, usedBytes: 0, backups: [] });
    // Wiederherstellen ohne ELW-Anmeldung, nur mit dem Zugang
    expect((await call('GET', `/v1/backups/${vault}`, { token: vaultToken })).status).toBe(200);
    expect((await call('PUT', `/v1/backups/${vault}`, { token: vaultToken })).status).toBe(200);
    expect((await call('GET', `/v1/backups/${vault}`, { token: 'falsch' })).status).toBe(404);
    expect((await call('GET', `/v1/backups/${vault}`)).status).toBe(401);
  });

  it('lädt Teile hoch, liefert sie zurück und löscht sie', async () => {
    await openVault();
    const done = await upload(uuid(1), [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id: uuid(1), size: 5, parts: 2, meta: 'verschlüsselt' });
    const list = (await call<BackupVaultInfo>('GET', `/v1/backups/${vault}`, { token: vaultToken })).body;
    expect(list.usedBytes).toBe(5);
    expect(list.backups.map((b) => b.id)).toEqual([uuid(1)]);
    expect((await call<Uint8Array>('GET', `/v1/backups/${vault}/backups/${uuid(1)}/parts/1`, { token: vaultToken })).body).toEqual(new Uint8Array([4, 5]));
    expect((await call('GET', `/v1/backups/${vault}/backups/${uuid(1)}/parts/2`, { token: vaultToken })).status).toBe(404);
    expect((await call('DELETE', `/v1/backups/${vault}/backups/${uuid(1)}`, { token: vaultToken })).status).toBe(204);
    expect(r2.objects.size).toBe(0);
  });

  it('lehnt unvollständige Uploads ab und zeigt sie nicht an', async () => {
    await openVault();
    await call('POST', `/v1/backups/${vault}/backups/${uuid(1)}`, { token: vaultToken, body: { meta: 'm' } });
    await call('PUT', `/v1/backups/${vault}/backups/${uuid(1)}/parts/0`, { token: vaultToken, raw: new Uint8Array(4) });
    expect((await call('POST', `/v1/backups/${vault}/backups/${uuid(1)}/complete`, { token: vaultToken, body: { parts: 2, size: 8 } })).status).toBe(400);
    expect((await call<BackupVaultInfo>('GET', `/v1/backups/${vault}`, { token: vaultToken })).body.backups).toEqual([]);
    // nach 24 Stunden räumt der Cron auf
    now = new Date('2026-10-26T11:00:00Z');
    await cleanup(env, now);
    expect(r2.objects.size).toBe(0);
  });

  it('hält das Kontingent ein, ältere Backups weichen', async () => {
    await openVault();
    for (let i = 1; i <= 4; i++) {
      now = new Date(now.getTime() + 60_000);
      await upload(uuid(i), [new Uint8Array(10)]);
    }
    let list = (await call<BackupVaultInfo>('GET', `/v1/backups/${vault}`, { token: vaultToken })).body;
    expect(list.backups.map((b) => b.id)).toEqual([uuid(4), uuid(3), uuid(2)]);
    // nach Größe: 60 Byte passen nur ohne die älteren
    now = new Date(now.getTime() + 60_000);
    await upload(uuid(5), [new Uint8Array(60)]);
    now = new Date(now.getTime() + 60_000);
    await upload(uuid(6), [new Uint8Array(50)]);
    list = (await call<BackupVaultInfo>('GET', `/v1/backups/${vault}`, { token: vaultToken })).body;
    expect(list.backups.map((b) => b.id)).toEqual([uuid(6)]);
    expect((await upload(uuid(7), [new Uint8Array(101)])).status).toBe(413);
  });

  it('löscht Tresore ohne Zugriff nach einem Jahr', async () => {
    await openVault();
    await upload(uuid(1), [new Uint8Array(3)]);
    now = new Date('2027-10-26T10:00:00Z');
    await cleanup(env, now);
    expect(r2.objects.size).toBe(0);
    expect((await call('GET', `/v1/backups/${vault}`, { token: vaultToken })).status).toBe(404);
  });
});
