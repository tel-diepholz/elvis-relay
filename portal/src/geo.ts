/**
 * In welcher Gemeinde liegt ein Punkt? Vereinfachte Gemeindegrenzen aus VG250 (© GeoBasis-DE / BKG, dl-de/by-2-0),
 * erzeugt mit scripts/build-boundaries.py: /geo/kreise.json (Umrisse je Kreis) und /geo/gem/<Kreis-ARS>.json
 * (Gemeinden mit Ringen, ganzzahlig in 1e-5 Grad, erster Punkt absolut, danach Differenzen). Geladen wird nur, was
 * ein Punkt braucht.
 */

type BBox = [number, number, number, number];
interface Gemeinde {
  ars: string;
  name: string;
  bbox: BBox;
  rings: number[][];
}
export interface Place {
  /** Regionalschlüssel der Gemeinde (12 Stellen) */
  ars: string;
  name: string;
}

let kreise: Promise<{ ars: string; bbox: BBox }[]> | null = null;
const gemeinden = new Map<string, Promise<Gemeinde[]>>();
const decoded = new WeakMap<number[], Float64Array>();

const getJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gemeindegrenzen nicht geladen (${res.status})`);
  return (await res.json()) as T;
};
const inBox = (b: BBox, lon: number, lat: number) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

function ring(r: number[]): Float64Array {
  let out = decoded.get(r);
  if (!out) {
    out = new Float64Array(r.length);
    let x = 0;
    let y = 0;
    for (let i = 0; i < r.length; i += 2) {
      x += r[i]!;
      y += r[i + 1]!;
      out[i] = x / 1e5;
      out[i + 1] = y / 1e5;
    }
    decoded.set(r, out);
  }
  return out;
}

/** Gerade-ungerade-Regel über alle Ringe (Löcher inklusive) */
function contains(g: Gemeinde, lon: number, lat: number): boolean {
  let inside = false;
  for (const r of g.rings) {
    const p = ring(r);
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const yi = p[i + 1]!;
      const yj = p[j + 1]!;
      if (yi > lat !== yj > lat && lon < ((p[j]! - p[i]!) * (lat - yi)) / (yj - yi) + p[i]!) inside = !inside;
    }
  }
  return inside;
}

/** Gemeinde zum Punkt; null außerhalb Deutschlands (bzw. der Grenzdaten) */
export async function locate(lat: number, lon: number): Promise<Place | null> {
  kreise ??= getJson<{ kreise: { ars: string; bbox: BBox }[] }>('/geo/kreise.json').then((m) => m.kreise);
  for (const k of await kreise) {
    if (!inBox(k.bbox, lon, lat)) continue;
    let list = gemeinden.get(k.ars);
    if (!list) gemeinden.set(k.ars, (list = getJson<Gemeinde[]>(`/geo/gem/${k.ars}.json`)));
    for (const g of await list) if (inBox(g.bbox, lon, lat) && contains(g, lon, lat)) return { ars: g.ars, name: g.name };
  }
  return null;
}

/** Gemeinden einer Gebietskörperschaft (Gemeinde, Verband, Kreis, Land) als Ringe [lat, lon] für die Karte; '' = keine */
export async function areaOf(ars: string): Promise<{ ars: string; name: string; rings: [number, number][][] }[]> {
  if (!ars) return [];
  kreise ??= getJson<{ kreise: { ars: string; bbox: BBox }[] }>('/geo/kreise.json').then((m) => m.kreise);
  const files = (await kreise).filter((k) => (ars.length >= 5 ? k.ars === ars.slice(0, 5) : k.ars.startsWith(ars)));
  const out: { ars: string; name: string; rings: [number, number][][] }[] = [];
  for (const k of files) {
    let list = gemeinden.get(k.ars);
    if (!list) gemeinden.set(k.ars, (list = getJson<Gemeinde[]>(`/geo/gem/${k.ars}.json`)));
    for (const g of await list) {
      if (!g.ars.startsWith(ars) && !ars.startsWith(g.ars)) continue;
      out.push({
        ars: g.ars,
        name: g.name,
        rings: g.rings.map((r) => {
          const p = ring(r);
          const pts: [number, number][] = [];
          for (let i = 0; i < p.length; i += 2) pts.push([p[i + 1]!, p[i]!]);
          return pts;
        }),
      });
    }
  }
  return out;
}
