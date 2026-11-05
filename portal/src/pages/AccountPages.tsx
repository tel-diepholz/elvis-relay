import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, KeyRound, LogOut, Mail, Trash2, UserRound } from 'lucide-react';
import { api, type Me } from '../api';
import { navigate } from '../router';
import { NewPassword, PASSWORD_MIN, useRun } from './LoginPage';

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="login">
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <img src="/favicon.svg" alt="" width={48} height={48} />
        <h1>{title}</h1>
      </div>
      {children}
    </div>
  );
}

/** Link aus einer Mail einlösen (Bestätigen, neue Adresse) – einmal, auch im StrictMode */
function useRedeem<T>(f: () => Promise<T>) {
  const [state, setState] = useState<{ ok: T } | { error: string } | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    f().then(
      (ok) => setState({ ok }),
      (e: Error) => setState({ error: e.message }),
    );
  }, [f]);
  return state;
}

/** /bestaetigen/<token>: Adresse bestätigen und anmelden */
export function VerifyPage({ token, onMe }: { token: string; onMe: (me: Me) => void }) {
  const state = useRedeem(() => api.verify(token));
  useEffect(() => {
    if (state && 'ok' in state) {
      onMe(state.ok);
      navigate('/');
    }
  }, [state, onMe]);
  return (
    <Frame title="E-Mail-Adresse bestätigen">
      <div className="card">{!state ? <p className="muted">Wird bestätigt …</p> : 'error' in state ? <ErrorWithLogin text={state.error} /> : <p>Bestätigt – Sie sind angemeldet.</p>}</div>
    </Frame>
  );
}

/** /email-bestaetigen/<token>: neue Adresse übernehmen */
export function EmailConfirmPage({ token, me }: { token: string; me: Me | null }) {
  const state = useRedeem(() => api.confirmEmail(token));
  return (
    <Frame title="Neue E-Mail-Adresse">
      <div className="card" style={{ display: 'grid', gap: 12 }}>
        {!state ? (
          <p className="muted">Wird bestätigt …</p>
        ) : 'error' in state ? (
          <p className="error">{state.error}</p>
        ) : (
          <p>
            <Check size={16} /> Ihr Konto hat jetzt die Adresse <strong>{state.ok.email}</strong>. Damit melden Sie sich ab sofort an.
          </p>
        )}
        <button className="btn" onClick={() => (window.location.href = me ? '/konto' : '/')}>
          {me ? 'Zum Konto' : 'Zur Anmeldung'}
        </button>
      </div>
    </Frame>
  );
}

function ErrorWithLogin({ text }: { text: string }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p className="error">{text}</p>
      <button className="btn" onClick={() => navigate('/')}>
        Zur Anmeldung
      </button>
    </div>
  );
}

/** /passwort-zuruecksetzen/<token>: neues Passwort festlegen, danach angemeldet (andere Sitzungen enden) */
export function ResetPasswordPage({ token, onMe }: { token: string; onMe: (me: Me) => void }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const { busy, error, run } = useRun();
  const submit = (e: FormEvent) => (
    e.preventDefault(),
    void run(async () => {
      onMe(await api.resetPassword(token, password));
      navigate('/');
    })
  );
  return (
    <Frame title="Neues Passwort">
      <form className="card" onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <p className="muted small">Nach dem Speichern sind Sie hier angemeldet und auf allen anderen Geräten abgemeldet.</p>
        <NewPassword value={password} onChange={setPassword} repeat={repeat} onRepeat={setRepeat} label="Neues Passwort" />
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" disabled={busy || password.length < PASSWORD_MIN || password !== repeat}>
          <KeyRound size={16} /> Passwort speichern
        </button>
      </form>
    </Frame>
  );
}

/** /konto: Name, Passwort, E-Mail-Adresse, Sitzungen, Konto löschen */
export function AccountPage({ me, onMe }: { me: Me; onMe: (me: Me | null) => void }) {
  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 640 }}>
      <h1>Mein Konto</h1>
      <NameCard me={me} onMe={onMe} />
      <PasswordCard />
      <EmailCard me={me} />
      <SessionsCard />
      <DeleteCard onMe={onMe} />
    </div>
  );
}

function Notice({ ok, error }: { ok: string | null; error: string | null }) {
  return (
    <>
      {ok && <p className="notice ok">{ok}</p>}
      {error && <p className="error">{error}</p>}
    </>
  );
}

function NameCard({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  const [name, setName] = useState(me.name);
  const [ok, setOk] = useState<string | null>(null);
  const { busy, error, run } = useRun();
  const save = (e: FormEvent) => (e.preventDefault(), void run(async () => (onMe(await api.rename(name.trim())), setOk('Name gespeichert'))));
  return (
    <form className="card" onSubmit={save} style={{ display: 'grid', gap: 12 }}>
      <h2>
        <UserRound size={18} /> Name
      </h2>
      <label className="field">
        Name (sichtbar für andere in Ihren Bereichen)
        <input required maxLength={80} value={name} onChange={(e) => (setName(e.target.value), setOk(null))} />
      </label>
      <Notice ok={ok} error={error} />
      <div className="row">
        <button className="btn" disabled={busy || !name.trim() || name.trim() === me.name}>
          Speichern
        </button>
      </div>
    </form>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [ok, setOk] = useState<string | null>(null);
  const { busy, error, run } = useRun();
  const save = (e: FormEvent) => (
    e.preventDefault(),
    void run(async () => {
      await api.changePassword(current, password);
      setCurrent('');
      setPassword('');
      setRepeat('');
      setOk('Passwort geändert – andere Anmeldungen wurden beendet.');
    })
  );
  return (
    <form className="card" onSubmit={save} style={{ display: 'grid', gap: 12 }}>
      <h2>
        <KeyRound size={18} /> Passwort ändern
      </h2>
      <label className="field">
        Aktuelles Passwort
        <input type="password" autoComplete="current-password" required value={current} onChange={(e) => (setCurrent(e.target.value), setOk(null))} />
      </label>
      <NewPassword value={password} onChange={setPassword} repeat={repeat} onRepeat={setRepeat} label="Neues Passwort" />
      <Notice ok={ok} error={error} />
      <div className="row">
        <button className="btn" disabled={busy || !current || password.length < PASSWORD_MIN || password !== repeat}>
          Passwort ändern
        </button>
      </div>
    </form>
  );
}

function EmailCard({ me }: { me: Me }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [ok, setOk] = useState<string | null>(null);
  const { busy, error, run } = useRun();
  const save = (e: FormEvent) => (
    e.preventDefault(),
    void run(async () => {
      const r = await api.changeEmail(email, password);
      setPassword('');
      setOk(`Bitte den Link in der Mail an ${r.email} öffnen. Bis dahin gilt ${me.email}.`);
    })
  );
  return (
    <form className="card" onSubmit={save} style={{ display: 'grid', gap: 12 }}>
      <h2>
        <Mail size={18} /> E-Mail-Adresse
      </h2>
      <p className="muted small">
        Angemeldet als <strong>{me.email}</strong>. Eine neue Adresse gilt erst, wenn Sie den Link in der Mail an sie bestätigen. Einladungen gehen an die jeweils aktuelle Adresse.
      </p>
      <label className="field">
        Neue E-Mail-Adresse
        <input type="email" autoComplete="email" required value={email} onChange={(e) => (setEmail(e.target.value), setOk(null))} />
      </label>
      <label className="field">
        Passwort zur Bestätigung
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <Notice ok={ok} error={error} />
      <div className="row">
        <button className="btn" disabled={busy || !email || !password}>
          Adresse ändern
        </button>
      </div>
    </form>
  );
}

function SessionsCard() {
  const [ok, setOk] = useState<string | null>(null);
  const { busy, error, run } = useRun();
  const end = () => void run(async () => setOk(`${(await api.logoutOthers()).ended} andere Anmeldungen beendet`));
  return (
    <section className="card" style={{ display: 'grid', gap: 12 }}>
      <h2>
        <LogOut size={18} /> Anmeldungen
      </h2>
      <p className="muted small">Eine Anmeldung gilt 30 Tage. Haben Sie sich auf einem fremden oder verlorenen Gerät angemeldet, beenden Sie hier alle anderen Anmeldungen.</p>
      <Notice ok={ok} error={error} />
      <div className="row">
        <button className="btn" disabled={busy} onClick={end}>
          Überall sonst abmelden
        </button>
      </div>
    </section>
  );
}

function DeleteCard({ onMe }: { onMe: (me: Me | null) => void }) {
  const [password, setPassword] = useState('');
  const [sure, setSure] = useState(false);
  const { busy, error, run } = useRun();
  const remove = (e: FormEvent) => (
    e.preventDefault(),
    void run(async () => {
      await api.deleteAccount(password);
      onMe(null);
      navigate('/');
    })
  );
  return (
    <form className="card" onSubmit={remove} style={{ display: 'grid', gap: 12 }}>
      <h2>
        <Trash2 size={18} /> Konto löschen
      </h2>
      <p className="muted small">Ihr Konto und Ihre Rechte in allen Bereichen werden gelöscht. Gepflegte Stammdaten bleiben erhalten. Verwalten Sie einen Bereich allein, setzen Sie vorher jemand anderen als Admin ein.</p>
      <label className="field">
        Passwort
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label className="check-inline">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> Ja, mein Konto endgültig löschen
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn" style={{ color: 'var(--bad)' }} disabled={busy || !password || !sure}>
          Konto löschen
        </button>
      </div>
    </form>
  );
}
