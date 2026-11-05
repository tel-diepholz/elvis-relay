#!/usr/bin/env python3
"""Gemeindegrenzen für das Portal (portal/public/geo/) aus den Verwaltungsgebieten VG250 des BKG bauen.

Quelle: VG250 (Ebenen, Stand 01.01.), https://gdz.bkg.bund.de → Verwaltungsgebiete 1:250 000,
Datei vg250_01-01.utm32s.shape.ebenen.zip. © GeoBasis-DE / BKG (Jahr), Datenlizenz Deutschland – Namensnennung – 2.0.

Aufruf:  python3 scripts/build-boundaries.py <entpackter Ordner mit VG250_GEM.shp/.dbf> <Jahr>   (ohne Zusatzpakete)

Ausgabe:
- portal/public/geo/kreise.json: [{"ars": "03251", "name": "Diepholz", "bbox": [minLon, minLat, maxLon, maxLat]}, …]
- portal/public/geo/gem/<ARS des Kreises>.json: [{"ars": "032510037037", "name": "Stuhr", "bbox": […], "rings": [[lon0, lat0, dLon1, dLat1, …], …]}, …]
  `ars` ist der Schlüssel aus dem Kommunen-Katalog (src/regions.json), unter dem es den Knoten gibt – bei kreisfreien
  Städten also der des Kreises (z. B. 04011 Bremen).
  Koordinaten als ganze Zahlen in 1e-5 Grad (~1 m), erster Punkt absolut, danach Differenzen. Ringe mit Löchern; ein
  Punkt liegt in der Gemeinde, wenn er in einer ungeraden Zahl von Ringen liegt.
Vereinfacht mit Douglas-Peucker (TOLERANCE_M, unter der Genauigkeit von VG250).
"""
import json
import math
import struct
import sys
from pathlib import Path

TOLERANCE_M = 15.0
SCALE = 100000  # 1e-5 Grad ≈ 1 m


# --- DBF (dBASE III) ---

def read_dbf(path):
    data = path.read_bytes()
    n = struct.unpack('<I', data[4:8])[0]
    header_len, record_len = struct.unpack('<HH', data[8:12])
    fields, pos = [], 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b'\0')[0].decode('ascii')
        fields.append((name, data[pos + 16]))
        pos += 32
    records = []
    for i in range(n):
        off = header_len + i * record_len + 1
        rec = {}
        for name, length in fields:
            raw = data[off:off + length]
            off += length
            rec[name] = raw.decode('utf-8', errors='replace').strip()
        records.append(rec)
    return records


# --- SHP (Polygon, Typ 5) ---

def read_shp(path):
    data = path.read_bytes()
    pos, shapes = 100, []
    while pos < len(data):
        _, length = struct.unpack('>ii', data[pos:pos + 8])
        content = data[pos + 8:pos + 8 + length * 2]
        pos += 8 + length * 2
        shape_type = struct.unpack('<i', content[:4])[0]
        if shape_type == 0:
            shapes.append([])
            continue
        num_parts, num_points = struct.unpack('<ii', content[36:44])
        parts = list(struct.unpack(f'<{num_parts}i', content[44:44 + 4 * num_parts]))
        pts_off = 44 + 4 * num_parts
        coords = struct.unpack(f'<{2 * num_points}d', content[pts_off:pts_off + 16 * num_points])
        points = list(zip(coords[0::2], coords[1::2]))
        parts.append(num_points)
        shapes.append([points[parts[i]:parts[i + 1]] for i in range(num_parts)])
    return shapes


# --- UTM Zone 32N (ETRS89/GRS80) → geografisch (Snyder, USGS PP 1395) ---

A, F = 6378137.0, 1 / 298.257222101
E2 = F * (2 - F)
EP2 = E2 / (1 - E2)
K0, LON0 = 0.9996, math.radians(9)


def utm_to_lonlat(x, y):
    x -= 500000.0
    m = y / K0
    mu = m / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    s, c, t = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    n1 = A / math.sqrt(1 - E2 * s * s)
    t1 = t * t
    c1 = EP2 * c * c
    r1 = A * (1 - E2) / (1 - E2 * s * s) ** 1.5
    d = x / (n1 * K0)
    lat = phi1 - (n1 * t / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * EP2) * d ** 4 / 24
                                  + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * EP2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = LON0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * EP2 + 24 * t1 ** 2) * d ** 5 / 120) / c
    return math.degrees(lon), math.degrees(lat)


# --- Douglas-Peucker (in Metern, vor der Umrechnung) ---

def simplify(points, tol):
    if len(points) < 5:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = points[i], points[j]
        dx, dy = x2 - x1, y2 - y1
        seg = math.hypot(dx, dy) or 1e-9
        best, idx = 0.0, -1
        for k in range(i + 1, j):
            x, y = points[k]
            dist = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / seg
            if dist > best:
                best, idx = dist, k
        if best > tol and idx > 0:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    out = [p for p, k in zip(points, keep) if k]
    return out if len(out) >= 4 else points


def bbox(rings):
    xs, ys = [], []
    for r in rings:
        x = y = 0
        for i in range(0, len(r), 2):
            x += r[i]
            y += r[i + 1]
            xs.append(x)
            ys.append(y)
    return [min(xs) / SCALE, min(ys) / SCALE, max(xs) / SCALE, max(ys) / SCALE]


def catalog_key(ars, catalog):
    """Schlüssel, unter dem der Kommunen-Katalog (src/regions.json) die Gemeinde führt: kreisfreie Städte und
    gemeindefreie Gebiete gibt es dort nur als Kreis, verbandsfreie Gemeinden ohne Verband"""
    for key in (ars, ars[:9], ars[:5], ars[:2]):
        if key in catalog:
            return key
    return None


def main(src, year):
    src = Path(src)
    root = Path(__file__).resolve().parent.parent
    catalog = {r[0] for r in json.loads((root / 'src' / 'regions.json').read_text(encoding='utf-8'))}
    unknown = 0
    shapes = read_shp(src / 'VG250_GEM.shp')
    records = read_dbf(src / 'VG250_GEM.dbf')
    gemeinden = {}
    for rec, rings in zip(records, shapes):
        ars = rec['ARS']
        if not rings or len(ars) != 12:
            continue
        key = catalog_key(ars, catalog)
        if key is None:
            unknown += 1
            continue
        out = []
        for ring in rings:
            ll = [utm_to_lonlat(x, y) for x, y in simplify(ring, TOLERANCE_M)]
            ints = [(round(lon * SCALE), round(lat * SCALE)) for lon, lat in ll]
            flat, px, py = [], 0, 0
            for x, y in ints:
                if flat and x == px and y == py:
                    continue
                flat += [x - px, y - py]
                px, py = x, y
            out.append(flat)
        # Mehrere VG250-Flächen mit gleichem Katalogschlüssel (z. B. Stadtstaat) werden eine
        g = gemeinden.setdefault(key, {'ars': key, 'kreis': ars[:5], 'name': rec['GEN'], 'rings': []})
        g['rings'].extend(out)
    out_dir = root / 'portal' / 'public' / 'geo'
    (out_dir / 'gem').mkdir(parents=True, exist_ok=True)
    by_kreis = {}
    for g in gemeinden.values():
        g['bbox'] = bbox(g['rings'])
        by_kreis.setdefault(g['kreis'], []).append(g)
    kreise = []
    total = 0
    for k, gs in sorted(by_kreis.items()):
        gs.sort(key=lambda g: g['ars'])
        text = json.dumps([{'ars': g['ars'], 'name': g['name'], 'bbox': g['bbox'], 'rings': g['rings']} for g in gs], ensure_ascii=False, separators=(',', ':'))
        (out_dir / 'gem' / f'{k}.json').write_text(text, encoding='utf-8')
        total += len(text)
        boxes = [g['bbox'] for g in gs]
        kreise.append({'ars': k, 'bbox': [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]})
    meta = {'source': f'© GeoBasis-DE / BKG ({year}), dl-de/by-2-0, VG250 vereinfacht', 'kreise': kreise}
    (out_dir / 'kreise.json').write_text(json.dumps(meta, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(gemeinden)} Gebiete in {len(kreise)} Kreisen, {total / 1e6:.1f} MB, {unknown} ohne Katalogeintrag ausgelassen')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else '2026')
