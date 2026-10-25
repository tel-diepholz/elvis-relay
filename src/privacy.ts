/** Datenschutzhinweise der App (Pflicht im Play Store für Standort im Hintergrund) – vor Veröffentlichung um den Betreiber ergänzen */
export const PRIVACY_HTML = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ELVIS-App – Datenschutz</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#222}h1{font-size:1.4rem}</style>
</head>
<body>
<h1>ELVIS-App – Datenschutzhinweise</h1>
<p>Die ELVIS-App übermittelt den Standort Ihres Geräts an den Einsatzleitwagen (ELW), mit dem Sie die App gekoppelt haben, damit die Einsatzleitung Ihre Einheit auf der Lagekarte sieht.</p>
<h2>Welche Daten?</h2>
<ul>
<li>Eine zufällige App-ID und ein Zugangsschlüssel – kein Name, keine Telefonnummer, kein Konto.</li>
<li>Während einer Kopplung: Standort (Koordinaten, Genauigkeit, Zeitpunkt) und Akkustand, alle 10 Minuten oder bei Bewegung über 10 Meter, auch wenn die App im Hintergrund läuft.</li>
</ul>
<h2>Wer erhält sie?</h2>
<p>Nur der gekoppelte ELW. Dieser Dienst leitet die Positionen weiter und löscht sie mit der Abholung, spätestens nach 24 Stunden. Im ELW werden sie mit dem Einsatz dokumentiert.</p>
<h2>Wie lange?</h2>
<p>Die Ortung endet, wenn Sie sie in der App stoppen, die Einsatzleitung entkoppelt oder der Einsatz endet. Nicht mehr genutzte App-IDs werden nach 90 Tagen gelöscht. „App zurücksetzen“ löscht die App-ID sofort.</p>
</body>
</html>
`;
