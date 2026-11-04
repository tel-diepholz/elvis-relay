import { fail, json } from './http.js';
import type { Region, RegionKind, RegionWithPath } from './messagingprotocol.js';
import RAW from './regions.json';

/**
 * Kommunen-Katalog für das Verzeichnis: Land › Kreis › Gemeindeverband › Gemeinde nach dem Amtlichen
 * Regionalschlüssel. Erzeugt mit scripts/build-regions.py aus dem Gemeindeverzeichnis (© Destatis).
 */

type Row = [ars: string, name: string, kind: RegionKind, parent: string];

interface Node {
  ars: string;
  name: string;
  kind: RegionKind;
  parent: string;
  children: Node[];
}

const ROOT = '';
let index: Map<string, Node> | null = null;

function load(): Map<string, Node> {
  if (index) return index;
  const map = new Map<string, Node>([[ROOT, { ars: ROOT, name: 'Deutschland', kind: 'land', parent: ROOT, children: [] }]]);
  for (const [ars, name, kind, parent] of RAW as Row[]) map.set(ars, { ars, name, kind, parent, children: [] });
  for (const n of map.values()) if (n.ars !== ROOT) map.get(n.parent)?.children.push(n);
  const collator = new Intl.Collator('de');
  for (const n of map.values()) n.children.sort((a, b) => collator.compare(a.name, b.name));
  return (index = map);
}

const brief = (n: Node): Region => ({ ars: n.ars, name: n.name, kind: n.kind, hasChildren: n.children.length > 0 });

/** Pfad ohne Deutschland, von oben nach unten */
function pathOf(n: Node): Region[] {
  const all = load();
  const out: Region[] = [];
  for (let x: Node | undefined = n; x && x.ars !== ROOT; x = all.get(x.parent)) out.unshift(brief(x));
  return out;
}

export function region(ars: string): RegionWithPath | null {
  const n = load().get(ars);
  return n ? { ...brief(n), path: pathOf(n) } : null;
}

/** Text für das Verzeichnis, z. B. „Niedersachsen › Landkreis Diepholz › Stuhr“ */
export const regionLabel = (ars: string) => (ars === ROOT ? 'Deutschland' : (region(ars)?.path.map((p) => p.name).join(' › ') ?? ''));

export const children = (ars: string): Region[] | null => load().get(ars)?.children.map(brief) ?? null;

const fold = (s: string) => s.toLocaleLowerCase('de').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');

/** Namenssuche; Treffer am Wortanfang vor Treffern im Wort, dann größere Einheiten vor Gemeinden */
export function search(q: string, limit = 30): RegionWithPath[] {
  const needle = fold(q.trim());
  if (needle.length < 2) return [];
  const order: Record<RegionKind, number> = { land: 0, kreis: 1, verband: 2, gemeinde: 3 };
  const hits: { n: Node; score: number }[] = [];
  for (const n of load().values()) {
    if (n.ars === ROOT) continue;
    const name = fold(n.name);
    const at = name.indexOf(needle);
    if (at < 0) continue;
    const word = at === 0 || /[\s,(-]/.test(name[at - 1]!);
    hits.push({ n, score: (word ? 0 : 10) + order[n.kind] });
  }
  hits.sort((a, b) => a.score - b.score || a.n.name.localeCompare(b.n.name, 'de'));
  return hits.slice(0, limit).map(({ n }) => ({ ...brief(n), path: pathOf(n) }));
}

const CACHE = { 'cache-control': 'public, max-age=86400' };

/** GET /v1/regions?parent=<ars> · ?q=<Name> · /v1/regions/<ars> (öffentlich) */
export function handleRegions(req: Request, path: string, url: URL): Response {
  if (req.method !== 'GET') return fail(405, 'Nur GET');
  const one = /^\/v1\/regions\/(\d{2}|\d{5}|\d{9}|\d{12})$/.exec(path);
  if (one) {
    const r = region(one[1]!);
    return r ? json(200, r, CACHE) : fail(404, 'Region unbekannt');
  }
  if (path !== '/v1/regions') return fail(404, 'Nicht gefunden');
  const q = url.searchParams.get('q');
  if (q !== null) return json(200, search(q), CACHE);
  const list = children(url.searchParams.get('parent') ?? ROOT);
  return list ? json(200, list, CACHE) : fail(404, 'Region unbekannt');
}
