import * as openpgp from 'openpgp';
import { beforeEach, describe, expect, it } from 'vitest';
import { base64url, sha256Hex } from './http.js';
import { deliverKeyMails, receiveMail, wkdHash, type IncomingMail } from './mail.js';
import { MAIL_SIGNATURE_HEADER, mailSignaturePayload, type MailboxStatus, type RelayMailBatch, type RelayStatus } from './mailprotocol.js';
import type { ElwRegistration } from './protocol.js';
import { cleanup, handle, type Env } from './relay.js';
import { runStatusChecks } from './status.js';
import { fakeD1, fakeR2 } from './testing.js';

interface Sent {
  from: string;
  to: string;
  raw: string;
}

let env: Env;
let r2: ReturnType<typeof fakeR2>;
let outbox: Sent[];
let sendFails: boolean;
let now: Date;

beforeEach(() => {
  r2 = fakeR2();
  outbox = [];
  sendFails = false;
  now = new Date('2026-10-25T10:00:00Z');
  env = {
    DB: fakeD1(),
    MAIL: r2,
    MAIL_DOMAIN: 'einsatzleitwagen.app',
    RELAY_URL: 'https://relay.test',
    STATUS_ADMIN_TOKEN: 'geheim',
    SEND: async (from, to, raw) => {
      if (sendFails) throw new Error('Versand gestört');
      outbox.push({ from, to, raw });
    },
  };
});

/** Was ELVIS beim Beantragen erzeugt: OpenPGP-Schlüssel, Widerruf, Ed25519 für signierte Abrufe */
async function elvis(localpart = 'elw2-diepholz') {
  const res = await handle(new Request('https://relay.test/v1/elws', { method: 'POST' }), env, now);
  const reg = (await res.json()) as ElwRegistration;
  const pgp = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ name: 'ELW', email: `${localpart}@einsatzleitwagen.app` }], format: 'armored' });
  const sig = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const sigPublicKey = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', sig.publicKey)));
  const request = { localpart, adminEmail: 'admin@feuerwehr.example', publicKey: pgp.publicKey, revocationCert: pgp.revocationCertificate, sigPublicKey };

  async function call(method: string, path: string, opts: { body?: unknown; sign?: boolean; t?: number; nonce?: string } = {}) {
    const raw = opts.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(opts.body));
    const headers: Record<string, string> = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' };
    if (opts.sign !== false) {
      const t = opts.t ?? now.getTime();
      const n = opts.nonce ?? base64url(crypto.getRandomValues(new Uint8Array(16)));
      const payload = mailSignaturePayload(method, path, await sha256Hex(raw), t, n);
      const s = base64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, sig.privateKey, new TextEncoder().encode(payload))));
      headers[MAIL_SIGNATURE_HEADER] = `t=${t},n=${n},s=${s}`;
    }
    const res = await handle(new Request(`https://relay.test${path}`, { method, headers, body: opts.body === undefined ? undefined : raw }), env, now);
    return res;
  }
  const jsonCall = async <T>(method: string, path: string, opts: Parameters<typeof call>[2] = {}) => {
    const res = await call(method, path, opts);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  return { reg, pgp, request, call, jsonCall };
}

const linkIn = (raw: string) => {
  const text = Buffer.from(raw.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8');
  return /\/m\/confirm\/([A-Za-z0-9_-]{43})/.exec(text)![1]!;
};
const confirm = (token: string, method = 'POST') => handle(new Request(`https://relay.test/m/confirm/${token}`, { method }), env, now);

async function activeMailbox(localpart?: string) {
  const e = await elvis(localpart);
  const res = await e.jsonCall<MailboxStatus>('POST', '/v1/elws/me/mailbox', { body: e.request, sign: false });
  expect(res.status).toBe(201);
  const token = linkIn(outbox.at(-1)!.raw);
  expect((await confirm(token)).status).toBe(200);
  return e;
}

function incoming(to: string, raw: string, headers: Record<string, string> = {}): IncomingMail & { rejected: string | null } {
  const bytes = new TextEncoder().encode(raw);
  const mail = {
    from: 'leitstelle@example.org',
    to,
    raw: new Response(bytes).body!,
    rawSize: bytes.length,
    headers: new Headers(headers),
    rejected: null as string | null,
    setReject(reason: string) {
      mail.rejected = reason;
    },
  };
  return mail;
}

describe('Postfach beantragen', () => {
  it('richtet nach Bestätigung ein und schickt die Schlüssel genau einmal', async () => {
    const e = await elvis();
    const res = await e.jsonCall<MailboxStatus>('POST', '/v1/elws/me/mailbox', { body: e.request, sign: false });
    expect(res.body).toMatchObject({ status: 'pending', address: 'elw2-diepholz@einsatzleitwagen.app' });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe('admin@feuerwehr.example');

    const token = linkIn(outbox[0]!.raw);
    // GET ändert nichts (Linkvorschau)
    const view = await confirm(token, 'GET');
    expect(await view.text()).toContain('<form method="post">');
    expect((await e.jsonCall<MailboxStatus>('GET', '/v1/elws/me/mailbox')).body.status).toBe('pending');

    expect((await confirm(token)).status).toBe(200);
    expect((await confirm(token)).status).toBe(410);
    const status = (await e.jsonCall<MailboxStatus>('GET', '/v1/elws/me/mailbox')).body;
    expect(status).toMatchObject({ status: 'active', adminEmail: 'admin@feuerwehr.example' });
    expect(status.keysMailedAt).not.toBeNull();

    expect(outbox).toHaveLength(2);
    expect(outbox[1]!.raw).toContain('filename="publickey.asc"');
    expect(outbox[1]!.raw).toContain('filename="revocation.asc"');
    const row = await env.DB.prepare('SELECT revocation_cert FROM mailboxes').first<{ revocation_cert: string | null }>();
    expect(row!.revocation_cert).toBeNull();
    await deliverKeyMails(env, now);
    expect(outbox).toHaveLength(2);
  });

  it('wartet bei manueller Freigabe auf den Betreiber', async () => {
    env.MAIL_APPROVAL = 'manual';
    const e = await elvis();
    await e.jsonCall('POST', '/v1/elws/me/mailbox', { body: e.request, sign: false });
    await confirm(linkIn(outbox[0]!.raw));
    expect((await e.jsonCall<MailboxStatus>('GET', '/v1/elws/me/mailbox')).body.status).toBe('approval');
    expect(outbox).toHaveLength(1);
    await env.DB.prepare("UPDATE mailboxes SET status = 'active'").run();
    await cleanup(env, now);
    expect(outbox).toHaveLength(2);
  });

  it('prüft Adresse, Schlüssel und Admin-Adresse', async () => {
    const e = await elvis();
    const post = (body: unknown) => e.jsonCall<{ error: string }>('POST', '/v1/elws/me/mailbox', { body, sign: false });
    expect((await post({ ...e.request, localpart: 'postmaster' })).status).toBe(400);
    expect((await post({ ...e.request, localpart: 'A b' })).status).toBe(400);
    expect((await post({ ...e.request, localpart: 'anderer-elw' })).body.error).toContain('gehört nicht zu');
    expect((await post({ ...e.request, adminEmail: 'x@einsatzleitwagen.app' })).status).toBe(400);
    const other = await openpgp.generateKey({ type: 'curve25519', userIDs: [{ email: 'elw2-diepholz@einsatzleitwagen.app' }] });
    expect((await post({ ...e.request, revocationCert: other.revocationCertificate })).body.error).toContain('Widerruf');
    expect((await post(e.request)).status).toBe(201);

    const second = await elvis();
    expect((await second.jsonCall('POST', '/v1/elws/me/mailbox', { body: second.request, sign: false })).status).toBe(409);
  });

  it('veröffentlicht den Schlüssel per WKD', async () => {
    expect(await wkdHash('Joe.Doe')).toBe('iy9q119eutrkn8s1mk4r39qejnbu3n5q');
    const e = await activeMailbox();
    const hu = await wkdHash('elw2-diepholz');
    const res = await handle(new Request(`https://openpgpkey.einsatzleitwagen.app/.well-known/openpgpkey/einsatzleitwagen.app/hu/${hu}?l=elw2-diepholz`), env, now);
    expect(res.status).toBe(200);
    const key = await openpgp.readKey({ binaryKey: new Uint8Array(await res.arrayBuffer()) });
    expect(key.getFingerprint()).toBe((await openpgp.readKey({ armoredKey: e.pgp.publicKey })).getFingerprint());
    expect((await handle(new Request('https://relay.test/.well-known/openpgpkey/einsatzleitwagen.app/policy'), env, now)).status).toBe(200);
    expect((await handle(new Request(`https://relay.test/.well-known/openpgpkey/hu/${'y'.repeat(32)}`), env, now)).status).toBe(404);
  });
});

describe('Empfang und Abruf', () => {
  const RAW = 'From: Leitstelle <leitstelle@example.org>\r\nTo: elw2-diepholz@einsatzleitwagen.app\r\nSubject: Lage\r\n\r\nBitte melden.\r\n';

  it('verschlüsselt sofort, liefert nur signiert aus und löscht nach Bestätigung', async () => {
    const e = await activeMailbox();
    const mail = incoming('ELW2-Diepholz+lage@einsatzleitwagen.app', RAW);
    await receiveMail(mail, env, now);
    expect(mail.rejected).toBeNull();
    const [stored] = [...r2.objects.values()];
    expect(new TextDecoder().decode(stored)).not.toContain('Bitte melden');

    expect((await e.call('GET', '/v1/elws/me/mail?after=0', { sign: false })).status).toBe(401);
    const batch = await e.jsonCall<RelayMailBatch>('GET', '/v1/elws/me/mail?after=0');
    expect(batch.body.items).toHaveLength(1);
    const blob = new Uint8Array(await (await e.call('GET', `/v1/elws/me/mail/${batch.body.items[0]!.seq}`)).arrayBuffer());
    const decryptionKeys = await openpgp.readPrivateKey({ armoredKey: e.pgp.privateKey });
    const { data } = await openpgp.decrypt({ message: await openpgp.readMessage({ binaryMessage: blob }), decryptionKeys, format: 'binary' });
    const text = new TextDecoder().decode(data as Uint8Array);
    expect(text).toContain('Return-Path: <leitstelle@example.org>');
    expect(text).toContain('Bitte melden.');

    const next = await e.jsonCall<RelayMailBatch>('GET', `/v1/elws/me/mail?after=${batch.body.next}`);
    expect(next.body.items).toHaveLength(0);
    expect(r2.objects.size).toBe(0);
    expect((await e.jsonCall<MailboxStatus>('GET', '/v1/elws/me/mailbox')).body.lastFetchAt).toBe(now.toISOString());
  });

  it('weist unbekannte Empfänger und fremde Domains ab', async () => {
    await activeMailbox();
    const unknown = incoming('niemand@einsatzleitwagen.app', RAW);
    await receiveMail(unknown, env, now);
    expect(unknown.rejected).toBeTruthy();
    const foreign = incoming('elw2-diepholz@example.org', RAW);
    await receiveMail(foreign, env, now);
    expect(foreign.rejected).toBeTruthy();
    expect(r2.objects.size).toBe(0);
  });

  it('lehnt fehlende, wiederholte und alte Signaturen ab und warnt den Admin einmal am Tag', async () => {
    const e = await activeMailbox();
    const mails = outbox.length;
    expect((await e.call('GET', '/v1/elws/me/mail?after=0', { sign: false })).status).toBe(401);
    expect((await e.call('GET', '/v1/elws/me/mail?after=0', { sign: false })).status).toBe(401);
    expect(outbox).toHaveLength(mails + 1);
    expect(outbox.at(-1)!.to).toBe('admin@feuerwehr.example');

    expect((await e.call('GET', '/v1/elws/me/mail?after=0', { nonce: 'gleichenonce12345678' })).status).toBe(200);
    expect((await e.call('GET', '/v1/elws/me/mail?after=0', { nonce: 'gleichenonce12345678' })).status).toBe(401);
    expect((await e.call('GET', '/v1/elws/me/mail?after=0', { t: now.getTime() - 10 * 60_000 })).status).toBe(401);

    // Ein anderer ELW kommt nicht an das Postfach
    const other = await elvis('anderer-elw');
    expect((await other.call('GET', '/v1/elws/me/mail?after=0')).status).toBe(404);
  });
});

describe('Versand', () => {
  const raw = (from: string, extra = '') => Buffer.from(`From: ELW 2 <${from}>\r\nTo: a@example.org\r\n${extra}Subject: Test\r\n\r\nHallo\r\n`).toString('base64');

  it('sendet nur mit der eigenen Absenderadresse und begrenzt die Menge', async () => {
    const e = await activeMailbox();
    const before = outbox.length;
    expect((await e.call('POST', '/v1/elws/me/mail/outbox', { body: { to: ['a@example.org'], raw: raw('chef@einsatzleitwagen.app') } })).status).toBe(400);
    expect((await e.call('POST', '/v1/elws/me/mail/outbox', { body: { to: ['a@example.org'], raw: raw('elw2-diepholz@einsatzleitwagen.app', 'Bcc: b@example.org\r\n') } })).status).toBe(400);
    const ok = await e.jsonCall('POST', '/v1/elws/me/mail/outbox', { body: { to: ['a@example.org', 'B@example.org'], raw: raw('elw2-diepholz@einsatzleitwagen.app') } });
    expect(ok).toEqual({ status: 200, body: { sent: 2 } });
    expect(outbox.slice(before).map((m) => [m.from, m.to])).toEqual([
      ['elw2-diepholz@einsatzleitwagen.app', 'a@example.org'],
      ['elw2-diepholz@einsatzleitwagen.app', 'b@example.org'],
    ]);

    const many = Array.from({ length: 50 }, (_, i) => `x${i}@example.org`);
    expect((await e.call('POST', '/v1/elws/me/mail/outbox', { body: { to: many, raw: raw('elw2-diepholz@einsatzleitwagen.app') } })).status).toBe(200);
    expect((await e.call('POST', '/v1/elws/me/mail/outbox', { body: { to: many, raw: raw('elw2-diepholz@einsatzleitwagen.app') } })).status).toBe(429);

    sendFails = true;
    now = new Date(now.getTime() + 2 * 3600_000);
    expect((await e.call('POST', '/v1/elws/me/mail/outbox', { body: { to: ['a@example.org'], raw: raw('elw2-diepholz@einsatzleitwagen.app') } })).status).toBe(502);
  });
});

describe('Neuinstallation und Kündigung', () => {
  it('überträgt die Adresse nur nach Bestätigung durch den Admin', async () => {
    const old = await activeMailbox();
    await receiveMail(incoming('elw2-diepholz@einsatzleitwagen.app', 'Subject: alt\r\n\r\nalt\r\n'), env, now);
    const fresh = await elvis();
    const mails = outbox.length;

    // Falsche Admin-Adresse: gleiche Antwort, aber keine Mail
    const wrong = await fresh.jsonCall<MailboxStatus>('POST', '/v1/elws/me/mailbox/rebind', { body: { ...fresh.request, adminEmail: 'fremd@example.org' }, sign: false });
    expect(wrong).toMatchObject({ status: 202, body: { status: 'rebind-pending' } });
    expect(outbox).toHaveLength(mails);

    const right = await fresh.jsonCall<MailboxStatus>('POST', '/v1/elws/me/mailbox/rebind', { body: { ...fresh.request, adminEmail: 'Admin@Feuerwehr.example' }, sign: false });
    expect(right).toMatchObject({ status: 202, body: { status: 'rebind-pending' } });
    expect(outbox).toHaveLength(mails + 1);
    expect((await fresh.jsonCall<MailboxStatus>('GET', '/v1/elws/me/mailbox', { sign: false })).body.status).toBe('rebind-pending');

    expect((await confirm(linkIn(outbox.at(-1)!.raw))).status).toBe(200);
    // Alte Mails sind weg, neue Schlüssel per Mail, WKD liefert den neuen Schlüssel
    expect(r2.objects.size).toBe(0);
    expect(outbox.at(-1)!.raw).toContain('filename="revocation.asc"');
    expect((await fresh.jsonCall<MailboxStatus>('GET', '/v1/elws/me/mailbox')).body.status).toBe('active');
    const wkd = await handle(new Request(`https://relay.test/.well-known/openpgpkey/hu/${await wkdHash('elw2-diepholz')}`), env, now);
    const key = await openpgp.readKey({ binaryKey: new Uint8Array(await wkd.arrayBuffer()) });
    expect(key.getFingerprint()).toBe((await openpgp.readKey({ armoredKey: fresh.pgp.publicKey })).getFingerprint());

    // Die alte Installation erfährt den Umzug
    expect((await old.jsonCall<MailboxStatus>('GET', '/v1/elws/me/mailbox')).body.status).toBe('moved');
    expect((await old.call('GET', '/v1/elws/me/mail?after=0')).status).toBe(403);
  });

  it('drosselt Übernahmeversuche', async () => {
    await activeMailbox();
    const fresh = await elvis();
    for (let i = 0; i < 3; i++) {
      expect((await fresh.call('POST', '/v1/elws/me/mailbox/rebind', { body: { ...fresh.request, adminEmail: `x${i}@example.org` }, sign: false })).status).toBe(202);
    }
    expect((await fresh.call('POST', '/v1/elws/me/mailbox/rebind', { body: fresh.request, sign: false })).status).toBe(429);
  });

  it('kündigt: Mails weg, Adresse 90 Tage gesperrt', async () => {
    const e = await activeMailbox();
    await receiveMail(incoming('elw2-diepholz@einsatzleitwagen.app', 'Subject: x\r\n\r\nx\r\n'), env, now);
    expect((await e.call('DELETE', '/v1/elws/me/mailbox')).status).toBe(204);
    expect(r2.objects.size).toBe(0);
    expect((await e.jsonCall<MailboxStatus>('GET', '/v1/elws/me/mailbox', { sign: false })).body.status).toBe('none');
    expect((await e.call('POST', '/v1/elws/me/mailbox', { body: e.request, sign: false })).status).toBe(409);
    now = new Date(now.getTime() + 91 * 24 * 3600_000);
    await cleanup(env, now);
    expect((await e.call('POST', '/v1/elws/me/mailbox', { body: e.request, sign: false })).status).toBe(201);
  });
});

describe('Statusseite', () => {
  const status = async () => (await (await handle(new Request('https://relay.test/v1/status'), env, now)).json()) as RelayStatus;

  beforeEach(() => {
    // Testmails an probe@ laufen wie bei Cloudflare zurück in den Worker
    env.SEND = async (from, to, raw) => {
      if (sendFails) throw new Error('Versand gestört');
      if (to.startsWith('probe@')) {
        const id = /X-Elvis-Probe: (\S+)/.exec(raw)![1]!;
        await receiveMail(incoming(to, raw, { 'x-elvis-probe': id }), env, now);
      }
      outbox.push({ from, to, raw });
    };
  });

  it('meldet ok, wenn die Testmail ankommt, und gestört, wenn nicht', async () => {
    await runStatusChecks(env, now);
    let s = await status();
    expect(s.overall).toBe('ok');
    expect(s.components.map((c) => c.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(s.uptime.inbound.at(-1)).toEqual({ day: '2026-10-25', ok: 1 });

    sendFails = true;
    now = new Date(now.getTime() + 5 * 60_000);
    await runStatusChecks(env, now);
    s = await status();
    expect(s.overall).toBe('degraded');
    expect(s.components.find((c) => c.id === 'outbound')).toMatchObject({ status: 'degraded', detail: 'Versand gestört' });

    // Ohne Prüfung seit 15 Minuten: nicht mehr ok
    sendFails = false;
    now = new Date(now.getTime() + 20 * 60_000);
    expect((await status()).components.find((c) => c.id === 'api')!.status).toBe('degraded');
  });

  it('verbucht Testmails, die schon während des Versands ankommen', async () => {
    // Wie in Produktion: der email()-Handler läuft, bevor send() zurückkommt (beforeEach-SEND stellt synchron zu)
    await runStatusChecks(env, now);
    const probe = await env.DB.prepare('SELECT received_at FROM status_probes').first<{ received_at: string | null }>();
    expect(probe?.received_at).toBe(now.toISOString());
    now = new Date(now.getTime() + 5 * 60_000);
    await runStatusChecks(env, now);
    expect((await status()).components.find((c) => c.id === 'inbound')!.status).toBe('ok');
  });

  it('verwaltet Störungsmeldungen nur mit Token', async () => {
    await runStatusChecks(env, now);
    const post = (token: string) =>
      handle(
        new Request('https://relay.test/v1/status/incidents', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ title: 'Versand verzögert', severity: 'degraded', components: ['outbound'] }),
        }),
        env,
        now,
      );
    expect((await post('falsch')).status).toBe(401);
    const created = (await (await post('geheim')).json()) as { id: number };
    let s = await status();
    expect(s.overall).toBe('degraded');
    expect(s.incidents[0]).toMatchObject({ title: 'Versand verzögert', resolvedAt: null });

    const patch = await handle(
      new Request(`https://relay.test/v1/status/incidents/${created.id}`, { method: 'PATCH', headers: { authorization: 'Bearer geheim' }, body: JSON.stringify({ resolved: true }) }),
      env,
      now,
    );
    expect(patch.status).toBe(200);
    s = await status();
    expect(s.overall).toBe('ok');
    expect(s.incidents[0]!.resolvedAt).not.toBeNull();
  });
});

describe('MIME', () => {
  it('baut die Message-ID aus der Absenderadresse', async () => {
    const { buildMime } = await import('./mime.js');
    const raw = buildMime({ from: 'ELVIS Relay <noreply@einsatzleitwagen.app>', to: 'a@example.org', subject: 'Prüfung', text: 'x' });
    expect(raw).toMatch(/^Message-ID: <[0-9a-f]{24}@einsatzleitwagen\.app>\r$/m);
    expect(raw).toContain('Subject: =?UTF-8?B?');
  });
});
