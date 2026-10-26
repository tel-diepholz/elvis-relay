import { MAX_SHEET_PERSONS, PERSON_GRADES, QUALIFICATION_SUGGESTIONS } from './protocol.js';

/**
 * Online-Formular für Personalbögen: Ein Einheitsführer trägt Einheit / Fahrzeug und das Personal ein. Vor dem
 * Absenden verschlüsselt der Browser den Bogen mit dem öffentlichen Schlüssel des ELW – das Relay speichert
 * nur, was es nicht lesen kann. Alles steckt in einer Seite (kein Nachladen, strenge CSP).
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** JSON sicher in <script> einbetten */
const inline = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export const formHeaders = (nonce: string) => ({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // Die Adresse ist der Zugang – nicht weitergeben, nicht indexieren
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
});

const STYLE = `
:root{--bg:#f4f5f7;--card:#fff;--fg:#1b1f24;--muted:#5d6670;--line:#d5d9de;--accent:#c4161c;--accent-fg:#fff;--ok:#1e7d32;--err:#b3261e;--field:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1c1f24;--fg:#e8eaed;--muted:#9aa3ad;--line:#353a41;--accent:#e5484d;--ok:#5cc46a;--err:#ff8a80;--field:#14171a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:44rem;margin:0 auto;padding:16px 16px 96px}
header{margin:8px 0 16px}
h1{font-size:1.45rem;margin:0 0 4px}
h2{font-size:1.05rem;margin:0}
.sub{color:var(--muted);margin:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 12px}
label{display:block;font-weight:600;font-size:.9rem;margin:0 0 4px}
.f{margin:0 0 12px}
.hint{color:var(--muted);font-size:.85rem;font-weight:400}
input,select,textarea{width:100%;font:inherit;color:inherit;background:var(--field);border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-height:44px}
textarea{min-height:64px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
.grid{display:grid;gap:0 12px;grid-template-columns:1fr}
@media (min-width:560px){.grid{grid-template-columns:1fr 1fr}.wide{grid-column:1/-1}}
.person-head{display:flex;align-items:center;gap:8px;margin:0 0 12px}
.person-head h2{flex:1}
.quals{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.quals label{display:inline-flex;align-items:center;gap:6px;font-weight:400;border:1px solid var(--line);border-radius:999px;padding:6px 12px;margin:0;min-height:36px;cursor:pointer}
.quals input{width:auto;min-height:0;margin:0}
.quals label:has(input:checked){border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
button{font:inherit;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:10px 16px;min-height:44px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
button.link{border:none;background:none;color:var(--muted);padding:6px 8px;min-height:0;text-decoration:underline}
button:disabled{opacity:.6;cursor:default}
.actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;align-items:center}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px}
.bar .actions{max-width:44rem;margin:0 auto}
.msg{margin:12px 0 0;font-weight:600}
.msg.err{color:var(--err)}
.done{text-align:center;padding:32px 16px}
.done h2{color:var(--ok);font-size:1.3rem;margin:0 0 8px}
.privacy{color:var(--muted);font-size:.85rem}
[hidden]{display:none!important}
`;

/** Formularfelder je Person (Name, Grenze, Typ) – wie personInputSchema in ELVIS */
const FIELDS: { key: string; label: string; max: number; type?: string; required?: boolean; wide?: boolean; hint?: string; auto?: string; area?: boolean; list?: string }[] = [
  { key: 'lastName', label: 'Nachname', max: 80, required: true, auto: 'family-name' },
  { key: 'firstName', label: 'Vorname', max: 80, required: true, auto: 'given-name' },
  { key: 'birthDate', label: 'Geburtsdatum', max: 10, type: 'date', auto: 'bday' },
  { key: 'function', label: 'Funktion', max: 60, hint: 'z. B. Gruppenführer, Maschinist', list: 'functions' },
  { key: 'organization', label: 'Feuerwehr / Organisation', max: 100, hint: 'wird für die nächste Person übernommen' },
  { key: 'phone', label: 'Telefon (mobil)', max: 40, type: 'tel', auto: 'tel' },
  { key: 'address', label: 'Anschrift', max: 200, wide: true, auto: 'street-address' },
  { key: 'employer', label: 'Arbeitgeber', max: 200, wide: true, hint: 'für Freistellung und Verdienstausfall' },
  { key: 'emergencyContact', label: 'Im Notfall benachrichtigen', max: 200, wide: true, hint: 'Name und Telefon' },
  { key: 'notes', label: 'Bemerkung', max: 500, wide: true, area: true },
];

const FUNCTIONS = ['Verbandsführer', 'Zugführer', 'Gruppenführer', 'Staffelführer', 'Truppführer', 'Maschinist', 'Melder', 'Angriffstrupp', 'Wassertrupp', 'Schlauchtrupp', 'Sanitäter'];

/** Der Teil, der im Browser läuft (als Text eingebettet) */
const CLIENT = `
const C = JSON.parse(document.getElementById('cfg').textContent);
const $ = (s, el = document) => el.querySelector(s);
const persons = $('#persons');
const tpl = $('#person-tpl');
const msg = $('#msg');
let n = 0;

function renumber() {
  const cards = [...persons.children];
  cards.forEach((c, i) => {
    $('.no', c).textContent = 'Person ' + (i + 1);
    $('.remove', c).hidden = cards.length === 1;
  });
  $('#count').textContent = cards.length === 1 ? '1 Person' : cards.length + ' Personen';
  $('#add').disabled = cards.length >= C.max;
}

function addPerson(focus) {
  const prev = persons.lastElementChild;
  const node = tpl.content.firstElementChild.cloneNode(true);
  const id = 'p' + (++n);
  node.querySelectorAll('[data-k]').forEach((el) => {
    el.id = id + '-' + el.dataset.k;
    const lab = el.closest('.f')?.querySelector('label[data-for]');
    if (lab) lab.htmlFor = el.id;
  });
  node.querySelectorAll('.quals input').forEach((el, i) => { el.id = id + '-q' + i; el.parentElement.htmlFor = el.id; });
  if (prev) $('[data-k=organization]', node).value = $('[data-k=organization]', prev).value;
  $('.remove', node).addEventListener('click', () => { node.remove(); renumber(); });
  persons.appendChild(node);
  renumber();
  if (focus) $('[data-k=lastName]', node).focus();
}

function collect() {
  return {
    unitLabel: $('#unit').value.trim(),
    persons: [...persons.children].map((c) => {
      const p = {};
      c.querySelectorAll('[data-k]').forEach((el) => { p[el.dataset.k] = el.value.trim(); });
      const quals = [...c.querySelectorAll('.quals input:checked')].map((el) => el.value);
      for (const q of p.moreQuals.split(',')) if (q.trim() && !quals.includes(q.trim())) quals.push(q.trim().slice(0, 40));
      delete p.moreQuals;
      p.qualifications = quals.slice(0, 30);
      return p;
    }),
  };
}

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function encrypt(sheet) {
  const subtle = crypto.subtle;
  const pub = await subtle.importKey('jwk', C.publicKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(C.formId) }, aes, enc.encode(JSON.stringify(sheet)));
  const key = await subtle.encrypt({ name: 'RSA-OAEP' }, pub, await subtle.exportKey('raw', aes));
  return { alg: 'RSA-OAEP-256+A256GCM', key: b64(key), iv: b64(iv), data: b64(data) };
}

$('#add').addEventListener('click', () => addPerson(true));
$('#again').addEventListener('click', () => {
  persons.replaceChildren();
  $('#unit').value = '';
  addPerson(false);
  $('#done').hidden = true;
  $('#sheet').hidden = false;
  window.scrollTo(0, 0);
  $('#unit').focus();
});

$('#sheet').addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = '';
  msg.className = 'msg';
  if (!window.crypto || !crypto.subtle) {
    msg.textContent = 'Dieser Browser kann nicht verschlüsseln – bitte einen aktuellen Browser verwenden.';
    msg.className = 'msg err';
    return;
  }
  const btn = $('#send');
  btn.disabled = true;
  btn.textContent = 'Wird übermittelt …';
  try {
    const sheet = collect();
    const res = await fetch(location.pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await encrypt(sheet)) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Übermittlung fehlgeschlagen (HTTP ' + res.status + ')');
    $('#done-text').textContent = sheet.persons.length + (sheet.persons.length === 1 ? ' Person' : ' Personen') + ' für „' + sheet.unitLabel + '“ an die Einsatzleitung übermittelt.';
    $('#sheet').hidden = true;
    $('#done').hidden = false;
    window.scrollTo(0, 0);
  } catch (err) {
    msg.textContent = (err && err.message) || String(err);
    msg.className = 'msg err';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Personalbogen absenden';
  }
});

addPerson(false);
`;

const field = (f: (typeof FIELDS)[number]) => {
  const attrs = `data-k="${f.key}" maxlength="${f.max}"${f.required ? ' required' : ''}${f.auto ? ` autocomplete="${f.auto}"` : ''}${f.list ? ` list="${f.list}"` : ''}`;
  const control = f.area ? `<textarea ${attrs}></textarea>` : `<input type="${f.type ?? 'text'}" ${attrs}>`;
  return `<div class="f${f.wide ? ' wide' : ''}"><label data-for>${esc(f.label)}${f.required ? ' *' : ''}${f.hint ? ` <span class="hint">– ${esc(f.hint)}</span>` : ''}</label>${control}</div>`;
};

const personTemplate = `<section class="card person">
  <div class="person-head"><h2 class="no">Person</h2><button type="button" class="link remove">Entfernen</button></div>
  <div class="grid">
    ${FIELDS.slice(0, 3).map(field).join('')}
    <div class="f"><label data-for>Einordnung</label><select data-k="grade">${PERSON_GRADES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></div>
    ${FIELDS.slice(3).map(field).join('')}
    <div class="f wide"><label>Qualifikationen</label>
      <div class="quals">${QUALIFICATION_SUGGESTIONS.map((q) => `<label><input type="checkbox" value="${esc(q)}">${esc(q)}</label>`).join('')}</div>
      <input data-k="moreQuals" maxlength="300" placeholder="weitere, durch Komma getrennt" aria-label="Weitere Qualifikationen">
    </div>
  </div>
</section>`;

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function formPage(opts: { nonce: string; formId: string; title: string; expiresAt: string; publicKey: unknown }): string {
  const cfg = { formId: opts.formId, publicKey: opts.publicKey, max: MAX_SHEET_PERSONS };
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Personalbogen – ELVIS</title>
<style nonce="${opts.nonce}">${STYLE}</style>
</head>
<body>
<main>
<header>
  <h1>Personalbogen</h1>
  ${opts.title ? `<p class="sub">${esc(opts.title)}</p>` : ''}
  <p class="sub">Link gültig bis ${esc(fmtDate(opts.expiresAt))} Uhr</p>
</header>
<form id="sheet">
  <section class="card">
    <div class="f"><label for="unit">Einheit / Fahrzeug *</label><input id="unit" maxlength="100" required placeholder="z. B. LF 10 Barnstorf, 2. Zug" autocomplete="off"></div>
    <p class="privacy">Bitte die Personen eintragen, die mit dieser Einheit im Einsatz sind. Die Angaben werden in diesem Browser verschlüsselt und nur an die Einsatzleitung (ELW) übermittelt.</p>
  </section>
  <div id="persons"></div>
  <div class="actions"><button type="button" id="add">+ Person hinzufügen</button><span class="hint" id="count"></span></div>
  <p id="msg" class="msg" role="alert"></p>
  <div class="bar"><div class="actions"><span class="hint">* Pflichtfeld</span><button type="submit" class="primary" id="send">Personalbogen absenden</button></div></div>
</form>
<section id="done" class="card done" hidden>
  <h2>Übermittelt</h2>
  <p id="done-text"></p>
  <button type="button" id="again">Weiteren Personalbogen ausfüllen</button>
</section>
<datalist id="functions">${FUNCTIONS.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
<template id="person-tpl">${personTemplate}</template>
</main>
<script id="cfg" type="application/json" nonce="${opts.nonce}">${inline(cfg)}</script>
<script nonce="${opts.nonce}">${CLIENT}</script>
</body>
</html>
`;
}

/** Link abgelaufen, beendet oder unbekannt */
export function closedPage(nonce: string): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Personalbogen – ELVIS</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
<header><h1>Personalbogen</h1></header>
<section class="card done"><p>Dieser Link ist abgelaufen oder wurde von der Einsatzleitung beendet. Bitte dort einen neuen Link anfordern.</p></section>
</main>
</body>
</html>
`;
}
