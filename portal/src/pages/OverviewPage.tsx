import { useEffect, useState, type FormEvent } from 'react';
import { Building, RefreshCw, Truck } from 'lucide-react';
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
          <p className="muted">Keine. Verknüpfen lässt sich eine Installation auf der Seite eines Bereichs mit dem Code aus ELVIS (Einstellungen → Cloud).</p>
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
