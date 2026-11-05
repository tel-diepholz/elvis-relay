import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, History, KeyRound, LogOut, MailCheck, Search, ShieldCheck, Trash2, Unlock, Users } from 'lucide-react';
import { ROLE_LABELS, api, type AdminAccount, type AdminLogEntry, type AdminOverview, type CloudNodeRef, type CloudRole, type Me, type RegionWithPath } from '../api';

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–');
const where = (n: CloudNodeRef) => n.path.join(' › ') || 'Deutschland';
const ROLES: CloudRole[] = ['viewer', 'editor', 'admin'];

const ACTION_LABEL: Record<AdminLogEntry['action'], string> = {
  edit: 'Bearbeitet',
  operator: 'Betreiber',
  disable: 'Gesperrt',
  enable: 'Entsperrt',
  'reset-link': 'Passwort-Link',
  verify: 'Bestätigt',
  unlock: 'Sperre aufgehoben',
  logout: 'Abgemeldet',
  delete: 'Gelöscht',
  role: 'Rolle',
};

/** Status eines Kontos als Kennzeichen */
function Badges({ a }: { a: AdminAccount }) {
  return (
    <span className="row" style={{ gap: 4, alignItems: 'center' }}>
      {a.operator && <span className="badge admin">Betreiber</span>}
      {a.disabledAt && <span className="badge bad">gesperrt</span>}
      {!a.emailVerified && <span className="badge warn">unbestätigt</span>}
      {!a.hasPassword && <span className="badge warn">ohne Passwort</span>}
      {a.lockedUntil && <span className="badge bad">Fehlversuche</span>}
    </span>
  );
}

/**
 * Verwaltung für Betreiber: alle Konten der Plattform suchen, Status sehen und verwalten (Name, Adresse, Betreiber,
 * sperren, Passwort-Link, bestätigen, abmelden, löschen, Rollen in allen Bereichen) und das Protokoll dazu.
 */
export function AdminPage({ me }: { me: Me }) {
  const [tab, setTab] = useState<'accounts' | 'log'>('accounts');
  const [data, setData] = useState<AdminOverview | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.adminOverview().then(setData, (e: Error) => setError(e.message)), []);
  useEffect(() => void load(), [load]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data?.accounts ?? []).filter((a) => !t || a.email.includes(t) || a.name.toLowerCase().includes(t));
  }, [data, q]);
  const replace = (a: AdminAccount | null, id: string) =>
    setData((d) => (d ? { ...d, accounts: a ? d.accounts.map((x) => (x.id === id ? a : x)) : d.accounts.filter((x) => x.id !== id) } : d));

  const count = (f: (a: AdminAccount) => boolean) => data?.accounts.filter(f).length ?? 0;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div>
        <h1>Verwaltung</h1>
        <p className="muted">Alle Konten von ELVIS Cloud. Neue Benutzer kommen über Einladungen an einem Bereich dazu.</p>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" className={`tab ${tab === 'accounts' ? 'active' : ''}`} aria-selected={tab === 'accounts'} onClick={() => setTab('accounts')}>
          <Users size={14} /> Benutzer {data && <span className="muted">{data.accounts.length}</span>}
        </button>
        <button role="tab" className={`tab ${tab === 'log' ? 'active' : ''}`} aria-selected={tab === 'log'} onClick={() => setTab('log')}>
          <History size={14} /> Protokoll
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {tab === 'log' ? (
        <AdminLog />
      ) : !data ? (
        <p className="muted">Lädt …</p>
      ) : (
        <section className="card" style={{ display: 'grid', gap: 12 }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <label className="grow admin-search">
              <Search size={16} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name oder E-Mail suchen" aria-label="Benutzer suchen" />
            </label>
            <span className="muted small">
              {count((a) => a.operator)} Betreiber · {count((a) => !!a.disabledAt)} gesperrt · {count((a) => !a.emailVerified)} unbestätigt · {count((a) => !a.hasPassword)} ohne Passwort
            </span>
          </div>
          <ul className="list">
            {shown.map((a) => (
              <li key={a.id} style={{ display: 'block' }}>
                <button className="admin-row" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>
                  {open === a.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="title">{a.name || '–'}</span> <span className="muted">{a.email}</span>
                    {a.id === me.id && <span className="muted"> (Sie)</span>}
                  </span>
                  <Badges a={a} />
                  <span className="muted small" title="Letzte Anmeldung">
                    {fmt(a.lastLoginAt)}
                  </span>
                  <span className="muted small">{a.memberships.length} Bereiche</span>
                </button>
                {open === a.id && <AccountDetail a={a} me={me} nodes={data.nodes} onChange={(next) => replace(next, a.id)} />}
              </li>
            ))}
            {shown.length === 0 && <li className="muted">Kein Treffer</li>}
          </ul>
        </section>
      )}
    </div>
  );
}

function AccountDetail({ a, me, nodes, onChange }: { a: AdminAccount; me: Me; nodes: CloudNodeRef[]; onChange: (a: AdminAccount | null) => void }) {
  const [name, setName] = useState(a.name);
  const [email, setEmail] = useState(a.email);
  const [nodeId, setNodeId] = useState('');
  const [role, setRole] = useState<CloudRole>('editor');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const self = a.id === me.id;

  const run = async (f: () => Promise<AdminAccount | null>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      onChange(await f());
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const saveIdentity = (e: FormEvent) => {
    e.preventDefault();
    const patch = { ...(name.trim() !== a.name && { name: name.trim() }), ...(email.trim().toLowerCase() !== a.email && { email: email.trim() }) };
    if (!Object.keys(patch).length) return;
    void run(() => api.adminPatch(a.id, patch), 'Gespeichert');
  };
  const confirmRun = (question: string, f: () => Promise<AdminAccount | null>, ok: string) => window.confirm(question) && void run(f, ok);

  return (
    <div className="admin-detail">
      <form onSubmit={saveIdentity} className="row">
        <label className="field grow">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        </label>
        <label className="field grow">
          E-Mail-Adresse
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <button className="btn" disabled={busy || (name.trim() === a.name && email.trim().toLowerCase() === a.email)}>
          Speichern
        </button>
      </form>
      <p className="muted small">
        Angelegt {fmt(a.createdAt)} · letzte Anmeldung {fmt(a.lastLoginAt)} · {a.sessions} aktive Anmeldungen
        {a.disabledAt && ` · gesperrt ${fmt(a.disabledAt)} von ${a.disabledBy}`}
        {a.lockedUntil && ` · nach Fehlversuchen gesperrt bis ${fmt(a.lockedUntil)}`}
      </p>

      <div className="row">
        <button className="btn btn-sm" disabled={busy || !!a.disabledAt} onClick={() => void run(() => api.adminAction(a.id, 'reset-link'), `Link zum Zurücksetzen an ${a.email} gesendet`)}>
          <KeyRound size={14} /> Passwort-Link senden
        </button>
        {!a.emailVerified && (
          <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => api.adminAction(a.id, 'verify'), 'Adresse als bestätigt markiert')}>
            <MailCheck size={14} /> Als bestätigt markieren
          </button>
        )}
        {a.lockedUntil && (
          <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => api.adminAction(a.id, 'unlock'), 'Sperre aufgehoben')}>
            <Unlock size={14} /> Fehlversuch-Sperre aufheben
          </button>
        )}
        {a.sessions > 0 && !self && (
          <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => api.adminAction(a.id, 'logout'), 'Überall abgemeldet')}>
            <LogOut size={14} /> Überall abmelden
          </button>
        )}
        {!self && (
          <>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                a.operator
                  ? confirmRun(`${a.email} das Betreiber-Recht entziehen?`, () => api.adminPatch(a.id, { operator: false }), 'Betreiber-Recht entzogen')
                  : confirmRun(`${a.email} zum Betreiber machen? Betreiber verwalten alle Bereiche und alle Konten.`, () => api.adminPatch(a.id, { operator: true }), 'Zum Betreiber ernannt')
              }
            >
              <ShieldCheck size={14} /> {a.operator ? 'Betreiber-Recht entziehen' : 'Zum Betreiber machen'}
            </button>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                a.disabledAt
                  ? void run(() => api.adminPatch(a.id, { disabled: false }), 'Entsperrt')
                  : confirmRun(`${a.email} sperren? Alle Anmeldungen enden sofort.`, () => api.adminPatch(a.id, { disabled: true }), 'Gesperrt')
              }
            >
              {a.disabledAt ? 'Entsperren' : 'Sperren'}
            </button>
            <button
              className="btn btn-sm"
              style={{ color: 'var(--bad)' }}
              disabled={busy}
              onClick={() => confirmRun(`Konto ${a.email} endgültig löschen? Rollen und Anmeldungen gehen verloren.`, async () => (await api.adminDelete(a.id), null), 'Gelöscht')}
            >
              <Trash2 size={14} /> Löschen
            </button>
          </>
        )}
      </div>

      <h3 className="small" style={{ margin: '8px 0 0' }}>
        Rollen in Bereichen
      </h3>
      {a.operator && <p className="muted small">Als Betreiber verwaltet {self ? 'Ihr Konto' : 'das Konto'} ohnehin alle Bereiche.</p>}
      <ul className="list">
        {a.memberships.map((m) => (
          <li key={m.node.id}>
            <span className="grow">{where(m.node)}</span>
            <select value={m.role} disabled={busy} onChange={(e) => void run(() => api.adminMembership(a.id, m.node.id, e.target.value as CloudRole), 'Rolle geändert')} aria-label={`Rolle in ${where(m.node)}`}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void run(() => api.adminMembership(a.id, m.node.id, null), 'Rolle entzogen')} aria-label={`Rolle in ${where(m.node)} entziehen`}>
              <Trash2 size={14} />
            </button>
          </li>
        ))}
        {a.memberships.length === 0 && <li className="muted small">Keine Rollen</li>}
      </ul>
      <div className="row">
        <AreaPicker nodes={nodes} value={nodeId} onChange={setNodeId} />
        <select value={role} onChange={(e) => setRole(e.target.value as CloudRole)} aria-label="Rolle">
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <button className="btn btn-sm" disabled={busy || !nodeId} onClick={() => void run(() => api.adminMembership(a.id, nodeId, role), 'Rolle vergeben').then(() => setNodeId(''))}>
          Rolle vergeben
        </button>
      </div>
      {msg && <p className={msg.ok ? 'notice ok' : 'error'}>{msg.text}</p>}
    </div>
  );
}

function AdminLog() {
  const [log, setLog] = useState<AdminLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api.adminLog().then(setLog, (e: Error) => setError(e.message)), []);
  if (error) return <p className="error">{error}</p>;
  if (!log) return <p className="muted">Lädt …</p>;
  return (
    <section className="card">
      {log.length === 0 ? (
        <p className="muted">Noch keine Verwaltungsaktionen.</p>
      ) : (
        <ul className="list">
          {log.map((e, i) => (
            <li key={i}>
              <span className="muted small" style={{ minWidth: 110 }}>
                {fmt(e.at)}
              </span>
              <span className="badge">{ACTION_LABEL[e.action]}</span>
              <span className="grow">
                <strong>{e.target}</strong> {e.detail && <span className="muted">– {e.detail}</span>}
              </span>
              <span className="muted small">{e.by}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const KIND_LABEL: Record<RegionWithPath['kind'], string> = { land: 'Land', kreis: 'Kreis', verband: 'Gemeindeverband', gemeinde: 'Gemeinde' };
const fold = (t: string) => t.toLocaleLowerCase('de').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');

type AreaHit = { id: string; label: string; hint?: string };

/**
 * Bereich suchen: bestehende Knoten (auch frei angelegte) und alle Gebietskörperschaften aus dem Katalog. Gebiete,
 * in denen noch niemand angemeldet war, gibt es als Knoten noch nicht – das Relay legt sie bei der Rollenvergabe an.
 */
function AreaPicker({ nodes, value, onChange }: { nodes: CloudNodeRef[]; value: string; onChange: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState('');
  const [regions, setRegions] = useState<RegionWithPath[]>([]);
  const needle = fold(q.trim());

  useEffect(() => {
    if (needle.length < 2) return setRegions([]);
    let live = true;
    const t = setTimeout(() => {
      api.regions(q.trim()).then((r) => live && setRegions(r), () => live && setRegions([]));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [needle]); // eslint-disable-line react-hooks/exhaustive-deps

  const hits = useMemo<AreaHit[]>(() => {
    if (!needle || value) return [];
    const known = nodes.filter((n) => fold(where(n)).includes(needle)).map((n) => ({ id: n.id, label: where(n) }));
    const ids = new Set(known.map((h) => h.id));
    const fromCatalog = regions
      .map((r) => ({ id: `ars:${r.ars}`, label: r.path.map((p) => p.name).join(' › '), hint: KIND_LABEL[r.kind] }))
      .filter((h) => !ids.has(h.id));
    return [...known, ...fromCatalog].slice(0, 12);
  }, [needle, value, nodes, regions]);

  // Nach der Vergabe setzt der Aufrufer die Auswahl zurück, dann leert sich auch das Suchfeld
  useEffect(() => {
    if (!value) setQ((cur) => (cur === picked ? '' : cur));
  }, [value, picked]);

  const pick = (h: AreaHit) => {
    onChange(h.id);
    setPicked(h.label);
    setQ(h.label);
  };

  return (
    <div className="grow" style={{ position: 'relative', minWidth: 0 }}>
      <label className="admin-search">
        <Search size={16} />
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (value) onChange('');
          }}
          placeholder="Bereich suchen (Land, Kreis, Gemeinde …)"
          aria-label="Bereich"
          aria-autocomplete="list"
        />
      </label>
      {hits.length > 0 && (
        <ul className="list area-hits" role="listbox">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" className="admin-row" role="option" aria-selected={false} onClick={() => pick(h)}>
                <span className="grow">{h.label}</span>
                {h.hint && <span className="muted small">{h.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!value && needle.length >= 2 && hits.length === 0 && <p className="muted small">Kein Bereich gefunden</p>}
    </div>
  );
}
