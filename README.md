# ELVIS Relay

Cloud-Relay für die App-Anbindung von [ELVIS](https://github.com/tel-diepholz/elvis). Über das Relay senden
Einsatzkräfte mit der App [ELVIS Ortung](https://github.com/tel-diepholz/elvis-app) ihre Position an den
Einsatzleitwagen (ELW). ELVIS holt die Positionen ausgehend ab, der ELW braucht also keine öffentliche Adresse.

```
App ──HTTPS──▶ Relay (Cloudflare Worker + D1) ◀──Abruf alle 15 s── ELVIS im ELW
```

Es läuft unter **`https://elvis-app.h2com.eu`**. Diese Adresse ist in ELVIS und in der App als Vorgabe eingebaut.

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
| `GET /datenschutz` | alle | Datenschutzhinweise der App (Play Store) |

Die Zugangsschlüssel werden als `Authorization: Bearer …` übergeben; das Relay speichert nur ihren SHA-256-Hash.
Das Protokoll ist in `src/protocol.ts` beschrieben. Gegenstück in ELVIS: `packages/shared/src/applink.ts`;
Änderungen an beiden Stellen gleich halten.

## Datenschutz

- Das Relay kennt nur zufällige IDs, keine Namen oder Telefonnummern.
- Positionen löscht es mit der Abholung durch den ELW, spätestens nach 24 Stunden (stündlicher Cron).
- App-IDs ohne Kontakt löscht es nach 90 Tagen, ELW-Zugänge nach einem Jahr.
- Der Text unter `/datenschutz` steht in `src/privacy.ts`. Vor der Veröffentlichung im Play Store dort den
  Betreiber ergänzen.

## Einrichten

Einmalig, mit einem Cloudflare-Konto, in dem die Zone `h2com.eu` liegt (Free-Tier genügt):

```sh
npm install
npx wrangler login
npx wrangler d1 create elvis-relay   # ausgegebene database_id in wrangler.toml eintragen und committen
npm run deploy                        # Schema anlegen und Worker veröffentlichen
```

Die eigene Domain ist in `wrangler.toml` unter `routes` eingetragen; DNS-Eintrag und Zertifikat legt Cloudflare
beim Deploy an.

### Automatisch veröffentlichen

Jeder Push auf `main` wird getestet und, sobald die Secrets hinterlegt sind, veröffentlicht. Dabei wendet der
Workflow auch neue Migrationen an.

| Secret | Inhalt |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API-Token mit den Rechten *Workers Scripts: Edit*, *D1: Edit*, *Workers Routes: Edit* (Zone `h2com.eu`) |
| `CLOUDFLARE_ACCOUNT_ID` | Konto-ID aus dem Cloudflare-Dashboard |

## Entwickeln

```sh
npm test                                              # Vitest, D1 im Speicher (better-sqlite3)
npx wrangler d1 migrations apply elvis-relay --local
npm run dev                                           # http://localhost:8787
```

Zum Ausprobieren ELVIS mit `ELVIS_APP_RELAY_URL=http://localhost:8787` starten. In der App im Android-Emulator
die Relay-Adresse `http://10.0.2.2:8787` eintragen.

## Lizenz

MIT, siehe [LICENSE](LICENSE).
