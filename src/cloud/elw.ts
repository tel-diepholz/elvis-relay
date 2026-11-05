import { CLOUD_LINK_ALPHABET, CLOUD_LINK_CODE_LENGTH, CLOUD_LINK_TTL_MS, cloudLinkRequestSchema, type CloudLinkStatus } from '../cloudprotocol.js';
import { fail, json, random } from '../http.js';
import { verifySigned } from '../mail.js';
import type { Env } from '../relay.js';
import { nodeRef } from './nodes.js';
import type { InstallationRow } from './status.js';
import { pull, writeRecord } from './records.js';
import { syncPushSchema, type SyncPull, type SyncResult } from '../syncprotocol.js';

interface LinkRequestRow {
  elw_id: string;
  code: string;
  name: string;
  sig_public_key: string;
  version: string;
  expires_at: string;
}

export const newLinkCode = () => [...random(CLOUD_LINK_CODE_LENGTH)].map((b) => CLOUD_LINK_ALPHABET[b % CLOUD_LINK_ALPHABET.length]).join('');

/** Version aus dem Kopf der Aufrufe (zeigt das Portal) */
const versionOf = (req: Request) => (req.headers.get('x-elvis-version') ?? '').slice(0, 40);

/**
 * Cloud-Verknüpfung aus Sicht der Installation (`/v1/elws/me/cloud…`). Jeder Aufruf ist mit dem Ed25519-Schlüssel der
 * Verknüpfung signiert: bei der Anfrage mit dem darin mitgeschickten, danach mit dem gespeicherten.
 */
export async function handleElwCloud(req: Request, env: Env, elwId: string, path: string, now: Date): Promise<Response> {
  const db = env.DB;
  const ts = now.toISOString();
  const raw = new Uint8Array(await req.arrayBuffer());
  const installation = await db.prepare('SELECT * FROM installations WHERE elw_id = ?').bind(elwId).first<InstallationRow>();
  const request = await db.prepare('SELECT * FROM link_requests WHERE elw_id = ? AND expires_at > ?').bind(elwId, ts).first<LinkRequestRow>();
  const signedBy = async (key: string | undefined) => !!key && (await verifySigned(req, raw, key, db, now));

  if (req.method === 'POST' && path === '/v1/elws/me/cloud/link') {
    let parsed;
    try {
      parsed = cloudLinkRequestSchema.safeParse(JSON.parse(new TextDecoder().decode(raw)));
    } catch {
      return fail(400, 'Anfrage ungültig');
    }
    if (!parsed.success) return fail(400, 'Anfrage ungültig');
    if (!(await signedBy(parsed.data.sigPublicKey))) return fail(401, 'Signatur ungültig');
    if (installation) return fail(409, 'Installation ist bereits verknüpft');
    const expiresAt = new Date(now.getTime() + CLOUD_LINK_TTL_MS).toISOString();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newLinkCode();
      try {
        await db.prepare('DELETE FROM link_requests WHERE elw_id = ?').bind(elwId).run();
        await db
          .prepare('INSERT INTO link_requests (elw_id, code, name, sig_public_key, version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(elwId, code, parsed.data.name, parsed.data.sigPublicKey, parsed.data.version, ts, expiresAt)
          .run();
        return json(201, { state: 'pending', code, expiresAt } satisfies CloudLinkStatus);
      } catch {
        // Code schon vergeben (UNIQUE) – neuer Versuch
      }
    }
    return fail(503, 'Kein freier Code, bitte erneut versuchen');
  }

  // --- Stammdaten: abholen und eigene Änderungen senden (nur verknüpft, nur der eigene Knoten ist beschreibbar) ---
  if (path === '/v1/elws/me/cloud/sync') {
    if (!installation) return fail(409, 'Installation ist nicht verknüpft');
    if (!(await signedBy(installation.sig_public_key))) return fail(401, 'Signatur ungültig');
    if (req.method === 'GET') {
      const after = Math.max(0, Math.floor(Number(new URL(req.url).searchParams.get('after') ?? 0)) || 0);
      await db.prepare('UPDATE installations SET last_sync_at = ? WHERE elw_id = ?').bind(ts, elwId).run();
      return json(200, { ...(await pull(db, installation.node_id, after)), nodeId: installation.node_id } satisfies SyncPull);
    }
    if (req.method === 'POST') {
      let parsed;
      try {
        parsed = syncPushSchema.safeParse(JSON.parse(new TextDecoder().decode(raw)));
      } catch {
        return fail(400, 'Änderungen ungültig');
      }
      if (!parsed.success) return fail(400, 'Änderungen ungültig');
      const by = `ELVIS ${installation.name}`;
      const results: SyncResult[] = [];
      for (const c of parsed.data.changes) {
        results.push(await writeRecord(db, { ...c, data: c.data ?? null, nodeId: installation.node_id, by, mayWrite: async (node) => node === installation.node_id }, now));
      }
      return json(200, { results });
    }
    return fail(405, 'Nicht erlaubt');
  }

  if (path === '/v1/elws/me/cloud') {
    if (installation) {
      if (!(await signedBy(installation.sig_public_key))) return fail(401, 'Signatur ungültig');
      if (req.method === 'GET') {
        const version = versionOf(req);
        if (version && version !== installation.version) await db.prepare('UPDATE installations SET version = ? WHERE elw_id = ?').bind(version, elwId).run();
        const node = await nodeRef(db, installation.node_id);
        if (!node) return fail(500, 'Knoten fehlt');
        return json(200, { state: 'linked', node, linkedAt: installation.linked_at, linkedBy: installation.linked_by } satisfies CloudLinkStatus);
      }
      if (req.method === 'DELETE') {
        await db.prepare('DELETE FROM installations WHERE elw_id = ?').bind(elwId).run();
        await db.prepare('DELETE FROM link_requests WHERE elw_id = ?').bind(elwId).run();
        return json(204, null);
      }
      return fail(405, 'Nicht erlaubt');
    }
    if (request) {
      if (!(await signedBy(request.sig_public_key))) return fail(401, 'Signatur ungültig');
      if (req.method === 'GET') return json(200, { state: 'pending', code: request.code, expiresAt: request.expires_at } satisfies CloudLinkStatus);
      if (req.method === 'DELETE') {
        await db.prepare('DELETE FROM link_requests WHERE elw_id = ?').bind(elwId).run();
        return json(204, null);
      }
      return fail(405, 'Nicht erlaubt');
    }
    // Weder verknüpft noch angefragt: nichts zu schützen
    if (req.method === 'GET') return json(200, { state: 'none' } satisfies CloudLinkStatus);
    if (req.method === 'DELETE') return json(204, null);
    return fail(405, 'Nicht erlaubt');
  }
  return fail(404, 'Nicht gefunden');
}
