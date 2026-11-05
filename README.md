# ELVIS Relay

Cloud-Relay für die App-Anbindung von [ELVIS](https://github.com/tel-diepholz/elvis). Über das Relay senden
Einsatzkräfte mit der App [ELVIS Ortung](https://github.com/tel-diepholz/elvis-app) ihre Position an den
Einsatzleitwagen (ELW). ELVIS holt die Positionen ausgehend ab, der ELW braucht also keine öffentliche Adresse.
Außerdem stellt es Online-Formulare für Personalbögen bereit, ein verschlüsseltes Postfach je ELW (E-Mail) und die
Daten der Statusseite.

```
App ──HTTPS──▶ Relay (Cloudflare Worker + D1) ◀──Abruf alle 15 s── ELVIS im ELW
```

Es läuft unter **`https://relay.einsatzleitwagen.app`**. Diese Adresse ist in ELVIS und in der App als Vorgabe eingebaut.

## Ablauf

1. Die App meldet sich an (`POST /v1/devices`) und zeigt App-ID und Code.
2. ELVIS meldet sich beim ersten Koppeln selbst an (`POST /v1/elws`). Danach koppelt es die App mit ID und Code
   (`POST /v1/elws/me/pairings`). Der Code gilt einmal; nach 5 Fehlversuchen bekommt die App einen neuen.
3. Die App sendet Positionen (`POST /v1/devices/me/positions`). Gespeichert werden sie nur, solange sie gekoppelt
   ist. Jede Antwort enthält den Kopplungsstatus; so merkt die App, wenn ELVIS entkoppelt hat, und hört auf zu orten.
4. ELVIS holt die Positionen mit einem Cursor ab (`GET /v1/elws/me/positions?after=<seq>`). Was mit dem Cursor
   bestätigt ist, löscht das Relay.

| Endpunkt | Wer | Zweck |
| --- | --- | --- |
| `POST /v1/devices` | App | anmelden → `{ deviceId, token, code }` |
| `GET /v1/devices/me` | App | Kopplungsstatus `{ paired, label, code }` |
| `POST /v1/devices/me/positions` | App | Position `{ lat, lon, accuracyM, ts, battery }` → Status |
| `DELETE /v1/devices/me` | App | App-ID löschen („Neue App-ID“) |
| `POST /v1/elws` | ELVIS | anmelden → `{ elwId, token }` |
| `POST /v1/elws/me/pairings` | ELVIS | koppeln `{ deviceId, code, label }` |
| `PUT /v1/elws/me/pairings/:deviceId` | ELVIS | Bezeichnung ändern |
| `DELETE /v1/elws/me/pairings/:deviceId` | ELVIS | entkoppeln |
| `GET /v1/elws/me/positions?after=<seq>` | ELVIS | Positionen abholen (höchstens 500 je Abruf) |
| `POST /v1/elws/me/forms` | ELVIS | Formular-Link anlegen `{ title, publicKey (JWK), expiresAt }` → `{ formId, url }` |
| `DELETE /v1/elws/me/forms/:formId` | ELVIS | Link beenden (nicht abgeholte Bögen bleiben bis zur Abholung) |
| `GET /v1/elws/me/submissions?after=<seq>` | ELVIS | eingereichte (verschlüsselte) Personalbögen abholen |
| `GET /p/:formId` | Einheitsführer | Online-Formular für Personalbögen |
| `POST /p/:formId` | Formular | verschlüsselten Bogen einreichen |
| `GET /datenschutz` | alle | Datenschutzhinweise der App (Play Store) |
| `GET /v1/elws/me/mailbox` | ELVIS | Zustand des Postfachs (`none`, `pending`, `approval`, `active`, `rebind-pending`, `moved`) |
| `POST /v1/elws/me/mailbox` | ELVIS | Postfach beantragen `{ localpart, adminEmail, publicKey, revocationCert, sigPublicKey }` |
| `POST /v1/elws/me/mailbox/rebind` | ELVIS | Adresse nach Neuinstallation übernehmen (gleicher Inhalt) |
| `DELETE /v1/elws/me/mailbox` | ELVIS | Antrag zurückziehen oder Postfach kündigen |
| `GET /v1/elws/me/mail?after=<seq>` | ELVIS | eingegangene Mails auflisten; alles bis `after` wird gelöscht |
| `GET /v1/elws/me/mail/:seq` | ELVIS | eine Mail (OpenPGP, für den ELW verschlüsselt) |
| `POST /v1/elws/me/mail/outbox` | ELVIS | Mail senden `{ to, raw (base64) }` |
| `GET`/`POST /m/confirm/:token` | Admin | Bestätigungslink (erst der POST ändert etwas) |
| `GET /.well-known/openpgpkey/…` | alle | Web Key Directory der Postfächer |
| `POST /v1/elws/me/hooks` | ELVIS | Webhook für einen Messenger anlegen bzw. abfragen `{ kind: 'whatsapp' \| 'threema' }` → `{ url, verifyToken }` |
| `DELETE /v1/elws/me/hooks/:kind` | ELVIS | Webhook löschen (die Adresse gilt dann nicht mehr) |
| `GET /v1/elws/me/hooks/events?after=<seq>` | ELVIS | gepufferte Aufrufe abholen (höchstens 100 je Abruf) |
| `GET /h/:hookId` | Meta | Prüfung beim Einrichten (`hub.verify_token` → `hub.challenge`) |
| `POST /h/:hookId` | Meta, Threema | Webhook-Aufruf puffern (unverändert, samt `X-Hub-Signature-256`) |
| `GET /v1/regions?parent=<ars>` · `?q=<Name>` · `/v1/regions/<ars>` | alle | Kommunen-Katalog (Land › Kreis › Gemeindeverband › Gemeinde) |
| `GET`/`PUT`/`DELETE /v1/elws/me/messaging/profile` | ELVIS | Eintrag im Verzeichnis `{ regionArs, vehicle, listed }` (braucht ein aktives Postfach) |
| `GET /v1/elws/me/messaging/directory?q=&region=` | ELVIS | Verzeichnis durchsuchen (Region als Präfix: `03251` = alles im LK Diepholz) |
| `GET /v1/elws/me/messaging/directory/:elwId` | ELVIS | ein Eintrag samt öffentlichem Schlüssel |
| `GET`/`POST /v1/elws/me/messaging/conversations` | ELVIS | Chats auflisten bzw. anfragen `{ to, ciphertext }` |
| `POST /v1/elws/me/messaging/conversations/:id/accept\|decline\|close` | ELVIS | annehmen, ablehnen (nur die angefragte Seite), beenden |
| `POST /v1/elws/me/messaging/messages` | ELVIS | Nachricht `{ conversationId, ciphertext, attachmentId? }` (nur angenommene Chats) |
| `POST /v1/elws/me/messaging/attachments`, `GET …/:id` | ELVIS | verschlüsselten Anhang hochladen bzw. als Empfänger laden (höchstens 25 MB) |
| `GET /v1/elws/me/messaging/events?after=<seq>` | ELVIS | Ereignisse abholen; alles bis `after` wird gelöscht (samt Anhängen) |
| `GET /v1/elws/me/messaging/socket` | ELVIS | WebSocket: Anstoß bei neuen Ereignissen (Durable Object je ELW) |
| `GET /v1/status` | alle | Statusseite (einsatzleitwagen.app/status) |
| `POST /v1/status/incidents`, `PATCH /v1/status/incidents/:id` | Betreiber | Störungsmeldungen (Bearer `STATUS_ADMIN_TOKEN`) |

Die Zugangsschlüssel werden als `Authorization: Bearer …` übergeben; das Relay speichert nur ihren SHA-256-Hash.
Das Protokoll ist in `src/protocol.ts` beschrieben. Gegenstück in ELVIS: `packages/shared/src/applink.ts`;
Änderungen an beiden Stellen gleich halten.

## E-Mail

Jeder ELW kann ein Postfach `<name>@einsatzleitwagen.app` bekommen. Cloudflare Email Routing gibt eingehende Mails an
den Worker (`email`-Handler), der Versand läuft über Cloudflare Email Sending (`send_email`-Binding `MAILER`).

1. **Beantragen:** ELVIS erzeugt einen OpenPGP-Schlüssel (Curve25519, User-ID = Postfachadresse) und einen
   Ed25519-Schlüssel für signierte Abrufe. Es schickt beide öffentlichen Schlüssel, das Widerrufszertifikat, die
   gewünschte Adresse und eine Admin-Kontaktadresse. Das Relay prüft Schlüssel und Widerruf und schickt einen
   Bestätigungslink an die Admin-Adresse (24 Stunden gültig).
2. **Bestätigen:** Erst der Knopf auf der Bestätigungsseite (POST) aktiviert das Postfach, Linkvorschauen lösen nichts aus.
   Mit `MAIL_APPROVAL = "manual"` wartet das Postfach danach auf die Freigabe des Betreibers:
   `npx wrangler d1 execute elvis-relay --remote --command "UPDATE mailboxes SET status = 'active' WHERE localpart = '…'"`.
3. **Schlüssel-Mail:** Einmalig gehen Fingerprint, `publickey.asc` und `revocation.asc` an den Admin. Danach löscht das
   Relay das Widerrufszertifikat. Bleibt der Versand hängen, holt der stündliche Cron ihn nach.
4. **Empfang:** Das Relay verschlüsselt jede Mail komplett (inkl. Kopf) sofort mit dem öffentlichen Schlüssel des ELW und
   legt sie in R2 ab (`MAIL`), in D1 stehen nur Nummer, Größe und Zeit. Unbekannte Empfänger werden abgewiesen.
5. **Abruf und Versand:** Jeder Aufruf unter `/v1/elws/me/mail*` muss zusätzlich zum Bearer-Token signiert sein:
   Header `x-elvis-signature: t=<Unix-ms>,n=<Nonce>,s=<Ed25519>` über `Methode\nPfad?Query\nSHA-256(Körper)\nt\nn`,
   ±5 Minuten, jede Nonce nur einmal. Bei ungültiger Signatur bekommt der Admin höchstens einmal am Tag eine Warnung.
   Versand nur mit der eigenen Absenderadresse, höchstens 50 Empfänger je Mail, 60 je Stunde und 300 je Tag.
6. **Schlüsselverzeichnis:** Unter `openpgpkey.einsatzleitwagen.app` liefert das Relay die Schlüssel aktiver Postfächer
   per WKD, damit Gegenstellen automatisch verschlüsselt antworten.
7. **Neuinstallation:** `POST /v1/elws/me/mailbox/rebind` mit neuen Schlüsseln. Die Antwort ist immer gleich, eine Mail mit
   Bestätigungslink geht aber nur raus, wenn die Admin-Adresse stimmt (höchstens 3 Versuche am Tag). Nach der Bestätigung
   gehört die Adresse der neuen Installation, nicht abgeholte Mails werden gelöscht, die alte Installation bekommt 403.
   Ist die Admin-Adresse nicht mehr erreichbar, überträgt der Betreiber von Hand (Spalten `elw_id`, `public_key`,
   `fingerprint`, `sig_public_key` in `mailboxes`).
8. **Kündigen:** Nicht abgeholte Mails werden gelöscht, die Adresse ist 90 Tage gesperrt.

Das Protokoll steht in `src/mailprotocol.ts`, Gegenstück in ELVIS: `packages/shared/src/mailrelay.ts`.

## Backups

Backup-Treiber „einsatzleitwagen.app – Cloud“ in ELVIS (`src/backup.ts`). ELVIS leitet aus dem
Wiederherstellungsschlüssel des Nutzers per HKDF Tresor-ID, Zugang und AES-Schlüssel ab. Das Relay speichert nur
den Hash des Zugangs, die verschlüsselten Teile in R2 (`BACKUPS`, je höchstens 16 MiB) und einen verschlüsselten
Metadaten-Blob. Eine frische Installation braucht zum Wiederherstellen also nur den Schlüssel.

- `PUT /v1/backups/<tresor>`: Tresor öffnen, anlegen nur mit Header `x-elvis-elw: <ELW-Token>`
- `GET /v1/backups/<tresor>`: Kontingent, belegter Speicher, abgeschlossene Backups (neueste zuerst)
- `POST …/backups/<uuid>` `{meta}`, `PUT …/backups/<uuid>/parts/<n>`, `POST …/backups/<uuid>/complete` `{parts, size}`
- `GET …/backups/<uuid>/parts/<n>`, `DELETE …/backups/<uuid>`

Kontingent: `BACKUP_MAX_COUNT` / `BACKUP_MAX_BYTES` (Vorgabe), je Tresor über `max_backups` / `max_bytes` in
`backup_vaults` (z. B. für ein Abo). Passt ein neues Backup nicht mehr hinein, fallen die ältesten weg. Der stündliche
Cron löscht Uploads, die nach 24 Stunden nicht abgeschlossen sind, und Tresore ohne Zugriff seit einem Jahr.

## Statusseite

Der Cron `0 * * * *` prüft stündlich Datenbank, R2 und den Mailweg Ende zu Ende: Er schickt eine Testmail an
`probe@einsatzleitwagen.app`, die beim nächsten Lauf angekommen sein muss. Fehler aus dem Betrieb (Annahme, Versand)
der letzten Stunde zählen mit. Die Testmails zählen gegen das tägliche Versandkontingent des Cloudflare-Kontos. Meldet
Cloudflare das Kontingent als erschöpft, zeigt die Statusseite „Tägliches Versandkontingent erschöpft“, bis zum
nächsten Tag (UTC) gehen keine Testmails mehr raus, und ELWs bekommen beim Versand 429 mit einer klaren Meldung. `GET /v1/status` liefert Gesamtstatus, Komponenten, Tageswerte der letzten 90 Tage und
Störungsmeldungen. Die Homepage zeigt das unter `/status` und blendet bei Störungen einen Hinweis ein. Ändert sich der
Gesamtstatus, geht eine Mail an `STATUS_ALERT_EMAIL` (fällt der Versand selbst aus, kommt sie nicht an).

Meldungen pflegen:

```sh
curl -X POST https://relay.einsatzleitwagen.app/v1/status/incidents \
  -H "authorization: Bearer $STATUS_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Wartung Mail-Versand","body":"Heute 20–21 Uhr","severity":"degraded","components":["outbound"]}'
curl -X PATCH https://relay.einsatzleitwagen.app/v1/status/incidents/1 \
  -H "authorization: Bearer $STATUS_ADMIN_TOKEN" -d '{"resolved":true}'
```

## Cloud Messaging

Fahrzeug-zu-Fahrzeug-Chat zwischen ELVIS-Installationen (`src/messaging.ts`, Protokoll `src/messagingprotocol.ts`).
Voraussetzung ist ein aktives Postfach: Signatur (Ed25519) und Verschlüsselung (OpenPGP) nutzen dessen Schlüssel.

```
ELVIS A ──signierte POSTs──▶ Relay (D1: msg_events je Empfänger) ──WebSocket-Anstoß──▶ ELVIS B ──GET events?after──▶ Relay
```

- **Verzeichnis:** Jede Installation trägt Fahrzeug (Name, Funkrufname, Organisation, Kontaktdaten) und ihre
  Gebietskörperschaft als Amtlichen Regionalschlüssel ein. Der ist präfix-hierarchisch, so findet die Suche nach einem
  Kreis auch alle Gemeinden darin. Nicht gelistete Installationen erscheinen nicht in der Suche, können aber anfragen.
- **Zustellung:** Jedes Ereignis (Anfrage, Statuswechsel, Nachricht) liegt zuerst in D1. Danach stößt das Durable
  Object `ElwSocket` (`src/socket.ts`, Hibernation API, eines je ELW) die verbundene Installation an. ELVIS holt dann
  per Cursor ab und quittiert damit. Pushes können sich überholen, darum trägt nur der Cursor die Reihenfolge. Den
  Keepalive (`ping` → `pong`) beantwortet die Laufzeit, ohne das Objekt zu wecken. Ohne Verbindung kostet es nichts.
- **Kommunen-Katalog:** `src/regions.json` erzeugt `scripts/build-regions.py` aus dem Gemeindeverzeichnis von Destatis
  (Auszug „Gemeinden in Deutschland nach Fläche, Bevölkerung und Postleitzahl“, xlsx, jährlich zum 31.12.).
  © Statistisches Bundesamt (Destatis); Vervielfältigung und Verbreitung mit Quellenangabe gestattet. Aktuell:
  Gebietsstand 31.12.2024.

## Cloud-Zugang (Portal)

Portal für die gemeinsame Datenpflege unter **`https://cloud.einsatzleitwagen.app`**: Konten, Baustruktur, Einladungen
und der Zustand der Cloud-Module verknüpfter ELVIS-Installationen. Die Oberfläche (`portal/`, Vite + React) liefert
derselbe Worker als Static Assets aus (`[assets]` in `wrangler.toml`, nur unter der Portal-Adresse), die API liegt
unter `/v1/cloud` (`src/cloud/portal.ts`), Protokoll in `src/cloudprotocol.ts`.

- **Konto:** E-Mail-Adresse und Passwort (mindestens 10 Zeichen, PBKDF2-SHA256 mit 100.000 Runden und Salz je Konto).
  - *Registrieren:* Danach kommt ein Bestätigungslink (24 Stunden). Erst danach ist eine Anmeldung möglich. Mit einer
    Einladung an genau diese Adresse ist sie sofort bestätigt.
  - *Anmelden:* Nach 5 falschen Passwörtern ist das Konto 15 Minuten gesperrt. Antworten und Mails verraten nicht, ob es
    eine Adresse schon gibt.
  - *Passwort vergessen:* Ein Link (1 Stunde) setzt ein neues Passwort und beendet alle Sitzungen. So setzen auch Konten
    aus der Zeit der Anmeldecodes ihr erstes Passwort.
  - *Im Konto (`/konto`):* Passwort ändern (beendet die anderen Sitzungen, Hinweis per Mail), E-Mail-Adresse ändern (gilt
    erst nach Bestätigung an die neue Adresse, Hinweis an die alte), überall sonst abmelden, Konto löschen. Wer einen
    Bereich als einziger verwaltet, kann sein Konto nicht löschen.
  - *Mails:* höchstens 5 je Adresse und Stunde. Links sind einmalig und nur als Hash gespeichert.
- **Sitzung:** Cookie `elvis_cloud` (HttpOnly, Secure, SameSite=Strict, 30 Tage). Ändernde Aufrufe verlangen JSON und,
  wenn der Browser sie schickt, die eigene Origin.
- **Baustruktur:** Gebietskörperschaften nach dem Amtlichen Regionalschlüssel (Knoten `ars:<ARS>`, aus dem
  Kommunen-Katalog, entstehen bei Bedarf), darunter frei angelegte Knoten (z. B. Ortsfeuerwehr). Rollen *Lesen*,
  *Pflegen* und *Verwalten* gelten für den Knoten und alles darunter: Wer den Landkreis verwaltet, verwaltet auch jede
  Gemeinde darin.
- **Erster Verwalter:** Konten mit `operator = 1` sind überall Verwalter und setzen die ersten Verwalter eines
  Landkreises oder einer Gemeinde per Einladung ein. Betreiber von Hand festlegen (das Konto muss sich einmal angemeldet
  haben):
  `npx wrangler d1 execute elvis-relay --remote --command "UPDATE accounts SET operator = 1 WHERE email = '…'"`.
- **Einladungen** gehen per Mail mit Link `/einladung/<token>` (14 Tage gültig) und gelten nur für die eingeladene
  Adresse.
- **Installation verknüpfen:** ELVIS (*Einstellungen → Cloud-Zugang*) fordert einen Code an (8 Zeichen, eine Stunde),
  ein Verwalter gibt ihn auf der Seite des Knotens ein (höchstens 10 falsche Codes je Stunde und Konto). Aufrufe von
  ELVIS unter `/v1/elws/me/cloud` sind wie der Mail-Abruf signiert, aber mit einem eigenen Ed25519-Schlüssel der
  Verknüpfung, ein Postfach ist nicht nötig.
- **Status** je Installation aus dem, was das Relay ohnehin speichert: letzter Kontakt, Postfach (wartende Mails, Größe,
  älteste, letzter Abruf, heute gesendet), Cloud Messaging (wartende Ereignisse, Chats, Verzeichnis), App-Anbindung,
  Webhooks, Backup. Inhalte sieht das Portal nicht.

| Endpunkt | Wer | Zweck |
| --- | --- | --- |
| `POST /v1/cloud/login`, `POST …/login/verify`, `POST …/logout`, `GET`/`PATCH /v1/cloud/me` | Portal | Anmelden, Konto |
| `GET`/`PATCH`/`DELETE /v1/cloud/nodes/:id`, `POST /v1/cloud/nodes` | Portal | Knoten ansehen, freie Knoten anlegen, umbenennen, löschen |
| `PUT`/`DELETE /v1/cloud/nodes/:id/members/:accountId` | Verwalter | Rolle ändern, entfernen |
| `POST /v1/cloud/invitations`, `DELETE …/:id`, `GET …/token/:token`, `POST …/token/:token/accept` | Portal | Einladungen |
| `GET`/`POST /v1/cloud/installations`, `GET`/`PUT`/`DELETE …/:elwId` | Portal | Installationen und Status, verknüpfen, verschieben, trennen |
| `POST /v1/elws/me/cloud/link`, `GET`/`DELETE /v1/elws/me/cloud` | ELVIS | Code anfordern, Stand abfragen, trennen |

Gegenstück in ELVIS: `packages/shared/src/cloudrelay.ts`.

### Stammdaten

Kräfte, Einsatzstichworte, Rollen, Benutzer (ohne PIN) und Aufgabenvorlagen liegen in `md_records` (`src/cloud/records.ts`,
Protokoll `src/syncprotocol.ts`, Gegenstück in ELVIS `packages/shared/src/cloudsync.ts`). Jeder Datensatz gehört einem
Knoten und hat eine Revision. `seq` ist der Änderungszähler, Gelöschtes bleibt als Tombstone stehen.

- **Sichtbarkeit:** Kräfte und Stichworte sieht ein Knoten von oben und von unten, Rollen, Benutzer und
  Aufgabenvorlagen nur von oben (`VISIBLE_BELOW`).
- **Schreiben:** im Portal mit der Rolle *Pflegen* am Knoten des Datensatzes, als Installation nur am eigenen Knoten.
  Optimistische Sperre: `baseRev` muss stimmen, sonst kommt `conflict` mit dem aktuellen Stand.
- **Kräfte** führen ihre Untereinheiten als uid-Liste (auch über Knoten hinweg). Aufgabenvorlagen verweisen per uid
  auf Rollen, Dokumentvorlagen nur per Namen.

| Endpunkt | Wer | Zweck |
| --- | --- | --- |
| `GET /v1/cloud/nodes/:id/records?kind=` | Portal | sichtbare Datensätze am Knoten (mit `editable`, `position`) |
| `POST /v1/cloud/records`, `PUT`/`DELETE /v1/cloud/records/:uid` | Portal | anlegen, ändern (`baseRev`), löschen (`?rev=`) |
| `GET /v1/elws/me/cloud/sync?after=<seq>` | ELVIS | Änderungen abholen (höchstens 500, `more`) |
| `POST /v1/elws/me/cloud/sync` | ELVIS | eigene Änderungen `{ changes: [{ uid, kind, baseRev, data, deleted }] }` → je `ok`/`conflict`/`invalid` |
| `POST /v1/cloud/records/batch` | Portal | viele auf einmal anlegen (CSV-Import, höchstens 500) |
| `PUT`/`GET /v1/elws/me/cloud/files/:uid` | ELVIS | Datei der Objektbibliothek hochladen (vor dem Datensatz) bzw. abholen |
| `PUT /v1/cloud/files/:uid?object=`, `GET /v1/cloud/files/:uid` | Portal | dasselbe im Portal |

**Objektbibliothek:**
- **Arten:** `objectType`, `object` und `objectFile`.
- **Sichtbarkeit:** Sie hängt am Typ (`visibility`: `both`, `down`, `up`, `own`). Objekte und Dateien tragen sie in
  der Spalte `scope` und bekommen bei einer Änderung eine neue `seq`. Typen selbst sieht jeder Knoten darüber und
  darunter.
- **Vordefinierte Typen:** Wasserentnahmestelle und Einsatzobjekt liegen mit fester uid an der Wurzel. Pflegen dürfen
  sie nur Betreiber.
- **Dateien:** Sie liegen in R2 `elvis-library` (`lib/<uid>`), höchstens 50 MB. Sie sind unveränderlich, der
  Datensatz verlangt die vorher hochgeladene Datei mit gleicher Größe. Gelöschte Objekte nehmen ihre Dateien mit.
  Uploads ohne Datensatz räumt der stündliche Cron nach einem Tag weg.

## Datenschutz

- Personalbögen verschlüsselt der Browser mit dem öffentlichen Schlüssel des ELW (RSA-OAEP-256 + AES-256-GCM,
  Formular-ID als Zusatzdaten). Das Relay kann sie nicht lesen; es löscht sie mit der Abholung, spätestens nach
  7 Tagen. Formular-Links gelten höchstens 7 Tage, höchstens 200 Bögen je Link. Die Formularseite läuft mit strenger
  CSP, `no-referrer` und `noindex` (die Adresse ist der Zugang).

- Mails speichert das Relay nur für den ELW verschlüsselt und löscht sie mit der Abholung, spätestens nach 30 Tagen.
  Es kennt Adresse und Admin-Kontakt des Postfachs, nicht den privaten Schlüssel. Unverschlüsselt eingehende Mails
  sieht es kurz beim Empfang, unverschlüsselt gesendete beim Versand.
- Cloud Messaging: Anfragen, Nachrichten und Anhänge sind für die Gegenseite verschlüsselt und signiert. Das Relay sieht
  nur, wer wann wem schreibt. Es löscht sie mit der Abholung, spätestens nach 14 Tagen. Beendete und abgelehnte Chats
  löscht es nach 14 Tagen, Verzeichniseinträge ohne aktives Postfach beim nächsten Aufräumen. Den Verzeichniseintrag
  (Fahrzeug, Kontaktdaten, Gebiet) sehen alle registrierten Installationen.
- Cloud-Zugang: Das Relay speichert E-Mail-Adresse und Namen der Konten, Rollen, Einladungen und Namen der verknüpften
  Installationen. Passwörter nur als PBKDF2-Hash, Links aus Mails und Sitzungen nur als Hash; Links gelten 1 bzw. 24
  Stunden, Sitzungen 30 Tage.
- Das Relay kennt sonst nur zufällige IDs, keine Namen oder Telefonnummern.
- Positionen löscht es mit der Abholung durch den ELW, spätestens nach 24 Stunden (stündlicher Cron).
- App-IDs ohne Kontakt löscht es nach 90 Tagen, ELW-Zugänge nach einem Jahr.
- Der Text unter `/datenschutz` steht in `src/privacy.ts`. Vor der Veröffentlichung im Play Store dort den
  Betreiber ergänzen.

## Einrichten

Einmalig, mit einem Cloudflare-Konto (Free-Tier genügt):

```sh
npm install
npx wrangler login
npx wrangler d1 create elvis-relay   # ausgegebene database_id in wrangler.toml eintragen und committen
npm run deploy                        # Schema anlegen und Worker veröffentlichen
```

Für E-Mail zusätzlich (Zone `einsatzleitwagen.app` im selben Konto):

```sh
npx wrangler r2 bucket create elvis-mail
npx wrangler r2 bucket create elvis-backups      # Backups der Installationen
npx wrangler r2 bucket create elvis-messaging    # Anhänge des Cloud Messagings
npx wrangler r2 bucket create elvis-library      # Dateien der Objektbibliothek (Cloud-Zugang)
npx wrangler secret put STATUS_ADMIN_TOKEN       # langer Zufallswert für Störungsmeldungen
```

- **Email Routing** für `einsatzleitwagen.app` aktivieren (setzt MX und SPF) und eine Catch-all-Regel „Send to a Worker“
  → `elvis-relay` anlegen.
- **Email Sending** für die Domain einrichten (DKIM-Einträge übernehmen), außerdem einen DMARC-Eintrag setzen, z. B.
  `_dmarc TXT "v=DMARC1; p=quarantine; rua=mailto:…"`.
- Die Custom Domains `relay.einsatzleitwagen.app`, `openpgpkey.einsatzleitwagen.app` (WKD) und
  `cloud.einsatzleitwagen.app` (Portal) legt `wrangler deploy` über `routes` selbst an. `npm run deploy` baut vorher
  das Portal (`portal/dist`).
- Optional in `wrangler.toml`: `MAIL_APPROVAL = "manual"`, `STATUS_ALERT_EMAIL`.

Der Worker läuft unter der Custom Domain `relay.einsatzleitwagen.app` (legt `wrangler deploy` über `routes` an).
Die alte Adresse `https://elvis-relay.hhansen06.workers.dev` bleibt aktiv (`workers_dev = true`), damit ELWs und
Apps mit der früheren Vorgabe weiter funktionieren. Bei einem Wechsel der Adresse müssen ELVIS (`app.relayUrl`), die
App (Vorgabe in `app/build.gradle`) und die Homepage (`src/links.ts`) angepasst werden.

### Automatisch veröffentlichen

Jeder Push auf `main` wird getestet und, sobald die Secrets hinterlegt sind, veröffentlicht. Dabei wendet der
Workflow auch neue Migrationen an.

| Secret | Inhalt |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API-Token mit den Rechten *Workers Scripts: Edit*, *D1: Edit*, *Workers R2 Storage: Edit* und *Workers Routes: Edit* (für die WKD-Domain) |
| `CLOUDFLARE_ACCOUNT_ID` | Konto-ID aus dem Cloudflare-Dashboard |

## Entwickeln

```sh
npm test                                              # Vitest, D1 im Speicher (better-sqlite3)
npx wrangler d1 migrations apply elvis-relay --local
npm run dev                                           # http://localhost:8787
```

Zum Ausprobieren ELVIS mit `ELVIS_APP_RELAY_URL=http://localhost:8787` starten. Lokal schreibt `wrangler dev` gesendete
Mails als `.eml`-Datei (Pfad steht im Log), Eingang lässt sich mit
`curl -X POST 'localhost:8787/cdn-cgi/handler/email?from=a@example.org&to=<name>@einsatzleitwagen.app' --data-binary @mail.eml`
simulieren und die Statusprüfung mit `wrangler dev --test-scheduled` und `curl 'localhost:8787/__scheduled?cron=*/5+*+*+*+*'`.
Die Testmail an `probe@` kommt lokal nicht an, die Statusseite zeigt den Empfang deshalb als eingeschränkt.

**Portal lokal:** `npm run build:portal`, dann

```sh
npx wrangler dev --port 8787 --local-upstream localhost:8787 --var CLOUD_URL:http://localhost:8787 --var CLOUD_DEV:1
```

und `http://localhost:8787` öffnen. `CLOUD_DEV` schreibt Mails des Portals (Bestätigungs- und Passwort-Links, Einladungen) ins Log statt sie zu mailen und
prüft die Origin nicht (`wrangler dev` schreibt den Kopf um). Nur lokal setzen! Zum Arbeiten an der Oberfläche
`npm --prefix portal run dev` (http://localhost:5174, leitet `/v1` an :8787 weiter). ELVIS dazu mit
`ELVIS_APP_RELAY_URL=http://localhost:8787 ELVIS_CLOUD_URL=http://localhost:8787` starten.

Den Link in Bestätigungsmails baut das Relay aus `RELAY_URL`, lokal also `--var RELAY_URL:http://localhost:8787`. In der App im Android-Emulator
die Relay-Adresse `http://10.0.2.2:8787` eintragen.

## Lizenz

MIT, siehe [LICENSE](LICENSE).

## Webhooks der Messenger

WhatsApp (Cloud API von Meta) und Threema (Gateway) liefern eingehende Nachrichten nur an eine öffentliche
HTTPS-Adresse. Der ELW hat keine, deshalb nimmt das Relay die Aufrufe an: Je ELW und Messenger gibt es eine Adresse
`/h/<id>` (128 Bit, zugleich der Zugang). Das Relay speichert den Aufruf **unverändert** samt Signatur-Header und
antwortet sofort. ELVIS holt die Aufrufe mit einem Cursor ab und prüft die Signatur selbst: bei Meta mit dem
App-Geheimnis, bei Threema mit dem MAC des API-Secrets. Das Relay kennt keine dieser Schlüssel. Threema-Nachrichten
bleiben Ende-zu-Ende-verschlüsselt, den privaten Schlüssel hat nur ELVIS.

Grenzen: höchstens 256 KB je Aufruf und 5000 nicht abgeholte Aufrufe je Webhook. Was nach 7 Tagen nicht abgeholt
ist, löscht das Relay. Meldet sich ein ELW neu an (neuer Zugang), bekommt er neue Adressen, die bei Meta bzw.
Threema neu eingetragen werden müssen.
