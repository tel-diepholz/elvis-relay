import { useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, LogIn, Mail, UserPlus } from 'lucide-react';
import { ApiError, api, type Me } from '../api';

/** Wie in src/cloudprotocol.ts (dort mit zod; das Portal bindet zod nicht ein) */
export const PASSWORD_MIN = 10;

type Mode = 'login' | 'register' | 'forgot' | 'sent' | 'unverified';

/** Formular mit Fehler- und Ladezustand */
export function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/** Neues Passwort mit Wiederholung */
export function NewPassword({ value, onChange, repeat, onRepeat, label = 'Passwort' }: { value: string; onChange: (v: string) => void; repeat: string; onRepeat: (v: string) => void; label?: string }) {
  return (
    <>
      <label className="field">
        {label}
        <input type="password" autoComplete="new-password" required minLength={PASSWORD_MIN} maxLength={200} value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
      <p className="muted small" style={{ margin: '-6px 0 0' }}>
        Mindestens {PASSWORD_MIN} Zeichen – gern ein ganzer Satz.
      </p>
      <label className="field">
        {label} wiederholen
        <input type="password" autoComplete="new-password" required value={repeat} onChange={(e) => onRepeat(e.target.value)} />
      </label>
      {repeat && value !== repeat && <p className="error small">Die Passwörter stimmen nicht überein.</p>}
    </>
  );
}

/**
 * Anmelden mit E-Mail und Passwort, Konto anlegen (Bestätigung per Mail), Passwort vergessen.
 * Mit `email` (Einladung) ist die Adresse fest; mit `invitation` ist sie beim Registrieren sofort bestätigt.
 */
export function LoginForm({ onLogin, email: fixed, invitation, initialMode = 'login' }: { onLogin: (me: Me) => void; email?: string; invitation?: string; initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState(fixed ?? '');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [name, setName] = useState('');
  const { busy, error, setError, run } = useRun();
  const go = (m: Mode) => (setMode(m), setError(null), setPassword(''), setRepeat(''));

  const login = (e: FormEvent) => (
    e.preventDefault(),
    void run(async () => {
      try {
        onLogin(await api.login(email, password));
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) return go('unverified');
        throw err;
      }
    })
  );
  const register = (e: FormEvent) => (
    e.preventDefault(),
    void run(async () => {
      if (password !== repeat) throw new Error('Die Passwörter stimmen nicht überein');
      const r = await api.register(email, name.trim(), password, invitation);
      if ('id' in r) onLogin(r);
      else go('sent');
    })
  );
  const forgot = (e: FormEvent) => (e.preventDefault(), void run(async () => (await api.forgotPassword(email), go('sent'))));
  const resend = () => void run(async () => (await api.resendVerify(email), go('sent')));

  const emailField = (
    <label className="field">
      E-Mail-Adresse
      <input type="email" autoComplete="username" required value={email} readOnly={!!fixed} onChange={(e) => setEmail(e.target.value)} autoFocus={!fixed} />
    </label>
  );
  const switcher: ReactNode = (
    <div className="tabs" role="tablist" style={{ marginBottom: 4 }}>
      <button type="button" role="tab" className={`tab ${mode === 'login' ? 'active' : ''}`} aria-selected={mode === 'login'} onClick={() => go('login')}>
        Anmelden
      </button>
      <button type="button" role="tab" className={`tab ${mode === 'register' ? 'active' : ''}`} aria-selected={mode === 'register'} onClick={() => go('register')}>
        Konto anlegen
      </button>
    </div>
  );

  if (mode === 'sent' || mode === 'unverified') {
    return (
      <div className="card" style={{ display: 'grid', gap: 12 }}>
        <h2>
          <Mail size={18} /> {mode === 'sent' ? 'Bitte Postfach prüfen' : 'Adresse noch nicht bestätigt'}
        </h2>
        <p className="muted">
          {mode === 'sent'
            ? `Wenn es zu ${email} passt, ist eine Mail mit einem Link unterwegs. Der Link zum Bestätigen gilt 24 Stunden, der zum Zurücksetzen des Passworts 1 Stunde.`
            : `Bitte zuerst den Link in der Bestätigungsmail an ${email} öffnen.`}
        </p>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="btn" disabled={busy} onClick={resend}>
            Bestätigungsmail erneut senden
          </button>
          <button className="btn btn-ghost" onClick={() => go('login')}>
            Zur Anmeldung
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'forgot') {
    return (
      <form className="card" onSubmit={forgot} style={{ display: 'grid', gap: 12 }}>
        <h2>Passwort vergessen</h2>
        <p className="muted small">Sie bekommen einen Link, mit dem Sie ein neues Passwort festlegen. Auch für Konten, die bisher per Code angemeldet wurden.</p>
        {emailField}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="btn btn-primary" disabled={busy || !email}>
            <Mail size={16} /> Link senden
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => go('login')}>
            Zurück
          </button>
        </div>
      </form>
    );
  }

  if (mode === 'register') {
    return (
      <form className="card" onSubmit={register} style={{ display: 'grid', gap: 12 }}>
        {switcher}
        {emailField}
        <label className="field">
          Ihr Name
          <input autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Anna Muster" />
        </label>
        <NewPassword value={password} onChange={setPassword} repeat={repeat} onRepeat={setRepeat} />
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" disabled={busy || !email || !name.trim() || password.length < PASSWORD_MIN || password !== repeat}>
          <UserPlus size={16} /> Konto anlegen
        </button>
        {!invitation && <p className="muted small">Danach kommt eine Mail mit einem Link zum Bestätigen der Adresse.</p>}
      </form>
    );
  }

  return (
    <form className="card" onSubmit={login} style={{ display: 'grid', gap: 12 }}>
      {switcher}
      {emailField}
      <label className="field">
        Passwort
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!fixed} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row" style={{ alignItems: 'center' }}>
        <button className="btn btn-primary" disabled={busy || !email || !password}>
          <LogIn size={16} /> Anmelden
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => go('forgot')}>
          <KeyRound size={14} /> Passwort vergessen?
        </button>
      </div>
    </form>
  );
}

export function LoginPage({ onLogin }: { onLogin: (me: Me) => void }) {
  return (
    <div className="login">
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <img src="/favicon.svg" alt="" width={48} height={48} />
        <h1>ELVIS Cloud</h1>
        <p className="muted">Stammdaten pflegen und ELVIS-Installationen im Blick behalten</p>
      </div>
      <LoginForm onLogin={onLogin} />
    </div>
  );
}
