import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LogOut } from 'lucide-react';
import { ApiError, api, type Me } from './api';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { NodePage } from './pages/NodePage';
import { InvitationPage } from './pages/InvitationPage';
import { useRoute, Link } from './router';
import './styles.css';

function App() {
  const route = useRoute();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const reload = useCallback(
    () =>
      api
        .me()
        .then(setMe)
        .catch((e: unknown) => setMe(e instanceof ApiError && e.status === 401 ? null : null)),
    [],
  );
  useEffect(() => void reload(), [reload]);

  if (me === undefined) return <div className="center muted">Lädt …</div>;

  // Einladungen gehen auch ohne Anmeldung zu öffnen (Anmeldung dort)
  const invite = /^\/einladung\/([A-Za-z0-9_-]{43})$/.exec(route);
  if (invite) return <InvitationPage token={invite[1]!} me={me} onMe={setMe} />;
  if (!me) return <LoginPage onLogin={setMe} />;

  const nodeMatch = /^\/knoten\/(.+)$/.exec(route);
  return (
    <>
      <header className="top">
        <Link to="/" className="brand">
          <img src="/favicon.svg" alt="" /> ELVIS Cloud
        </Link>
        <div className="who">
          <span className="name muted">{me.name || me.email}</span>
          <button className="btn btn-sm" onClick={() => void api.logout().then(() => setMe(null))}>
            <LogOut size={16} /> Abmelden
          </button>
        </div>
      </header>
      <main>{nodeMatch ? <NodePage id={decodeURIComponent(nodeMatch[1]!)} me={me} /> : <OverviewPage me={me} onMe={setMe} />}</main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
