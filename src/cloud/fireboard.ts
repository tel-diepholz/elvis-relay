import { z } from 'zod';
import type { FireboardCategory, FireboardItem, FireboardLibrary, FireboardSuggestion } from '../fireboardprotocol.js';

export const fireboardLoginSchema = z.object({
  nodeId: z.string().min(1).max(60),
  email: z.string().trim().email('E-Mail-Adresse ungültig').max(254),
  password: z.string().min(1, 'Passwort fehlt').max(200),
});

/**
 * Fireboard-Kartenbaum holen und aufbereiten. Anmeldung wie im Browser (Formular mit CSRF-Token, Sitzungscookie),
 * danach GET /map/tree/. Die Zugangsdaten verlassen diese Funktion nicht und werden nirgends gespeichert.
 */

const BASE = 'https://login.fireboard.net';
const TIMEOUT_MS = 30_000;
const UA = 'ELVIS-Relay Fireboard-Import (+https://einsatzleitwagen.app)';

export class FireboardError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

/** Einfacher Cookie-Speicher für die eine Sitzung */
class Jar {
  private readonly cookies = new Map<string, string>();
  take(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      if (i > 0) this.cookies.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export async function fetchFireboardTree(email: string, password: string, f: Fetch = fetch): Promise<unknown> {
  const jar = new Jar();
  const call = async (path: string, init: RequestInit = {}) => {
    try {
      const res = await f(`${BASE}${path}`, {
        ...init,
        redirect: 'manual',
        headers: { 'user-agent': UA, cookie: jar.header(), ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      jar.take(res);
      return res;
    } catch (e) {
      throw new FireboardError(502, `Fireboard nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const page = await call('/');
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())?.[1];
  if (!csrf) throw new FireboardError(502, 'Fireboard: Anmeldeseite unerwartet (kein CSRF-Token)');
  const form = new URLSearchParams({ _csrf: csrf, 'LoginForm[type]': 'standard-login', 'LoginForm[email]': email, 'LoginForm[password]': password });
  const login = await call('/', { method: 'POST', body: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  // Erfolg: Weiterleitung aufs Dashboard; sonst kommt das Formular mit Fehlermeldung zurück
  if (login.status !== 302 || !/dashboard/.test(login.headers.get('location') ?? '')) {
    await login.body?.cancel();
    throw new FireboardError(400, 'Anmeldung bei Fireboard fehlgeschlagen – E-Mail oder Passwort prüfen');
  }
  await login.body?.cancel();
  const tree = await call(`/map/tree/?_=${Date.now()}`, { headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' } });
  if (tree.status !== 200 || !(tree.headers.get('content-type') ?? '').includes('json')) {
    await tree.body?.cancel();
    throw new FireboardError(502, `Fireboard: Kartendaten nicht abrufbar (HTTP ${tree.status})`);
  }
  return tree.json();
}

// --- Aufbereiten ---

interface RawNode {
  type?: string;
  id?: number;
  title?: string | null;
  name?: string | null;
  comment?: string | null;
  address?: string | null;
  lat?: string | number | null;
  lng?: string | number | null;
  icon?: string | null;
  startdate?: string | null;
  starttime?: string | null;
  enddate?: string | null;
  endtime?: string | null;
  attachments?: number;
  cloud_attachments?: number;
  children?: RawNode[] | null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€' };

/** HTML der Beschreibung als Text: Absätze und Umbrüche als Zeilen, Tags weg, Entitäten aufgelöst */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h\d|tr)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
    )
    .replace(/[⁠​﻿]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ART = {
  ufh: 'Hydrant Unterflur',
  ofh: 'Hydrant Überflur',
  brunnen: 'Löschwasserbrunnen',
  teich: 'Löschteich',
  zisterne: 'Löschwasserbehälter / Zisterne',
  saug: 'Saugstelle',
  gewaesser: 'Offenes Gewässer',
} as const;

/** Art und Nennweite aus dem Fireboard-Symbol (z. B. unterflurhydrant_150.png), sonst aus dem Kategoriepfad */
export function waterKind(icon: string, path: string[]): { art: string | null; dn: number | null } {
  const file = (icon.split('/').pop() ?? '').replace(/\.\w+$/, '').toLowerCase();
  const num = (s: string | undefined) => (s ? Number(s) : null);
  let m: RegExpExecArray | null;
  let art: string | null = null;
  let dn: number | null = null;
  if ((m = /^unterflurhydrant(?:_(\d+))?$/.exec(file))) [art, dn] = [ART.ufh, num(m[1])];
  else if ((m = /^ueberflurhydrant(?:_(\d+))?$/.exec(file))) [art, dn] = [ART.ofh, num(m[1])];
  else if ((m = /^hydrantenschild(?:_(\d+))?$/.exec(file))) [art, dn] = [ART.ufh, num(m[1])];
  else if (/^hydrantenschild_brunnen/.test(file)) art = ART.brunnen;
  else if (/^hydrantenschild_zisterne/.test(file)) art = ART.zisterne;
  else if (/teich/.test(file)) art = ART.teich;
  else if (/^saugstelle/.test(file)) art = ART.saug;
  else if (file === 'hydrant_circle_double') art = ART.gewaesser;
  else if (file === 'hydrant_circle_narrow') art = ART.ufh;
  const where = path.join(' ').toLowerCase();
  if (!art) {
    if (/unterflur/.test(where)) art = ART.ufh;
    else if (/überflur|ueberflur/.test(where)) art = ART.ofh;
    else if (/zisterne/.test(where)) art = ART.zisterne;
    else if (/brunnen/.test(where)) art = ART.brunnen;
    else if (/teich/.test(where)) art = ART.teich;
    else if (/gewässer|offene wasser/.test(where)) art = ART.gewaesser;
    else if (/saug/.test(where)) art = ART.saug;
  }
  // Nennweite aus „H 150“ im Pfad, wenn das Symbol keine nennt
  if (dn === null) dn = num(/\bH (\d{2,3})\b/.exec(path.at(-1) ?? '')?.[1]);
  return { art, dn };
}

const isSite = (icon: string) => /sonderobjekt/.test(icon);

function fmtDate(d: string | null | undefined, t: string | null | undefined): string {
  if (!d) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return `${m ? `${m[3]}.${m[2]}.${m[1]}` : d}${t ? ` ${t.slice(0, 5)}` : ''}`;
}

/** Kartenbaum in Kategorien (mit Pfad und Vorschlag) und Objekte zerlegen */
export function normalizeFireboard(tree: unknown): FireboardLibrary {
  const categories: FireboardCategory[] = [];
  const items: FireboardItem[] = [];
  let documents = 0;
  let withoutPosition = 0;
  const walk = (nodes: RawNode[] | null | undefined, path: string[]) => {
    for (const n of nodes ?? []) {
      if (n.type === 'category') {
        const p = [...path, (n.title ?? n.name ?? '').trim() || 'Ohne Namen'];
        const own: FireboardItem[] = [];
        // Erst die direkten Objekte (für den Vorschlag), dann die Unterkategorien
        for (const c of n.children ?? []) if (c.type === 'poi') pushPoi(c, p, n.id!, own);
        if (own.length) {
          const water = own.filter((i) => i.art !== null).length;
          const site = (n.children ?? []).filter((c) => c.type === 'poi' && isSite(c.icon ?? '')).length;
          const suggestion: FireboardSuggestion = water * 2 > own.length ? 'water' : site * 2 > own.length ? 'site' : 'new';
          // Ohne Wasser-Vorschlag keine Art/DN an den Objekten
          if (suggestion !== 'water') for (const i of own) [i.art, i.dn] = [null, null];
          categories.push({ id: n.id!, path: p, count: own.length, suggestion });
          items.push(...own);
        }
        walk(
          (n.children ?? []).filter((c) => c.type !== 'poi'),
          p,
        );
      } else if (n.type === 'doi') {
        documents++;
      }
      // Objekte ohne Kategorie kommen in Fireboard nicht vor
    }
  };
  const pushPoi = (n: RawNode, path: string[], categoryId: number, out: FireboardItem[]) => {
    const lat = Number(n.lat);
    const lon = Number(n.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return void withoutPosition++;
    const { art, dn } = waterKind(n.icon ?? '', path);
    const from = fmtDate(n.startdate, n.starttime);
    const to = fmtDate(n.enddate, n.endtime);
    const notes = [htmlToText(n.comment ?? ''), from || to ? `Gültig: ${from || '…'} – ${to || '…'}` : '', `Fireboard: ${path.join(' › ')}`].filter(Boolean).join('\n\n');
    const name = htmlToText(n.name ?? '') || htmlToText(n.title ?? '') || htmlToText(n.address ?? '') || 'Ohne Namen';
    out.push({
      id: n.id!,
      categoryId,
      name: name.slice(0, 120),
      lat,
      lon,
      address: htmlToText(n.address ?? '').slice(0, 200),
      notes: notes.slice(0, 5000),
      art,
      dn: dn !== null && Number.isFinite(dn) ? dn : null,
      attachments: (n.attachments ?? 0) + (n.cloud_attachments ?? 0),
    });
  };
  walk(Array.isArray(tree) ? (tree as RawNode[]) : [], []);
  return { categories, items, documents, withoutPosition };
}
