import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Download, FileText, Library, Lock, Paperclip, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { FireboardImport } from './FireboardImport';
import { api, type PortalRecord, type RecordDataMap } from '../api';
import type { ObjectVisibility } from '../../../src/syncprotocol';

/**
 * Kacheln von OpenStreetMap. Die Seite sendet sonst keinen Referer (_headers: no-referrer); OSM sperrt Kachelabrufe
 * aus dem Browser ohne Referer („Access blocked“, Tile Usage Policy). Darum schicken nur die Kacheln den Origin mit.
 */
const OsmTiles = () => (
  <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap-Mitwirkende" maxZoom={19} referrerPolicy="strict-origin-when-cross-origin" />
);

type TypeRec = PortalRecord & { data: RecordDataMap['objectType'] };
type ObjRec = PortalRecord & { data: RecordDataMap['object'] };
type FileRec = PortalRecord & { data: RecordDataMap['objectFile'] };
type Field = RecordDataMap['objectType']['fields'][number];

const VISIBILITY: Record<ObjectVisibility, string> = { both: 'Bereiche darüber und darunter', down: 'Bereiche darunter', up: 'Bereiche darüber', own: 'nur der eigene Bereich' };
const FIELD_TYPES: Record<Field['type'], string> = { text: 'Text', longtext: 'Mehrzeilig', number: 'Zahl', select: 'Auswahl', bool: 'Ja/Nein', url: 'Link', phone: 'Telefon' };

const keyOf = (label: string, taken: string[]) => {
  const base =
    label
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'f$1')
      .slice(0, 36) || 'feld';
  let k = base;
  for (let n = 2; taken.includes(k); n++) k = `${base}_${n}`;
  return k;
};

const fmtValue = (f: Field, v: unknown) => (v === undefined || v === '' ? '' : f.type === 'bool' ? (v ? 'ja' : 'nein') : `${String(v)}${f.unit ? ` ${f.unit}` : ''}`);

const sha256 = async (buf: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field grow">
      {label}
      {children}
    </label>
  );
}

/** Kartenausschnitt auf die Objekte setzen, Klick setzt die Position (beim Bearbeiten) */
function MapControl({ points, onPick }: { points: [number, number][]; onPick?: (lat: number, lon: number) => void }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 1) map.setView(points[0]!, 16);
    else if (points.length > 1) map.fitBounds(points, { padding: [24, 24], maxZoom: 16 });
  }, [map, points.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useMapEvents({ click: (e) => onPick?.(e.latlng.lat, e.latlng.lng) });
  return null;
}

function TypeForm({ initial, onSubmit, onCancel }: { initial: RecordDataMap['objectType'] | null; onSubmit: (d: RecordDataMap['objectType']) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [icon, setIcon] = useState(initial?.icon ?? 'MapPin');
  const [color, setColor] = useState(initial?.color ?? '#7c3aed');
  const [visibility, setVisibility] = useState<ObjectVisibility>(initial?.visibility ?? 'both');
  const [fields, setFields] = useState<(Field & { isNew?: boolean; optionsText?: string })[]>(() => (initial?.fields ?? []).map((f) => ({ ...f, optionsText: f.options.join(', ') })));
  const set = (i: number, patch: Partial<Field & { optionsText: string }>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const keys: string[] = [];
    const out = fields
      .filter((f) => f.label.trim())
      .map((f) => {
        const key = f.isNew ? keyOf(f.label, [...keys, ...fields.filter((x) => !x.isNew).map((x) => x.key)]) : f.key;
        keys.push(key);
        return {
          key,
          label: f.label.trim(),
          type: f.type,
          options: f.type === 'select' ? (f.optionsText ?? '').split(',').map((o) => o.trim()).filter(Boolean) : [],
          unit: f.type === 'number' ? f.unit : '',
          badge: f.badge,
        };
      });
    onSubmit({ name, icon, color, visibility, fields: out, builtin: initial?.builtin ?? null, sort: initial?.sort ?? 100 });
  };
  return (
    <form className="card record-form" onSubmit={submit}>
      <div className="row">
        <Labeled label="Name *">
          <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Sammelplatz" autoFocus />
        </Labeled>
        <Labeled label="Symbol (Lucide-Name)">
          <input pattern="[A-Z][A-Za-z0-9]*" value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="z. B. Users, Flame, Droplet" />
        </Labeled>
        <label className="field">
          Farbe
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 64 }} />
        </label>
        <Labeled label="Sichtbar für">
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as ObjectVisibility)}>
            {Object.entries(VISIBILITY).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Labeled>
      </div>
      <div className="field">
        Felder
        {fields.map((f, i) => (
          <div key={i} className="row">
            <input aria-label="Beschriftung" placeholder="Beschriftung" value={f.label} onChange={(e) => set(i, { label: e.target.value })} className="grow" />
            <select aria-label="Art" value={f.type} onChange={(e) => set(i, { type: e.target.value as Field['type'] })} style={{ width: 'auto' }}>
              {Object.entries(FIELD_TYPES).map(([t, l]) => (
                <option key={t} value={t}>
                  {l}
                </option>
              ))}
            </select>
            {f.type === 'select' && <input aria-label="Werte" placeholder="Werte, mit Komma" value={f.optionsText ?? ''} onChange={(e) => set(i, { optionsText: e.target.value })} className="grow" />}
            {f.type === 'number' && <input aria-label="Einheit" placeholder="Einheit" value={f.unit} onChange={(e) => set(i, { unit: e.target.value })} style={{ width: 90 }} />}
            <label className="check-inline">
              <input type="checkbox" checked={f.badge} onChange={(e) => setFields((fs) => fs.map((x, j) => ({ ...x, badge: j === i ? e.target.checked : false })))} /> Schild
            </label>
            <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label="Feld entfernen" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}>
              <X size={16} />
            </button>
          </div>
        ))}
        <div>
          <button type="button" className="btn btn-sm" onClick={() => setFields((fs) => [...fs, { key: '', label: '', type: 'text', options: [], unit: '', badge: false, isNew: true }])}>
            <Plus size={14} /> Feld
          </button>
        </div>
      </div>
      <div className="row">
        <button className="btn btn-primary">Speichern</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}

function ObjectForm({ type, initial, files, canEdit, onSubmit, onCancel, onUpload, onRemoveFile }: {
  type: TypeRec;
  initial: ObjRec | null;
  files: FileRec[];
  canEdit: boolean;
  onSubmit: (d: RecordDataMap['object']) => void;
  onCancel: () => void;
  onUpload: (file: File) => void;
  onRemoveFile: (f: FileRec) => void;
}) {
  const d = initial?.data;
  const [name, setName] = useState(d?.name ?? '');
  const [address, setAddress] = useState(d?.address ?? '');
  const [notes, setNotes] = useState(d?.notes ?? '');
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(d ? { lat: d.lat, lon: d.lon } : null);
  const [props, setProps] = useState<Record<string, string | number | boolean>>(d?.props ?? {});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!pos) return;
    const clean: Record<string, string | number | boolean> = {};
    for (const f of type.data.fields) {
      const v = props[f.key];
      if (v === undefined || v === '') continue;
      clean[f.key] = f.type === 'number' ? Number(String(v).replace(',', '.')) : v;
    }
    onSubmit({ typeUid: type.uid, name, address, notes, lat: pos.lat, lon: pos.lon, props: clean, source: d?.source ?? null, geometry: d?.geometry ?? null });
  };
  return (
    <form className="card record-form" onSubmit={submit}>
      <fieldset disabled={!canEdit} className="plain">
        <div className="row">
          <Labeled label="Name *">
            <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Labeled>
          <Labeled label="Adresse">
            <input maxLength={200} value={address} onChange={(e) => setAddress(e.target.value)} />
          </Labeled>
          <Labeled label="Breite">
            <input inputMode="decimal" value={pos?.lat ?? ''} onChange={(e) => setPos({ lat: Number(e.target.value), lon: pos?.lon ?? 0 })} placeholder="in die Karte klicken" />
          </Labeled>
          <Labeled label="Länge">
            <input inputMode="decimal" value={pos?.lon ?? ''} onChange={(e) => setPos({ lat: pos?.lat ?? 0, lon: Number(e.target.value) })} />
          </Labeled>
        </div>
        <div className="mini-map">
          <MapContainer center={pos ? [pos.lat, pos.lon] : [52.8, 8.6]} zoom={pos ? 16 : 9} style={{ height: '100%' }}>
            <OsmTiles />
            <MapControl points={[]} onPick={canEdit ? (lat, lon) => setPos({ lat, lon }) : undefined} />
            {pos && <CircleMarker center={[pos.lat, pos.lon]} radius={9} pathOptions={{ color: '#fff', weight: 2, fillColor: type.data.color, fillOpacity: 1 }} />}
          </MapContainer>
        </div>
        {type.data.fields.length > 0 && (
          <div className="row">
            {type.data.fields.map((f) => (
              <Labeled key={f.key} label={f.unit ? `${f.label} (${f.unit})` : f.label}>
                {f.type === 'select' ? (
                  <select value={String(props[f.key] ?? '')} onChange={(e) => setProps((p) => ({ ...p, [f.key]: e.target.value }))}>
                    <option value="">–</option>
                    {f.options.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : f.type === 'bool' ? (
                  <select value={props[f.key] === undefined ? '' : props[f.key] ? 'ja' : 'nein'} onChange={(e) => setProps((p) => ({ ...p, [f.key]: e.target.value === '' ? '' : e.target.value === 'ja' }))}>
                    <option value="">–</option>
                    <option value="ja">ja</option>
                    <option value="nein">nein</option>
                  </select>
                ) : (
                  <input value={String(props[f.key] ?? '')} onChange={(e) => setProps((p) => ({ ...p, [f.key]: e.target.value }))} />
                )}
              </Labeled>
            ))}
          </div>
        )}
        <Labeled label="Bemerkung">
          <input maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Labeled>
      </fieldset>
      {initial && (
        <div className="field">
          Dateien
          {files.length > 0 && (
            <ul className="list">
              {files.map((f) => (
                <li key={f.uid}>
                  <FileText size={16} />
                  <a className="grow" href={`/v1/cloud/files/${f.uid}`} target="_blank" rel="noreferrer">
                    {f.data.filename}
                  </a>
                  <span className="small muted">{f.data.sizeBytes < 1024 ? `${f.data.sizeBytes} B` : f.data.sizeBytes < 1048576 ? `${Math.round(f.data.sizeBytes / 1024)} KB` : `${(f.data.sizeBytes / 1048576).toFixed(1)} MB`}</span>
                  {canEdit && f.editable && (
                    <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label={`${f.data.filename} entfernen`} onClick={() => onRemoveFile(f)}>
                      <X size={16} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <label className="btn btn-sm" style={{ justifySelf: 'start' }}>
              <Paperclip size={14} /> Datei anhängen
              <input type="file" hidden onChange={(e) => (e.target.files?.[0] && onUpload(e.target.files[0]), (e.target.value = ''))} />
            </label>
          )}
        </div>
      )}
      <div className="row">
        {canEdit && (
          <button className="btn btn-primary" disabled={!pos}>
            Speichern
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {canEdit ? 'Abbrechen' : 'Schließen'}
        </button>
      </div>
    </form>
  );
}

/** CSV mit Kopfzeile: name, lat, lon, address, notes und Feldschlüssel (z. B. dn, art); Trenner ; oder , */
export function parseCsv(text: string, type: TypeRec): { items: RecordDataMap['object'][]; errors: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { items: [], errors: ['Keine Daten'] };
  const sep = lines[0]!.includes(';') ? ';' : ',';
  const head = lines[0]!.split(sep).map((h) => h.trim().toLowerCase());
  const col = (row: string[], k: string) => row[head.indexOf(k)]?.trim() ?? '';
  const errors: string[] = [];
  const items: RecordDataMap['object'][] = [];
  lines.slice(1).forEach((line, i) => {
    const row = line.split(sep);
    const lat = Number(col(row, 'lat').replace(',', '.'));
    const lon = Number(col(row, 'lon').replace(',', '.'));
    if (!col(row, 'name') || !Number.isFinite(lat) || !Number.isFinite(lon) || !lat || !lon) return void errors.push(`Zeile ${i + 2}: Name, lat oder lon fehlt`);
    const props: Record<string, string | number | boolean> = {};
    for (const f of type.data.fields) {
      const v = col(row, f.key);
      if (!v) continue;
      props[f.key] = f.type === 'number' ? Number(v.replace(',', '.')) : f.type === 'bool' ? /^(ja|1|true|x)$/i.test(v) : v;
    }
    items.push({ typeUid: type.uid, name: col(row, 'name'), lat, lon, address: col(row, 'address'), notes: col(row, 'notes'), props, source: null, geometry: null });
  });
  return { items, errors };
}

/** Objektbibliothek eines Bereichs: Typen (mit Sichtbarkeit), Objekte auf der Karte, Dateien, Import */
export function LibrarySection({ nodeId, canEdit }: { nodeId: string; canEdit: boolean }) {
  const [types, setTypes] = useState<TypeRec[]>([]);
  const [objects, setObjects] = useState<ObjRec[]>([]);
  const [files, setFiles] = useState<FileRec[]>([]);
  const [typeUid, setTypeUid] = useState<string | null>(null);
  const [editingType, setEditingType] = useState<TypeRec | 'new' | null>(null);
  const [editing, setEditing] = useState<ObjRec | 'new' | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const [fireboard, setFireboard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, o, f] = await Promise.all([api.records(nodeId, 'objectType'), api.records(nodeId, 'object'), api.records(nodeId, 'objectFile')]);
      setTypes([...t].sort((a, b) => a.data.sort - b.data.sort || a.data.name.localeCompare(b.data.name, 'de')));
      setObjects(o);
      setFiles(f);
      setTypeUid((cur) => cur ?? t[0]?.uid ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [nodeId]);
  useEffect(() => void load(), [load]);

  const act = async (f: () => Promise<unknown>, ok?: string) => {
    setError(null);
    setNotice(null);
    try {
      await f();
      if (ok) setNotice(ok);
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const type = types.find((t) => t.uid === typeUid) ?? null;
  const shown = useMemo(() => objects.filter((o) => o.data.typeUid === typeUid), [objects, typeUid]);
  const points = useMemo(() => shown.map((o) => [o.data.lat, o.data.lon] as [number, number]), [shown]);
  const filesOf = (o: ObjRec) => files.filter((f) => f.data.objectUid === o.uid);
  const badgeField = type?.data.fields.find((f) => f.badge);

  const upload = async (o: ObjRec, file: File) => {
    const buf = await file.arrayBuffer();
    const uid = crypto.randomUUID();
    const res = await fetch(`/v1/cloud/files/${uid}?object=${o.uid}`, { method: 'PUT', body: buf, credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' } });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Fehler ${res.status}`);
    await api.createRecordWithUid(o.nodeId, 'objectFile', uid, { objectUid: o.uid, filename: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: buf.byteLength, sha256: await sha256(buf) });
  };

  const runImport = () => {
    if (!type || importText === null) return;
    const { items, errors } = parseCsv(importText, type);
    if (!items.length) return setError(errors.join('; ') || 'Nichts zu importieren');
    void act(async () => {
      const r = await api.importRecords(nodeId, 'object', items);
      setImportText(null);
      setNotice(`${r.created} ${type.data.name} importiert${r.errors.length + errors.length ? `, ${r.errors.length + errors.length} Zeilen übersprungen` : ''}`);
    });
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <Library size={18} /> Objektbibliothek
        </h2>
        {canEdit && editingType === null && (
          <span className="row">
            <button className="btn btn-sm" onClick={() => setFireboard(true)} disabled={fireboard}>
              <Download size={14} /> Aus Fireboard
            </button>
            <button className="btn btn-sm" onClick={() => setEditingType('new')}>
              <Plus size={14} /> Typ
            </button>
          </span>
        )}
      </div>
      <p className="muted small">Wasserentnahmestellen, Einsatzobjekte und eigene Typen. Wer die Objekte sieht, stellt der Typ ein; ELVIS zeigt sie unter Karte → Ebenen → Objektbibliothek.</p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="notice ok">{notice}</p>}
      {fireboard && (
        <FireboardImport
          nodeId={nodeId}
          types={types}
          objects={objects}
          onClose={() => setFireboard(false)}
          onDone={(msg) => {
            setFireboard(false);
            setNotice(msg);
            void load();
          }}
        />
      )}
      {editingType !== null && (
        <TypeForm
          initial={editingType === 'new' ? null : editingType.data}
          onCancel={() => setEditingType(null)}
          onSubmit={(d) =>
            void act(() => (editingType === 'new' ? api.createRecord(nodeId, 'objectType', d) : api.updateRecord(editingType.uid, editingType.rev, d))).then((ok) => ok && setEditingType(null))
          }
        />
      )}
      <div className="tabs" role="tablist">
        {types.map((t) => (
          <button key={t.uid} role="tab" aria-selected={t.uid === typeUid} className={`tab ${t.uid === typeUid ? 'active' : ''}`} onClick={() => (setTypeUid(t.uid), setEditing(null))}>
            <span className="dot" style={{ background: t.data.color }} /> {t.data.name} <span className="muted">{objects.filter((o) => o.data.typeUid === t.uid).length}</span>
          </button>
        ))}
      </div>
      {type && (
        <>
          <div className="row small muted" style={{ alignItems: 'center' }}>
            <span className="grow">
              Sichtbar für {VISIBILITY[type.data.visibility]} · gepflegt von {type.nodeName || 'Deutschland'}
              {type.data.builtin && ' (vordefiniert)'}
            </span>
            {type.editable ? (
              <button className="btn btn-sm btn-ghost" onClick={() => setEditingType(type)}>
                <Pencil size={14} /> Typ bearbeiten
              </button>
            ) : (
              <span title="Nur lesbar">
                <Lock size={14} />
              </span>
            )}
          </div>
          <div className="lib-map">
            <MapContainer center={[52.8, 8.6]} zoom={9} preferCanvas style={{ height: '100%' }}>
              <OsmTiles />
              <MapControl points={points} />
              {shown.map((o) => (
                <CircleMarker key={o.uid} center={[o.data.lat, o.data.lon]} radius={6} pathOptions={{ color: '#fff', weight: 2, fillColor: type.data.color, fillOpacity: o.position === 'here' ? 1 : 0.55 }} eventHandlers={{ click: () => setEditing(o) }}>
                  <Tooltip>
                    {o.data.name}
                    {badgeField && o.data.props[badgeField.key] !== undefined ? ` · ${fmtValue(badgeField, o.data.props[badgeField.key])}` : ''}
                  </Tooltip>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>
          {canEdit && editing === null && importText === null && (
            <div className="row">
              <button className="btn btn-sm" onClick={() => setEditing('new')}>
                <Plus size={14} /> {type.data.name}
              </button>
              <button className="btn btn-sm" onClick={() => setImportText('')}>
                <Upload size={14} /> CSV importieren
              </button>
            </div>
          )}
          {importText !== null && (
            <div className="card record-form">
              <p className="small muted">
                Kopfzeile mit <code>name;lat;lon</code>, optional <code>address;notes</code> und die Feldschlüssel {type.data.fields.map((f) => <code key={f.key}>{f.key}</code>).reduce<ReactNode[]>((a, c) => (a.length ? [...a, ', ', c] : [c]), [])}. Trenner Semikolon oder Komma. Die Objekte gehören zu diesem Bereich.
              </p>
              <label className="btn btn-sm" style={{ justifySelf: 'start' }}>
                <Upload size={14} /> Datei wählen
                <input type="file" accept=".csv,text/csv" hidden onChange={(e) => void e.target.files?.[0]?.text().then(setImportText)} />
              </label>
              <textarea rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={'name;lat;lon;dn\nH Lange Straße 1;52.95;8.85;100'} />
              <div className="row">
                <button className="btn btn-primary" disabled={!importText.trim()} onClick={runImport}>
                  Importieren ({parseCsv(importText, type).items.length})
                </button>
                <button className="btn btn-ghost" onClick={() => setImportText(null)}>
                  Abbrechen
                </button>
              </div>
            </div>
          )}
          {editing !== null && (
            <ObjectForm
              key={editing === 'new' ? 'new' : editing.uid}
              type={type}
              initial={editing === 'new' ? null : editing}
              files={editing === 'new' ? [] : filesOf(editing)}
              canEdit={canEdit && (editing === 'new' || editing.editable)}
              onCancel={() => setEditing(null)}
              onSubmit={(d) => void act(() => (editing === 'new' ? api.createRecord(nodeId, 'object', d) : api.updateRecord(editing.uid, editing.rev, d)), 'Gespeichert').then((ok) => ok && setEditing(null))}
              onUpload={(file) => editing !== 'new' && void act(() => upload(editing, file), `${file.name} angehängt`)}
              onRemoveFile={(f) => window.confirm(`„${f.data.filename}“ entfernen?`) && void act(() => api.removeRecord(f.uid, f.rev))}
            />
          )}
          <ul className="list">
            {shown.slice(0, 300).map((o) => (
              <li key={o.uid}>
                <div className="grow">
                  <button className="link-button title" onClick={() => setEditing(o)}>
                    {o.data.name}
                  </button>
                  <div className="small muted">
                    {[o.data.address, ...type.data.fields.filter((f) => f.type !== 'longtext').map((f) => (o.data.props[f.key] !== undefined ? `${f.label} ${fmtValue(f, o.data.props[f.key])}` : '')).filter(Boolean).slice(0, 3)].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {filesOf(o).length > 0 && (
                  <span className="small muted">
                    <Paperclip size={12} /> {filesOf(o).length}
                  </span>
                )}
                {o.position !== 'here' && <span className="badge">{o.position === 'above' ? `von ${o.nodeName}` : `aus ${o.nodeName}`}</span>}
                {o.editable && canEdit && (
                  <button className="btn btn-sm btn-icon btn-ghost" aria-label={`${o.data.name} löschen`} onClick={() => window.confirm(`„${o.data.name}“ löschen?`) && void act(() => api.removeRecord(o.uid, o.rev))}>
                    <Trash2 size={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {shown.length > 300 && <p className="small muted">300 von {shown.length} gezeigt – alle stehen auf der Karte.</p>}
        </>
      )}
    </section>
  );
}
