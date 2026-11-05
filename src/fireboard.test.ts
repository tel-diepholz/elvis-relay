import { describe, expect, it } from 'vitest';
import { fetchFireboardTree, FireboardError, htmlToText, normalizeFireboard, waterKind } from './cloud/fireboard.js';

/** Ausschnitt im Aufbau des Fireboard-Kartenbaums (/map/tree/), Daten ausgedacht */
export const FIREBOARD_TREE = [
  {
    type: 'category',
    id: 1,
    title: 'Löschwasserversorgung',
    children: [
      {
        type: 'category',
        id: 2,
        title: 'Hydranten',
        children: [
          { type: 'poi', id: 101, title: 'Hauptstraße 1, 28816 Stuhr', name: '', address: 'Hauptstraße 1, 28816 Stuhr', lat: '53.01', lng: '8.78', icon: '/x/img/map/icons/unterflurhydrant_150.png', comment: '<p>Nummer 146<br />Vorne: 5,7m</p>', attachments: 0, cloud_attachments: 0 },
          { type: 'poi', id: 102, title: 'Ohne Ort', name: '', address: '', lat: '0.0000000000', lng: '0.0000000000', icon: '/x/hydrantenschild_100.png', comment: null, attachments: 0, cloud_attachments: 0 },
          {
            type: 'category',
            id: 3,
            title: 'H 200',
            children: [{ type: 'poi', id: 103, title: 'Am Markt', name: 'UFH Markt', address: '', lat: 53.02, lng: 8.79, icon: '/x/hydrant_circle_narrow.png', comment: '', attachments: 2, cloud_attachments: 0 }],
          },
        ],
      },
      { type: 'category', id: 4, title: 'Zisternen', children: [{ type: 'poi', id: 104, title: 'Hof Meyer', name: '', address: '', lat: '53.0', lng: '8.7', icon: '/x/hydrantenschild_zisterne.png', comment: '' }] },
    ],
  },
  {
    type: 'category',
    id: 5,
    title: 'Sonderobjekte',
    children: [{ type: 'poi', id: 105, title: 'Schule', name: 'Grundschule &amp; Hort', address: 'Schulweg 2', lat: '53.03', lng: '8.8', icon: '/x/sonderobjekt_rot_dach.png', comment: '<ul><li>BMA</li><li>FSD Haupteingang</li></ul>' }],
  },
  {
    type: 'category',
    id: 6,
    title: 'Osterfeuer',
    children: [
      { type: 'poi', id: 106, title: 'Feuer Brinkum', name: '', address: '', lat: '53.0', lng: '8.8', icon: '/x/feuer.png', comment: '', startdate: '2026-04-04', starttime: '18:00:00', enddate: '2026-04-05', endtime: null },
      { type: 'doi', id: 7, title: 'Telefonliste', comment: '0170 1234' },
    ],
  },
  { type: 'category', id: 8, title: 'Leer', children: null },
];

describe('Fireboard: Aufbereitung', () => {
  it('Art und Nennweite aus Symbol und Kategorie', () => {
    expect(waterKind('/i/unterflurhydrant_150.png', [])).toEqual({ art: 'Hydrant Unterflur', dn: 150 });
    expect(waterKind('/i/ueberflurhydrant.png', ['Hydranten', 'H 100'])).toEqual({ art: 'Hydrant Überflur', dn: 100 });
    expect(waterKind('/i/hydrantenschild_125.png', [])).toEqual({ art: 'Hydrant Unterflur', dn: 125 });
    expect(waterKind('/i/hydrantenschild_brunnen_pumpe.png', [])).toEqual({ art: 'Löschwasserbrunnen', dn: null });
    expect(waterKind('/i/hydrant_circle_double.png', [])).toEqual({ art: 'Offenes Gewässer', dn: null });
    expect(waterKind('/i/hydrant.png', ['Löschwasser', 'Zisternen'])).toEqual({ art: 'Löschwasserbehälter / Zisterne', dn: null });
    expect(waterKind('/i/feuer.png', ['Osterfeuer'])).toEqual({ art: null, dn: null });
  });

  it('HTML wird Text', () => {
    expect(htmlToText('<p>Nummer 146<br />Vorne: 5,7m</p><p>&Auml;rger &amp; mehr&#8203;</p>')).toBe('Nummer 146\nVorne: 5,7m\nÄrger & mehr');
    expect(htmlToText('<ul><li>BMA</li><li>FSD</li></ul>')).toBe('• BMA\n• FSD');
  });

  it('Kategorien mit Pfad und Vorschlag, Objekte mit Herkunftsdaten', () => {
    const lib = normalizeFireboard(FIREBOARD_TREE);
    expect(lib.categories.map((c) => [c.path.join(' › '), c.count, c.suggestion])).toEqual([
      ['Löschwasserversorgung › Hydranten', 1, 'water'],
      ['Löschwasserversorgung › Hydranten › H 200', 1, 'water'],
      ['Löschwasserversorgung › Zisternen', 1, 'water'],
      ['Sonderobjekte', 1, 'site'],
      ['Osterfeuer', 1, 'new'],
    ]);
    expect(lib).toMatchObject({ documents: 1, withoutPosition: 1 });
    const byId = (id: number) => lib.items.find((i) => i.id === id)!;
    expect(byId(101)).toMatchObject({ name: 'Hauptstraße 1, 28816 Stuhr', lat: 53.01, lon: 8.78, art: 'Hydrant Unterflur', dn: 150, notes: 'Nummer 146\nVorne: 5,7m\n\nFireboard: Löschwasserversorgung › Hydranten' });
    expect(byId(103)).toMatchObject({ name: 'UFH Markt', art: 'Hydrant Unterflur', dn: 200, attachments: 2 });
    expect(byId(104)).toMatchObject({ art: 'Löschwasserbehälter / Zisterne' });
    expect(byId(105)).toMatchObject({ name: 'Grundschule & Hort', art: null, notes: expect.stringContaining('• BMA\n• FSD Haupteingang') });
    expect(byId(106).notes).toContain('Gültig: 04.04.2026 18:00 – 05.04.2026');
  });
});

describe('Fireboard: Anmeldung und Abruf', () => {
  /** Fireboard im Kleinen: Anmeldeseite mit CSRF, Login (302 aufs Dashboard), Kartenbaum nur mit Sitzung */
  const fakeFireboard = (password = 'richtig') => {
    const calls: { method: string; path: string; cookie: string; body: string }[] = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ method: init.method ?? 'GET', path, cookie: headers.cookie ?? '', body: String(init.body ?? '') });
      if (path === '/' && (init.method ?? 'GET') === 'GET') return new Response('<input type="hidden" name="_csrf" value="tok==">', { headers: { 'set-cookie': '_csrf=c1; path=/' } });
      if (path === '/' && init.method === 'POST') {
        const form = new URLSearchParams(String(init.body));
        const ok = form.get('_csrf') === 'tok==' && form.get('LoginForm[password]') === password && headers.cookie?.includes('_csrf=c1');
        return ok ? new Response(null, { status: 302, headers: { location: '/dashboard', 'set-cookie': 'PHPSESSID=s1; path=/' } }) : new Response('<form>Falsches Passwort</form>');
      }
      if (path === '/map/tree/') {
        return headers.cookie?.includes('PHPSESSID=s1') ? Response.json(FIREBOARD_TREE) : new Response(null, { status: 302, headers: { location: '/unauthorized' } });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    return { f, calls };
  };

  it('meldet sich an und holt den Kartenbaum mit der Sitzung', async () => {
    const { f, calls } = fakeFireboard();
    const tree = await fetchFireboardTree('a@b.de', 'richtig', f);
    expect(normalizeFireboard(tree).items).toHaveLength(5);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /', 'POST /', 'GET /map/tree/']);
    expect(calls[1]!.body).toContain('LoginForm%5Bemail%5D=a%40b.de');
    expect(calls[2]!.cookie).toBe('_csrf=c1; PHPSESSID=s1');
  });

  it('falsches Passwort ist ein Eingabefehler', async () => {
    const { f } = fakeFireboard('anders');
    await expect(fetchFireboardTree('a@b.de', 'richtig', f)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Anmeldung bei Fireboard fehlgeschlagen/) });
    await expect(fetchFireboardTree('a@b.de', 'x', (async () => new Response('kaputt')) as unknown as typeof fetch)).rejects.toBeInstanceOf(FireboardError);
  });
});
