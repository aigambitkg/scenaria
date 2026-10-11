# Scenaria

**Quicksave für KI-Agenten – mit jedem LLM, in jedem Framework.** Scenaria hält jeden Entscheidungspunkt eines Agentenlaufs fest: Frage, Optionen, Wahl, Dateistand und eine kompakte Faktenkapsel. Halluziniert der Agent oder biegt falsch ab, springst du genau an diesen Punkt zurück – oder probierst die Option aus, die er nicht genommen hat.

Egal ob Claude, GPT, Gemini, Mistral, Llama über Ollama oder ein eigenes Modell: alle teilen sich denselben Entscheidungsbaum, dieselbe Prüfung und dasselbe Protokoll. Ein lokales Dashboard zeigt den Lauf als Szenariobaum.

![Scenaria Szenario-Karte](docs/screenshot.png)

## Warum

Lange Agentenaufgaben scheitern mittendrin. Undo-Werkzeuge gibt es schon – sie sichern aber nach **Zeit** und leben jeweils im Tool eines einzelnen Anbieters. Scenaria sichert nach **Entscheidung** und funktioniert anbieterübergreifend:

- **Entscheidungspunkte als eigene Objekte:** Frage, alle erwogenen Optionen, Wahl, Begründung, Annahmen, Konfidenz. Nicht gewählte Optionen bleiben auf der Karte und lassen sich später erkunden – auch mit einem anderen Modell.
- **Rücksprung = Dateien + Kontext:** Dateien werden wiederhergestellt, und der Agent erhält eine Kontext-Kapsel mit *nur* dem Pfad bis zu diesem Punkt. Verworfene Zweige bleiben draußen, höchstens eine einzeilige Lektion wird übernommen.
- **Nichts geht verloren:** Vor jedem Rücksprung wird Ungesichertes als Autosave abgelegt – auch ignorierte Dateien, die überschrieben würden.
- **Prüfung auf denselben Objekten:** Deterministische Checks plus ein Prüfagent, der je Knoten ein Urteil festhält – gern ein anderes Modell eines anderen Anbieters.
- **Weniger Token:** Weiterarbeiten aus einer Kapsel von wenigen hundert Token statt einen langen Verlauf neu zu lesen.

## Funktioniert mit jedem LLM und Agenten-Stack

| Du nutzt … | Anbindung | Einrichtung |
|---|---|---|
| **Claude Code** | MCP + Hooks (automatische Erfassung von Prompts, Rückfragen, Plan-Freigaben, riskanten Befehlen) | `scenaria init --for claude` |
| **Cursor · VS Code/Copilot · Gemini CLI · Codex** | MCP + Regeln in `AGENTS.md` / `GEMINI.md` | `scenaria init --for cursor,vscode,gemini,codex` |
| **Windsurf · Cline · Zed · jeder MCP-Client** | MCP | `scenaria init --for windsurf` / `--for generic` zeigt die Konfiguration |
| **OpenAI · Azure OpenAI · Mistral · Groq · OpenRouter · Ollama · vLLM · LM Studio** | Function Calling + HTTP | `scenaria tools --format openai`, [Beispiel](examples/openai_compatible_agent.py) |
| **Anthropic-API · Gemini-API** | Function Calling + HTTP | `scenaria tools --format anthropic` / `gemini` |
| **LangChain · LlamaIndex · CrewAI · AutoGen · eigenes Python** | [Python-Client](clients/python/scenaria_client.py) (nur Standardbibliothek) | `scenaria serve` |
| **n8n · Make · Zapier · Power Automate** | HTTP-API | `scenaria serve`, [Beispiele](examples/README.md) |
| **Aider · Open Interpreter · Shell-Agenten** | CLI | `scenaria call scenaria_checkpoint '{"title":"…"}'` |
| **Agenten ganz ohne Tool-Unterstützung** | Dateiwächter | `scenaria watch` |

Alle Wege nutzen **ein einziges Tool-Register** – dieselben 13 Werkzeuge mit derselben Validierung, egal ob über MCP, HTTP, CLI oder Function Calling.

## Für Organisationen

- **Lokal, ohne Telemetrie:** Alles liegt in `.scenaria/` im Projekt. Nichts verlässt den Rechner, solange du keinen Team-Server startest – DSGVO-freundlich und sicher für Kundencode.
- **Gemischte Modelle, ein Protokoll:** Jeder Knoten speichert `agent`, `model` und `user`. Anbieter an derselben Aufgabe vergleichen oder ein Modell bauen und ein anderes prüfen lassen.
- **Team-Server:** `scenaria serve --host 0.0.0.0 --token <geheim>` stellt Dashboard und API fürs Team bereit (Bearer-Token oder Browser-Cookie). Lokal antwortet Scenaria nur auf 127.0.0.1, geschützt gegen DNS-Rebinding und Cross-Site-Anfragen.
- **Audit & Governance:** `scenaria export` liefert maschinenlesbares JSON (Knoten + Ereignisse) für BI- oder Governance-Tools; `scenaria protocol` ein lesbares Protokoll – Entscheidungen, Prüfurteile, nicht umkehrbare Aktionen, wer und wann. Hilfreich für ISO/IEC 42001 und die Dokumentation nach AI Act.
- **Regeln für jeden Agenten:** Blöcke in `AGENTS.md`, `CLAUDE.md` und `GEMINI.md` sagen den Agenten, wann sie Entscheidungen festhalten; ein fertiger [Prüf-Prompt](templates/rules/verifier-prompt.md) funktioniert mit jedem LLM.
- **Open Source (MIT):** selbst betreiben, prüfen, erweitern.

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
scenaria init --for claude,cursor     # oder: vscode, gemini, codex, windsurf, generic, all
scenaria ui                           # Szenario-Karte unter http://127.0.0.1:4477
```

Erst mal nur anschauen: `npm run demo` legt ein Demo-Projekt an – mit halluziniertem Schritt, Rücksprung und einer Alternative, die ein zweiter Agent mit einem anderen Modell erkundet. Danach `scenaria ui --root scenaria-demo`.

## Dashboard

- **Karte:** Zeit läuft von links nach rechts (*t*₁ … *t*ₙ), der aktive Pfad ist wie mit Textmarker nachgezogen, nicht gewählte Optionen sind gestrichelt.
- **Knotendetails:** Frage und Optionen, Begründung, Konfidenz, Fakten, Output, Lektionen, nicht umkehrbare Wirkungen, geänderte Dateien, Prüfergebnisse, Agent / Modell / verantwortliche Person, Größe der Kontext-Kapsel.
- **Aktionen:** Hierhin zurückspringen, Option erkunden, mit vorherigem Stand vergleichen, Kontext kopieren, Prüfung starten, „Stimmt so“ / „Problem gefunden“, Jetzt sichern, Protokoll.
- Deutsch/Englisch, Hell (Rasterpapier) und Dunkel (Blaupause), live aktualisiert.

## Grenzen

- Ein Rücksprung stellt **Dateien** wieder her. Versendete Mails, Pushes, Deploys oder Datenbank-Schreibvorgänge kann er nicht zurücknehmen – sie werden als nicht umkehrbar markiert, und Scenaria warnt.
- Der *Gesprächsverlauf* wird über die Kontext-Kapsel zurückgesetzt, nicht durch Bearbeiten von Agenten-Transkripten.
- Im Team-Server-Modus sichern Snapshots den Projektordner auf dem Rechner, auf dem `scenaria serve` läuft.
- Wenn du dieses Repo verschiebst, in deinen Projekten erneut `scenaria init --for …` ausführen (Konfigurationen verweisen auf den absoluten Pfad).

Mehr: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ROADMAP.md](docs/ROADMAP.md), [examples/](examples/README.md).

## Lizenz

MIT © Kevin Grundmann · [AI-Gambit](https://ai-gambit.com)
