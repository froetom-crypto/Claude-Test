# Pünktlich Köln

Handy-Web-App (PWA) für die **Verspätungsstatistik von KVB-Stadtbahn und Bussen** in Köln und für die Frage:
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
  3. Optional gibt es eine **Server-Statistik**: Der GitHub-Workflow `.github/workflows/collect-stats.yml` sammelt alle 15 Minuten die tatsächlichen Abfahrten an rund 20 zentralen Kölner Haltestellen (`collector/stops.json`). Er schreibt sie in `stats.json` auf den Branch `stats-data`. So entsteht eine Statistik rund um die Uhr, auch wenn die App zu ist.

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

## Dateien

* `index.html`, `styles.css`, `app.js`: die App
* `stats.js`: Statistik-Logik, die App und Sammler gemeinsam nutzen
* `sw.js`, `manifest.webmanifest`, `icon.svg`: installierbar und offline startbar
* `collector/`: der Sammler für die Server-Statistik (Node 20, ohne Abhängigkeiten)
* `.github/workflows/e2e-live.yml`: Test der App in einem echten Browser mit echten Live-Daten (von Hand startbar)

Inoffiziell, keine Gewähr. Fahrplan- und Echtzeitdaten: Transitous / DELFI.
