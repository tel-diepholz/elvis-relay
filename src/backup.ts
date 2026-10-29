import { z } from 'zod';
import type { BackupEntry, BackupQuota, BackupVaultInfo } from './protocol.js';
import { bearer, body, fail, hash, json, sameCode } from './http.js';

/**
 * Backups der ELVIS-Installationen (Treiber „einsatzleitwagen.app – Cloud“). ELVIS leitet aus dem
 * Wiederherstellungsschlüssel Tresor-ID, Zugang und Verschlüsselung ab; hier landen nur verschlüsselte Teile
 * (je höchstens MAX_PART_BYTES, das Body-Limit der Worker liegt bei 100 MB) und ein verschlüsselter Metadaten-Blob.
 * Angelegt wird ein Tresor nur von einem angemeldeten ELW, wiederherstellen kann jede Installation mit dem Schlüssel.
 */

export interface BackupEnv {
  DB: D1Database;
  BACKUPS?: R2Bucket;
  /** Kontingent je Tresor (Vorgabe), pro Tresor in backup_vaults überschreibbar */
  BACKUP_MAX_COUNT?: string;
  BACKUP_MAX_BYTES?: string;
}

export const MAX_PART_BYTES = 16 * 1024 * 1024;
const MAX_META_LENGTH = 4096;
const DEFAULT_MAX_COUNT = 30;
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
/** Nicht abgeschlossene Uploads und ungenutzte Tresore fallen weg */
const UPLOAD_TTL_MS = 24 * 3600_000;
const VAULT_TTL_MS = 365 * 24 * 3600_000;

const createSchema = z.object({ meta: z.string().min(1).max(MAX_META_LENGTH) });
const completeSchema = z.object({ parts: z.number().int().min(1).max(10_000), size: z.number().int().min(0) });

interface VaultRow {
  id: string;
  token_hash: string;
  max_backups: number | null;
  max_bytes: number | null;
}

interface BackupRow {
  id: string;
  status: string;
  size: number;
  parts: number;
  meta: string;
  created_at: string;
}

const partKey = (vaultId: string, backupId: string, n: number) => `${vaultId}/${backupId}/${n}`;

function quotaOf(env: BackupEnv, v: VaultRow): BackupQuota {
  return {
    maxBackups: v.max_backups ?? (Number(env.BACKUP_MAX_COUNT) || DEFAULT_MAX_COUNT),
    maxBytes: v.max_bytes ?? (Number(env.BACKUP_MAX_BYTES) || DEFAULT_MAX_BYTES),
  };
}

const entry = (r: BackupRow): BackupEntry => ({ id: r.id, size: r.size, parts: r.parts, createdAt: r.created_at, meta: r.meta });

async function completed(db: D1Database, vaultId: string): Promise<BackupRow[]> {
  return (await db.prepare("SELECT * FROM backups WHERE vault_id = ? AND status = 'complete' ORDER BY created_at DESC").bind(vaultId).all<BackupRow>()).results;
}

async function info(env: BackupEnv, v: VaultRow): Promise<BackupVaultInfo> {
  const rows = await completed(env.DB, v.id);
  return { quota: quotaOf(env, v), usedBytes: rows.reduce((s, r) => s + r.size, 0), backups: rows.map(entry) };
}

/** Backup samt Teilen löschen */
async function removeBackup(env: BackupEnv, vaultId: string, b: Pick<BackupRow, 'id' | 'parts'>): Promise<void> {
  const parts = (await env.DB.prepare('SELECT n FROM backup_parts WHERE backup_id = ?').bind(b.id).all<{ n: number }>()).results.map((p) => p.n);
  const keys = [...new Set([...parts, ...Array.from({ length: b.parts }, (_, i) => i)])].map((n) => partKey(vaultId, b.id, n));
  for (let i = 0; i < keys.length; i += 1000) await env.BACKUPS!.delete(keys.slice(i, i + 1000));
  await env.DB.prepare('DELETE FROM backup_parts WHERE backup_id = ?').bind(b.id).run();
  await env.DB.prepare('DELETE FROM backups WHERE id = ?').bind(b.id).run();
}

export async function handleBackup(req: Request, env: BackupEnv, path: string, now: Date): Promise<Response> {
  if (!env.BACKUPS) return fail(503, 'Backups sind auf diesem Relay nicht eingerichtet');
  const m = /^\/v1\/backups\/([0-9a-f]{32})(?:\/backups\/([0-9a-f-]{36})(?:\/(complete|parts\/(\d{1,5})))?)?$/.exec(path);
  if (!m) return fail(404, 'Nicht gefunden');
  const [, vaultId, backupId, action, partNo] = m as unknown as [string, string, string | undefined, string | undefined, string | undefined];
  const ts = now.toISOString();
  const db = env.DB;

  const token = bearer(req);
  if (!token) return fail(401, 'Zugang zum Tresor fehlt');
  const tokenHash = await hash(token);
  let vault = await db.prepare('SELECT * FROM backup_vaults WHERE id = ?').bind(vaultId).first<VaultRow>();

  // Tresor anlegen (nur für angemeldete ELW) oder mit dem Zugang öffnen
  if (req.method === 'PUT' && !backupId) {
    if (!vault) {
      const elwToken = req.headers.get('x-elvis-elw');
      const elw = elwToken ? await db.prepare('SELECT id FROM elws WHERE token_hash = ?').bind(await hash(elwToken)).first<{ id: string }>() : null;
      if (!elw) return fail(401, 'ELW nicht angemeldet');
      await db.prepare('INSERT INTO backup_vaults (id, token_hash, elw_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?)').bind(vaultId, tokenHash, elw.id, ts, ts).run();
      vault = (await db.prepare('SELECT * FROM backup_vaults WHERE id = ?').bind(vaultId).first<VaultRow>())!;
      return json(201, await info(env, vault));
    }
  }
  if (!vault || !sameCode(vault.token_hash, tokenHash)) return fail(404, 'Tresor nicht gefunden – Wiederherstellungsschlüssel prüfen');
  await db.prepare('UPDATE backup_vaults SET last_seen = ? WHERE id = ?').bind(ts, vault.id).run();

  if (!backupId) {
    if (req.method === 'GET' || req.method === 'PUT') return json(200, await info(env, vault));
    return fail(405, 'Nicht erlaubt');
  }

  // Neues Backup beginnen: POST …/backups/<id> mit der von ELVIS gewählten UUID
  const backup = await db.prepare('SELECT * FROM backups WHERE id = ? AND vault_id = ?').bind(backupId, vault.id).first<BackupRow>();
  if (!action && req.method === 'POST') {
    if (backup) return fail(409, 'Backup gibt es schon');
    const parsed = createSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, 'Angaben zum Backup ungültig');
    await db.prepare("INSERT INTO backups (id, vault_id, status, meta, created_at) VALUES (?, ?, 'uploading', ?, ?)").bind(backupId, vault.id, parsed.data.meta, ts).run();
    return json(201, null);
  }
  if (!backup) return fail(404, 'Backup nicht gefunden');

  if (!action && req.method === 'DELETE') {
    await removeBackup(env, vault.id, backup);
    return json(204, null);
  }

  if (partNo !== undefined) {
    const n = Number(partNo);
    if (req.method === 'PUT') {
      if (backup.status !== 'uploading') return fail(409, 'Backup ist bereits abgeschlossen');
      const data = new Uint8Array(await req.arrayBuffer());
      if (data.byteLength > MAX_PART_BYTES) return fail(413, 'Teil zu groß');
      await env.BACKUPS.put(partKey(vault.id, backup.id, n), data);
      await db.prepare('INSERT INTO backup_parts (backup_id, n, size) VALUES (?, ?, ?) ON CONFLICT(backup_id, n) DO UPDATE SET size = excluded.size').bind(backup.id, n, data.byteLength).run();
      return json(204, null);
    }
    if (req.method === 'GET') {
      if (backup.status !== 'complete' || n >= backup.parts) return fail(404, 'Teil nicht gefunden');
      const obj = await env.BACKUPS.get(partKey(vault.id, backup.id, n));
      if (!obj) return fail(404, 'Teil nicht gefunden');
      return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream' } });
    }
    return fail(405, 'Nicht erlaubt');
  }

  if (action === 'complete' && req.method === 'POST') {
    if (backup.status !== 'uploading') return fail(409, 'Backup ist bereits abgeschlossen');
    const parsed = completeSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, 'Angaben zum Backup ungültig');
    const { parts, size } = parsed.data;
    const stored = (await db.prepare('SELECT n, size FROM backup_parts WHERE backup_id = ? ORDER BY n').bind(backup.id).all<{ n: number; size: number }>()).results;
    if (stored.length !== parts || stored.some((p, i) => p.n !== i) || stored.reduce((s, p) => s + p.size, 0) !== size) return fail(400, 'Teile unvollständig');

    const quota = quotaOf(env, vault);
    if (size > quota.maxBytes) {
      await removeBackup(env, vault.id, { id: backup.id, parts });
      return fail(413, 'Backup größer als das Kontingent');
    }
    // Ältere Backups weichen, bis das neue in das Kontingent passt
    const older = await completed(db, vault.id);
    let used = older.reduce((s, r) => s + r.size, 0);
    while (older.length && (older.length + 1 > quota.maxBackups || used + size > quota.maxBytes)) {
      const oldest = older.pop()!;
      used -= oldest.size;
      await removeBackup(env, vault.id, oldest);
    }
    await db.prepare("UPDATE backups SET status = 'complete', size = ?, parts = ?, created_at = ? WHERE id = ?").bind(size, parts, ts, backup.id).run();
    return json(200, entry({ ...backup, status: 'complete', size, parts, created_at: ts }));
  }

  return fail(405, 'Nicht erlaubt');
}

/** Stündlich: abgebrochene Uploads und lange nicht genutzte Tresore löschen */
export async function backupCleanup(env: BackupEnv, now = new Date()): Promise<void> {
  if (!env.BACKUPS) return;
  const before = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const stale = await env.DB.prepare("SELECT id, vault_id, parts FROM backups WHERE status = 'uploading' AND created_at < ?").bind(before(UPLOAD_TTL_MS)).all<{ id: string; vault_id: string; parts: number }>();
  for (const b of stale.results) await removeBackup(env, b.vault_id, b);
  const vaults = await env.DB.prepare('SELECT id FROM backup_vaults WHERE last_seen < ?').bind(before(VAULT_TTL_MS)).all<{ id: string }>();
  for (const v of vaults.results) {
    const all = await env.DB.prepare('SELECT id, parts FROM backups WHERE vault_id = ?').bind(v.id).all<{ id: string; parts: number }>();
    for (const b of all.results) await removeBackup(env, v.id, b);
    await env.DB.prepare('DELETE FROM backup_vaults WHERE id = ?').bind(v.id).run();
  }
}
