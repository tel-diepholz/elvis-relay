import { useEffect, useState, type FormEvent } from 'react';
import { Building, Link2, RefreshCw, Truck } from 'lucide-react';
import { api, type InstallationStatus, type Me } from '../api';
import { InstallationCard, RoleBadge } from '../components';
import { Link, nodeUrl } from '../router';

export function OverviewPage({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  const [installations, setInstallations] = useState<InstallationStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const load = () =>
    api
      .installations()
      .then((l) => (setInstallations(l), setError(null)))
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    // Status bleibt aktuell, solange die Seite offen ist
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, []);
  const saveName = (e: FormEvent) => (e.preventDefault(), void api.rename(name.trim()).then(onMe));

  // Verknüpfen direkt hier: an einem Bereich, den man verwaltet (Unterbereiche über deren Seite)
  const adminAreas = me.memberships.filter((m) => m.role === 'admin');
  const [code, setCode] = useState('');
  const [area, setArea] = useState('');
  const [linkMsg, setLinkMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const link = (e: FormEvent) => {
    e.preventDefault();
    const nodeId = area || adminAreas[0]?.node.id;
    if (!nodeId) return;
    setLinkMsg(null);
    api
      .link(code, nodeId)
      .then((s) => (setLinkMsg({ ok: true, text: `„${s.name}“ mit ${s.node.path.join(' › ') || 'Deutschland'} verknüpft` }), setCode(''), void load()))
      .catch((err: Error) => setLinkMsg({ ok: false, text: err.message }));
  };

  return (
    <>
      <div>
        <h1>Übersicht</h1>
        <p className="muted">Ihre Bereiche in der Baustruktur und die verknüpften ELVIS-Installationen.</p>
      </div>
      {!me.name && (
        <form className="card" onSubmit={saveName}>
          <h2>Wie heißen Sie?</h2>
          <p className="muted small">Der Name erscheint bei Einladungen und Verknüpfungen.</p>
          <div className="row">
            <input className="grow" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Vor- und Nachname" aria-label="Name" />
            <button className="btn btn-primary" disabled={!name.trim()}>
              Speichern
            </button>
          </div>
        </form>
      )}
      <section className="card">
        <div className="card-head">
          <h2>
            <Building size={18} /> Meine Bereiche
          </h2>
        </div>
        {me.memberships.length === 0 ? (
          <p className="muted">
            Noch keine. Ein Verwalter Ihrer Gebietskörperschaft lädt Sie per E-Mail ein. Für die erste Verwaltung eines Landkreises oder einer Gemeinde wenden Sie sich an
            den Betreiber.
          </p>
        ) : (
          <ul className="list">
            {me.memberships.map((m) => (
              <li key={m.node.id}>
                <div className="grow">
                  <Link to={nodeUrl(m.node.id)} className="title">
                    {m.node.name}
                  </Link>
                  <div className="small muted">{m.node.path.join(' › ') || 'Deutschland'}</div>
                </div>
                <RoleBadge role={m.role} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <div className="card-head">
          <h2>
            <Link2 size={18} /> Installation verknüpfen
          </h2>
        </div>
        <p className="muted small">
          In ELVIS unter <em>Einstellungen → Cloud-Zugang</em> „Verknüpfungscode anfordern“ wählen und den Code hier eingeben. Für einen Unterbereich (z. B. eine Gemeinde im
          Kreis) geht das auch auf dessen Seite unter „Installationen hier“.
        </p>
        {adminAreas.length === 0 ? (
          <p className="notice">
            Verknüpfen dürfen Verwalter eines Bereichs. {me.memberships.length ? 'Sie haben hier nur lesende bzw. pflegende Rechte.' : 'Ihr Konto hat noch keinen Bereich.'} Ein Verwalter Ihres
            Landkreises oder Ihrer Gemeinde lädt Sie mit der Rolle „Verwalten“ ein; die ersten Verwalter setzt der Betreiber ein.
          </p>
        ) : (
          <form className="row" onSubmit={link}>
            <label className="field grow">
              Verknüpfungscode
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" maxLength={9} autoComplete="off" />
            </label>
            {adminAreas.length > 1 && (
              <label className="field grow">
                Bereich
                <select value={area || adminAreas[0]!.node.id} onChange={(e) => setArea(e.target.value)}>
                  {adminAreas.map((m) => (
                    <option key={m.node.id} value={m.node.id}>
                      {m.node.path.join(' › ') || 'Deutschland'}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="btn btn-primary" disabled={code.replace(/[\s-]/g, '').length !== 8}>
              <Link2 size={16} /> Installation verknüpfen
            </button>
          </form>
        )}
        {adminAreas.length === 1 && <p className="small muted">wird verknüpft mit {adminAreas[0]!.node.path.join(' › ') || 'Deutschland'}</p>}
        {linkMsg && <p className={linkMsg.ok ? 'notice ok' : 'error'}>{linkMsg.text}</p>}
      </section>
      <section>
        <div className="card-head" style={{ marginBottom: 12 }}>
          <h2>
            <Truck size={18} /> Installationen
          </h2>
          <button className="btn btn-sm" onClick={() => void load()}>
            <RefreshCw size={14} /> Aktualisieren
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {installations === null ? (
          <p className="muted">Lädt …</p>
        ) : installations.length === 0 ? (
          <p className="muted">Keine. Verknüpfen geht oben mit dem Code aus ELVIS (Einstellungen → Cloud-Zugang).</p>
        ) : (
          <div className="grid">
            {installations.map((s) => (
              <InstallationCard key={s.elwId} status={s} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
