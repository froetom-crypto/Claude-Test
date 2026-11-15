# Pünktlich (Deutschland)

**App öffnen:** https://froetom-crypto.github.io/Claude-Test/

Handy-Web-App (PWA) für die **Verspätungsstatistik von Bus, Straßenbahn, U-Bahn, S-Bahn, Regional- und Fernverkehr in ganz Deutschland** und für die Frage:
**Wann muss ich losgehen, damit ich pünktlich bin – und wie wahrscheinlich komme ich zu spät?**

## Funktionen

| Reiter | Was er kann |
|---|---|
| **Route** | Start und Ziel (Haltestelle, Adresse oder „Mein Standort“) eingeben, dazu „ankommen bis“ und die gewünschte Sicherheit (80–98 %). Die App sucht live die Verbindungen und berechnet für jede die **Chance, pünktlich anzukommen**. Das Risiko wird aufgeteilt in **Ausfall**, **verpassten Umstieg** und **Verspätung**. Ganz oben steht die **späteste Zeit zum Losgehen**, die deine Sicherheit noch erreicht. |
| **Haltestelle** | Live-Abfahrten mit Verspätung und Ausfällen, dazu die Pünktlichkeit je Linie in den letzten 90 Minuten und langfristig. Haltestellen lassen sich als Favorit merken. |
| **Linien** | **Zuverlässigkeitsprofil** je Linie: Pünktlichkeitsquote, Ausfallquote, Ø-Verspätung, „9 von 10 Fahrten besser als …“, Verteilung der Verspätung, Pünktlichkeit nach Uhrzeit, Wochentag und im Verlauf der Tage. |
| **Mehr** | Was als pünktlich gilt (Standard: unter 3 Min.), API-Adresse, Server-Statistik, Daten exportieren oder löschen. |

## Datenquellen

* **Live:** [Transitous](https://transitous.org), eine freie Fahrplanauskunft (MOTIS) auf Basis der deutschlandweiten DELFI-Fahrplan- und Echtzeitdaten. Sie enthält KVB-Stadtbahnen und -Busse mit Echtzeit-Verspätungen und Ausfällen. Die Abfrage läuft direkt vom Handy aus, ohne eigenen Server und ohne API-Schlüssel. (Die früher genutzte Schnittstelle `v6.db.transport.rest` ist abgeschaltet.)
* **Statistik:** Eine öffentliche Schnittstelle mit historischen KVB-Verspätungen gibt es nicht. Die Statistik wird deshalb aus echten Beobachtungen aufgebaut:
  1. Jede Abfrage wertet auch die **Abfahrten der letzten 90 Minuten** an der Haltestelle aus. Deren Verspätungen stehen dann schon fest. So gibt es sofort eine Statistik.
  2. Alles, was das Handy einmal beobachtet hat, wird **lokal gespeichert**. Favoriten werden alle 3 Minuten mitprotokolliert, solange die App offen ist.
  3. Optional gibt es eine **Server-Statistik**: Der GitHub-Workflow `.github/workflows/collect-stats.yml` sammelt alle 15 Minuten die tatsächlichen Abfahrten an rund 50 großen Knoten in ganz Deutschland (`collector/stops.json`); Linien werden je Verkehrsbetrieb getrennt gezählt. Er schreibt sie in `stats.json` auf den Branch `stats-data`. So entsteht eine Statistik rund um die Uhr, auch wenn die App zu ist.

## Wie die Wahrscheinlichkeit berechnet wird

Für jede Verbindung werden 3000 Fahrten simuliert. Je Teilstrecke wird eine Verspätung aus der **echten Verspätungsverteilung dieser Linie** gezogen. Mit der gemessenen **Ausfallquote** fällt die Fahrt aus. Fällt eine Fahrt aus oder wird ein Umstieg verpasst, wartet man auf die nächste Fahrt. Den Takt liest die App aus dem Abfahrtsplan. Liegt für eine Fahrt in den nächsten 45 Minuten schon eine **Live-Verspätung** vor, wird sie eingerechnet. Ist die Fahrt live als ausgefallen gemeldet, wird das direkt berücksichtigt. Hat eine Linie weniger als 15 beobachtete Fahrten, nimmt die App alle Linien desselben Typs dazu, zum Beispiel alle Stadtbahnen. Das wird in den Details angezeigt.

Vereinfachungen: Die Verspätung bei der Ankunft wird gleich der Verspätung bei der Abfahrt angenommen. Fußwege rechnet die App mit der Dauer, die die Auskunft angibt.

## Aufs Handy bringen

> **Wichtig:** Das Repository ist privat. GitHub Pages und der Abruf der Server-Statistik funktionieren mit einem kostenlosen GitHub-Konto nur bei **öffentlichen** Repositories (Settings → General → Danger Zone → Change visibility → Public). Im Repository liegen keine Passwörter oder Schlüssel.

1. Im Repository unter **Settings → Pages** als Quelle „Deploy from a branch“, `main`, Ordner `/ (root)` wählen. Dafür muss dieser Stand auf `main` liegen.
2. Die Seite `https://<benutzer>.github.io/<repo>/` auf dem Handy öffnen.
   * iPhone: Teilen → „Zum Home-Bildschirm“.
   * Android: Menü → „App installieren“.

## Server-Statistik einschalten (optional)

1. Der Workflow muss auf dem Standard-Branch (`main`) liegen. GitHub führt zeitgesteuerte Workflows nur von dort aus.
2. Unter **Actions** den Workflow „Verspätungsstatistik sammeln“ einmal von Hand starten.
3. Die App lädt die Statistik automatisch von
   `https://raw.githubusercontent.com/froetom-crypto/Claude-Test/stats-data/stats.json` (nur bei öffentlichem Repository erreichbar).

Der Branch `stats-data` enthält immer nur einen einzigen Commit. Er wird bei jedem Lauf ersetzt, damit das Repository nicht wächst.

## Bildsuche

**Öffnen:** https://froetom-crypto.github.io/Claude-Test/bildsuche/

Eigene Seite im Ordner `bildsuche/`: Du gibst eine Bildbeschreibung ein (gern auf Deutsch), und die Seite sucht die **5 Bilder, die am genauesten passen**, ohne API-Schlüssel und ohne Konto.

1. Eine deutsche Beschreibung wird im Browser ins Englische übersetzt (`Xenova/opus-mt-de-en`), daraus entstehen Stichwörter.
2. Drei freie Bildquellen werden parallel durchsucht (alle erlauben Abfragen aus dem Browser):
   * **Reddit**: Reddit sperrt direkte Abfragen von fremden Webseiten. Dann kommen die Beiträge aus [Arctic Shift](https://arctic-shift.photon-reddit.com), einem freien Reddit-Archiv. Es verlangt immer ein Subreddit, deshalb sucht die Seite passende Subreddits (z. B. „cat“ → r/cat, r/cats) und schaut zusätzlich in r/pics und r/itookapicture. Höchstens 2 Anfragen gleichzeitig, bei Überlastung mit Wiederholung.
   * **Wikimedia Commons**: über 100 Mio. freie Fotos.
   * **Openverse**: Suchmaschine für frei lizenzierte Bilder (Flickr, Museen, Wikimedia u. v. m.). Ohne Konto höchstens 20 Ergebnisse pro Abfrage.
3. Aus jeder Quelle kommen die besten Kandidaten nach Titel (zusammen bis zu 48, doppelte entfernt). Die Bild-KI **SigLIP** (`Xenova/siglip-base-patch16-224`, Nachfolger von CLIP) schaut sich jedes Bild an und bewertet, wie gut es zur Beschreibung passt. Die 5 besten werden mit Quelle, Urheber und Lizenz angezeigt.

Die KI läuft per [Transformers.js](https://huggingface.co/docs/transformers.js) direkt im Browser. Beim ersten Mal lädt sie ca. 300 MB Modelldaten von Hugging Face, danach kommen sie aus dem Cache. Bilder ohne CORS-Freigabe werden über den freien Bild-Proxy wsrv.nl geladen.

**Optional mit Anthropic-API-Schlüssel** (unter „Einstellungen“): Claude plant Suchbegriffe und Subreddits, schaut sich jedes Bild an und vergibt 0–100 Punkte mit Begründung. Der Schlüssel bleibt nur im Browser. Kosten grob 0,05–0,15 € pro Suche.

**Test:** `.github/workflows/bildsuche-test.yml` startet bei jeder Änderung einen echten Browser: einmal mit echten Fotos (Hund muss vor Katzen landen) und zweimal mit echten Daten aus allen Quellen.

Dateien: `bildsuche/index.html`, `app.js` (Ablauf, Quellen zusammenführen, Claude), `sources.js` (Wikimedia, Openverse), `reddit.js` (Reddit-Daten auswerten), `local-ai.js` (Übersetzer und SigLIP im Browser), `vendor/anthropic-sdk.js` (Anthropic-SDK 1.3.0, für den Browser gebündelt). Transformers.js 4.3.1 wird bei Bedarf von cdn.jsdelivr.net geladen.

## Dateien

* `index.html`, `styles.css`, `app.js`: die App
* `stats.js`: Statistik-Logik, die App und Sammler gemeinsam nutzen
* `sw.js`, `manifest.webmanifest`, `icon.svg`: installierbar und offline startbar
* `collector/`: der Sammler für die Server-Statistik (Node 20, ohne Abhängigkeiten)
* `.github/workflows/e2e-live.yml`: Test der App in einem echten Browser mit echten Live-Daten (von Hand startbar)

Inoffiziell, keine Gewähr. Fahrplan- und Echtzeitdaten: Transitous / DELFI.
