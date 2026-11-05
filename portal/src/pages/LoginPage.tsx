import { useState, type FormEvent } from 'react';
import { KeyRound, Mail } from 'lucide-react';
import { api, type Me } from '../api';

/** Anmeldung per Code an die E-Mail-Adresse; beim ersten Mal entsteht dabei das Konto */
export function LoginForm({ onLogin, email: fixed }: { onLogin: (me: Me) => void; email?: string }) {
  const [email, setEmail] = useState(fixed ?? '');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
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
  const sendCode = (e: FormEvent) => (e.preventDefault(), void run(async () => (await api.login(email), setStep('code'))));
  const verify = (e: FormEvent) => (e.preventDefault(), void run(async () => onLogin(await api.verify(email, code, name.trim() || undefined))));

  return step === 'email' ? (
    <form className="card" onSubmit={sendCode}>
      <h2>Anmelden</h2>
      <p className="muted small">Sie bekommen einen Code per E-Mail. Beim ersten Mal entsteht dabei Ihr Konto – ein Passwort gibt es nicht.</p>
      <label className="field">
        E-Mail-Adresse
        <input type="email" autoComplete="email" required value={email} readOnly={!!fixed} onChange={(e) => setEmail(e.target.value)} autoFocus={!fixed} />
      </label>
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary" disabled={busy || !email}>
        <Mail size={16} /> Code senden
      </button>
    </form>
  ) : (
    <form className="card" onSubmit={verify}>
      <h2>Code eingeben</h2>
      <p className="muted small">Der Code ging an {email} und gilt 15 Minuten.</p>
      <label className="field">
        Code
        <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
      </label>
      <label className="field">
        Ihr Name (nur beim ersten Anmelden)
        <input autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Anna Muster" />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn btn-primary" disabled={busy || code.length !== 6}>
          <KeyRound size={16} /> Anmelden
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => (setStep('email'), setCode(''), setError(null))}>
          Andere Adresse
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
