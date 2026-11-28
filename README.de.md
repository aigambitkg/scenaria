# Scenaria

**Quicksave für KI-Agenten – mit jedem LLM, in jedem Framework.** Scenaria hält jeden Entscheidungspunkt einer Agenten-Arbeit fest: die Frage, die Optionen, die Wahl, die Dateien und eine kurze Zusammenfassung der Fakten. Biegt ein Agent falsch ab, gehst du genau zu diesem Punkt zurück oder probierst die Option aus, die er nicht gewählt hat.

![Scenaria Szenario-Karte](docs/screenshot.png)

[English version](README.md) · [Ganzes Handbuch](docs/GUIDE.de.md) · [Änderungen](CHANGELOG.md)

> **Stand: öffentliche Vorschau (0.9.x).** Scenaria ist nutzbar und gut getestet (mehr als 580 automatische Tests, auf Linux, macOS und Windows), wurde aber noch nicht von einer externen Sicherheitsfirma geprüft. Lies [Bekannte Grenzen](docs/KNOWN-LIMITS.md) und [SECURITY.md](SECURITY.md), bevor du es mit vertraulichen Unternehmensdaten einsetzt.

## Was es kann

- **Zurück zu einer Entscheidung, nicht zu einer Uhrzeit.** Jeder Entscheidungspunkt enthält Frage, alle Optionen, die Wahl und den Grund. Zurückgehen stellt die Dateien wieder her *und* gibt dem Agenten eine kurze Zusammenfassung nur des Wegs dorthin. Ein Fehler wandert so nicht in den nächsten Versuch.
- **Nichts geht verloren.** Ungespeicherte Arbeit wird vor jedem Schritt zurück gesichert. Auch ein Schritt zurück lässt sich rückgängig machen.
- **Ein Baum für jedes Modell.** Claude, GPT, Gemini, Mistral, lokale Modelle über Ollama: Alle teilen einen Entscheidungsbaum und ein Protokoll, wer was getan hat.
- **Nur du kannst „geprüft“ sagen.** Das eigene „bestanden“ eines Agenten wird als Selbstauskunft gezeigt und zählt nie. Deine Freigaben und Urteile sind mit einem Schlüssel signiert, der außerhalb des Projekts liegt.
- **Ein Dashboard in einfachen Worten.** Drei Ansichten auf dieselben Daten: *Einfach* für den Alltag, *Prüfung* zum Kontrollieren, *Steuerung* für Einstellungen und Analyse. Deutsch und Englisch.
- **Nachweise für Audits.** Eine Prüfakte, geordnet nach den Annex-A-Kontrollen der ISO/IEC 42001, signiert und exportierbar. Die Zuordnung ist eigene Arbeit des Projekts und kein Zertifikat.
- **Lokal, ohne Telemetrie.** Alles liegt in `.scenaria/` in deinem Projekt. Nichts verlässt deinen Rechner, außer du startest einen Team-Server.

## Installieren

Scenaria braucht `git` (auf macOS: `xcode-select --install`).

```bash
# macOS / Linux: eine Datei, kein Node.js nötig
curl -fsSL https://raw.githubusercontent.com/aigambitkg/scenaria/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/aigambitkg/scenaria/main/install.ps1 | iex

# oder mit Node.js ab Version 20
npm install -g scenaria
```

Die Installationsskripte laden die Datei für dein System von der [Release-Seite](https://github.com/aigambitkg/scenaria/releases) und prüfen sie vor dem Installieren gegen die veröffentlichte `SHA256SUMS`. Selbst prüfen:

```bash
sha256sum -c SHA256SUMS --ignore-missing      # macOS: shasum -a 256 -c SHA256SUMS --ignore-missing
```

Aus dem Quellcode:

```bash
git clone https://github.com/aigambitkg/scenaria && cd scenaria
npm install && npm run build && npm link
```

## Benutzen

```bash
cd ~/Projekte/meine-app
scenaria start
```

`start` richtet das Projekt ein, verbindet die gefundenen Agenten (Claude Code, Cursor, VS Code/Copilot, Gemini CLI, Codex, Windsurf), macht einen ersten Schnappschuss, öffnet das Dashboard und speichert ab dann automatisch.

- Ohne Terminal? `scenaria launcher` legt ein Start-Symbol auf den Schreibtisch.
- Claude Desktop: `scenaria init --for claude-desktop`, danach die App neu starten.
- Jeder andere Agent oder Chat: im Dashboard auf **Agent-Prompt** klicken (oder `scenaria prompt`) und den Text einfügen.
- Agenten erreichen Scenaria über MCP, HTTP, die Kommandozeile oder Function Calling; alle nutzen dieselben Werkzeuge.

Alles Weitere – Fixpunkte, Prognosen, Prüfakte, Fortschritt, Kontextfenster, Team-Server, jeder Befehl – steht im [Handbuch](docs/GUIDE.de.md) (vollständige Referenz auf Englisch: [docs/GUIDE.md](docs/GUIDE.md)).

## Sicherheit in Kürze

- Das Dashboard antwortet nur auf deinem eigenen Rechner (`127.0.0.1`), außer du startest einen Team-Server mit Token.
- Agenten können Regeln, Fixpunkte und Urteile nur *vorschlagen*. Verbindlich macht sie nur du: im Freigabemodus des Dashboards (das Schloss 🔒) oder mit getippter Bestätigung am Terminal.
- Dein Signaturschlüssel liegt in `~/.config/scenaria`, nie im Projekt. API-Schlüssel werden nie gespeichert.
- Nichts aus dem Projektordner wird mit deinen Rechten ausgeführt: keine Git-Hooks, kein Befehl aus einer Projektdatei, außer du startest ihn selbst.
- **Lass Agenten in einer Sandbox laufen** (oder unter einem eigenen Konto), ohne Zugriff auf `~/.config/scenaria`. Scenaria macht Manipulation sichtbar, verhindert sie aber nicht: Ein Programm mit deinen vollen Benutzerrechten kann deinen Schlüssel lesen.

Sicherheitsproblem gefunden? Bitte vertraulich melden: [SECURITY.md](SECURITY.md).

## Grenzen

- Zurückgehen stellt **Dateien** wieder her. Gesendete E-Mails, Pushes, Deploys oder Datenbank-Schreibvorgänge lassen sich nicht zurücknehmen; sie werden markiert, und Scenaria warnt vorher.
- Aufgezeichnete Unterhaltungen und Schnappschüsse sind normale Dateien in `.scenaria/`. Nutze für Vertrauliches eine Festplattenverschlüsselung.
- Der Team-Server hat ein gemeinsames Token und keine Benutzerkonten; betreibe ihn hinter HTTPS.
- Ausführlich (englisch): [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md).

## Dokumentation

| | |
|---|---|
| [docs/GUIDE.de.md](docs/GUIDE.de.md) | Das Handbuch auf Deutsch |
| [docs/GUIDE.md](docs/GUIDE.md) | Die vollständige Referenz (englisch) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Wie es innen funktioniert |
| [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md) | Was es nicht kann oder nicht schützt |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Was fertig ist und was kommt |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) · [CONTRIBUTING.md](CONTRIBUTING.md) | Scenaria weiterentwickeln und mitmachen |

## Lizenz

MIT © Kevin Grundmann · [AI-Gambit](https://ai-gambit.com)
