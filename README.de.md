# Scenaria

**Quicksave für KI-Agenten – mit jedem LLM, in jedem Framework, eine Zeitleiste für Unterhaltungen, Entscheidungen und Dateien.** Scenaria hält jeden Entscheidungspunkt fest: Frage, Optionen, Wahl, Dateistand, die Unterhaltung dazu und eine kompakte Faktenkapsel. Halluziniert der Agent oder biegt falsch ab, springst du genau an diesen Punkt zurück – oder probierst die Option aus, die er nicht genommen hat.

![Scenaria Szenario-Karte](docs/screenshot.png)

## Installieren – eine Zeile

```bash
# macOS / Linux: eine Datei, kein Node.js nötig
curl -fsSL https://raw.githubusercontent.com/aigambitkg/scenaria/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/aigambitkg/scenaria/main/install.ps1 | iex

# oder mit Node.js ≥ 20
npm install -g scenaria
```

Für Datei-Snapshots braucht Scenaria `git` (auf den meisten Entwicklerrechnern vorhanden; macOS: `xcode-select --install`).

## Benutzen – ein Befehl

```bash
cd ~/Projekte/meine-app
scenaria start
```

`start` richtet das Projekt ein, erkennt deine installierten Agenten (Claude Code, Cursor, VS Code/Copilot, Gemini CLI, Codex, Windsurf) und bindet sie an, legt eine Ausgangsversion an, öffnet das Dashboard, aktiviert Auto-Save (jede Dateiänderung wird eine Version) und startet den **Gesprächs-Proxy** für jeden LLM-Anbieter.

Einmalig für **alle** Projekte:

```bash
scenaria setup --global     # Agenten-Konfiguration auf Nutzerebene; Projekte richten sich beim ersten Einsatz selbst ein
```

Scenaria richtet sich nie im Home-Ordner oder in Ordnern ein, die nicht nach Projekt aussehen.

**Ohne Terminal:** Einmal `scenaria launcher` (oder Einstellungen → *Start-Symbol anlegen*) legt ein Scenaria-Symbol auf deinen Schreibtisch. Ein Doppelklick startet Scenaria für dieses Projekt; ein zweiter Doppelklick öffnet nur das Dashboard wieder.

**Claude Desktop:** Einstellungen → *Deine KI verbinden* → Claude Desktop (oder `scenaria init --for claude-desktop`) trägt dieses Projekt in die Claude-App ein. Die App ganz beenden und neu öffnen; danach kann Claude Schritte festhalten und zurückspringen.

**Muss ich dem Agenten sagen, dass er Scenaria nutzen soll?** Bei Claude Code nicht: Die Hooks erfassen Prompts, Rückfragen, Pläne und Dateiänderungen, und jeder Prompt bekommt automatisch eine einzeilige Scenaria-Erinnerung. Für alle anderen Agenten und Chats gibt es im Dashboard den Knopf **Agent-Prompt** (oder `scenaria prompt`) mit einem fertigen Text zum Kopieren, in drei Varianten: MCP-Agenten, Shell-Agenten und normale Chats ohne Tools.

## Ein Projektbaum, ein Hauptziel

Jedes Projekt hat genau **einen** Entscheidungsbaum. Die Wurzel `n0` steht für das Projekt und sein **Hauptziel**. Jede Arbeit wird ein **Teilziel** auf dieser Linie, ob Agent-Sitzung, Unterhaltung über den Proxy oder `scenaria task`. Erledigte Teilziele klappen auf der Karte zu einem Knoten zusammen; so bleibt auch ein monatelanges Projekt übersichtlich. Ein neues Szenario (`s2`, `s3`, …) entsteht nur, wenn die Linie wirklich abzweigt: bei einem Fork oder bei neuer Arbeit nach einem Rücksprung. So siehst du, wann das Projekt wo abgebogen ist, wer entschieden hat und warum.

Ein Teilziel entsteht erst, wenn eine Sitzung wirklich etwas erzeugt. Eine kurze Frage ohne Änderung lässt die Karte unberührt. Projekte aus älteren Versionen (ein Baum pro Mission) werden beim ersten Öffnen automatisch zu einem Projektbaum zusammengeführt; eine Sicherung liegt in `.scenaria/backups/`.

## Jede Entscheidung mit Kontext – analysierbar mit jedem LLM

Eine Entscheidung enthält mehr als Frage, Optionen und Wahl:
- `rationale`: warum diese Option. Pflicht, sobald eine Option gewählt wird; abschaltbar mit `requireRationale: false`.
- `context`: die Ausgangslage.
- `servesGoal`: wie die Wahl dem Hauptziel dient.
- `expectedOutcome`: woran man erkennt, ob sie richtig war.
- `trigger`: die Nutzeranfrage, die zur Entscheidung führte. Scenaria erfasst sie automatisch.

Fehlende Angaben werden auf der Karte und im Tool-Ergebnis markiert.

- **Projekt-Check ohne LLM, ohne Token:** `scenaria analyze` bzw. Dashboard → *Analyse*. Er prüft:
  - ob das Hauptziel gesetzt ist;
  - ob Entscheidungen Kontext, Begründung und Zielbezug haben;
  - ob Arbeit auf fehlgeschlagenen Prüfungen aufbaut;
  - offene Entscheidungen und solche mit niedriger Konfidenz;
  - Teilziele mit vielen Neustarts;
  - die Qualität je Agent und Modell.
- **Mustererkennung mit beliebigem Modell:** `scenaria analyze --llm ollama --model llama3.3` (oder `openai`, `anthropic`, `gemini`, `mistral`, `openrouter`, `groq`, jede OpenAI-kompatible URL; lokal oder per API).
  - Gesendet wird nur ein kompaktes Dossier mit Token-Budget.
  - API-Schlüssel kommen aus Umgebungsvariablen oder werden im Dashboard nur für einen Lauf eingegeben, nie gespeichert.
  - Ganz ohne API: `scenaria analyze --dossier` kopiert das Dossier für jeden Chat, das Ergebnis fügst du wieder ein.
- **Der Kreis schließt sich:** Übernommene Empfehlungen werden **Projektregeln**, die ab dann jede Kontext-Kapsel und jeder Agent-Prompt enthält. Projektregeln legst nur du fest; Agenten können sie nur vorschlagen.

## Kanon-Events: die Fixpunkte des Projekts

Manches muss gelten, egal welcher Agent als Nächstes arbeitet. Scenaria nennt diese Fixpunkte **Kanon-Events**:
- **Vergangenheit:** feste Vorgaben, z. B. „Läuft nur in AWS eu-central-1“, „nur TypeScript“, „keine Cookies ohne Einwilligung“.
- **Zukunft:** Meilensteine, die die Arbeit bestehen muss, z. B. „10.000 Anfragen/s bis 1.1.2027“, optional mit einem Prüfbefehl als Beweis.

So wird über Fixpunkte entschieden:
- **Du gibst frei, Agenten schlagen vor.** Agenten (`scenaria_canon {action: "propose"}`), Chat-Blöcke und der **Archivar** erzeugen nur Vorschläge. Verbindlich wird ein Fixpunkt erst mit deiner Freigabe: im Dashboard unter *Kanon* oder per `scenaria canon approve` in einem interaktiven Terminal. Die Freigabe wird protokolliert (wer, über welchen Weg).
- **Der Archivar** schlägt Kandidaten aus der Historie vor: geprüfte oder sichere Entscheidungen sowie Pflichten in Fakten und Regeln. Mit `scenaria canon suggest --llm …` oder *Archivar fragen* extrahiert ein beliebiges LLM Vorschläge samt Belegen.
- **Prüfungen startest nur du.** Geprüft werden ausschließlich freigegebene Fixpunkte: `scenaria canon check` oder *Prüfungen ausführen*; Agenten lösen sie nie aus. Ein vorgeschlagener Befehl wird nur dann zur Prüfung, wenn du genau diesen Befehl mit *übernehmen* bestätigst.
- **Freigaben sind signiert.** Jede verbindliche Entscheidung trägt eine Ed25519-Signatur deines Freigabe-Schlüssels (`~/.config/scenaria/approver-key.pem`, nie im Projekt). Signaturen sind an das Projekt und an eine Revision gebunden, und dein Rechner merkt sich (außerhalb des Projekts) die neueste gesehene Revision – eine ältere signierte `canon.json` zurückzuspielen oder eine aus einem anderen Projekt zu kopieren, funktioniert also auch nicht. Ein Eintrag mit fehlender, falscher, veralteter oder fremder (nicht vertrauter) Signatur ist **nicht verbindlich** und erscheint als *Nicht verbindlich – bitte prüfen* (z. B. wenn `canon.json` von Hand, von einem Agenten oder durch einen Merge geändert wurde). Im Team: `scenaria canon key` zeigt deinen öffentlichen Schlüssel, `scenaria canon trust <Schlüssel> --name ..` vertraut dem eines anderen.
- **Der Freigabe-Link** (`scenaria start`/`ui` oder das Schloss 🔒 im Dashboard) öffnet das Dashboard mit Freigaberecht in deinem Browser. Er funktioniert genau einmal und wird nie im Terminal angezeigt (`--print-approval-link` nur für einen Rechner ohne Browser).
- **Agenten gehören in eine Sandbox.** Scenaria hält Agenten von deinen Freigaben fern; ein Programm mit Shell unter deinem eigenen Benutzerkonto könnte aber deinen Freigabe-Schlüssel lesen oder Scenaria selbst starten und damit signieren. Lass Agenten in einer Sandbox (oder unter eigenem Konto) laufen, ohne Zugriff auf Scenarias Konfigurationsordner (`~/.config/scenaria`).

Was das ehrlich schützt: Agenten, Chat-Blöcke, API-Tokens und Änderungen an Dateien im Repository können nichts verbindlich machen. Es ist manipulations-*erkennend*, nicht manipulations-*sicher*: Ein bösartiges Programm mit deinen vollen Benutzerrechten kann deinen Schlüssel lesen.

So werden Fixpunkte durchgesetzt:
- Jede Kapsel und jeder Prompt enthält die aktiven Fixpunkte; harte fallen nie dem Token-Budget zum Opfer.
- Entscheidungen geben an, welche sie respektieren (`respectsCanon`).
- Einen zu brechen erfordert `breaksCanon` plus Begründung. Das erscheint im Projekt-Check, im Treue-Diagramm (⚑) und auf der Tafel.

**Der String:** `scenaria string` (bzw. `scenaria_context {mode: "string"}`) macht aus einer Arbeitslinie ein Paket:
- Vorgaben aus der Vergangenheit;
- getroffene Entscheidungen;
- Zukunftsprüfungen mit ihrem Status;
- ein Urteil: *gültig*, *noch nicht bewiesen* oder *ungültig*.

**Das Gate – überlebende Strings:** `scenaria canon gate` (oder *Kanon → Arbeitslinien*) führt die übernommenen Prüfbefehle auf dem Snapshot **jeder** Arbeitslinie aus, jeweils in einer temporären Kopie (dein Arbeitsordner bleibt unberührt; `node_modules` & Co. werden verlinkt). Die Tabelle zeigt, welche Linien jeden harten Fixpunkt überstehen. Ergebnisse sind signiert wie Freigaben; geänderte oder zurückgespielte Ergebnisse werden ignoriert und gemeldet.

**Das Relay – Archivar → Handwerker → Orakel:** Für eine Entscheidung mit großer Tragweite macht `scenaria relay "<Frage>" --decide` (oder *Chat → Orakel befragen*) drei getrennte Modell-Aufrufe, jeder nur mit seinem Ausschnitt des Kontexts: Der Archivar liest die Vergangenheit (Dossier, Regeln, vergangene Fixpunkte), der Handwerker schlägt 2–4 Optionen für die Gegenwart vor, das Orakel prüft sie gegen die zukünftigen Fixpunkte. Der Orchestrator – normaler Code, kein Modell – schneidet Optionen ab, die harten Kanon brechen, und legt eine **offene Entscheidung** an; du wählst. Jede Rolle kann ihr eigenes Modell nutzen.

## Scenaria von einer Stelle aus steuern: Einstellungen, Chat, eigener Agent

- **Einstellungen (⚙):** ein Modell für Chat, Analyse, Archivar und Relay – lokal (Ollama, LM Studio) oder über jede API – plus optional ein eigenes Modell pro Funktion, Modellliste und Verbindungstest. API-Schlüssel werden **nie gespeichert**: Scenaria nutzt den Schlüssel aus einer Umgebungsvariable oder einen, den du nur für diese Browser-Sitzung eingibst. Ein Umgebungs-Schlüssel geht nur an den offiziellen Endpunkt des Anbieters oder an Endpunkte, denen du dort vertraust (ein Agent oder eine Projektdatei kann ihn nicht umleiten). Auf derselben Seite verbindest du deine Agenten per MCP mit einem Klick und findest Snippets für jeden anderen Agenten (MCP-JSON, HTTP-Tools, Proxy-URLs).
- **Chat (rechtes Panel):** Sprich mit deinem Modell – es bedient Scenaria mit denselben Werkzeugen wie deine Agenten: Status, Kontext, Entscheidungen, Checkpoints, Aufgaben, Kanon-Vorschläge, Relay. Auch deine eigenen Aktionen gehen per Chat – Kanon freigeben/ablehnen/ausmustern, Prüfungen, Gate, Modell-Analyse, Modell wechseln, Agenten verbinden: Das Modell *fragt* nur, Scenaria zeigt eine Karte mit genau dem, was passiert, und es läuft nach deinem Klick. Zurückspulen und Verzweigen warten ebenfalls auf dein OK (einstellbar). Jeder Chat wird als Unterhaltung aufgezeichnet. Ollama wird über seine eigene Schnittstelle mit 16k Kontextfenster angesprochen (`SCENARIA_OLLAMA_CTX`), damit Werkzeuge und Projektstand nie abgeschnitten werden; Tool-Aufrufe, die kleine Modelle als Text schreiben, werden erkannt.
- **Dein eigener Agent:** in den Einstellungen verbinden (MCP) oder die HTTP-Tools aufrufen – er bekommt genau dieselben Möglichkeiten und Grenzen wie der eingebaute Chat.

Einstellungen, Chat und Relay handeln für dich und nutzen deine Schlüssel – sie brauchen deshalb wie Kanon-Freigaben den **Freigabe-Modus**. `scenaria start` öffnet ihn in deinem Browser; fehlt er in einem Fenster, klick oben auf das Schloss 🔒, und Scenaria öffnet ein neues Fenster im Freigabe-Modus (der Link läuft nie über etwas, das ein Agent lesen könnte).

## Prognosen, Orakel und Prüf-Experte: sehen, bevor man wählt (v0.9)

Jede offene Entscheidung bekommt eine **Prognose, bevor jemand wählt**: Wie treu bleibt die Linie nach jeder Option bei Kontext und Hauptziel? Es ist dieselbe Größe, die Scenaria danach misst – jede Prognose lässt sich also an der Wirklichkeit prüfen.

- **Kern** (sofort, ohne Modell): eine kleine Formel, die man von Hand nachrechnen kann. „Warum diese Zahl?“ zeigt jeden Teil, die aus deinen eigenen Entscheidungen gelernten Gewichte und ein ehrliches Unsicherheitsband.
- **Orakel** (Multiversum, dein Modell): Archivar (Vergangenheit), Handwerker (Gegenwart) und Orakel (Zukunft) dürfen den Kern nur **korrigieren** – höchstens ±20 Punkte je Teil, jede Korrektur mit Grund und existierendem Beleg. Korrekturen ohne Beleg zählen 0; wie sehr dem Orakel vertraut wird (γ), lernt Scenaria daraus, wie seine Korrekturen wirklich ausgingen.
- **Prüf-Experte**: eine Checkliste für jede Prognose (faire Reihenfolge, Signatur, Datenbasis, Unterscheidbarkeit, Bilanz, Belege) → belastbar / mit Vorsicht / nicht belastbar. Auf Wunsch prüft ein skeptisches Modell jede Aussage des Orakels gegen die Belege, so wie sie zitiert wurden, und streicht nicht belegte Korrekturen.
- **Einfach zu bedienen**: Der Prognosen-Dialog beginnt mit einem Bereit-Check (Modell, Freigabe, Hauptziel) und drei Wegen: Entscheidung vorhersagen (oder direkt aufschreiben), Prompt prüfen oder eine vergangene Entscheidung an der Wirklichkeit nachprüfen. Du siehst, welche Rolle gerade arbeitet, und bekommst das Ergebnis in Klartext.
- **Prognose-Prüfung** (Steuerung → Erweiterungen → **Prognose-Prüfung**): jede Prognose mit Ampel, Kennzahlen und Prüfbericht zum Herunterladen (Markdown/JSON) – nur lesend.
- **Güte**: Rückblick über jede vergangene Entscheidung aus ihrer eigenen Zeit heraus, Orakel vs. Kern und ein Prüfstand. Ehrlich: aussagekräftig ab 10 Entscheidungen, davor als Tendenz.

Prompts und Pläne lassen sich genauso prüfen, Varianten im direkten Vergleich. Automatische Prognosen sind optional, nutzen nur dein Modell und haben ein Tageslimit über alle Projekte. Im Dashboard unter **Prognosen**, per CLI mit `scenaria forecast n12` / `--quality` / `--audit f3 [--deep]`, im Chat oder für Agenten mit dem Tool `scenaria_forecast`.

## Der Experten-Analyst: ein Bericht zum Optimieren (v0.8)

Unter Analyse → **★ Experten-Analyse** wird eine Linie, das ganze Projekt oder **alle deine Projekte** aus vier Blickwinkeln geprüft: Architektur & technische Entscheidungen, Ziel- & Produktausrichtung, Agenten-Workflow & Kontext-Engineering, Governance & Risiko (im Sinne von ISO/IEC 42001). Die Fakten werden immer berechnet und stehen oben. Was das Modell schreibt, wird gegen sie geprüft: Falsche Zahlen und Aussagen, die den Fakten widersprechen, werden markiert und sind nicht übernehmbar. Belege müssen zum Befund passen, und der Reifegrad darf sich durch das Modell um höchstens ±15 verschieben. Empfehlungen sind priorisiert (P1–P3, Aufwand, Ziel-Kennzahl). Regeln übernimmst du mit einem Klick, dann gelten sie als Projektregeln für jeden Agenten; Aufgaben haben einen direkten Knopf. Berichte sind signiert und lassen sich als Markdown exportieren. Ohne Modell gibt es den regelbasierten Bericht. CLI: `scenaria analyst`.

## Mehrere Projekte: mit einem Klick wechseln (v0.8)

Ein Klick auf den Projektnamen oben zeigt deine Scenaria-Projekte auf diesem Rechner, und du kannst das Dashboard umschalten. Freigabe und Schlüssel (nur im Speicher) bleiben erhalten. Agenten arbeiten weiter in ihrem eigenen Projekt: MCP-Agenten in ihrem Ordner, und HTTP-Tools, LLM-Proxy und das automatische Sichern des Servers bleiben beim Startprojekt.

## Drei Ansichten, einfache Worte

Das Dashboard hat drei Ansichten auf dieselben Daten:
- **Einfach** (Standard): dein Verlauf in Klartext, nach Tagen. *Zurück zu diesem Stand* setzt deine Dateien auf jeden gesicherten Stand (mit *Rückgängig*), *Was hat die KI gemacht?* zeigt Auftrag, Ergebnis und geänderte Dateien, und jeder Stand lässt sich als Ordner öffnen.
- **Prüfung**: die Szenario-Karte mit Regeln und Meilensteinen, Projekt-Check, Protokoll und die **Prüfakte** (ISO/IEC 42001).
- **Steuerung**: Chat, Analyse und **Erweiterungen** (Prognosen, Prognose-Prüfung, Relay).

## Prüfakte nach ISO/IEC 42001 (v0.9.6–0.9.13)

Ein Prüfer findet jede der 38 Kontrollen aus Anhang A an einem Ort: was die Aufzeichnungen dieses Projekts belegen, was nur teilweise abgedeckt ist und was eure Organisation selbst nachweisen muss. Dashboard → **Prüfung** → **Prüfakte**, im Terminal `scenaria audit-file`.

- **Aus den Aufzeichnungen berechnet**, für das ganze Projekt oder einen Zeitraum: Status je Kontrolle (teilweise belegt / Nachweis durch die Organisation / nicht abgedeckt, mit den fehlenden Quellen), der Fälschungsschutz mit jeder Warnung, signierte Freigaben, Urteilsverlauf und Neu-Versiegelungen. Es zählen nur unabhängige, signierte Prüfurteile; ein beschädigter Fälschungsschutz warnt an jeder betroffenen Kontrolle, senkt aber keinen Status.
- **Die Dokumente der Organisation** je Kontrolle: Link und SHA-256 des Dokuments (im Browser berechnet, die Datei wird nie hochgeladen), Verantwortliche mit Rolle und Name, Datum. Nur du erfasst sie, direkt bei der Kontrolle im Dashboard (oder mit `scenaria audit-file evidence`), du siehst genau, was du signierst, und sie werden mit dem Projekt committet. Sie heben nie einen Status; ein bearbeiteter Eintrag fällt als geändert auf.
- **Signiertes Prüfpaket**: der Nachweis als kanonisches JSON mit deinem Schlüssel signiert, eine Druckseite (Drucken → Als PDF sichern, Fingerabdruck auf jeder Seite), Markdown und eine Anleitung zum Prüfen. Standardmäßig mit Namen, auf Wunsch nur Rollen. Jeder prüft es ohne Projekt: `scenaria audit-file verify` – den Nachweis, beide Lesekopien und die Anleitung; die erste Zeile nennt das Gesamtergebnis, und Dateien, die nicht zum Paket gehören (z. B. ein dort gesichertes PDF), werden als nicht geprüft genannt.
- **Prüfermodus vor Ort**: Du übergibst einen Browser an einen Prüfer; er liest alles und ändert nichts, bis du den Modus beendest. Ein Schutz vor Versehen, keine Sperre an deinem eigenen Rechner.
- **Ehrlicher Umfang**: Scenaria belegt, wie KI-Agenten in euren Projekten gearbeitet haben. Es belegt nicht, wie KI-Modelle entwickelt oder trainiert werden, und ersetzt keine Richtlinien oder Folgenabschätzungen – das sind Dokumente der Organisation. Wer die Prüfakte lesen darf, ist deine signierte Einstellung (Standard: nur du).

## Jede Zahl mit Herleitung (v0.9.14)

Neben der Kontext-Treue, dem Projekt-Check und den Zählern der Prüfakte steht **ⓘ Wie berechnet?**: die Formel mit Version, die Eingänge (bei Zählern jeder gezählte Eintrag) und ein Satz in einfachen Worten. Darüberfahren zeigt den Satz, Antippen oder Enter zeigt alles. Scenaria rechnet die Zahl aus den Eingängen nach und sagt, ob sie stimmt. Im Prüfpaket stehen die Herleitungen als Fußnoten, und `scenaria audit-file verify` rechnet sie nach. Ein Modell liefert nie eine dieser Zahlen.

## Fortschritt: wie weit ist die Arbeit? (v0.9.15)

**Fortschritt** zeigt in Prozent, wie weit jede Aufgabe und das ganze Projekt sind – nur aus Nachweisen berechnet, nach festen Regeln, mit **ⓘ Wie berechnet?** wie jede Zahl. Du legst fest, wann eine Aufgabe fertig ist: Fertig-Kriterien sind Meilensteine mit der Aufgabe, einem Gewicht und optional der Datei, die dabei entsteht; die KI schlägt sie vor, du gibst sie genau so frei, wie sie angezeigt werden. Die KI meldet im Checkpoint, welches Kriterium sie umgesetzt hat; das zählt erst mit Nachweis (die Datei wurde seit deiner Freigabe geändert). Stufen: begonnen, umgesetzt, geprüft (der Prüfbefehl bestand), bestätigt (von dir, oder der meldende Schritt wurde geprüft). Tore deckeln den Wert: 90 % braucht alle Kriterien bestätigt, 100 % dein eigenes Prüfurteil auf dem letzten Schritt der Aufgabe – die KI kann sich nie „fertig rechnen“. Es zählt nur der aktuelle Weg: Wer zurückspringt, lässt keine Nachweise des aufgegebenen Versuchs stehen. Agenten lesen ihn mit `scenaria_progress`, das Terminal mit `scenaria progress`.

## Wie voll ist das Kontextfenster der KI? (v0.9.20)

Scenaria misst, wie voll das Kontextfenster eines Agenten ist – aus den Token-Zahlen, die der Anbieter meldet, nie geschätzt: in Claude Code aus dem Sitzungsprotokoll, bei anderen Agenten über den LLM-Proxy. Eine Komprimierung beginnt ein neues Fenster. Der Wert ist ein Prozentsatz des nutzbaren Fensters, `C_eff = min(Fenstergröße laut Anbieter, 200.000 Tokens)`, mit Zonen: grün unter 50 %, gelb ab 50 %, orange ab einer weichen Schwelle (70 % minus ein Puffer, berechnet aus der Größe der Arbeitsschritte), rot ab 70 %, Notsicherung ab 85 %. Ein Modell, dessen Fenstergröße nicht in Scenarias Tabelle belegt ist, bekommt keine Zahl; wo Scenaria keine Tokens sieht (Claude Desktop nur über MCP), sagt es „hier nicht messbar“. Außerhalb von Scenaria geänderte Daten fallen auf und zählen dann nicht. Agenten lesen den Wert mit `scenaria_window`, das Terminal mit `scenaria window`.

Scenaria handelt danach, ohne den Agenten je zu blockieren: ab Gelb bekommt der Agent den Hinweis, keine große neue Teilaufgabe zu beginnen; ab Orange wird das Ende des Zugs als Schritt gesichert; ab Rot wird sofort ein Schritt gesichert, auch mitten im Zug, und du siehst eine Meldung („bitte ein neues Fenster öffnen“). Jede Zone wird je Fenster einmal gesichert. Die Übergabe an das neue Fenster liegt jederzeit bereit: `scenaria_handover` für Agenten, `scenaria handover` im Terminal. Über den LLM-Proxy tragen die Antworten ab Gelb `x-scenaria-context-zone`. Ein neues Fenster öffnen kann Scenaria nicht selbst. Das Dashboard zeigt es in jeder Ansicht: eine Karte in „Einfach“, „Kontextfenster“ in „Prüfung“ und „Steuerung“, jede Zahl mit „Wie berechnet?“. Die Werte der Regel (die Zonen-Linien, den Puffer, A_modell und die Fenstergröße lokaler Modelle wie Ollama) setzt nur du: in „Steuerung“ unter dem Schloss oder mit `scenaria window settings` im Terminal. Jede Änderung wird signiert und aufbewahrt, jede Zahl nennt die Regel, mit der sie berechnet wurde (z. B. `v1.0-p2`).

## Hilfe und Einführung

**?** oben rechts erklärt jede Funktion in einfachen Worten, und jeder Dialog hat sein eigenes **?**. Beim ersten Besuch führt eine kurze Einführung durch die ersten Schritte: Ziel, deine KI, Verlauf, Ansichten. Du kannst sie überspringen und über **Mehr → Einführung** jederzeit neu starten.

## Kontext-Treue: sehen, wo Kontext abbrach, sich änderte oder manipuliert wurde

Klickst du einen Knoten an, zeigt das Dashboard eine Linie vom Projektstart bis zu diesem Knoten, mit Prozentwert je Schritt. Der Wert jedes Knotens setzt sich zusammen aus:
- **Luftlinie zum Hauptziel:** Wortüberschneidung mit Haupt- und Teilziel, oder ein ausdrückliches `servesGoal`;
- **Anschluss** an die vorherigen Schritte, oder ausdrückliche `basedOn`-Verweise;
- **Integrität:** ob der Knoten noch dem entspricht, was Scenaria geschrieben hat;
- **Belastbarkeit:** Prüfungen und Konfidenz.

Marker zeigen, wo der Kontext **abbrach**, das **Hauptziel geändert** wurde, die Linie **abzweigte** und welche Schritte **außerhalb von Scenaria verändert** wurden. Auf der Karte trägt jeder Knoten zusätzlich einen Treue-Balken; im Terminal zeigt `scenaria fidelity [id]` dieselbe Linie.

Sichtbar wird Manipulation durch ein **Integritäts-Protokoll** (`.scenaria/ledger.jsonl`):
- Jeder Schreibvorgang legt den Inhalts-Hash des Knotens ab, und die Zeilen bilden eine Hash-Kette.
- Eine von Hand bearbeitete Knotendatei oder ein bearbeitetes Protokoll fällt auf: in `scenaria integrity`, im Projekt-Check und auf der Karte. Ein späterer Schreibvorgang wäscht eine Änderung nie rein.
- Ein **Anker außerhalb des Projekts** (`~/.config/scenaria/anchors/`) merkt sich, welches Protokoll dieser Rechner kennt und wie weit es reicht. Ein gelöschtes, ersetztes, gekürztes, zurückgesetztes oder verlängertes Protokoll wird gemeldet.
- **Zurücksetzen darf nur die Person** (`scenaria integrity --reseal` im Terminal oder der Knopf im Dashboard mit Freigabe-Link) – oder ein registrierter Prüfagent mit signiertem Antrag. Jedes Neuversiegeln wird signiert festgehalten; das alte Protokoll bleibt erhalten.
- **Geprüft sagen dürfen nur du und ein registrierter Prüfagent.** Das „bestanden“ eines Agenten wird als selbst gemeldet angezeigt und zählt nie; ein „fehlgeschlagen“ zählt von jedem. Deine Urteile sind signiert und an genau den geprüften Inhalt gebunden.
- Das Protokoll macht Manipulation erkennbar, verhindert sie aber nicht: Ein Programm mit deinen vollen Benutzerrechten könnte auch den Anker bearbeiten und deine Schlüssel lesen. Für Audits gehört der Schlüssel des Prüfagenten auf einen anderen Rechner oder in die CI.

Die Überschneidung ist rein lexikalisch: offline und ohne Token. Entscheidungen in einer anderen Sprache als das Ziel sollten deshalb `servesGoal` angeben.

## Übergaben, ohne alles neu zu schicken

Agenten teilen sich eine strukturierte Tafel, statt Chatverläufe weiterzureichen:
- **Global Workspace:** `scenaria_workspace` liefert die Tafel: Ziele, Entscheidungen, Fakten, offene Fragen, Regeln, Lektionen und Risiken, jeweils mit Referenz und Konfidenz. Jeder Leser wählt nur die Bereiche, die er braucht.
- **Kontext per Referenz:** `n12` (Knoten), `n12.f2` (zweiter Fakt daran), `n12.q1` (offene Frage), `r3` (Regel).
  - Weitergegeben werden Referenzen statt Inhalte; `scenaria_get_node {refs}` löst nur auf, was gebraucht wird.
  - `scenaria_context {mode: "refs"}` liefert einen kurzen Index.
- **Wissensmodell (Theory of Mind):** Mit einem `reader`-Namen merkt sich Scenaria, was dieser Leser schon kennt. Danach schickt es nur Neues und Geändertes, dazu Einträge, die **ungültig** geworden sind, etwa nach einem Rücksprung.
- **Predictive Coding:** Vor der Übernahme nennt ein Agent seine Annahmen in `scenaria_expect` (`"n12 done"`, `"n7 = Postgres"`, `"n12.f2"` oder freier Text) und bekommt nur die Abweichungen zurück.
- **Unsicherheit mitsenden:** Fakten können `{text, confidence, basedOn}` sein. Unsichere Einträge sind in Kapsel und Tafel mit „prüfen“ markiert.

## Wenig Token, langes Gedächtnis

- Die **Kontext-Kapsel** hat ein Token-Budget (Standard 1.500 Token):
  - Hauptziel, Projektregeln und das aktuelle Teilziel im Detail;
  - jedes frühere Teilziel als eine Zeile (Zusammenfassung, wichtigste Entscheidungen, Ergebnis, Lektion).
- Was nicht hineinpasst, holt **`scenaria_recall`** gezielt hervor: eine Stichwortsuche (BM25, offline) über Entscheidungen, Begründungen, Lektionen, Checkpoints und Unterhaltungen. Agenten laden Details nur bei Bedarf, statt lange Verläufe neu zu lesen.
- `scenaria_tree` faltet erledigte Teilziele auf je eine Zeile.
- Das Dashboard zeigt die Kapselgröße neben dem rohen Gesprächsverlauf, den sie ersetzt.

## Ein Overlay für jede Unterhaltung – egal welcher Anbieter

| Quelle | So wird erfasst |
|---|---|
| Claude Code | Hooks lesen das Sitzungs-Transkript fortlaufend (Prompts, Antworten, Tool-Aufrufe) |
| Jede App mit einstellbarer Basis-URL (OpenAI, Azure, Mistral, Groq, OpenRouter, Gemini, Ollama, LM Studio, Anthropic …) | **Proxy**: Basis-URL auf `http://127.0.0.1:4477/proxy/<anbieter>` setzen, eigener API-Schlüssel bleibt |
| n8n, Make, eigener Code | `POST /api/v1/messages` oder Python-Client |
| Shell-Werkzeuge | `scenaria log-message --role user --text "…"` |
| ChatGPT- und Claude.ai-Web | `scenaria import <export.json\|.zip>` (offizielle Datenexporte) |
| Agenten ohne jede Anbindung | `scenaria watch` / `start` erfassen jede Dateiänderung |

Der Proxy reicht Anfragen unverändert weiter (auch Streaming), speichert nie API-Schlüssel, erfasst jede Runde genau einmal (Chat-APIs schicken jedes Mal den ganzen Verlauf mit) und sichert nach jeder Antwort eine Version, wenn sich Dateien geändert haben.

| Anbieter | Basis-URL im Client |
|---|---|
| OpenAI und kompatible SDKs | `http://127.0.0.1:4477/proxy/openai` |
| Anthropic-SDK | `http://127.0.0.1:4477/proxy/anthropic` |
| Ollama · LM Studio | `…/proxy/ollama` · `…/proxy/lmstudio` |
| Mistral · Groq · OpenRouter · Gemini (OpenAI-kompatibel) | `…/proxy/mistral` · `…/proxy/groq` · `…/proxy/openrouter` · `…/proxy/gemini` |
| Alles andere | unter `proxy.upstreams` in `.scenaria/config.json` ergänzen oder Header `x-scenaria-upstream` senden |

## IDs für alles

| Objekt | Kurz-ID | Globale ID |
|---|---|---|
| Entscheidung / Checkpoint / Zweig (Knoten) | `n7` | `uid` (ULID, zeitlich sortierbar) |
| Szenario – eine Arbeitslinie; ein Fork oder neue Arbeit nach einem Rücksprung startet ein neues | `s2` | — |
| Version – Schritt im Pfad | `s2/v5` | Git-Ref `refs/scenaria/scenarios/s2/v5` |
| Unterhaltung | `c3` | `uid` + ID des Anbieters |
| Nachricht | `m42` | `uid`, mit ihrem Knoten verknüpft |
| Datei-Snapshot | — | Commit-Hash |

`scenaria versions` listet alles auf; im Dashboard zeigt jeder Knoten sein Label `s/v`, seine Unterhaltung und seinen Ordner.

## Snapshot-Ordner – jede Version als echter Ordner

```text
.scenaria/snapshots/
  index.md                                   Übersicht mit Links
  n1/s1/v003-n4-formular-und-webhook/        vollständige Projektdateien dieses Moments
      src/…  package.json  …
      .scenaria-version/node.json            IDs, Entscheidung, Kapsel, Modell, Person
      .scenaria-version/README.md            Entscheidungspfad bis hierher
      .scenaria-version/conversation.md      die Unterhaltung, die hierher führte
```

Unveränderte Dateien werden nur einmal gespeichert – auf macOS (APFS) als Copy-on-Write-Klone, sonst als Hardlinks aus einem Cache. Hundert Versionen kosten etwa so viel Platz wie eine plus die Änderungen. Die Dateien sind schreibgeschützt, damit niemand versehentlich die Historie verändert. `scenaria open n4` zeigt eine Version im Finder; `scenaria open n4 --copy-to ../test-n4` erzeugt eine bearbeitbare Kopie. Für Git-Teams: `scenaria mirror --enable` veröffentlicht alle Versionen als `refs/scenaria/*` im eigenen Repo (Branches und Index bleiben unberührt), z. B. `git worktree add ../s2v5 refs/scenaria/scenarios/s2/v5`.

## Funktioniert mit jedem LLM und Agenten-Stack

Claude Code (MCP + Hooks), Claude Desktop (MCP, je Projekt ein Eintrag), Cursor, VS Code/Copilot, Gemini CLI, Codex, Windsurf (MCP + `AGENTS.md`), jede API mit Function Calling (`scenaria tools --format openai|anthropic|gemini`), LangChain/CrewAI/AutoGen über den Python-Client, n8n/Make über HTTP, Shell-Agenten über `scenaria call`. Alle Wege nutzen dieselben 18 Werkzeuge.

## Für Organisationen

- **Lokal, ohne Telemetrie:** Alles liegt in `.scenaria/`; Unterhaltungen bleiben lokal und sind von Git ausgeschlossen.
- **Gemischte Modelle, ein Protokoll:** Jeder Knoten und jede Nachricht trägt Agent, Modell und Person.
- **Team-Server:** `scenaria serve --host 0.0.0.0 --token <geheim>`; der Proxy nutzt im Team-Modus den Header `x-scenaria-token`.
- **Audit & Governance:** die **Prüfakte nach ISO/IEC 42001** (siehe oben) mit jeder Kontrolle aus Anhang A und signiertem Prüfpaket; dazu `scenaria export` (JSON) und `scenaria protocol` – Entscheidungen, Prüfurteile, nicht umkehrbare Aktionen, wer und wann (ISO/IEC 42001, AI Act).
- **Open Source (MIT).**

## Grenzen

- Ein Rücksprung stellt **Dateien** wieder her, keine versendeten Mails, Pushes oder Deploys – diese werden markiert, und Scenaria warnt.
- Der Proxy erfasst Apps, deren Basis-URL sich einstellen lässt. Geschlossene Web-Apps (ChatGPT, Claude.ai) kommen über ihren Datenexport (`scenaria import`); eine Browser-Erweiterung steht auf der Roadmap.
- Im Team-Server-Modus sichern Snapshots den Projektordner auf dem Rechner, auf dem `scenaria serve` läuft.
- Die Signatur der Prüfakte heißt „auf diesem Rechner zu dieser Zeit aus diesen Aufzeichnungen berechnet und von dir freigegeben“, nicht, dass jede Tatsache bewiesen ist; der Fälschungsschutz macht Änderungen sichtbar, verhindert sie aber nicht. Der Prüfermodus schützt vor Versehen, er ist keine Sperre an deinem eigenen Rechner.

Mehr: [README.md](README.md) (vollständige Referenz), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/ROADMAP.md](docs/ROADMAP.md), [examples/](examples/README.md).

## Scenaria weiterentwickeln

Wer Scenaria weiterentwickelt (Mensch oder Agent), startet mit [docs/HANDOFF.md](docs/HANDOFF.md): Regeln, die nie gebrochen werden dürfen, Build und Tests, Modulübersicht, Arbeitsweise und offene Punkte. Danach [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) und [docs/ROADMAP.md](docs/ROADMAP.md).

## Lizenz

MIT © Kevin Grundmann · [AI-Gambit](https://ai-gambit.com)
