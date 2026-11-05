import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { ROLE_HINTS, ROLE_LABELS, api, type InvitationInfo, type Me } from '../api';
import { navigate, nodeUrl } from '../router';
import { LoginForm } from './LoginPage';

/** Einladungslink: zeigt Bereich und Rolle, meldet bei Bedarf an und nimmt an */
export function InvitationPage({ token, me, onMe }: { token: string; me: Me | null; onMe: (me: Me | null) => void }) {
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.invitation(token).then(setInfo, (e: Error) => setError(e.message));
  }, [token]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      onMe(await api.acceptInvitation(token));
      navigate(nodeUrl(info!.node.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <img src="/favicon.svg" alt="" width={48} height={48} />
        <h1>Einladung</h1>
      </div>
      {!info ? (
        <p className={error ? 'error' : 'muted'}>{error ?? 'Lädt …'}</p>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          <section className="card">
            <p>
              <strong>{info.invitedBy}</strong> lädt <strong>{info.email}</strong> ein, die Stammdaten von
            </p>
            <p style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{info.node.path.join(' › ') || info.node.name}</p>
            <p>
              mitzupflegen – Rolle <strong>{ROLE_LABELS[info.role]}</strong> ({ROLE_HINTS[info.role]}).
            </p>
            {info.accepted && <p className="notice">Diese Einladung wurde schon angenommen.</p>}
            {info.expired && !info.accepted && <p className="notice">Diese Einladung ist abgelaufen. Bitte um eine neue bitten.</p>}
            {error && <p className="error">{error}</p>}
            {me && !info.accepted && !info.expired && (
              me.email === info.email ? (
                <button className="btn btn-primary" disabled={busy} onClick={() => void accept()}>
                  <Check size={16} /> Einladung annehmen
                </button>
              ) : (
                <p className="notice">
                  Sie sind als {me.email} angemeldet. Die Einladung gilt für {info.email}.{' '}
                  <button className="btn btn-sm" onClick={() => void api.logout().then(() => onMe(null))}>
                    Abmelden
                  </button>
                </p>
              )
            )}
          </section>
          {!me && !info.accepted && !info.expired && <LoginForm email={info.email} onLogin={onMe} />}
        </div>
      )}
    </div>
  );
}
