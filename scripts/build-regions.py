#!/usr/bin/env python3
"""Kommunen-Katalog für das Cloud Messaging (src/regions.json) aus dem Gemeindeverzeichnis von Destatis bauen.

Quelle: Gemeindeverzeichnis-Informationssystem GV-ISys, Auszug „Gemeinden in Deutschland nach Fläche, Bevölkerung
und Postleitzahl“ (xlsx, jährlich zum 31.12.), https://www.destatis.de → Gemeindeverzeichnis → Administrativ.
© Statistisches Bundesamt (Destatis); Vervielfältigung und Verbreitung mit Quellenangabe gestattet.

Aufruf:  python3 scripts/build-regions.py 31122024_Auszug_GV.xlsx   (braucht openpyxl)

Ausgabe: Liste [ars, name, kind, parentArs] mit kind land | kreis | verband | gemeinde. Der Amtliche
Regionalschlüssel (ARS) ist präfix-hierarchisch: 03 Niedersachsen, 03251 Landkreis Diepholz, 032515402
Samtgemeinde Barnstorf, 032515402005 Barnstorf. Vereinfachungen für die Auswahl:
- Regierungsbezirke und Regionen werden übersprungen (Kreise hängen direkt am Land).
- Verbandsfreie Gemeinden hängen direkt am Kreis (der gleichnamige „Gemeindeverband“ entfällt).
- Kreisfreie Städte und Stadtstaaten, die nur aus einer Gemeinde bestehen, haben keine Unterebene.
- Gemeindefreie Gebiete (Forsten, Seen) fehlen.
"""
import json
import sys
from pathlib import Path

import openpyxl

KREIS = {'41': None, '42': 'Stadtkreis', '43': 'Kreis', '44': 'Landkreis', '45': 'Regionalverband'}
VERBAND = {'51': 'Amt', '52': 'Samtgemeinde', '53': 'Verbandsgemeinde', '54': 'Verwaltungsgemeinschaft',
           '55': 'Kirchspielslandgemeinde', '56': 'Verwaltungsverband', '58': None}


def label(prefix, name):
    return f'{prefix} {name}' if prefix and not name.startswith(prefix) else name


def main(src, out):
    wb = openpyxl.load_workbook(src, read_only=True)
    ws = next(s for s in wb.worksheets if s.title.startswith('Onlineprodukt'))
    lands, kreise, verbaende, gemeinden = [], [], {}, []
    for r in ws.iter_rows(min_row=7, values_only=True):
        satz, tk, land, rb, kreis, vb, gem, name = (r + (None,) * 8)[:8]
        if satz not in ('10', '40', '50', '60'):
            continue
        if satz == '10':
            lands.append((land, name))
        elif satz == '40':
            kreise.append((land + rb + kreis, land, label(KREIS.get(tk), name), tk))
        elif satz == '50':
            verbaende[land + rb + kreis + vb] = (label(VERBAND.get(tk), name), tk)
        elif tk not in ('65', '66'):
            gemeinden.append((land + rb + kreis + vb + gem, land + rb + kreis + vb, land + rb + kreis, name))

    by_verband, by_kreis = {}, {}
    for ars, vars_, kars, name in gemeinden:
        by_verband.setdefault(vars_, []).append((ars, name))
    rows = [[code, name, 'land', ''] for code, name in lands]
    kreis_children = {}
    for vars_, (vname, tk) in verbaende.items():
        members = by_verband.get(vars_, [])
        kars = vars_[:5]
        if tk == '50':
            kreis_children.setdefault(kars, []).extend([[a, n, 'gemeinde', kars] for a, n in members])
        else:
            kreis_children.setdefault(kars, []).append([vars_, vname, 'verband', kars])
            kreis_children[kars].extend([[a, n, 'gemeinde', vars_] for a, n in members])
    land_kreise = {}
    for kars, land, kname, tk in kreise:
        land_kreise.setdefault(land, []).append(kars)
        children = kreis_children.get(kars, [])
        rows.append([kars, kname, 'kreis', land])
        if not (tk in ('41', '42') and len(children) == 1):
            rows.extend(children)
    # Stadtstaaten mit nur einem Kreis (Berlin, Hamburg): keine Unterebene
    single = {land for land, ks in land_kreise.items() if len(ks) == 1 and not any(r[3] == ks[0] for r in rows)}
    rows = [r for r in rows if not (r[2] == 'kreis' and r[3] in single)]
    out.write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    counts = {k: sum(1 for r in rows if r[2] == k) for k in ('land', 'kreis', 'verband', 'gemeinde')}
    print(f'{out}: {len(rows)} Einträge {counts}')


if __name__ == '__main__':
    main(sys.argv[1], Path(__file__).resolve().parent.parent / 'src' / 'regions.json')
