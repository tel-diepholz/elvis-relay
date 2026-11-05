import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Database, Lock, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api, type PortalRecord, type RecordDataMap, type RecordKind } from '../api';

const KINDS: { kind: RecordKind; label: string; one: string; hint: string }[] = [
  { kind: 'force', one: 'Kraft', label: 'Kräfte', hint: 'Einheiten und Fahrzeuge zur Auswahl in der Lage. Sichtbar für alle Installationen darüber und darunter.' },
  { kind: 'keyword', one: 'Stichwort', label: 'Einsatzstichworte', hint: 'Auswahl bei Brand/Technische Hilfe. Sichtbar darüber und darunter.' },
  { kind: 'role', one: 'Rolle', label: 'Rollen', hint: 'Rollen in der Lage, die Benutzer nach der Anmeldung wählen. Gelten für alle Installationen darunter.' },
  { kind: 'user', one: 'Benutzer', label: 'Benutzer', hint: 'Anmeldung an ELVIS. Die PIN setzt ein Admin in der jeweiligen Installation. Gelten für alle Installationen darunter.' },
  { kind: 'taskTemplate', one: 'Vorlage', label: 'Aufgabenvorlagen', hint: 'Aufgaben, die beim Öffnen einer Lage entstehen. Gelten für alle Installationen darunter.' },
];

type Rec<K extends RecordKind> = PortalRecord & { data: RecordDataMap[K] };

const fmtMin = (m: number) => (m % 1440 === 0 ? `${m / 1440} d` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);

function title(r: PortalRecord): string {
  const d = r.data as Record<string, unknown>;
  if (r.kind === 'user') return `${d.firstName as string} ${d.lastName as string}`;
  if (r.kind === 'taskTemplate') return d.summary as string;
  return d.name as string;
}

function detail(r: PortalRecord, names: Map<string, string>): string {
  if (r.kind === 'force') {
    const d = r.data as RecordDataMap['force'];
    const s = d.strength;
    return [d.callsign, d.organization, `${s.leaders}/${s.subLeaders}/${s.crew}/${s.leaders + s.subLeaders + s.crew}`, d.members.length ? `mit ${d.members.map((m) => names.get(m.uid) ?? '?').join(', ')}` : '']
      .filter(Boolean)
      .join(' · ');
  }
  if (r.kind === 'role') return (r.data as RecordDataMap['role']).description;
  if (r.kind === 'user') return (r.data as RecordDataMap['user']).isAdmin ? 'Admin' : '';
  if (r.kind === 'taskTemplate') {
    const d = r.data as RecordDataMap['taskTemplate'];
    return [
      d.roleUid ? `an ${names.get(d.roleUid) ?? '?'}` : 'an alle',
      d.intervalMinutes ? `alle ${fmtMin(d.intervalMinutes)}` : d.offsetMinutes !== null ? `nach ${fmtMin(d.offsetMinutes)}` : 'ohne Termin',
      d.documentTemplateName ? `Vorlage ${d.documentTemplateName}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return '';
}

function origin(r: PortalRecord): ReactNode {
  if (r.position === 'here') return null;
  return <span className="badge">{r.position === 'above' ? `von ${r.nodeName}` : `aus ${r.nodeName}`}</span>;
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="field grow">
    {label}
    {children}
  </label>
);
const num = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.round(Number(v.replace(',', '.')))));

/** Formular je Art; liefert die Daten des Datensatzes */
function RecordForm({ kind, initial, all, roles, onSubmit, onCancel }: { kind: RecordKind; initial: Record<string, unknown> | null; all: PortalRecord[]; roles: PortalRecord[]; onSubmit: (data: unknown) => void; onCancel: () => void }) {
  const [v, setV] = useState<Record<string, unknown>>(() => ({ ...(initial ?? {}) }));
  const set = (k: string) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const str = (k: string) => (v[k] as string | undefined) ?? '';
  const strength = (v.strength as RecordDataMap['force']['strength'] | undefined) ?? { leaders: 0, subLeaders: 0, crew: 0 };
  const members = (v.members as RecordDataMap['force']['members'] | undefined) ?? [];
  const [addMember, setAddMember] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const sortNext = Math.max(-1, ...all.map((r) => ((r.data as { sort?: number }).sort ?? 0))) + 1;
    switch (kind) {
      case 'force':
        return onSubmit({ ...v, name: str('name'), callsign: str('callsign'), organization: str('organization'), email: str('email'), mobile: str('mobile'), notes: str('notes'), strength, members });
      case 'keyword':
        return onSubmit({ name: str('name'), sort: (v.sort as number | undefined) ?? sortNext });
      case 'role':
        return onSubmit({ name: str('name'), description: str('description'), sort: (v.sort as number | undefined) ?? sortNext });
      case 'user':
        return onSubmit({ firstName: str('firstName'), lastName: str('lastName'), isAdmin: !!v.isAdmin });
      case 'taskTemplate':
        return onSubmit({
          summary: str('summary'),
          description: str('description'),
          roleUid: (v.roleUid as string | null | undefined) || null,
          documentTemplateName: str('documentTemplateName') || null,
          intervalMinutes: typeof v.intervalMinutes === 'string' ? num(v.intervalMinutes) : ((v.intervalMinutes as number | null | undefined) ?? null),
          offsetMinutes: typeof v.offsetMinutes === 'string' ? num(v.offsetMinutes) : ((v.offsetMinutes as number | null | undefined) ?? null),
          sort: (v.sort as number | undefined) ?? sortNext,
        });
    }
  };

  const others = all.filter((r) => r.kind === 'force' && r.data && (r.data as { name?: string }).name && !members.some((m) => m.uid === r.uid) && r.uid !== (initial as { uid?: string } | null)?.uid);
  return (
    <form className="card record-form" onSubmit={submit}>
      {kind === 'force' && (
        <>
          <div className="row">
            <Field label="Name *">
              <input required maxLength={100} value={str('name')} onChange={set('name')} autoFocus placeholder="z. B. HLF 20 Leeste" />
            </Field>
            <Field label="Funkrufname">
              <input maxLength={100} value={str('callsign')} onChange={set('callsign')} placeholder="Florian Weyhe 12-46-1" />
            </Field>
            <Field label="Organisation">
              <input maxLength={100} value={str('organization')} onChange={set('organization')} placeholder="FF Weyhe" />
            </Field>
          </div>
          <div className="row">
            {(['leaders', 'subLeaders', 'crew'] as const).map((k, i) => (
              <Field key={k} label={['Führer', 'Unterführer', 'Mannschaft'][i]!}>
                <input inputMode="numeric" value={String(strength[k])} onChange={(e) => setV((x) => ({ ...x, strength: { ...strength, [k]: num(e.target.value) ?? 0 } }))} />
              </Field>
            ))}
            <Field label="E-Mail">
              <input type="email" maxLength={200} value={str('email')} onChange={set('email')} />
            </Field>
            <Field label="Mobil">
              <input type="tel" maxLength={40} value={str('mobile')} onChange={set('mobile')} />
            </Field>
          </div>
          <Field label="Bemerkung">
            <input maxLength={1000} value={str('notes')} onChange={set('notes')} />
          </Field>
          <div className="field">
            Untereinheiten
            {members.length > 0 && (
              <ul className="list">
                {members.map((m, i) => (
                  <li key={m.uid}>
                    <span className="grow">{title(all.find((r) => r.uid === m.uid) ?? ({ kind: 'force', data: { name: '?' } } as PortalRecord))}</span>
                    <input aria-label="Funktion" placeholder="Funktion, z. B. 1. Zug" style={{ maxWidth: 220 }} value={m.role} onChange={(e) => setV((x) => ({ ...x, members: members.map((mm, j) => (j === i ? { ...mm, role: e.target.value } : mm)) }))} />
                    <button type="button" className="btn btn-sm btn-icon btn-ghost" aria-label="Entfernen" onClick={() => setV((x) => ({ ...x, members: members.filter((_, j) => j !== i) }))}>
                      <X size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="row">
              <select aria-label="Untereinheit hinzufügen" value={addMember} onChange={(e) => setAddMember(e.target.value)} className="grow">
                <option value="">Untereinheit wählen …</option>
                {others.map((r) => (
                  <option key={r.uid} value={r.uid}>
                    {title(r)} {r.position !== 'here' ? `(${r.nodeName})` : ''}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn-sm" disabled={!addMember} onClick={() => (setV((x) => ({ ...x, members: [...members, { uid: addMember, role: '' }] })), setAddMember(''))}>
                <Plus size={14} /> Hinzufügen
              </button>
            </div>
          </div>
        </>
      )}
      {kind === 'keyword' && (
        <Field label="Stichwort *">
          <input required maxLength={40} value={str('name')} onChange={set('name')} autoFocus placeholder="z. B. TH 1, B 3" />
        </Field>
      )}
      {kind === 'role' && (
        <div className="row">
          <Field label="Name *">
            <input required maxLength={60} value={str('name')} onChange={set('name')} autoFocus placeholder="z. B. Einsatzleiter" />
          </Field>
          <Field label="Beschreibung">
            <input maxLength={300} value={str('description')} onChange={set('description')} />
          </Field>
        </div>
      )}
      {kind === 'user' && (
        <div className="row">
          <Field label="Vorname *">
            <input required maxLength={60} value={str('firstName')} onChange={set('firstName')} autoFocus />
          </Field>
          <Field label="Nachname *">
            <input required maxLength={60} value={str('lastName')} onChange={set('lastName')} />
          </Field>
          <label className="check-inline">
            <input type="checkbox" checked={!!v.isAdmin} onChange={(e) => setV((x) => ({ ...x, isAdmin: e.target.checked }))} /> Admin in ELVIS
          </label>
        </div>
      )}
      {kind === 'taskTemplate' && (
        <>
          <Field label="Aufgabe *">
            <input required maxLength={200} value={str('summary')} onChange={set('summary')} autoFocus placeholder="z. B. Lagemeldung an die Leitstelle" />
          </Field>
          <Field label="Beschreibung">
            <input maxLength={2000} value={str('description')} onChange={set('description')} />
          </Field>
          <div className="row">
            <Field label="Rolle">
              <select value={(v.roleUid as string | null | undefined) ?? ''} onChange={(e) => setV((x) => ({ ...x, roleUid: e.target.value || null }))}>
                <option value="">an alle</option>
                {roles.map((r) => (
                  <option key={r.uid} value={r.uid}>
                    {title(r)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Nach (Minuten ab Beginn)">
              <input inputMode="numeric" value={v.offsetMinutes === null || v.offsetMinutes === undefined ? '' : String(v.offsetMinutes)} onChange={set('offsetMinutes')} placeholder="ohne Termin" />
            </Field>
            <Field label="Wiederholen alle (Minuten)">
              <input inputMode="numeric" value={v.intervalMinutes === null || v.intervalMinutes === undefined ? '' : String(v.intervalMinutes)} onChange={set('intervalMinutes')} placeholder="einmalig" />
            </Field>
            <Field label="Dokumentvorlage (Dateiname)">
              <input maxLength={200} value={str('documentTemplateName')} onChange={set('documentTemplateName')} placeholder="z. B. Lagemeldung.docx" />
            </Field>
          </div>
        </>
      )}
      <div className="row">
        <button className="btn btn-primary">Speichern</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}

/** Stammdaten eines Knotens: eigene, geerbte (von oben) und – bei Kräften und Stichworten – die der Unterknoten */
export function RecordsSection({ nodeId, canEdit }: { nodeId: string; canEdit: boolean }) {
  const [kind, setKind] = useState<RecordKind>('force');
  const [records, setRecords] = useState<PortalRecord[] | null>(null);
  const [roles, setRoles] = useState<PortalRecord[]>([]);
  const [forces, setForces] = useState<PortalRecord[]>([]);
  const [editing, setEditing] = useState<PortalRecord | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, r, f] = await Promise.all([api.records(nodeId, kind), api.records(nodeId, 'role'), api.records(nodeId, 'force')]);
      setRecords(list);
      setRoles(r);
      setForces(f);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [nodeId, kind]);
  useEffect(() => {
    setRecords(null);
    setEditing(null);
    setError(null);
    void load();
  }, [load]);

  const act = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const names = new Map([...roles, ...forces].map((r) => [r.uid, title(r)]));
  const info = KINDS.find((k) => k.kind === kind)!;
  const sorted = [...(records ?? [])].sort((a, b) => {
    const order = { above: 0, here: 1, below: 2 } as const;
    const sa = (a.data as { sort?: number }).sort ?? 0;
    const sb = (b.data as { sort?: number }).sort ?? 0;
    return order[a.position] - order[b.position] || sa - sb || title(a).localeCompare(title(b), 'de');
  });

  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <Database size={18} /> Stammdaten
        </h2>
        {canEdit && editing === null && (
          <button className="btn btn-sm" onClick={() => setEditing('new')}>
            <Plus size={14} /> {info.one}
          </button>
        )}
      </div>
      <div className="tabs" role="tablist">
        {KINDS.map((k) => (
          <button key={k.kind} role="tab" aria-selected={kind === k.kind} className={`tab ${kind === k.kind ? 'active' : ''}`} onClick={() => setKind(k.kind)}>
            {k.label}
          </button>
        ))}
      </div>
      <p className="muted small">{info.hint}</p>
      {error && <p className="error">{error}</p>}
      {editing === 'new' && (
        <RecordForm kind={kind} initial={null} all={kind === 'force' ? forces : (records ?? [])} roles={roles} onCancel={() => setEditing(null)} onSubmit={(data) => void act(() => api.createRecord(nodeId, kind, data as never))} />
      )}
      {records === null ? (
        <p className="muted">Lädt …</p>
      ) : sorted.length === 0 ? (
        <p className="muted">Noch keine.</p>
      ) : (
        <ul className="list">
          {sorted.map((r) =>
            editing !== 'new' && editing?.uid === r.uid ? (
              <li key={r.uid}>
                <div className="grow">
                  <RecordForm
                    kind={kind}
                    initial={{ ...(r.data as object), uid: r.uid }}
                    all={kind === 'force' ? forces : sorted}
                    roles={roles}
                    onCancel={() => setEditing(null)}
                    onSubmit={(data) => {
                      const { uid: _uid, ...clean } = data as Record<string, unknown>;
                      void act(() => api.updateRecord(r.uid, r.rev, clean as never));
                    }}
                  />
                </div>
              </li>
            ) : (
              <li key={r.uid}>
                <div className="grow">
                  <div className="title">{title(r)}</div>
                  <div className="small muted">{detail(r, names)}</div>
                </div>
                {origin(r)}
                {r.editable ? (
                  <>
                    <button className="btn btn-sm btn-icon btn-ghost" aria-label={`${title(r)} bearbeiten`} onClick={() => setEditing(r)}>
                      <Pencil size={16} />
                    </button>
                    <button className="btn btn-sm btn-icon btn-ghost" aria-label={`${title(r)} löschen`} onClick={() => window.confirm(`„${title(r)}“ löschen? Die Installationen entfernen es beim nächsten Abgleich.`) && void act(() => api.removeRecord(r.uid, r.rev))}>
                      <Trash2 size={16} />
                    </button>
                  </>
                ) : (
                  <span title="Hier nur lesbar" className="muted">
                    <Lock size={14} />
                  </span>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
