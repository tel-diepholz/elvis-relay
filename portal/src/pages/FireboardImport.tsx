import { useMemo, useState, type FormEvent } from 'react';
import { Check, Copy, Download, MapPinned, X } from 'lucide-react';
import { api, type Me, type PortalRecord, type RecordDataMap } from '../api';
import { fireboardSource, type FireboardCategory, type FireboardItem, type FireboardLibrary } from '../../../src/fireboardprotocol';
import { locate, type Place } from '../geo';
import { NearbyIndex } from '../nearby';

type TypeRec = PortalRecord & { data: RecordDataMap['objectType'] };
type ObjRec = PortalRecord & { data: RecordDataMap['object'] };

/** Ziel einer Kategorie: vorhandener Typ (uid), neuer Typ (Name) oder nicht importieren */
type Target = { kind: 'type'; uid: string } | { kind: 'new'; name: string } | { kind: 'skip' };

/** So viele Objekte je Aufruf (die Cloud schreibt jedes einzeln) */
const BATCH = 50;
const NEW_TYPE_COLORS = ['#7c3aed', '#0891b2', '#ca8a04', '#db2777', '#16a34a', '#ea580c'];

const label = (c: FireboardCategory) => c.path.join(' › ');

/** Zu importierendes Objekt mit Zielknoten */
type Entry = { nodeId: string; data: RecordDataMap['object'] };

/** Radius, in dem eine Wasserentnahmestelle gleicher Art als möglicher Doppeleintrag gilt */
const NEAR_M = 10;

/**
 * Rückfragen vor dem Import:
 * - area: Wasserentnahmestelle liegt außerhalb der eigenen Gebietskörperschaft (place null = außerhalb Deutschlands);
 *   bei „Ja“ geht sie an die Gemeinde, in der sie liegt (nur mit Pflegerecht dort)
 * - near: im Umkreis von 10 m gibt es schon eine Wasserentnahmestelle gleicher Art (in der Bibliothek oder im Import)
 */
type Question =
  | { kind: 'area'; item: FireboardItem; place: Place | null; allowed: boolean }
  | { kind: 'near'; item: FireboardItem; other: { name: string; art: string | null; distance: number; inImport: boolean } };

/** Zwischenstand zwischen den Rückfragen */
interface Pass {
  /** Fertig entschieden (Nicht-Wasser und Wasser nach allen Prüfungen) */
  entries: Entry[];
  /** Wasserentnahmestellen vor der Nachbarschaftsprüfung */
  water: { item: FireboardItem; entry: Entry }[];
  created: number;
  moved: number;
  skipped: { no: number; noRight: number; outside: number; near: number };
}
interface Review {
  queue: Question[];
  index: number;
  /** Mit „Ja“ beantwortet (Fireboard-ID) */
  yes: Set<number>;
  pass: Pass;
}
const newName = (c: FireboardCategory) => c.path.at(-1)!.slice(0, 60);

/**
 * Einsatzbibliothek aus Fireboard übernehmen: Das Relay meldet sich mit den hier eingegebenen Zugangsdaten einmal bei
 * Fireboard an und liefert Kategorien und Objekte (gespeichert wird davon nichts). Je Kategorie wählt man den Zieltyp
 * (Vorschlag: Hydranten, Brunnen … → Wasserentnahmestelle mit Art und DN, Sonderobjekte → Einsatzobjekt). Schon
 * importierte Objekte (Herkunft fireboard:<id>) werden übersprungen, der Import lässt sich also wiederholen.
 */
export function FireboardImport({
  nodeId,
  ownArs,
  me,
  types,
  objects,
  onDone,
  onClose,
}: {
  nodeId: string;
  /** Gebietskörperschaft des Bereichs (bei freien Knoten die darüber); '' = Deutschland, null = unbekannt */
  ownArs: string | null;
  me: Me;
  types: TypeRec[];
  objects: ObjRec[];
  onDone: (msg: string) => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [lib, setLib] = useState<FireboardLibrary | null>(null);
  const [targets, setTargets] = useState<Record<number, Target>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Rückfragen (Lage, Nachbarschaft) mit „Für alle weiteren so verfahren“
  const [review, setReview] = useState<Review | null>(null);
  const [forAll, setForAll] = useState(false);

  // Vordefinierte Typen (Wasserentnahmestelle, Einsatzobjekt) an ihrem Kennzeichen erkennen
  const waterUid = types.find((t) => t.data.builtin === 'water')?.uid ?? null;
  const siteUid = types.find((t) => t.data.builtin === 'site')?.uid ?? null;
  const known = useMemo(() => new Set(objects.map((o) => o.data.source).filter(Boolean)), [objects]);

  const suggest = (c: FireboardCategory): Target => {
    if (c.suggestion === 'water' && waterUid) return { kind: 'type', uid: waterUid };
    if (c.suggestion === 'site' && siteUid) return { kind: 'type', uid: siteUid };
    // Gleichnamiger vorhandener Typ (z. B. von einem früheren Import), sonst neu
    const same = types.find((t) => t.data.name.toLowerCase() === newName(c).toLowerCase());
    return same ? { kind: 'type', uid: same.uid } : { kind: 'new', name: newName(c) };
  };

  /** Gewähltes Ziel; ohne eigene Wahl der Vorschlag (aus den aktuell geladenen Typen) */
  const targetOf = (c: FireboardCategory): Target => targets[c.id] ?? suggest(c);

  const fetchLibrary = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy('Anmeldung bei Fireboard und Abruf der Daten …');
    try {
      const l = await api.fireboard(nodeId, email, password);
      setLib(l);
      setTargets({});
      setPassword('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pending = (c: FireboardCategory) => lib!.items.filter((i) => i.categoryId === c.id && !known.has(fireboardSource(i.id)));

  /** Pflegerecht an einer Gemeinde: Betreiber, oder Pflegen/Verwalten an ihr bzw. einer Gebietskörperschaft darüber */
  const mayEditArs = (ars: string) =>
    me.operator || me.memberships.some((m) => (m.role === 'editor' || m.role === 'admin') && m.node.id.startsWith('ars:') && ars.startsWith(m.node.id.slice(4)));

  /** Objekte gruppiert nach Zielknoten in Paketen importieren */
  const importEntries = async (pass: Pass) => {
    const { entries, skipped } = pass;
    let done = 0;
    let failed = 0;
    let duplicate = 0;
    const byNode = new Map<string, RecordDataMap['object'][]>();
    for (const e of entries) byNode.set(e.nodeId, [...(byNode.get(e.nodeId) ?? []), e.data]);
    let sent = 0;
    for (const [target, items] of byNode) {
      for (let k = 0; k < items.length; k += BATCH) {
        sent += Math.min(BATCH, items.length - k);
        setBusy(`Importiere ${sent} von ${entries.length} Objekten …`);
        const r = await api.importRecords(target, 'object', items.slice(k, k + BATCH));
        done += r.created;
        failed += r.errors.length;
        duplicate += r.skipped ?? 0;
      }
    }
    const notes = [
      pass.created ? `${pass.created} neue Typen` : '',
      pass.moved ? `${pass.moved} anderen Gebietskörperschaften zugeordnet` : '',
      duplicate ? `${duplicate} schon vorhanden` : '',
      skipped.near ? `${skipped.near} mögliche Doppeleinträge nicht importiert` : '',
      skipped.no ? `${skipped.no} außerhalb nicht importiert` : '',
      skipped.noRight ? `${skipped.noRight} ohne Pflegerecht am Zielgebiet nicht importiert` : '',
      skipped.outside ? `${skipped.outside} außerhalb Deutschlands nicht importiert` : '',
      failed ? `${failed} abgelehnt` : '',
    ].filter(Boolean);
    onDone(`${done} Objekte aus Fireboard übernommen${notes.length ? ` (${notes.join(', ')})` : ''}`);
  };

  /** Gleiche Art: beide ohne Angabe oder gleich; fehlt sie nur bei einem, gilt es als gleich (lieber einmal zu oft fragen) */
  const sameArt = (a: unknown, b: unknown) => !a || !b || a === b;

  /**
   * Nachbarschaftsprüfung: Wasserentnahmestellen gleicher Art im Umkreis von 10 m – vorhandene in der Bibliothek (dieser
   * Bereich und die Zielgebiete) und solche, die im selben Import davor kommen
   */
  const checkNearby = async (pass: Pass) => {
    setBusy('Prüfe auf Wasserentnahmestellen in der Nähe …');
    type Point = { lat: number; lon: number; name: string; art: string | null; inImport: boolean };
    const index = new NearbyIndex<Point>();
    const add = (o: RecordDataMap['object'], inImport: boolean) => index.add({ lat: o.lat, lon: o.lon, name: o.name, art: typeof o.props.art === 'string' ? o.props.art : null, inImport });
    for (const o of objects) if (o.data.typeUid === waterUid) add(o.data, false);
    // Zielgebiete anderer Gemeinden: deren Bibliothek kennt dieser Bereich nicht
    for (const target of new Set(pass.water.map((w) => w.entry.nodeId).filter((n) => n !== nodeId))) {
      for (const o of await api.records(target, 'object')) if (o.data.typeUid === waterUid) add(o.data, false);
    }
    const queue: Question[] = [];
    for (const w of pass.water) {
      const art = (w.entry.data.props.art as string | undefined) ?? null;
      const near = index.nearest(w.entry.data, NEAR_M, (p) => sameArt(p.art, art));
      if (near) queue.push({ kind: 'near', item: w.item, other: { name: near.hit.name, art: near.hit.art, distance: near.distance, inImport: near.hit.inImport } });
      add(w.entry.data, true);
    }
    const asked = new Set(queue.map((q) => q.item.id));
    const next: Pass = { ...pass, entries: [...pass.entries, ...pass.water.filter((w) => !asked.has(w.item.id)).map((w) => w.entry)], water: pass.water.filter((w) => asked.has(w.item.id)) };
    if (queue.length) {
      setForAll(false);
      setReview({ queue, index: 0, yes: new Set(), pass: next });
      return;
    }
    await importEntries(next);
  };

  /** Alle Rückfragen einer Art beantwortet: übernehmen und weiter (Lage → Nachbarschaft → Import) */
  const finishReview = async (r: Review) => {
    setReview(null);
    setError(null);
    try {
      const pass: Pass = { ...r.pass, skipped: { ...r.pass.skipped }, water: [...r.pass.water], entries: [...r.pass.entries] };
      if (r.queue[0]?.kind === 'area') {
        for (const q of r.queue as Extract<Question, { kind: 'area' }>[]) {
          const w = pass.water.find((x) => x.item.id === q.item.id)!;
          pass.water = pass.water.filter((x) => x !== w);
          if (!r.yes.has(q.item.id)) pass.skipped.no++;
          else if (!q.place) pass.skipped.outside++;
          else if (!q.allowed) pass.skipped.noRight++;
          else (pass.water.push({ item: w.item, entry: { ...w.entry, nodeId: `ars:${q.place.ars}` } }), pass.moved++);
        }
        // Für die Lage zurückgehaltene, aber eigene Wasserentnahmestellen stehen schon in pass.water
        await checkNearby(pass);
      } else {
        for (const w of pass.water) {
          if (r.yes.has(w.item.id)) pass.entries.push(w.entry);
          else pass.skipped.near++;
        }
        pass.water = [];
        await importEntries(pass);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const answer = (yes: boolean) => {
    if (!review) return;
    const next = new Set(review.yes);
    // „Für alle weiteren“: diese und alle folgenden gleich entscheiden
    const upto = forAll ? review.queue.length : review.index + 1;
    for (let k = review.index; k < upto; k++) if (yes) next.add(review.queue[k]!.item.id);
    if (upto >= review.queue.length) void finishReview({ ...review, yes: next });
    else setReview({ ...review, index: upto, yes: next });
  };

  const run = async () => {
    if (!lib) return;
    setError(null);
    try {
      // Neue Typen zuerst (gleicher Name = ein Typ)
      const created = new Map<string, string>();
      for (const c of lib.categories) {
        const t = targetOf(c);
        if (t?.kind !== 'new' || created.has(t.name) || !pending(c).length) continue;
        setBusy(`Lege Typ „${t.name}“ an …`);
        const rec = await api.createRecord(nodeId, 'objectType', {
          name: t.name,
          icon: 'MapPin',
          color: NEW_TYPE_COLORS[created.size % NEW_TYPE_COLORS.length]!,
          fields: [],
          builtin: null,
          visibility: 'both',
          sort: 100 + created.size,
        });
        created.set(t.name, rec.uid);
      }
      const pass: Pass = { entries: [], water: [], created: created.size, moved: 0, skipped: { no: 0, noRight: 0, outside: 0, near: 0 } };
      for (const c of lib.categories) {
        const t = targetOf(c);
        if (!t || t.kind === 'skip') continue;
        const typeUid = t.kind === 'new' ? created.get(t.name)! : t.uid;
        const isWater = typeUid === waterUid;
        for (const i of pending(c)) {
          const props: Record<string, string | number> = {};
          if (isWater && i.art) props.art = i.art;
          if (isWater && i.dn) props.dn = i.dn;
          const entry: Entry = { nodeId, data: { typeUid, name: i.name, lat: i.lat, lon: i.lon, address: i.address, notes: i.notes, props, source: fireboardSource(i.id), geometry: null } };
          if (isWater) pass.water.push({ item: i, entry });
          else pass.entries.push(entry);
        }
      }
      // Wasserentnahmestellen: liegen sie in der eigenen Gebietskörperschaft? (Deutschland als Bereich: immer)
      const queue: Question[] = [];
      if (ownArs) {
        for (let k = 0; k < pass.water.length; k++) {
          if (k % 200 === 0) setBusy(`Prüfe Lage der Wasserentnahmestellen … ${k} von ${pass.water.length}`);
          const { item } = pass.water[k]!;
          const place = await locate(item.lat, item.lon);
          if (!place || !place.ars.startsWith(ownArs)) queue.push({ kind: 'area', item, place, allowed: !!place && mayEditArs(place.ars) });
        }
      }
      if (queue.length) {
        setForAll(false);
        setReview({ queue, index: 0, yes: new Set(), pass });
        return;
      }
      await checkNearby(pass);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const typeOptions = types.filter((t) => t.data.builtin !== null || t.position !== 'below');
  const total = lib ? lib.categories.reduce((n, c) => n + (targetOf(c).kind === 'skip' ? 0 : pending(c).length), 0) : 0;
  const already = lib ? lib.items.filter((i) => known.has(fireboardSource(i.id))).length : 0;
  const attachments = lib ? lib.items.filter((i) => i.attachments > 0).length : 0;

  return (
    <div className="card record-form">
      <div className="row" style={{ alignItems: 'center' }}>
        <strong className="grow">
          <Download size={14} /> Aus Fireboard importieren
        </strong>
        <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={!!busy} aria-label="Schließen">
          <X size={14} />
        </button>
      </div>
      {!lib ? (
        <form onSubmit={(e) => void fetchLibrary(e)} style={{ display: 'grid', gap: 10 }}>
          <p className="small muted">
            Mit dem Fireboard-Zugang meldet sich die Cloud einmal bei Fireboard an und holt die Einsatzbibliothek (Kartenansicht). Zugangsdaten und Rohdaten werden nicht
            gespeichert. Die Objekte gehören danach zu diesem Bereich.
          </p>
          <label className="field">
            Fireboard-E-Mail
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
          </label>
          <label className="field">
            Fireboard-Passwort
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" required />
          </label>
          <div className="row">
            <button className="btn btn-primary" disabled={!!busy || !email || !password}>
              Daten abrufen
            </button>
          </div>
        </form>
      ) : review ? (
        <ReviewStep review={review} forAll={forAll} onForAll={setForAll} onAnswer={answer} />
      ) : (
        <>
          <p className="small muted">
            {lib.items.length} Objekte in {lib.categories.length} Kategorien
            {already ? `, davon ${already} schon importiert (werden übersprungen)` : ''}.
            {lib.withoutPosition ? ` ${lib.withoutPosition} Objekte haben in Fireboard keine Koordinaten und fehlen.` : ''}
            {lib.documents ? ` ${lib.documents} Dokumente ohne Ort werden nicht übernommen.` : ''}
            {attachments ? ` Dateien an ${attachments} Objekten bleiben in Fireboard.` : ''}
          </p>
          <div className="fb-table">
            <table>
              <thead>
                <tr>
                  <th>Fireboard-Kategorie</th>
                  <th>Neu</th>
                  <th>Typ in der Bibliothek</th>
                </tr>
              </thead>
              <tbody>
                {lib.categories.map((c) => {
                  const t = targetOf(c);
                  const value = t.kind === 'type' ? t.uid : t.kind === 'new' ? `new:${t.name}` : 'skip';
                  return (
                    <tr key={c.id}>
                      <td>{label(c)}</td>
                      <td>{pending(c).length}</td>
                      <td>
                        <select
                          value={value}
                          disabled={!!busy}
                          onChange={(e) => {
                            const v = e.target.value;
                            setTargets({ ...targets, [c.id]: v === 'skip' ? { kind: 'skip' } : v.startsWith('new:') ? { kind: 'new', name: v.slice(4) } : { kind: 'type', uid: v } });
                          }}
                        >
                          {typeOptions.map((o) => (
                            <option key={o.uid} value={o.uid}>
                              {o.data.name}
                            </option>
                          ))}
                          <option value={`new:${newName(c)}`}>Neuer Typ „{newName(c)}“</option>
                          <option value="skip">nicht importieren</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row">
            <button className="btn btn-primary" disabled={!!busy || total === 0} onClick={() => void run()}>
              {total} Objekte importieren
            </button>
            <button className="btn btn-ghost" disabled={!!busy} onClick={() => setLib(null)}>
              Zurück
            </button>
          </div>
        </>
      )}
      {busy && <p className="notice">{busy}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

const fmtArt = (art: string | null) => (art ? ` (${art})` : '');

/** Rückfrage: Lage außerhalb der eigenen Gebietskörperschaft bzw. mögliche Doppeleinträge */
function ReviewStep({ review, forAll, onForAll, onAnswer }: { review: Review; forAll: boolean; onForAll: (v: boolean) => void; onAnswer: (yes: boolean) => void }) {
  const q = review.queue[review.index]!;
  const rest = review.queue.length - review.index;
  const item = q.item;
  return (
    <div className="fb-review">
      <p className="small muted">
        {q.kind === 'area' ? <MapPinned size={14} /> : <Copy size={14} />}{' '}
        {q.kind === 'area'
          ? `${review.queue.length} Wasserentnahmestellen liegen außerhalb Ihrer Gebietskörperschaft`
          : `${review.queue.length} Wasserentnahmestellen haben im Umkreis von ${NEAR_M} m schon eine gleicher Art`}{' '}
        – noch {rest} zu entscheiden.
      </p>
      <p>
        <strong>{item.name}</strong>
        {fmtArt(item.art)}
        {item.address && item.address !== item.name && <span className="muted"> – {item.address}</span>}{' '}
        {q.kind === 'area' ? (
          q.place ? (
            <>
              liegt in <strong>{q.place.name}</strong>. Der Gebietskörperschaft {q.place.name} zuordnen?
            </>
          ) : (
            <>liegt außerhalb Deutschlands bzw. der Gemeindegrenzen. Importieren geht nicht.</>
          )
        ) : (
          <>
            – {Math.round(q.other.distance)} m entfernt {q.other.inImport ? 'kommt im selben Import schon' : 'gibt es schon'} <strong>{q.other.name}</strong>
            {fmtArt(q.other.art)}. Wirklich importieren?
          </>
        )}
      </p>
      {q.kind === 'area' && q.place && !q.allowed && <p className="notice small">Sie haben in {q.place.name} kein Pflegerecht – bei „Ja“ wird sie trotzdem nicht importiert.</p>}
      <p className="muted small">
        Lage: {item.lat.toFixed(5)}, {item.lon.toFixed(5)} · bei „Nein“ wird sie nicht importiert.
      </p>
      <div className="row" style={{ alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={() => onAnswer(true)} disabled={q.kind === 'area' && !q.place}>
          <Check size={14} /> {q.kind === 'area' ? 'Ja, zuordnen' : 'Ja, importieren'}
        </button>
        <button className="btn" onClick={() => onAnswer(false)}>
          <X size={14} /> Nein
        </button>
        <label className="check-inline">
          <input type="checkbox" checked={forAll} onChange={(e) => onForAll(e.target.checked)} /> Für alle weiteren Wasserentnahmestellen so verfahren
        </label>
      </div>
    </div>
  );
}
