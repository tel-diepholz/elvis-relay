import type { InstallationStatus } from '../cloudprotocol.js';
import { regionLabel } from '../regions.js';
import { nodeRef } from './nodes.js';

export interface InstallationRow {
  elw_id: string;
  node_id: string;
  name: string;
  sig_public_key: string;
  version: string;
  linked_by: string;
  linked_at: string;
  last_sync_at: string | null;
}

type Count = { n: number; bytes?: number | null; oldest?: string | null; last?: string | null };

/** Zustand der Cloud-Module einer Installation – nur aus dem, was das Relay für seine Dienste ohnehin speichert */
export async function installationStatus(db: D1Database, i: InstallationRow, mailDomain: string, now: Date): Promise<InstallationStatus> {
  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).first<T>();
  const count = async (sql: string, ...args: unknown[]) => (await one<Count>(sql, ...args))?.n ?? 0;
  const id = i.elw_id;
  const today = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;

  const elw = await one<{ last_seen: string }>('SELECT last_seen FROM elws WHERE id = ?', id);
  const mailbox = await one<{ localpart: string; status: string; last_fetch_at: string | null; last_fetch_country: string | null }>(
    'SELECT localpart, status, last_fetch_at, last_fetch_country FROM mailboxes WHERE elw_id = ?',
    id,
  );
  let mail: InstallationStatus['mail'] = null;
  if (mailbox) {
    const inbox = await one<Count>('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes, MIN(received_at) AS oldest FROM mail_inbox WHERE localpart = ?', mailbox.localpart);
    const sent = await one<{ n: number | null }>('SELECT SUM(recipients) AS n FROM mail_sent WHERE localpart = ? AND sent_at >= ?', mailbox.localpart, today);
    mail = {
      address: `${mailbox.localpart}@${mailDomain}`,
      state: mailbox.status,
      waiting: inbox?.n ?? 0,
      waitingBytes: inbox?.bytes ?? 0,
      oldestWaiting: inbox?.oldest ?? null,
      lastFetchAt: mailbox.last_fetch_at,
      lastFetchCountry: mailbox.last_fetch_country,
      sentToday: sent?.n ?? 0,
    };
  }

  const dir = await one<{ region_ars: string; listed: number }>('SELECT region_ars, listed FROM msg_directory WHERE elw_id = ?', id);
  const messaging: InstallationStatus['messaging'] = dir
    ? {
        listed: dir.listed === 1,
        region: regionLabel(dir.region_ars),
        pendingEvents: await count('SELECT COUNT(*) AS n FROM msg_events WHERE to_elw = ?', id),
        openConversations: await count("SELECT COUNT(*) AS n FROM msg_conversations WHERE (from_elw = ? OR to_elw = ?) AND state = 'accepted'", id, id),
      }
    : null;

  const hooks = await db.prepare('SELECT kind FROM hooks WHERE elw_id = ? ORDER BY kind').bind(id).all<{ kind: string }>();
  const vault = await one<Count>(
    "SELECT COUNT(b.id) AS n, COALESCE(SUM(b.size), 0) AS bytes, MAX(b.created_at) AS last FROM backup_vaults v LEFT JOIN backups b ON b.vault_id = v.id AND b.status = 'complete' WHERE v.elw_id = ? GROUP BY v.elw_id",
    id,
  );

  return {
    elwId: id,
    name: i.name,
    node: (await nodeRef(db, i.node_id)) ?? { id: i.node_id, name: '?', path: [] },
    version: i.version,
    linkedAt: i.linked_at,
    linkedBy: i.linked_by,
    lastSeen: elw?.last_seen ?? null,
    mail,
    messaging,
    app: {
      pairedDevices: await count('SELECT COUNT(*) AS n FROM devices WHERE elw_id = ?', id),
      pendingPositions: await count('SELECT COUNT(*) AS n FROM positions WHERE elw_id = ?', id),
      openForms: await count('SELECT COUNT(*) AS n FROM forms WHERE elw_id = ? AND expires_at > ?', id, now.toISOString()),
      pendingSheets: await count('SELECT COUNT(*) AS n FROM submissions WHERE elw_id = ?', id),
    },
    hooks: { kinds: hooks.results.map((h) => h.kind), pendingEvents: await count('SELECT COUNT(*) AS n FROM hook_events WHERE elw_id = ?', id) },
    backup: vault ? { count: vault.n, bytes: vault.bytes ?? 0, lastAt: vault.last ?? null } : null,
  };
}
