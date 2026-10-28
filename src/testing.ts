import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';

/** D1 im Speicher (nur das, was der Worker nutzt) */
export function fakeD1(): D1Database {
  const db = new Database(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const prepare = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => prepare(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } }),
  });
  return { prepare } as unknown as D1Database;
}

/** R2 im Speicher (put, get, delete) */
export function fakeR2(): R2Bucket & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const toBytes = (v: unknown) => (typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v as ArrayBuffer));
  return {
    objects,
    put: async (key: string, value: unknown) => void objects.set(key, toBytes(value)),
    get: async (key: string) => {
      const v = objects.get(key);
      return v ? { body: new Response(v as BodyInit).body, text: async () => new TextDecoder().decode(v) } : null;
    },
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  } as unknown as R2Bucket & { objects: Map<string, Uint8Array> };
}
