import { bearer, body, fail, json, sameCode } from './http.js';
import {
  statusIncidentPatchSchema,
  statusIncidentSchema,
  STATUS_COMPONENTS,
  type RelayStatus,
  type StatusComponentId,
  type StatusIncident,
  type StatusLevel,
} from './mailprotocol.js';
import { buildMime } from './mime.js';
import type { Env } from './relay.js';

/**
 * Statusseite (einsatzleitwagen.app/status). Alle 5 Minuten prüft der Cron Datenbank, Speicher und den
 * Mailweg Ende zu Ende: eine Testmail an probe@ muss bis zum nächsten Lauf angekommen sein. Dazu zählen Fehler
 * aus dem echten Betrieb (Annahme, Versand) der letzten 15 Minuten.
 */

export const PROBE_LOCALPART = 'probe';
const STALE_MS = 15 * 60_000;
const EVENT_WINDOW_MS = 15 * 60_000;
const UPTIME_DAYS = 90;
const LEVELS: StatusLevel[] = ['ok', 'degraded', 'outage'];
const worst = (a: StatusLevel, b: StatusLevel) => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);
const before = (now: Date, ms: number) => new Date(now.getTime() - ms).toISOString();

export async function recordEvent(env: Env, component: StatusComponentId, ok: boolean, now: Date): Promise<void> {
  try {
    await env.DB.prepare('INSERT INTO status_events (component, ok, at) VALUES (?, ?, ?)').bind(component, ok ? 1 : 0, now.toISOString()).run();
  } catch (e) {
    console.error('Statusereignis', e);
  }
}

export async function recordProbe(env: Env, id: string | null, now: Date): Promise<void> {
  if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return;
  await env.DB.prepare('UPDATE status_probes SET received_at = ? WHERE id = ? AND received_at IS NULL').bind(now.toISOString(), id).run();
}

interface Check {
  component: StatusComponentId;
  ok: boolean;
  latencyMs: number | null;
  detail: string;
}

async function timed(fn: () => Promise<unknown>): Promise<{ ok: boolean; ms: number; error: string }> {
  const t0 = Date.now();
  try {
    await fn();
    return { ok: true, ms: Date.now() - t0, error: '' };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Fehler aus dem Betrieb: gestört, wenn in 15 Minuten mindestens 3 Fehler und mehr Fehler als Erfolge */
async function eventsOk(env: Env, component: StatusComponentId, now: Date): Promise<boolean> {
  const r = await env.DB.prepare('SELECT SUM(ok = 0) AS bad, SUM(ok = 1) AS good FROM status_events WHERE component = ? AND at > ?')
    .bind(component, before(now, EVENT_WINDOW_MS))
    .first<{ bad: number | null; good: number | null }>();
  const bad = r?.bad ?? 0;
  return bad < 3 || bad <= (r?.good ?? 0);
}

export async function runStatusChecks(env: Env, now = new Date()): Promise<void> {
  const db = env.DB;
  const ts = now.toISOString();
  const checks: Check[] = [{ component: 'api', ok: true, latencyMs: null, detail: '' }];

  const d = await timed(() => db.prepare('SELECT 1').first());
  checks.push({ component: 'db', ok: d.ok, latencyMs: d.ms, detail: d.error });

  if (env.MAIL) {
    const bucket = env.MAIL;
    const s = await timed(async () => {
      await bucket.put('status/check', ts);
      const back = await bucket.get('status/check');
      if ((await back?.text()) !== ts) throw new Error('Prüfobjekt nicht lesbar');
      await bucket.delete('status/check');
    });
    checks.push({ component: 'storage', ok: s.ok, latencyMs: s.ms, detail: s.error });
  }

  if (env.SEND) {
    // Testmail vom letzten Lauf angekommen?
    const last = await db.prepare('SELECT id, sent_at, received_at FROM status_probes ORDER BY sent_at DESC LIMIT 1').first<{ id: string; sent_at: string; received_at: string | null }>();
    const arrived = !last || last.received_at !== null;
    const latency = last?.received_at ? new Date(last.received_at).getTime() - new Date(last.sent_at).getTime() : null;

    const id = crypto.randomUUID();
    const domain = env.MAIL_DOMAIN ?? 'einsatzleitwagen.app';
    // Vor dem Versand eintragen: Cloudflare stellt oft zu, bevor send() zurückkommt
    await db.prepare('INSERT INTO status_probes (id, sent_at) VALUES (?, ?)').bind(id, ts).run();
    const send = await timed(async () => {
      await env.SEND!(
        `status@${domain}`,
        `${PROBE_LOCALPART}@${domain}`,
        buildMime({ from: `status@${domain}`, to: `${PROBE_LOCALPART}@${domain}`, subject: 'ELVIS Statusprüfung', text: id, headers: { 'X-Elvis-Probe': id }, date: now }),
      );
    });
    if (!send.ok) await db.prepare('DELETE FROM status_probes WHERE id = ?').bind(id).run();

    const outOk = send.ok && (await eventsOk(env, 'outbound', now));
    const inOk = arrived && (await eventsOk(env, 'inbound', now));
    checks.push({ component: 'outbound', ok: outOk, latencyMs: send.ms, detail: send.ok ? (outOk ? '' : 'Versand schlägt häufig fehl') : send.error });
    checks.push({ component: 'inbound', ok: inOk, latencyMs: latency, detail: arrived ? (inOk ? '' : 'Annahme schlägt häufig fehl') : 'Testmail nicht angekommen' });
  }

  const day = ts.slice(0, 10);
  for (const c of checks) {
    await db.prepare('INSERT INTO status_checks (component, ok, latency_ms, detail, checked_at) VALUES (?, ?, ?, ?, ?)').bind(c.component, c.ok ? 1 : 0, c.latencyMs, c.detail, ts).run();
    await db
      .prepare('INSERT INTO status_daily (component, day, checks, ok) VALUES (?, ?, 1, ?) ON CONFLICT (component, day) DO UPDATE SET checks = checks + 1, ok = ok + excluded.ok')
      .bind(c.component, day, c.ok ? 1 : 0)
      .run();
  }

  await db.prepare('DELETE FROM status_checks WHERE checked_at < ?').bind(before(now, 2 * 24 * 3600_000)).run();
  await db.prepare('DELETE FROM status_daily WHERE day < ?').bind(before(now, (UPTIME_DAYS + 1) * 24 * 3600_000).slice(0, 10)).run();
  await db.prepare('DELETE FROM status_events WHERE at < ?').bind(before(now, 24 * 3600_000)).run();
  await db.prepare('DELETE FROM status_probes WHERE sent_at < ?').bind(before(now, 24 * 3600_000)).run();

  await alertOnChange(env, now);
}

/** Mail an den Betreiber, wenn sich der Gesamtstatus ändert (geht über den Mailweg – fällt der aus, kommt sie u. U. nicht an) */
async function alertOnChange(env: Env, now: Date): Promise<void> {
  const report = await statusReport(env, now);
  const prev = (await env.DB.prepare("SELECT value FROM status_state WHERE key = 'overall'").first<{ value: string }>())?.value ?? 'ok';
  if (prev === report.overall) return;
  await env.DB.prepare("INSERT INTO status_state (key, value) VALUES ('overall', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(report.overall).run();
  if (!env.STATUS_ALERT_EMAIL || !env.SEND) return;
  const domain = env.MAIL_DOMAIN ?? 'einsatzleitwagen.app';
  const lines = report.components.map((c) => `- ${c.label}: ${c.status}${c.detail ? ` (${c.detail})` : ''}`).join('\n');
  try {
    await env.SEND(
      `status@${domain}`,
      env.STATUS_ALERT_EMAIL,
      buildMime({ from: `status@${domain}`, to: env.STATUS_ALERT_EMAIL, subject: `ELVIS Relay: ${prev} → ${report.overall}`, text: `${lines}\n\nhttps://${domain}/status\n` }),
    );
  } catch (e) {
    console.error('Statusalarm', e);
  }
}

interface CheckRow {
  component: StatusComponentId;
  ok: number;
  detail: string;
  checked_at: string;
}

interface IncidentRow {
  id: number;
  title: string;
  body: string;
  severity: StatusIncident['severity'];
  components: string;
  started_at: string;
  resolved_at: string | null;
}

const incident = (r: IncidentRow): StatusIncident => ({
  id: r.id,
  title: r.title,
  body: r.body,
  severity: r.severity,
  components: JSON.parse(r.components) as StatusComponentId[],
  startedAt: r.started_at,
  resolvedAt: r.resolved_at,
});

export async function statusReport(env: Env, now = new Date()): Promise<RelayStatus> {
  const db = env.DB;
  const recent = await db
    .prepare('SELECT component, ok, detail, checked_at FROM status_checks WHERE checked_at > ? ORDER BY checked_at DESC')
    .bind(before(now, 3600_000))
    .all<CheckRow>();
  const incidents = (
    await db
      .prepare('SELECT * FROM incidents WHERE resolved_at IS NULL OR resolved_at > ? ORDER BY started_at DESC LIMIT 20')
      .bind(before(now, 14 * 24 * 3600_000))
      .all<IncidentRow>()
  ).results.map(incident);
  const open = incidents.filter((i) => !i.resolvedAt && i.severity !== 'info');

  const components = STATUS_COMPONENTS.map(({ id, label }) => {
    const rows = recent.results.filter((r) => r.component === id);
    const latest = rows[0];
    let status: StatusLevel = 'ok';
    let detail = '';
    if (!latest) {
      // Mailkomponenten gibt es erst, wenn das Relay Mail kann
      if (id === 'api' || id === 'db' || (id === 'storage' ? env.MAIL : env.SEND)) {
        status = 'degraded';
        detail = 'Keine aktuelle Prüfung';
      }
    } else if (latest.checked_at < before(now, STALE_MS)) {
      status = 'degraded';
      detail = 'Keine aktuelle Prüfung';
    } else if (!latest.ok) {
      // Mehrmals hintereinander fehlgeschlagen = Ausfall, einmal = gestört
      status = rows.slice(0, 3).length === 3 && rows.slice(0, 3).every((r) => !r.ok) ? 'outage' : 'degraded';
      detail = latest.detail;
    }
    for (const i of open) if (i.components.includes(id)) status = worst(status, i.severity as StatusLevel);
    return { id, label, status, lastCheck: latest?.checked_at ?? null, detail };
  });

  let overall = components.reduce<StatusLevel>((acc, c) => worst(acc, c.status), 'ok');
  for (const i of open) if (!i.components.length) overall = worst(overall, i.severity as StatusLevel);

  const days = Array.from({ length: UPTIME_DAYS }, (_, k) => new Date(now.getTime() - (UPTIME_DAYS - 1 - k) * 24 * 3600_000).toISOString().slice(0, 10));
  const daily = await db.prepare('SELECT component, day, checks, ok FROM status_daily WHERE day >= ?').bind(days[0]).all<{ component: StatusComponentId; day: string; checks: number; ok: number }>();
  const uptime = Object.fromEntries(
    STATUS_COMPONENTS.map(({ id }) => [
      id,
      days.map((day) => {
        const r = daily.results.find((x) => x.component === id && x.day === day);
        return { day, ok: r && r.checks ? r.ok / r.checks : null };
      }),
    ]),
  ) as RelayStatus['uptime'];

  return { overall, checkedAt: recent.results[0]?.checked_at ?? null, components, uptime, incidents };
}

export async function handleStatus(req: Request, env: Env, path: string, now: Date): Promise<Response | null> {
  if (req.method === 'GET' && path === '/v1/status') {
    return json(200, await statusReport(env, now), { 'cache-control': 'public, max-age=60' });
  }
  const isNew = path === '/v1/status/incidents';
  const one = /^\/v1\/status\/incidents\/(\d+)$/.exec(path);
  if (!isNew && !one) return null;

  const token = bearer(req);
  if (!env.STATUS_ADMIN_TOKEN || !token || !sameCode(token, env.STATUS_ADMIN_TOKEN)) return fail(401, 'Nicht berechtigt');
  const ts = now.toISOString();

  if (req.method === 'POST' && isNew) {
    const parsed = statusIncidentSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, 'Meldung ungültig');
    const i = parsed.data;
    const row = await env.DB.prepare('INSERT INTO incidents (title, body, severity, components, started_at) VALUES (?, ?, ?, ?, ?) RETURNING *')
      .bind(i.title, i.body, i.severity, JSON.stringify(i.components), ts)
      .first<IncidentRow>();
    return json(201, incident(row!));
  }
  if (req.method === 'PATCH' && one) {
    const parsed = statusIncidentPatchSchema.safeParse(await body(req));
    if (!parsed.success) return fail(400, 'Meldung ungültig');
    const current = await env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(Number(one[1])).first<IncidentRow>();
    if (!current) return fail(404, 'Meldung nicht gefunden');
    const p = parsed.data;
    const row = await env.DB.prepare('UPDATE incidents SET title = ?, body = ?, severity = ?, components = ?, resolved_at = ? WHERE id = ? RETURNING *')
      .bind(
        p.title ?? current.title,
        p.body ?? current.body,
        p.severity ?? current.severity,
        p.components ? JSON.stringify(p.components) : current.components,
        p.resolved === undefined ? current.resolved_at : p.resolved ? (current.resolved_at ?? ts) : null,
        current.id,
      )
      .first<IncidentRow>();
    return json(200, incident(row!));
  }
  return fail(405, 'Nicht erlaubt');
}
