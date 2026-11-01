import { beforeEach, describe, expect, it } from 'vitest';
import type { ElwRegistration, RelayHook, RelayHookBatch } from './protocol.js';
import { cleanup, handle, type Env } from './relay.js';
import { MAX_HOOK_BYTES } from './hooks.js';
import { fakeD1 } from './testing.js';

let env: Env;
let now = new Date('2026-11-01T10:00:00Z');

async function call<T = unknown>(method: string, path: string, opts: { token?: string; body?: string; json?: unknown; headers?: Record<string, string> } = {}) {
  const res = await handle(
    new Request(`https://relay.test${path}`, {
      method,
      headers: { ...(opts.token && { authorization: `Bearer ${opts.token}` }), 'content-type': opts.json !== undefined ? 'application/json' : 'text/plain', ...opts.headers },
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
    }),
    env,
    now,
  );
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Text (z. B. hub.challenge)
  }
  return { status: res.status, body: parsed as T };
}

beforeEach(() => {
  env = { DB: fakeD1(), RELAY_URL: 'https://relay.einsatzleitwagen.app' };
  now = new Date('2026-11-01T10:00:00Z');
});

describe('Webhooks der Messenger', () => {
  it('legt je ELW und Art einen Webhook an, beantwortet die Prüfung von Meta und puffert Aufrufe', async () => {
    const elw = (await call<ElwRegistration>('POST', '/v1/elws')).body;
    const other = (await call<ElwRegistration>('POST', '/v1/elws')).body;
    const hook = (await call<RelayHook>('POST', '/v1/elws/me/hooks', { token: elw.token, json: { kind: 'whatsapp' } })).body;
    expect(hook.url).toMatch(/^https:\/\/relay\.einsatzleitwagen\.app\/h\/[A-Za-z0-9_-]{22}$/);
    // Erneut: derselbe Webhook
    expect((await call<RelayHook>('POST', '/v1/elws/me/hooks', { token: elw.token, json: { kind: 'whatsapp' } })).body).toEqual(hook);
    expect((await call('POST', '/v1/elws/me/hooks', { token: elw.token, json: { kind: 'icq' } })).status).toBe(400);
    expect((await call('POST', '/v1/elws/me/hooks', { json: { kind: 'whatsapp' } })).status).toBe(401);
    const path = new URL(hook.url).pathname;

    expect(await call('GET', `${path}?hub.mode=subscribe&hub.verify_token=${hook.verifyToken}&hub.challenge=4711`)).toEqual({ status: 200, body: 4711 });
    expect((await call('GET', `${path}?hub.mode=subscribe&hub.verify_token=falsch&hub.challenge=1`)).status).toBe(403);
    expect((await call('POST', '/h/AAAAAAAAAAAAAAAAAAAAAA', { body: '{}' })).status).toBe(404);

    expect((await call('POST', path, { body: '{"entry":[]}', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=abc' } })).status).toBe(200);
    expect((await call('POST', path, { body: 'x'.repeat(MAX_HOOK_BYTES + 1) })).status).toBe(413);

    const batch = (await call<RelayHookBatch>('GET', '/v1/elws/me/hooks/events', { token: elw.token })).body;
    expect(batch.items).toEqual([{ seq: 1, kind: 'whatsapp', contentType: 'application/json', signature: 'sha256=abc', body: '{"entry":[]}', receivedAt: now.toISOString() }]);
    // Andere ELWs sehen nichts; mit dem Cursor ist der Aufruf weg
    expect((await call<RelayHookBatch>('GET', '/v1/elws/me/hooks/events', { token: other.token })).body.items).toEqual([]);
    expect((await call<RelayHookBatch>('GET', `/v1/elws/me/hooks/events?after=${batch.next}`, { token: elw.token })).body).toEqual({ items: [], next: 1 });
    expect((await call<RelayHookBatch>('GET', '/v1/elws/me/hooks/events', { token: elw.token })).body.items).toEqual([]);

    // Löschen: die Adresse gilt nicht mehr
    expect((await call('DELETE', '/v1/elws/me/hooks/whatsapp', { token: elw.token })).status).toBe(204);
    expect((await call('POST', path, { body: '{}' })).status).toBe(404);
  });

  it('räumt alte Aufrufe auf', async () => {
    const elw = (await call<ElwRegistration>('POST', '/v1/elws')).body;
    const hook = (await call<RelayHook>('POST', '/v1/elws/me/hooks', { token: elw.token, json: { kind: 'threema' } })).body;
    await call('POST', new URL(hook.url).pathname, { body: 'from=ECHOECHO&box=00', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    now = new Date('2026-11-09T10:00:00Z');
    await cleanup(env, now);
    expect((await call<RelayHookBatch>('GET', '/v1/elws/me/hooks/events', { token: elw.token })).body.items).toEqual([]);
  });
});
