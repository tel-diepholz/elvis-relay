import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { FolderPlus, Link2, Mail, Pencil, Search, Trash2, Truck, Users, X } from 'lucide-react';
import { ROLE_HINTS, ROLE_LABELS, api, type CloudRole, type InstallationStatus, type Me, type NodeDetail } from '../api';
import { Crumbs, InstallationCard, RoleBadge } from '../components';
import { Link, navigate, nodeUrl } from '../router';

const ROLES: CloudRole[] = ['viewer', 'editor', 'admin'];
const KIND_LABELS: Record<string, string> = { country: 'Staat', land: 'Land', kreis: 'Kreis', verband: 'Gemeindeverband', gemeinde: 'Gemeinde', free: 'eigener Knoten' };

/** Ein Bereich der Baustruktur: Unterknoten, Installationen, Mitglieder, Einladungen */
export function NodePage({ id, me }: { id: string; me: Me }) {
  const [node, setNode] = useState<NodeDetail | null>(null);
  const [installations, setInstallations] = useState<InstallationStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [childName, setChildName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<CloudRole>('editor');
  const [code, setCode] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [n, all] = await Promise.all([api.node(id), api.installations()]);
      setNode(n);
      setInstallations(all.filter((i) => i.node.id === id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    setNode(null);
    setNotice(null);
    void load();
  }, [load]);

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

  if (!node) return error ? <p className="error">{error}</p> : <p className="muted">Lädt …</p>;
  const admin = node.role === 'admin';
  const shownChildren = node.children.filter((c) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));

  const addChild = (e: FormEvent) => {
    e.preventDefault();
    void act(() => api.createNode(id, childName.trim()), `„${childName.trim()}“ angelegt`).then((ok) => ok && setChildName(''));
  };
  const sendInvite = (e: FormEvent) => {
    e.preventDefault();
    void act(() => api.invite(id, inviteEmail.trim(), inviteRole), `Einladung an ${inviteEmail.trim()} verschickt`).then((ok) => ok && setInviteEmail(''));
  };
  const link = (e: FormEvent) => {
    e.preventDefault();
    void act(() => api.link(code, id), 'Installation verknüpft').then((ok) => ok && setCode(''));
  };

  return (
    <>
      <div>
        <Crumbs path={node.path.slice(0, -1)} ids={node.pathIds.slice(0, -1)} />
        <div className="card-head">
          {renaming !== null ? (
            <form className="row" onSubmit={(e) => (e.preventDefault(), void act(() => api.renameNode(id, renaming)).then((ok) => ok && setRenaming(null)))}>
              <input aria-label="Name" value={renaming} maxLength={80} onChange={(e) => setRenaming(e.target.value)} autoFocus />
              <button className="btn btn-primary btn-sm">Speichern</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRenaming(null)}>
                Abbrechen
              </button>
            </form>
          ) : (
            <h1>{node.name}</h1>
          )}
          <div className="row">
            <span className="badge">{KIND_LABELS[node.kind] ?? node.kind}</span>
            <RoleBadge role={node.role} />
            {admin && node.kind === 'free' && renaming === null && (
              <>
                <button className="btn btn-sm btn-icon btn-ghost" aria-label="Umbenennen" title="Umbenennen" onClick={() => setRenaming(node.name)}>
                  <Pencil size={16} />
                </button>
                <button
                  className="btn btn-sm btn-icon btn-ghost"
                  aria-label="Knoten löschen"
                  title="Knoten löschen"
                  onClick={() => window.confirm(`„${node.name}“ löschen?`) && void act(() => api.removeNode(id)).then((ok) => ok && navigate(node.parentId ? nodeUrl(node.parentId) : '/'))}
                >
                  <Trash2 size={16} />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      {error && <p className="notice error">{error}</p>}
      {notice && <p className="notice ok">{notice}</p>}

      <section className="card">
        <div className="card-head">
          <h2>
            <Truck size={18} /> Installationen hier
          </h2>
        </div>
        {installations.length === 0 && <p className="muted">Keine Installation direkt an diesem Knoten.</p>}
        {installations.length > 0 && (
          <div className="grid">
            {installations.map((s) => (
              <InstallationCard key={s.elwId} status={s} onUnlink={admin ? () => window.confirm(`„${s.name}“ von der Cloud trennen?`) && void act(() => api.unlink(s.elwId), 'Getrennt') : undefined} />
            ))}
          </div>
        )}
        {admin && (
          <form className="row" onSubmit={link}>
            <label className="field grow">
              Verknüpfungscode aus ELVIS (Einstellungen → Cloud)
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" maxLength={9} autoComplete="off" />
            </label>
            <button className="btn btn-primary" disabled={code.replace(/[\s-]/g, '').length !== 8}>
              <Link2 size={16} /> Installation verknüpfen
            </button>
          </form>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>
            <FolderPlus size={18} /> Unterknoten
          </h2>
          {node.children.length > 12 && (
            <label className="row" style={{ alignItems: 'center' }}>
              <Search size={16} aria-hidden />
              <input type="search" aria-label="Unterknoten filtern" placeholder="Filtern" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} />
            </label>
          )}
        </div>
        {node.children.length === 0 ? (
          <p className="muted">Keine Unterknoten.</p>
        ) : (
          <ul className="list">
            {shownChildren.slice(0, 200).map((c) => (
              <li key={c.id}>
                <div className="grow">
                  <Link to={nodeUrl(c.id)} className="title">
                    {c.name}
                  </Link>
                </div>
                <span className="badge">{KIND_LABELS[c.kind] ?? c.kind}</span>
              </li>
            ))}
          </ul>
        )}
        {admin && node.kind !== 'country' && (
          <form className="row" onSubmit={addChild}>
            <label className="field grow">
              Eigener Unterknoten, z. B. Ortsfeuerwehr, Zug, Fachgruppe
              <input value={childName} maxLength={80} onChange={(e) => setChildName(e.target.value)} placeholder="z. B. OF Leeste" />
            </label>
            <button className="btn" disabled={!childName.trim()}>
              <FolderPlus size={16} /> Anlegen
            </button>
          </form>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>
            <Users size={18} /> Mitglieder
          </h2>
        </div>
        <p className="muted small">Rollen gelten auch für alle Unterknoten. {ROLES.map((r) => `${ROLE_LABELS[r]}: ${ROLE_HINTS[r]}`).join(' · ')}.</p>
        {node.members.length === 0 ? (
          <p className="muted">Noch niemand.</p>
        ) : (
          <ul className="list">
            {node.members.map((m) => (
              <li key={`${m.accountId}:${m.nodeName}`}>
                <div className="grow">
                  <div className="title">{m.name || m.email}</div>
                  <div className="small muted">
                    {m.name && `${m.email} · `}
                    {m.inherited ? `über ${m.nodeName}` : 'direkt'}
                  </div>
                </div>
                {admin && !m.inherited && m.accountId !== me.id ? (
                  <>
                    <select aria-label={`Rolle von ${m.email}`} value={m.role} style={{ width: 'auto' }} onChange={(e) => void act(() => api.setRole(id, m.accountId, e.target.value as CloudRole))}>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn btn-sm btn-icon btn-ghost"
                      aria-label={`${m.email} entfernen`}
                      onClick={() => window.confirm(`${m.email} aus „${node.name}“ entfernen?`) && void act(() => api.removeMember(id, m.accountId))}
                    >
                      <X size={16} />
                    </button>
                  </>
                ) : (
                  <RoleBadge role={m.role} />
                )}
              </li>
            ))}
          </ul>
        )}
        {admin && (
          <>
            {node.invitations.length > 0 && (
              <>
                <h3 className="small muted" style={{ margin: '4px 0 0' }}>
                  Offene Einladungen
                </h3>
                <ul className="list">
                  {node.invitations.map((i) => (
                    <li key={i.id}>
                      <div className="grow">
                        <div className="title">{i.email}</div>
                        <div className="small muted">
                          von {i.invitedBy} · gültig bis {new Date(i.expiresAt).toLocaleDateString('de-DE')}
                        </div>
                      </div>
                      <RoleBadge role={i.role} />
                      <button className="btn btn-sm btn-icon btn-ghost" aria-label={`Einladung an ${i.email} zurückziehen`} onClick={() => void act(() => api.cancelInvitation(i.id))}>
                        <X size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <form className="row" onSubmit={sendInvite}>
              <label className="field grow">
                Per E-Mail einladen
                <input type="email" required value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="name@feuerwehr.de" />
              </label>
              <label className="field">
                Rolle
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as CloudRole)}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn btn-primary" disabled={!inviteEmail.trim()}>
                <Mail size={16} /> Einladen
              </button>
            </form>
          </>
        )}
      </section>
    </>
  );
}
