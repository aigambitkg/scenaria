# Scenaria

**Quicksave für KI-Agenten.** Scenaria hält jeden Entscheidungspunkt eines Agentenlaufs fest: Frage, Optionen, Wahl, Dateistand und eine kompakte Faktenkapsel. Halluziniert der Agent oder biegt falsch ab, springst du genau an diesen Punkt zurück – oder probierst die Option aus, die er nicht genommen hat.

Funktioniert mit jedem MCP-Client, erfasst in Claude Code automatisch über Hooks und zeigt den Lauf als Szenariobaum in einem lokalen Dashboard.

![Scenaria Szenario-Karte](docs/screenshot.png)

## Warum

Lange Agentenaufgaben scheitern mittendrin. Undo-Werkzeuge für Dateien gibt es schon (git, Editor-Checkpoints, `/rewind` in Claude Code) – sie sichern aber nach **Zeit**. Scenaria sichert nach **Entscheidung**:

- **Entscheidungspunkte als eigene Objekte:** Frage, alle erwogenen Optionen, Wahl, Begründung, Annahmen, Konfidenz. Nicht gewählte Optionen bleiben auf der Karte und lassen sich später erkunden.
- **Rücksprung = Dateien + Kontext:** Die Dateien werden wiederhergestellt, und der Agent erhält eine Kontext-Kapsel, die *nur* den Pfad bis zu diesem Punkt enthält. Inhalte verworfener Zweige bleiben draußen, höchstens eine einzeilige Lektion wird übernommen. So schleppt der Agent eine Halluzination nicht in den nächsten Versuch.
- **Nichts geht verloren:** Vor jedem Rücksprung wird Ungesichertes als Autosave abgelegt – auch ein Rücksprung lässt sich rückgängig machen.
- **Prüfung auf denselben Objekten:** Deterministische Checks (behauptete Dateien, die nicht existieren; undokumentierte Änderungen; niedrige Konfidenz; nicht umkehrbare Nebenwirkungen) plus ein Prüfagent, der sein Urteil je Knoten festhält. „Letzter geprüfter Stand“ ist eine Abfrage.
- **Weniger Token:** Weiterarbeiten aus einer Kapsel von wenigen hundert Token statt einen langen Verlauf neu zu lesen.

## Schnellstart

Voraussetzungen: Node.js ≥ 20 und git.

```bash
cd ~/Projekte/Scenaria
npm install
npm run build
npm link            # macht den Befehl `scenaria` überall verfügbar
```

Im Projekt, in dem dein Agent arbeitet:

```bash
cd ~/Projekte/meine-app
scenaria init --claude   # .scenaria/, MCP-Server, Hooks, Prüfagent, Regeln in CLAUDE.md
claude                   # Claude Code in diesem Ordner neu starten
scenaria ui              # Szenario-Karte öffnen (http://127.0.0.1:4477)
```

Erst mal nur anschauen: `npm run demo` legt ein Demo-Projekt mit halluziniertem Schritt, Rücksprung und erkundeter Alternative an – danach `scenaria ui --root scenaria-demo`.

## Was erfasst wird

| Quelle | Wird zu |
|---|---|
| Erster Prompt einer Session (Hook) | Mission mit Hauptziel und Auftrag |
| Antworten auf Rückfragen `AskUserQuestion` (Hook) | Entscheidungsknoten, Antwort = gewählte Option |
| Plan-Freigabe `ExitPlanMode` (Hook) | Entscheidungsknoten mit dem Plan |
| Riskante Bash-Befehle (`rm -rf`, `git reset --hard` …) (Hook) | Autosave unmittelbar davor |
| Externe Wirkungen (`git push`, Deploys, `curl -X POST` …) (Hook) | Am nächsten Knoten als *nicht umkehrbar* markiert |
| Ende jedes Turns mit Dateiänderungen (Hook) | Checkpoint, Output-Bullets aus der Schlussnachricht des Agenten |
| `scenaria_decide` / `scenaria_checkpoint` (MCP) | Entscheidungen und Checkpoints, die der Agent selbst meldet |

Hooks blockieren den Agenten nie; Fehler landen in `.scenaria/hook-errors.log`.

## Dashboard

- **Karte:** Zeit läuft von links nach rechts (*t*₁ … *t*ₙ), der aktive Pfad ist wie mit Textmarker nachgezogen, nicht gewählte Optionen sind gestrichelt.
- **Knotendetails:** Frage und Optionen, Begründung, Konfidenz, Fakten, Output, Lektionen, nicht umkehrbare Wirkungen, geänderte Dateien, Prüfergebnisse, Größe der Kontext-Kapsel.
- **Aktionen:** Hierhin zurückspringen, Option erkunden, mit vorherigem Stand vergleichen (Diff), Kontext kopieren, Prüfung starten, „Stimmt so“ / „Problem gefunden“, Jetzt sichern, Protokoll.
- Deutsch/Englisch umschaltbar, Hell (Rasterpapier) und Dunkel (Blaupause), live aktualisiert.

## Prüfagent

`init --claude` legt `.claude/agents/scenaria-verifier.md` an. In Claude Code: *„Nutze den scenaria-verifier, um diesen Lauf zu prüfen.“* Er geht den Pfad ab, vergleicht Behauptungen mit Diffs und Dateien, markiert jeden Knoten und nennt den letzten guten Stand als Rücksprungziel. Mit `verifyCommand` in `.scenaria/config.json` (z. B. `"npm test"`) läuft zusätzlich ein Test mit.

## Grenzen

- Ein Rücksprung stellt **Dateien** wieder her. Versendete Mails, Pushes, Deploys oder Datenbank-Schreibvorgänge kann er nicht zurücknehmen – sie werden als nicht umkehrbar markiert, und Scenaria warnt beim Zurückspringen.
- Der *Gesprächsverlauf* wird über die Kontext-Kapsel zurückgesetzt, nicht durch Bearbeiten des internen Transkripts von Claude Code.
- Sehr große Binärdateien lassen die Snapshots wachsen – per `config.json → exclude` ausschließen.
- Wenn du dieses Repo verschiebst, in deinen Projekten erneut `scenaria init --claude` ausführen (die Hooks verweisen auf den absoluten Pfad).

Mehr: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ROADMAP.md](docs/ROADMAP.md).

## Lizenz

MIT © Kevin Grundmann · [AI-Gambit](https://ai-gambit.com)
