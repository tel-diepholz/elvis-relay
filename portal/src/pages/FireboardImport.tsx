import { useMemo, useState, type FormEvent } from 'react';
import { Download, X } from 'lucide-react';
import { api, type PortalRecord, type RecordDataMap } from '../api';
import { fireboardSource, type FireboardCategory, type FireboardLibrary } from '../../../src/fireboardprotocol';

type TypeRec = PortalRecord & { data: RecordDataMap['objectType'] };
type ObjRec = PortalRecord & { data: RecordDataMap['object'] };

/** Ziel einer Kategorie: vorhandener Typ (uid), neuer Typ (Name) oder nicht importieren */
type Target = { kind: 'type'; uid: string } | { kind: 'new'; name: string } | { kind: 'skip' };

/** So viele Objekte je Aufruf (die Cloud schreibt jedes einzeln) */
const BATCH = 50;
const NEW_TYPE_COLORS = ['#7c3aed', '#0891b2', '#ca8a04', '#db2777', '#16a34a', '#ea580c'];

const label = (c: FireboardCategory) => c.path.join(' › ');
const newName = (c: FireboardCategory) => c.path.at(-1)!.slice(0, 60);

/**
 * Einsatzbibliothek aus Fireboard übernehmen: Das Relay meldet sich mit den hier eingegebenen Zugangsdaten einmal bei
 * Fireboard an und liefert Kategorien und Objekte (gespeichert wird davon nichts). Je Kategorie wählt man den Zieltyp
 * (Vorschlag: Hydranten, Brunnen … → Wasserentnahmestelle mit Art und DN, Sonderobjekte → Einsatzobjekt). Schon
 * importierte Objekte (Herkunft fireboard:<id>) werden übersprungen, der Import lässt sich also wiederholen.
 */
export function FireboardImport({ nodeId, types, objects, onDone, onClose }: { nodeId: string; types: TypeRec[]; objects: ObjRec[]; onDone: (msg: string) => void; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [lib, setLib] = useState<FireboardLibrary | null>(null);
  const [targets, setTargets] = useState<Record<number, Target>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const fetchLibrary = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy('Anmeldung bei Fireboard und Abruf der Daten …');
    try {
      const l = await api.fireboard(nodeId, email, password);
      setLib(l);
      setTargets(Object.fromEntries(l.categories.map((c) => [c.id, suggest(c)])));
      setPassword('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const pending = (c: FireboardCategory) => lib!.items.filter((i) => i.categoryId === c.id && !known.has(fireboardSource(i.id)));

  const run = async () => {
    if (!lib) return;
    setError(null);
    try {
      // Neue Typen zuerst (gleicher Name = ein Typ)
      const created = new Map<string, string>();
      for (const c of lib.categories) {
        const t = targets[c.id];
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
      const items: RecordDataMap['object'][] = [];
      for (const c of lib.categories) {
        const t = targets[c.id];
        if (!t || t.kind === 'skip') continue;
        const typeUid = t.kind === 'new' ? created.get(t.name)! : t.uid;
        const water = typeUid === waterUid;
        for (const i of pending(c)) {
          const props: Record<string, string | number> = {};
          if (water && i.art) props.art = i.art;
          if (water && i.dn) props.dn = i.dn;
          items.push({ typeUid, name: i.name, lat: i.lat, lon: i.lon, address: i.address, notes: i.notes, props, source: fireboardSource(i.id), geometry: null });
        }
      }
      let done = 0;
      let failed = 0;
      for (let k = 0; k < items.length; k += BATCH) {
        setBusy(`Importiere ${Math.min(k + BATCH, items.length)} von ${items.length} Objekten …`);
        const r = await api.importRecords(nodeId, 'object', items.slice(k, k + BATCH));
        done += r.created;
        failed += r.errors.length;
      }
      onDone(`${done} Objekte aus Fireboard übernommen${created.size ? `, ${created.size} neue Typen` : ''}${failed ? `, ${failed} abgelehnt` : ''}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const typeOptions = types.filter((t) => t.data.builtin !== null || t.position !== 'below');
  const total = lib ? lib.categories.reduce((n, c) => n + (targets[c.id]?.kind === 'skip' ? 0 : pending(c).length), 0) : 0;
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
                  const t = targets[c.id] ?? { kind: 'skip' };
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
