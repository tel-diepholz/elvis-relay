import { useEffect, useState } from 'react';
import { Archive, Cloud, Mail, MessagesSquare, Smartphone, Unlink, Webhook } from 'lucide-react';
import { ROLE_LABELS, type CloudRole, type InstallationStatus } from './api';
import { Link, nodeUrl } from './router';

export const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(0)} KB` : b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`);

/** „vor 5 Min.“, „vor 3 Std.“, sonst Datum */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'nie';
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 48 * 3600) return `vor ${Math.round(s / 3600)} Std.`;
  return new Date(iso).toLocaleDateString('de-DE');
}

export const RoleBadge = ({ role }: { role: CloudRole | null }) => (role ? <span className={`badge ${role === 'admin' ? 'admin' : ''}`}>{ROLE_LABELS[role]}</span> : null);

export function Crumbs({ path, ids }: { path: string[]; ids?: string[] }) {
  return (
    <nav className="crumbs" aria-label="Pfad">
      <Link to="/">Übersicht</Link>
      {path.map((p, i) => (
        <span key={i}>
          {' › '}
          {ids?.[i] ? <Link to={nodeUrl(ids[i]!)}>{p}</Link> : p}
        </span>
      ))}
    </nav>
  );
}

/** Seit der letzten Meldung der Installation: aktuell (< 15 Min.), länger her, oder gar nicht */
function onlineBadge(lastSeen: string | null) {
  if (!lastSeen) return <span className="badge">nie gesehen</span>;
  const min = (Date.now() - new Date(lastSeen).getTime()) / 60_000;
  return min < 15 ? <span className="badge ok">erreichbar</span> : min < 24 * 60 ? <span className="badge warn">{ago(lastSeen)}</span> : <span className="badge bad">{ago(lastSeen)}</span>;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Kachel einer Installation mit dem Zustand ihrer Cloud-Module */
export function InstallationCard({ status: s, onUnlink }: { status: InstallationStatus; onUnlink?: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const mailOld = s.mail?.oldestWaiting && Date.now() - new Date(s.mail.oldestWaiting).getTime() > 3600_000;
  return (
    <section className="card inst" aria-label={s.name}>
      <div className="card-head">
        <div>
          <h3>{s.name}</h3>
          <div className="small muted">
            <Link to={nodeUrl(s.node.id)}>{s.node.path.join(' › ')}</Link>
            {s.version && ` · ELVIS ${s.version}`}
          </div>
        </div>
        {onlineBadge(s.lastSeen)}
      </div>
      <dl className="facts">
        <div>
          <dt title="E-Mail">
            <Mail size={18} />
          </dt>
          <dd>
            {s.mail ? (
              <>
                <span className={s.mail.waiting ? 'big' : ''}>{s.mail.waiting ? `${plural(s.mail.waiting, 'Mail wartet', 'Mails warten')} (${fmtBytes(s.mail.waitingBytes)})` : 'keine Mails wartend'}</span>
                {mailOld && <span className="badge warn"> älteste {ago(s.mail.oldestWaiting)}</span>}
                <div className="small muted">
                  {s.mail.address} · {s.mail.state === 'active' ? 'aktiv' : s.mail.state} · abgeholt {ago(s.mail.lastFetchAt)}
                  {s.mail.lastFetchCountry && ` (${s.mail.lastFetchCountry})`} · heute {s.mail.sentToday} gesendet
                </div>
              </>
            ) : (
              <span className="muted">kein Postfach</span>
            )}
          </dd>
        </div>
        <div>
          <dt title="Cloud Messaging">
            <MessagesSquare size={18} />
          </dt>
          <dd>
            {s.messaging ? (
              <>
                {s.messaging.pendingEvents ? <span className="big">{plural(s.messaging.pendingEvents, 'Ereignis wartet', 'Ereignisse warten')}</span> : 'nichts wartend'}
                <div className="small muted">
                  {plural(s.messaging.openConversations, 'Chat', 'Chats')} · {s.messaging.listed ? 'im Verzeichnis' : 'nicht gelistet'} · {s.messaging.region}
                </div>
              </>
            ) : (
              <span className="muted">Cloud Messaging nicht eingerichtet</span>
            )}
          </dd>
        </div>
        <div>
          <dt title="App-Anbindung">
            <Smartphone size={18} />
          </dt>
          <dd>
            {plural(s.app.pairedDevices, 'App gekoppelt', 'Apps gekoppelt')}
            {(s.app.pendingPositions > 0 || s.app.pendingSheets > 0 || s.app.openForms > 0) && (
              <div className="small muted">
                {s.app.pendingPositions} Positionen und {s.app.pendingSheets} Personalbögen warten · {plural(s.app.openForms, 'offenes Formular', 'offene Formulare')}
              </div>
            )}
          </dd>
        </div>
        {s.hooks.kinds.length > 0 && (
          <div>
            <dt title="Messenger-Webhooks">
              <Webhook size={18} />
            </dt>
            <dd>
              {s.hooks.kinds.join(', ')} · {s.hooks.pendingEvents} wartend
            </dd>
          </div>
        )}
        <div>
          <dt title="Backup">
            <Archive size={18} />
          </dt>
          <dd>
            {s.backup ? (
              <>
                {plural(s.backup.count, 'Backup', 'Backups')} · {fmtBytes(s.backup.bytes)}
                <div className="small muted">letztes {ago(s.backup.lastAt)}</div>
              </>
            ) : (
              <span className="muted">kein Cloud-Backup</span>
            )}
          </dd>
        </div>
        <div>
          <dt title="Verknüpfung">
            <Cloud size={18} />
          </dt>
          <dd className="small muted">
            verknüpft {ago(s.linkedAt)} von {s.linkedBy}
          </dd>
        </div>
      </dl>
      {onUnlink && (
        <div>
          <button className="btn btn-sm" onClick={onUnlink}>
            <Unlink size={14} /> Trennen
          </button>
        </div>
      )}
    </section>
  );
}
