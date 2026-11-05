/**
 * Nachbarschaftssuche für Punkte (Wasserentnahmestellen): Raster mit Zellen von ~20 m, Abstand in Metern
 * (Äquirektangular-Näherung, auf 10 m genau genug).
 */

const CELL_DEG = 0.0002;
const M_PER_DEG = 111_320;

export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dx = (b.lon - a.lon) * M_PER_DEG * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const dy = (b.lat - a.lat) * M_PER_DEG;
  return Math.hypot(dx, dy);
}

export class NearbyIndex<T extends { lat: number; lon: number }> {
  private readonly cells = new Map<string, T[]>();
  private key = (lat: number, lon: number) => `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;

  add(p: T): void {
    const k = this.key(p.lat, p.lon);
    const list = this.cells.get(k);
    if (list) list.push(p);
    else this.cells.set(k, [p]);
  }

  /** Nächster Punkt innerhalb von `radiusM` (höchstens eine Zelle weit), der `accept` erfüllt */
  nearest(p: { lat: number; lon: number }, radiusM: number, accept: (t: T) => boolean): { hit: T; distance: number } | null {
    const cy = Math.floor(p.lat / CELL_DEG);
    const cx = Math.floor(p.lon / CELL_DEG);
    let best: { hit: T; distance: number } | null = null;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const t of this.cells.get(`${cy + dy}:${cx + dx}`) ?? []) {
          const d = distanceM(p, t);
          if (d <= radiusM && accept(t) && (!best || d < best.distance)) best = { hit: t, distance: d };
        }
      }
    }
    return best;
  }
}
