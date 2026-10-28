# ELVIS Relay

Cloud-Relay für die App-Anbindung von [ELVIS](https://github.com/tel-diepholz/elvis). Über das Relay senden
Einsatzkräfte mit der App [ELVIS Ortung](https://github.com/tel-diepholz/elvis-app) ihre Position an den
Einsatzleitwagen (ELW). ELVIS holt die Positionen ausgehend ab, der ELW braucht also keine öffentliche Adresse.
Außerdem stellt es Online-Formulare für Personalbögen bereit, ein verschlüsseltes Postfach je ELW (E-Mail) und die
Daten der Statusseite.

```
App ──HTTPS──▶ Relay (Cloudflare Worker + D1) ◀──Abruf alle 15 s── ELVIS im ELW
```

Es läuft unter **`https://elvis-relay.hhansen06.workers.dev`**. Diese Adresse ist in ELVIS und in der App als Vorgabe eingebaut.

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

## Statusseite

Der Cron `*/5 * * * *` prüft Datenbank, R2 und den Mailweg Ende zu Ende: Er schickt eine Testmail an
`probe@einsatzleitwagen.app`, die beim nächsten Lauf angekommen sein muss. Fehler aus dem Betrieb (Annahme, Versand)
der letzten 15 Minuten zählen mit. `GET /v1/status` liefert Gesamtstatus, Komponenten, Tageswerte der letzten 90 Tage und
Störungsmeldungen. Die Homepage zeigt das unter `/status` und blendet bei Störungen einen Hinweis ein. Ändert sich der
Gesamtstatus, geht eine Mail an `STATUS_ALERT_EMAIL` (fällt der Versand selbst aus, kommt sie nicht an).

Meldungen pflegen:

```sh
curl -X POST https://elvis-relay.hhansen06.workers.dev/v1/status/incidents \
  -H "authorization: Bearer $STATUS_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Wartung Mail-Versand","body":"Heute 20–21 Uhr","severity":"degraded","components":["outbound"]}'
curl -X PATCH https://elvis-relay.hhansen06.workers.dev/v1/status/incidents/1 \
  -H "authorization: Bearer $STATUS_ADMIN_TOKEN" -d '{"resolved":true}'
```

## Datenschutz

- Personalbögen verschlüsselt der Browser mit dem öffentlichen Schlüssel des ELW (RSA-OAEP-256 + AES-256-GCM,
  Formular-ID als Zusatzdaten). Das Relay kann sie nicht lesen; es löscht sie mit der Abholung, spätestens nach
  7 Tagen. Formular-Links gelten höchstens 7 Tage, höchstens 200 Bögen je Link. Die Formularseite läuft mit strenger
  CSP, `no-referrer` und `noindex` (die Adresse ist der Zugang).

- Mails speichert das Relay nur für den ELW verschlüsselt und löscht sie mit der Abholung, spätestens nach 30 Tagen.
  Es kennt Adresse und Admin-Kontakt des Postfachs, nicht den privaten Schlüssel. Unverschlüsselt eingehende Mails
  sieht es kurz beim Empfang, unverschlüsselt gesendete beim Versand.
- Das Relay kennt nur zufällige IDs, keine Namen oder Telefonnummern.
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
npx wrangler secret put STATUS_ADMIN_TOKEN       # langer Zufallswert für Störungsmeldungen
```

- **Email Routing** für `einsatzleitwagen.app` aktivieren (setzt MX und SPF) und eine Catch-all-Regel „Send to a Worker“
  → `elvis-relay` anlegen.
- **Email Sending** für die Domain einrichten (DKIM-Einträge übernehmen), außerdem einen DMARC-Eintrag setzen, z. B.
  `_dmarc TXT "v=DMARC1; p=quarantine; rua=mailto:…"`.
- Die Custom Domain `openpgpkey.einsatzleitwagen.app` (WKD) legt `wrangler deploy` über `routes` selbst an.
- Optional in `wrangler.toml`: `MAIL_APPROVAL = "manual"`, `STATUS_ALERT_EMAIL`.

Der Worker läuft unter der `workers.dev`-Adresse des Kontos (`workers_dev = true` in `wrangler.toml`). Eine eigene
Domain per `routes` ginge nur, wenn ihre Zone im selben Cloudflare-Konto liegt. Eine Subdomain einer Zone, die
anderswo verwaltet wird (z. B. bei Hetzner), lässt sich im Free-Tarif nicht an Cloudflare delegieren. Bei einem
Wechsel der Adresse müssen ELVIS (`app.relayUrl`) und die App (Vorgabe in `app/build.gradle`) angepasst werden.

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

Den Link in Bestätigungsmails baut das Relay aus `RELAY_URL`, lokal also `--var RELAY_URL:http://localhost:8787`. In der App im Android-Emulator
die Relay-Adresse `http://10.0.2.2:8787` eintragen.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
