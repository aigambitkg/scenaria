/**
 * The help area: every function in plain words — what it is, when it helps, how to use it, one example.
 * Kept as data (DE/EN) so the help dialog, the onboarding and the "?" buttons share one source.
 */
export type HelpAction = "goal" | "forecasts" | "analysis" | "expert" | "canon" | "chat" | "relay" | "settings" | "prompt" | "conversations" | "protocol" | "projects" | "onboarding";

export interface HelpTopic {
  id: string;
  title: string;
  /** One sentence: what it is. */
  what: string;
  /** When it helps you. */
  when?: string;
  /** Steps. */
  how?: string[];
  example?: string;
  terms?: [string, string][];
  /** Good to know / limits. */
  notes?: string[];
  open?: { action: HelpAction; label: string };
}

const de: HelpTopic[] = [
  {
    id: "start",
    title: "Scenaria in einer Minute",
    what: "Scenaria zeichnet die Arbeit deiner KI-Agenten als Entscheidungsbaum auf: Jeder Schritt ist ein Knoten (Checkpoint, Entscheidung, Teilziel), jede Abzweigung eine eigene Linie. So siehst du jederzeit, wo du stehst, warum etwas so entschieden wurde – und kannst gefahrlos zurückspringen.",
    when: "Immer, wenn Agenten länger an einem Projekt arbeiten, mehrere Agenten oder Modelle beteiligt sind oder Entscheidungen nachvollziehbar sein sollen.",
    how: [
      "Hauptziel festlegen (oben in der Leiste) – alles wird daran gemessen.",
      "Einen Agenten verbinden (Mehr → Agent-Prompt, oder scenaria start im Projektordner).",
      "Arbeiten lassen: Checkpoints und Entscheidungen erscheinen live im Baum.",
      "Vor einer Wahl die Prognose ansehen, Fixpunkte freigeben, ab und zu die Experten-Analyse laufen lassen.",
    ],
    terms: [
      ["Knoten (n12)", "Ein Schritt im Baum. Klick darauf zeigt Details, Kontext und Dateien."],
      ["Linie / Szenario (s1)", "Ein Weg vom Projektstart bis zu einem Endpunkt – jede Abzweigung ist eine eigene Linie."],
      ["HEAD / aktuell", "Der Knoten, an dem gerade gearbeitet wird."],
      ["Checkpoint", "Ein gesicherter Stand (inkl. Datei-Snapshot), zu dem du zurückkehren kannst."],
    ],
    open: { action: "onboarding", label: "Einführung starten" },
  },
  {
    id: "goal",
    title: "Hauptziel und Teilziele",
    what: "Das Hauptziel ist der Nordstern des Projekts. Teilziele gliedern die Arbeit. Kontext-Treue, Prognosen und Analysen messen, wie nah jeder Schritt daran bleibt.",
    when: "Gleich am Anfang – ohne Hauptziel sind Prognosen und Treue-Werte ungenau (Ziel 0 %).",
    how: ["Oben auf „Hauptziel festlegen“ klicken, einen Satz schreiben, speichern.", "Agenten setzen Teilziele selbst; du kannst sie im Knoten bearbeiten."],
    example: "„Gamer-App, die Spieler mit täglichen Quests jeden Tag zurückholt.“",
    open: { action: "goal", label: "Hauptziel bearbeiten" },
  },
  {
    id: "fidelity",
    title: "Kontext-Treue",
    what: "Ein Wert von 0–100 % pro Schritt: Wie gut hält dieser Schritt den bisherigen Kontext und das Ziel? Berechnet aus Zielbezug, Anschluss an die vorherigen Schritte, Integrität und Belastbarkeit (Prüfungen, Konfidenz).",
    when: "Um zu sehen, wo eine Linie „den Faden verliert“ – z. B. nach einem Agentenwechsel.",
    terms: [
      ["Kontextabbruch ↯", "Ein starker Einbruch gegenüber dem vorherigen Schritt – hier hat der nächste Schritt den Faden verloren."],
      ["Drift ↗", "Die Linie entfernt sich schleichend vom Ziel."],
      ["Luftlinie zum Ziel", "Wie nah der Schritt inhaltlich am Haupt- bzw. Teilziel ist."],
    ],
    notes: ["Die Werte werden ohne KI berechnet (Wortbezüge, Struktur, Prüfungen) – schnell und nachvollziehbar, aber keine Bedeutungsanalyse."],
  },
  {
    id: "decisions",
    title: "Entscheidungen, Zurückspringen, Alternativen",
    what: "Entscheidungen halten Frage, Optionen, Wahl und Begründung fest. Du kannst zu jedem Knoten zurückspringen oder eine nicht gewählte Option als eigene Linie erkunden.",
    how: [
      "Knoten anklicken → „Hierhin zurückspringen“ (Dateien werden vorher automatisch gesichert).",
      "Bei einer Entscheidung eine andere Option wählen → neue Linie; die alte bleibt erhalten.",
      "Beim Zurückspringen eine Lektion notieren – sie warnt künftige Agenten und Prognosen.",
    ],
    terms: [
      ["Begründung", "Das Warum einer Wahl. Ohne Begründung wissen spätere Agenten nicht, warum – das senkt Qualität und Treue."],
      ["Lektion", "Eine Erkenntnis aus einem verworfenen Weg („Redis-Cache verlor Zähler nach Neustart“)."],
    ],
  },
  {
    id: "forecasts",
    title: "Prognosen – vor der Wahl sehen, was passiert",
    what: "Für jede offene Entscheidung (und für Prompts) sagt Scenaria voraus, wie treu die Linie nach dieser Option bei Kontext und Hauptziel bleibt – bevor du wählst. Es ist dieselbe Größe, die Scenaria danach misst (Kontext-Treue), daher lässt sich jede Prognose später überprüfen.",
    when: "Vor jeder wichtigen Wahl und bevor du einem Agenten einen großen Prompt gibst.",
    example: "„Login mit Passkeys?“ – der Kern kennt das Wort nicht und gibt 48 ± 20. Das Orakel korrigiert +12, weil Knoten n7 „passwortloses Anmelden“ als Ziel nennt (Beleg n7). Neue Zahl: 48 + α·12 = 52 – nachrechenbar in „Warum diese Zahl?“.",
    how: [
      "Oben „Prognosen“ öffnen (die Zahl zeigt offene Entscheidungen) – oder einen Entscheidungsknoten anklicken.",
      "Die Schnellprognose (der Kern) ist sofort da. „Warum diese Zahl?“ zeigt jede Zutat und die Formel.",
      "Für eine tiefe Prognose „Multiversum starten“: Das Orakel korrigiert den Kern – begrenzt und mit Belegen.",
      "Den Prüf-Experten lesen (belastbar / mit Vorsicht / nicht belastbar), bei Bedarf die KI-Prüfung starten.",
      "Wählen – mit der Prognose als Begründung. Im Tab „Güte“ siehst du, wie gut die Prognosen auf diesem Projekt bisher waren.",
    ],
    terms: [
      ["Kern (Schnellprognose)", "Ohne KI: P = L + α·(eigene Worte − L) + β·(Schritt im Kontext − L) − Risiko. L = Niveau der Linie, α und β lernt Scenaria aus deinen vergangenen Entscheidungen."],
      ["Band ±", "Die Unsicherheit: So weit lag der Kern bei den anderen Entscheidungen dieses Projekts meist daneben (80 %). Bis 8 Entscheidungen ±20."],
      ["Multiversum", "Drei getrennte KI-Rollen: Archivar = Vergangenheit, Handwerker = Gegenwart (nächste Schritte, was verloren ginge), Orakel = Zukunft."],
      ["Orakel-Korrektur", "Das Orakel darf den Kern nur korrigieren: höchstens ±20 Punkte je Teil, mit Grund und Beleg. Gezählt wird Vorschlag × Sicherheit × Vertrauen γ."],
      ["belegt", "Die Korrektur nennt eine existierende, konkrete ID (Knoten, Fixpunkt). Erfundene IDs werden verworfen; Projekt, Aufgabe oder die Entscheidung selbst zählen nicht als Beleg."],
      ["Vertrauen γ", "Wie stark Korrekturen des Orakels zählen. Startet bei 1 und wird aus geprüften Fällen gelernt: verschlechtert das Orakel die Prognosen, sinkt γ Richtung 0; hilft es, kann γ bis 1,5 steigen – die Korrektur bleibt dabei immer auf ±20 begrenzt."],
      ["Deckel 40", "Zeigt das Orakel einen harten Fixpunkt in Gefahr, wird die Prognose auf 40 begrenzt."],
      ["★ Empfehlung", "Die Option mit der höchsten Prognose (beim Multiversum: die Empfehlung des Orakels – Abweichungen meldet der Prüf-Experte)."],
      ["Kontext gehalten", "Balken: vorhergesagte Kontext-Treue der Linie mit dieser Option (0–100), mit Band und – sobald gemessen – der echten Markierung."],
      ["⚑ Fixpunkt-Chip", "Diese Option berührt einen Fixpunkt (Kanon) – das Orakel prüft, ob sie ihn bricht."],
      ["vor der Wahl erstellt", "Die Prognose entstand, bevor gewählt wurde – nur solche sind ein fairer Test."],
      ["Trefferquote", "Später misst Scenaria, wie treu die Linie wirklich blieb; die Abweichung (±) zeigt, wie gut die Prognosen sind (Tab „Güte“)."],
    ],
    notes: [
      "Das Multiversum nutzt dein Modell (3 Aufrufe je Prognose) und braucht den Freigabe-Link.",
      "Automatisch: In den Einstellungen einschaltbar, mit Tageslimit für alle Projekte zusammen.",
      "Der Kern ist wortbasiert: Synonyme oder eine andere Sprache erkennt er nicht – dafür ist das Orakel da, und dafür prüft der Prüf-Experte das Orakel.",
    ],
    open: { action: "forecasts", label: "Prognosen öffnen" },
  },
  {
    id: "forecast-check",
    title: "Prüf-Experte und Güte – Prognosen absichern",
    what: "Der Prüf-Experte prüft jede Prognose, bevor du dich darauf verlässt, und sagt: belastbar, mit Vorsicht oder nicht belastbar. Der Tab „Güte“ zeigt, wie gut Kern und Orakel auf diesem Projekt bisher wirklich waren.",
    when: "Bevor du nach einer Prognose wählst – vor allem, wenn das Orakel den Kern stark korrigiert hat.",
    example: "Die Passkey-Option: Der Kern hatte gewarnt (eigene Worte ohne Bezug), das Orakel korrigiert mit Beleg n7. Prüf-Experte: „mit Vorsicht“ – erst nach der KI-Prüfung. Der Skeptiker liest n7, bestätigt den Bezug → „belastbar“. Hätte er widersprochen, fiele die Korrektur in der geprüften Prognose weg.",
    how: [
      "Unter jeder gespeicherten Prognose: „Prüfpunkte zeigen“ – die Checkliste läuft sofort und ohne KI.",
      "„KI-Prüfung der Orakel-Aussagen“: Ein skeptisches Modell prüft jede Aussage NUR gegen die zitierten Belege (so, wie sie bei der Prognose waren). Nicht belegte Korrekturen fallen in der „geprüften Prognose“ weg.",
      "Im Tab „Güte“: Rückblick (jede vergangene Entscheidung aus ihrer Zeit heraus prognostiziert), Orakel vs. Kern, Prüfstand.",
    ],
    terms: [
      ["Checkliste", "Vor der Wahl erstellt? Signiert? Hauptziel und Linie da? Unterscheiden sich die Optionen stärker als das Band? War der Kern hier besser als die naive Fortschreibung? Sind alle Korrekturen belegt?"],
      ["KI-geprüft", "Der Skeptiker hat bestätigt, dass die Belege die Aussage tragen. Erst dann gilt eine Warnflagge des Kerns als entkräftet, und erst dann reicht eine große Korrektur (≥ 10 Punkte) für „belastbar“."],
      ["Skill", "1 − Fehler/Fehler der naiven Fortschreibung. Über 0 = besser als einfach „die Linie bleibt, wie sie ist“."],
      ["Im Band", "Wie oft die Wirklichkeit innerhalb des angegebenen ± lag."],
      ["Orakel-Backtest", "Vergangene Entscheidungen werden mit dem Wissen von damals neu prognostiziert – mit und ohne Orakel. So zeigt sich, ob das Orakel die Prognosen besser macht (3 Modellaufrufe je Entscheidung)."],
      ["Prüfstand", "Synthetische Fälle mit bekanntem Ausgang, um den Kern selbst zu testen."],
    ],
    notes: [
      "Aussagekräftig ab 10 Entscheidungen; davor zeigt Scenaria die Zahlen als Tendenz.",
      "Prüfungen und Backtests werden signiert gespeichert; außerhalb geänderte Dateien werden erkannt und ignoriert.",
      "KI-Prüfung und Orakel-Backtest nutzen dein Modell und brauchen den Freigabe-Link (im Terminal: scenaria forecast --audit f3 --deep).",
    ],
    open: { action: "forecasts", label: "Prognosen öffnen" },
  },

  {
    id: "canon",
    title: "Fixpunkte (Kanon)",
    what: "Fixpunkte sind Dinge, die feststehen: Vorgaben, Entscheidungen, Zusagen. Agenten bekommen sie in ihren Kontext; Linien, die einen harten Fixpunkt brechen, sind ungültig.",
    how: [
      "Kanon öffnen → „Archivar fragen“: er schlägt Fixpunkte aus der Historie vor.",
      "Vorschläge prüfen und freigeben – nur du kannst freigeben (Freigabe-Link).",
      "Optional einen Prüfbefehl hinterlegen (z. B. npm test) und das Gate laufen lassen: zeigt, welche Linien die Fixpunkte überstehen.",
    ],
    terms: [
      ["hart / weich", "Hart = darf nie gebrochen werden; weich = Leitplanke."],
      ["Gate", "Führt die freigegebenen Prüfbefehle auf einer Kopie jeder Linie aus."],
    ],
    notes: ["Fixpunkte sind signiert; ein von außen veränderter Fixpunkt wird als manipuliert angezeigt."],
    open: { action: "canon", label: "Kanon öffnen" },
  },
  {
    id: "chat",
    title: "Chat – Scenaria per Sprache steuern",
    what: "Im Chat steuerst du alles mit deinem Modell: Stand abfragen, Entscheidungen festhalten, Prognosen und Analysen starten, Fixpunkte vorschlagen.",
    how: ["Rechts auf „Chat“ wechseln und schreiben, z. B. „Wie ist der Stand?“", "Aktionen, die für dich handeln (Freigaben, Prüfbefehle, Analyse mit Modell), erscheinen als Karte – sie laufen erst nach deinem Klick."],
    example: "„Prognostiziere die offene Entscheidung zum Push-Dienst.“ · „Mach eine Experten-Analyse.“",
    open: { action: "chat", label: "Chat öffnen" },
  },
  {
    id: "relay",
    title: "Orakel befragen (Relay)",
    what: "Für eine neue, wichtige Frage ohne fertige Optionen: Archivar sammelt Vorgaben, Handwerker entwirft Optionen, Orakel prüft sie gegen die Fixpunkte. Auf Wunsch wird daraus eine offene Entscheidung.",
    open: { action: "relay", label: "Orakel befragen" },
  },
  {
    id: "analysis",
    title: "Analyse: Gesundheit, Muster, Experten-Analyse",
    what: "Drei Stufen: Der Gesundheitscheck (ohne KI) zeigt Probleme sofort. Die Muster-Analyse findet wiederkehrende Muster und schlägt Regeln vor. Die Experten-Analyse ist ein vollständiger, priorisierter Bericht zum Optimieren.",
    when: "Gesundheit: jederzeit. Experten-Analyse: nach einer Arbeitsphase, vor einem Release, für Kunden-Reviews.",
    how: [
      "Analyse → „★ Experten-Analyse“ → Umfang wählen: ganzes Projekt, eine Arbeitslinie oder alle deine Projekte.",
      "„Experten-Analyse starten“ (mit Modell) oder „Ohne Modell (regelbasiert)“.",
      "Empfehlungen vom Typ „Regel“ mit einem Klick übernehmen – jeder Agent bekommt sie ab dann in seinen Kontext. „Aufgaben“ haben einen direkten Knopf.",
      "Bericht als Markdown kopieren oder herunterladen.",
    ],
    terms: [
      ["Vier Blickwinkel", "Architektur & technische Entscheidungen · Ziel- & Produktausrichtung · Agenten-Workflow & Kontext · Governance & Risiko (im Sinne von ISO/IEC 42001)."],
      ["Fakten", "Immer oben, berechnet – nie vom Modell formuliert."],
      ["Einschätzung des Modells", "Separat und beschriftet. Zahlen, die nicht in den Fakten stehen, werden markiert."],
      ["widerspricht den Fakten", "Das Modell nannte einen falschen Wert oder eine Aussage, die nicht zum Wert passt – zählt nicht als belegt, kann nicht übernommen werden."],
      ["unbelegt", "Ohne passenden Knoten oder Kennzahl als Beleg."],
      ["Reifegrad", "Regelbasiert berechnet; das Modell darf ihn um höchstens ±15 verschieben."],
    ],
    notes: [
      "Grenzen: Ein richtiger Wert mit falscher Aussage wird nur bei klaren Fällen erkannt. Deshalb stehen die Fakten immer oben.",
      "Berichte sind signiert; ein von außen geschriebener Bericht wird als unbestätigt gezeigt.",
      "Analysen über alle Projekte liegen nur bei dir (nicht im Projekt) und brauchen den Freigabe-Link.",
    ],
    open: { action: "expert", label: "Experten-Analyse öffnen" },
  },
  {
    id: "projects",
    title: "Projekte wechseln",
    what: "Oben auf den Projektnamen ▾ klicken: Liste deiner Scenaria-Projekte auf diesem Rechner, Wechsel mit einem Klick.",
    how: [
      "Ein Projekt erscheint in der Liste, sobald es einmal mit scenaria start, scenaria init oder über einen MCP-Agenten geöffnet wurde.",
      "Ein anderes Projekt kannst du auch per Ordnerpfad öffnen.",
      "✕ entfernt ein Projekt nur aus der Liste – die Dateien bleiben.",
    ],
    terms: [
      ["Was wechselt", "Das Dashboard: Baum, Prognosen, Analyse, Kanon, Chat-Kontext."],
      ["Was bleibt", "Agenten an diesem Server (HTTP-Tools, LLM-Proxy), das automatische Sichern und MCP-Agenten arbeiten weiter in ihrem eigenen Projekt. Deine Freigabe und deine Schlüssel (nur im Speicher) bleiben erhalten."],
    ],
    open: { action: "projects", label: "Projektliste öffnen" },
  },
  {
    id: "agents",
    title: "Agenten verbinden",
    what: "Jeder Agent kann Scenaria nutzen: per MCP (Claude Code, Cursor, VS Code, Gemini, Codex …), per Kommandozeile, per HTTP oder einfach per kopiertem Prompt in einem beliebigen Chat.",
    how: [
      "Im Projektordner: scenaria start – verbindet erkannte Agenten automatisch und öffnet das Dashboard.",
      "Oder Einstellungen → Agenten verbinden.",
      "Für jeden anderen Chat: Mehr → Agent-Prompt kopieren und einfügen.",
    ],
    open: { action: "prompt", label: "Agent-Prompt öffnen" },
  },
  {
    id: "settings",
    title: "Einstellungen, Modelle, Schlüssel, Freigabe",
    what: "Hier wählst du Modelle (lokal z. B. Ollama, oder OpenAI, Anthropic, Gemini …) – ein Standardmodell und optional pro Rolle (Chat, Analyse, Experten-Analyst, Archivar, Handwerker, Orakel).",
    terms: [
      ["API-Schlüssel", "Werden nie gespeichert: entweder als Umgebungsvariable (z. B. OPENAI_API_KEY) oder nur für diese Browser-Sitzung."],
      ["Freigabe-Link", "Erscheint im Terminal von scenaria start. Er gibt diesem Browser das Recht, für dich zu handeln (Freigaben, Einstellungen, Chat, Modelle). Agenten können nur vorschlagen."],
    ],
    notes: ["Ist der Link verbraucht: Scenaria neu starten, um einen neuen zu bekommen."],
    open: { action: "settings", label: "Einstellungen öffnen" },
  },
  {
    id: "history",
    title: "Unterhaltungen und Protokoll",
    what: "Unterhaltungen zeigen die aufgezeichneten Chats deiner Agenten (über MCP, Proxy oder eingefügte Antworten) – passend zu den Knoten. Das Protokoll listet jedes Ereignis im Projekt.",
    open: { action: "conversations", label: "Unterhaltungen öffnen" },
  },
  {
    id: "privacy",
    title: "Datenschutz und Sicherheit",
    what: "Alles bleibt auf deinem Rechner: im Projekt unter .scenaria, persönliche Dinge (Einstellungen, Projektliste, Schlüssel zum Signieren, Analysen über alle Projekte) unter ~/.config/scenaria.",
    notes: [
      "Dein eigenes .git wird nie verändert (Snapshots liegen getrennt).",
      "Prüfbefehle laufen nur auf deinen Wunsch und nur freigegebene.",
      "Modelle bekommen nur, was für die jeweilige Aufgabe nötig ist; Schlüssel nur ihr eigener Anbieter.",
    ],
  },
  {
    id: "cli",
    title: "Kommandozeile – Kurzreferenz",
    what: "Alles geht auch im Terminal:",
    how: [
      "scenaria start – Projekt einrichten, Agenten verbinden, Dashboard öffnen",
      "scenaria status · scenaria workspace · scenaria fidelity",
      "scenaria forecast n12 [--quick] · scenaria forecast --prompt \"…\"",
      "scenaria analyst [--scope project|line|all] [--no-model] · scenaria analyst x3 --out-file bericht.md",
      "scenaria canon … · scenaria relay \"Frage\"",
    ],
  },
];

const en: HelpTopic[] = [
  {
    id: "start",
    title: "Scenaria in one minute",
    what: "Scenaria records the work of your AI agents as a decision tree: every step is a node (checkpoint, decision, task), every branch its own line. You always see where you are, why something was decided — and you can jump back safely.",
    when: "Whenever agents work on a project for a while, several agents or models are involved, or decisions should be traceable.",
    how: [
      "Set the main goal (top bar) — everything is measured against it.",
      "Connect an agent (More → Agent prompt, or scenaria start in the project folder).",
      "Let it work: checkpoints and decisions appear live in the tree.",
      "Look at the forecast before a choice, approve fixed points, run the expert analysis now and then.",
    ],
    terms: [
      ["Node (n12)", "One step in the tree. Click it for details, context and files."],
      ["Line / scenario (s1)", "A path from the project start to an end point — every branch is its own line."],
      ["HEAD / current", "The node being worked on right now."],
      ["Checkpoint", "A saved state (incl. file snapshot) you can return to."],
    ],
    open: { action: "onboarding", label: "Start the introduction" },
  },
  {
    id: "goal",
    title: "Main goal and tasks",
    what: "The main goal is the project's north star. Tasks structure the work. Context fidelity, forecasts and analyses measure how close every step stays to it.",
    when: "Right at the start — without a main goal forecasts and fidelity are imprecise (goal 0 %).",
    how: ["Click \"Set the main goal\" at the top, write one sentence, save.", "Agents set tasks themselves; you can edit them on the node."],
    example: "\"Gamer app that brings players back every day with daily quests.\"",
    open: { action: "goal", label: "Edit main goal" },
  },
  {
    id: "fidelity",
    title: "Context fidelity",
    what: "A value of 0–100 % per step: how well does this step keep the context so far and the goal? Computed from goal link, continuity with the previous steps, integrity and reliability (checks, confidence).",
    when: "To see where a line \"loses the thread\" — e.g. after a switch of agents.",
    terms: [
      ["Context break ↯", "A sharp drop against the previous step — here the next step lost the thread."],
      ["Drift ↗", "The line slowly moves away from the goal."],
      ["Distance to the goal", "How close the step is to the main goal or task in content."],
    ],
    notes: ["Computed without AI (word links, structure, checks) — fast and traceable, but no semantic analysis."],
  },
  {
    id: "decisions",
    title: "Decisions, jumping back, alternatives",
    what: "Decisions record the question, options, choice and rationale. You can jump back to any node or explore an option that was not chosen as its own line.",
    how: [
      "Click a node → \"Jump back here\" (files are saved automatically first).",
      "On a decision choose another option → a new line; the old one stays.",
      "Note a lesson when jumping back — it warns future agents and forecasts.",
    ],
    terms: [
      ["Rationale", "The why of a choice. Without it later agents do not know why — quality and fidelity drop."],
      ["Lesson", "An insight from a discarded path (\"Redis cache lost counters after a restart\")."],
    ],
  },
  {
    id: "forecasts",
    title: "Forecasts — see what happens before you choose",
    what: "For every open decision (and for prompts) Scenaria predicts how faithful the line stays to the context and the main goal after this option — before you choose. It is the same quantity Scenaria measures afterwards (context fidelity), so every forecast can be checked later.",
    when: "Before every important choice and before you give an agent a big prompt.",
    example: "\"Login with passkeys?\" — the core does not know the word and gives 48 ± 20. The oracle corrects +12 because node n7 names \"passwordless sign-in\" as a goal (evidence n7). New number: 48 + α·12 = 52 — retraceable in \"Why this number?\".",
    how: [
      "Open \"Forecasts\" at the top (the number shows open decisions) — or click a decision node.",
      "The quick forecast (the core) is there at once. \"Why this number?\" shows every ingredient and the formula.",
      "For a deep one: \"Start multiverse\" — the oracle corrects the core, bounded and with evidence.",
      "Read the auditor (reliable / with caution / not reliable); start the AI check if needed.",
      "Choose — with the forecast as your rationale. The \"Quality\" tab shows how good the forecasts have been on this project.",
    ],
    terms: [
      ["Core (quick forecast)", "Without AI: P = L + α·(own words − L) + β·(step in context − L) − risk. L = the line's level; α and β are learned from your past decisions."],
      ["Band ±", "The uncertainty: how far off the core usually was on this project's other decisions (80 %). ±20 until 8 decisions."],
      ["Multiverse", "Three separate AI roles: archivist = past, craftsman = present (next steps, what would be lost), oracle = future."],
      ["Oracle correction", "The oracle may only correct the core: at most ±20 points per part, with a reason and evidence. What counts is proposal × confidence × trust γ."],
      ["backed", "The correction cites an existing, specific id (node, fixed point). Invented ids are dropped; the project, the task or the decision itself are no evidence."],
      ["Trust γ", "How much the oracle's corrections count. Starts at 1 and is learned from checked cases: if the oracle makes forecasts worse, γ goes towards 0; if it helps, γ can rise to 1.5 — the correction always stays within ±20."],
      ["Cap 40", "If the oracle shows a hard fixed point at risk, the forecast is capped at 40."],
      ["★ Recommendation", "The option with the highest forecast (multiverse: the oracle's recommendation — the auditor reports any mismatch)."],
      ["Context kept", "Bar: predicted context fidelity of the line with this option (0–100), with the band and — once measured — the real marker."],
      ["⚑ Fixed-point chip", "This option touches a fixed point (canon) — the oracle checks whether it breaks it."],
      ["made before the choice", "The forecast existed before the choice — only those are a fair test."],
      ["Hit rate", "Later Scenaria measures how faithful the line really stayed; the deviation (±) shows how good the forecasts are (\"Quality\" tab)."],
    ],
    notes: [
      "The multiverse uses your model (3 calls per forecast) and needs the approval link.",
      "Automatic: can be switched on in Settings, with a daily limit for all projects together.",
      "The core is word-based: it does not see synonyms or another language — that is what the oracle is for, and why the auditor checks the oracle.",
    ],
    open: { action: "forecasts", label: "Open forecasts" },
  },
  {
    id: "forecast-check",
    title: "Auditor and quality — securing forecasts",
    what: "The auditor checks every forecast before you rely on it and says: reliable, with caution or not reliable. The \"Quality\" tab shows how good core and oracle really have been on this project.",
    when: "Before you choose based on a forecast — especially when the oracle corrected the core a lot.",
    example: "The passkey option: the core had warned (own words without connection), the oracle corrects with evidence n7. Auditor: \"with caution\" — until the AI check. The skeptic reads n7 and confirms the link → \"reliable\". Had it disagreed, the correction would be removed in the audited forecast.",
    how: [
      "Below every saved forecast: \"Show checks\" — the checklist runs at once, without AI.",
      "\"AI check of the oracle's claims\": a skeptical model checks each claim ONLY against the cited evidence (as it was when the forecast was made). Unsupported corrections are removed in the \"audited forecast\".",
      "In the \"Quality\" tab: backtest (every past decision forecast as of its own time), oracle vs. core, test bench.",
    ],
    terms: [
      ["Checklist", "Made before the choice? Signed? Main goal and line there? Do the options differ more than the band? Was the core better than naive persistence here? Are all corrections backed?"],
      ["AI-checked", "The skeptic confirmed that the evidence carries the claim. Only then does a core warning count as resolved, and only then is a large correction (≥ 10 points) enough for \"reliable\"."],
      ["Skill", "1 − error / error of naive persistence. Above 0 = better than simply \"the line stays as it is\"."],
      ["Within band", "How often reality fell within the stated ±."],
      ["Oracle backtest", "Past decisions forecast again with the knowledge of their time — with and without the oracle. Shows whether the oracle makes forecasts better (3 model calls per decision)."],
      ["Test bench", "Synthetic cases with a known outcome to test the core itself."],
    ],
    notes: [
      "Meaningful from 10 decisions; before that Scenaria shows the numbers as a tendency.",
      "Audits and backtests are stored signed; files changed outside are detected and ignored.",
      "The AI check and the oracle backtest use your model and need the approval link (terminal: scenaria forecast --audit f3 --deep).",
    ],
    open: { action: "forecasts", label: "Open forecasts" },
  },

  {
    id: "canon",
    title: "Fixed points (canon)",
    what: "Fixed points are things that are settled: constraints, decisions, commitments. Agents get them in their context; lines that break a hard fixed point are invalid.",
    how: [
      "Open Canon → \"Ask the archivist\": it proposes fixed points from the history.",
      "Review and approve proposals — only you can approve (approval link).",
      "Optionally add a check command (e.g. npm test) and run the gate: it shows which lines survive the fixed points.",
    ],
    terms: [
      ["hard / soft", "Hard = must never be broken; soft = guard rail."],
      ["Gate", "Runs the approved check commands on a copy of every line."],
    ],
    notes: ["Fixed points are signed; one changed from outside is shown as tampered."],
    open: { action: "canon", label: "Open canon" },
  },
  {
    id: "chat",
    title: "Chat — control Scenaria in plain language",
    what: "In the chat you control everything with your model: ask for the state, record decisions, start forecasts and analyses, propose fixed points.",
    how: ["Switch to \"Chat\" on the right and write, e.g. \"What is the state?\"", "Actions that act for you (approvals, check commands, analysis with a model) appear as a card — they run only after your click."],
    example: "\"Forecast the open decision about the push service.\" · \"Run an expert analysis.\"",
    open: { action: "chat", label: "Open chat" },
  },
  {
    id: "relay",
    title: "Ask the oracle (relay)",
    what: "For a new, important question without ready options: the archivist gathers constraints, the craftsman drafts options, the oracle checks them against the fixed points. Optionally it becomes an open decision.",
    open: { action: "relay", label: "Ask the oracle" },
  },
  {
    id: "analysis",
    title: "Analysis: health, patterns, expert analysis",
    what: "Three levels: the health check (no AI) shows problems at once. The pattern analysis finds recurring patterns and proposes rules. The expert analysis is a complete, prioritised report to optimise with.",
    when: "Health: any time. Expert analysis: after a phase of work, before a release, for client reviews.",
    how: [
      "Analysis → \"★ Expert analysis\" → choose the scope: whole project, one line of work or all your projects.",
      "\"Start expert analysis\" (with a model) or \"Without model (rule-based)\".",
      "Adopt recommendations of type \"rule\" with one click — every agent gets them in its context from then on. \"Tasks\" have a direct button.",
      "Copy or download the report as Markdown.",
    ],
    terms: [
      ["Four lenses", "Architecture & technical decisions · goal & product alignment · agent workflow & context · governance & risk (in the spirit of ISO/IEC 42001)."],
      ["Facts", "Always on top, computed — never written by the model."],
      ["The model's assessment", "Separate and labelled. Numbers that are not in the facts are flagged."],
      ["contradicts the facts", "The model quoted a wrong value or a statement that does not fit the value — not counted as backed, cannot be adopted."],
      ["unverified", "No fitting node or key figure as evidence."],
      ["Maturity", "Rule-based; the model may move it by at most ±15."],
    ],
    notes: [
      "Limits: a right value with a wrong statement is only caught in clear cases. That is why the facts always come first.",
      "Reports are signed; a report written from outside is shown as unconfirmed.",
      "Analyses across all projects are kept with you (not in a project) and need the approval link.",
    ],
    open: { action: "expert", label: "Open expert analysis" },
  },
  {
    id: "projects",
    title: "Switching projects",
    what: "Click the project name ▾ at the top: a list of your Scenaria projects on this computer, switch with one click.",
    how: [
      "A project appears in the list once it was opened with scenaria start, scenaria init or by an MCP agent.",
      "You can also open another project by its folder.",
      "✕ only removes a project from the list — the files stay.",
    ],
    terms: [
      ["What switches", "The dashboard: tree, forecasts, analysis, canon, chat context."],
      ["What stays", "Agents at this server (HTTP tools, LLM proxy), auto-save and MCP agents keep working in their own project. Your approval and your keys (memory only) are kept."],
    ],
    open: { action: "projects", label: "Open the project list" },
  },
  {
    id: "agents",
    title: "Connecting agents",
    what: "Any agent can use Scenaria: via MCP (Claude Code, Cursor, VS Code, Gemini, Codex …), the command line, HTTP, or simply a copied prompt in any chat.",
    how: [
      "In the project folder: scenaria start — wires detected agents and opens the dashboard.",
      "Or Settings → Connect agents.",
      "For any other chat: More → copy the agent prompt and paste it.",
    ],
    open: { action: "prompt", label: "Open agent prompt" },
  },
  {
    id: "settings",
    title: "Settings, models, keys, approval",
    what: "Choose models here (local e.g. Ollama, or OpenAI, Anthropic, Gemini …) — a default model and optionally one per role (chat, analysis, expert analyst, archivist, craftsman, oracle).",
    terms: [
      ["API keys", "Never stored: either as an environment variable (e.g. OPENAI_API_KEY) or only for this browser session."],
      ["Approval link", "Shown in the terminal of scenaria start. It gives this browser the right to act for you (approvals, settings, chat, models). Agents can only propose."],
    ],
    notes: ["If the link was used up: restart Scenaria to get a new one."],
    open: { action: "settings", label: "Open settings" },
  },
  {
    id: "history",
    title: "Conversations and protocol",
    what: "Conversations show the recorded chats of your agents (via MCP, proxy or pasted answers) — next to the nodes. The protocol lists every event in the project.",
    open: { action: "conversations", label: "Open conversations" },
  },
  {
    id: "privacy",
    title: "Privacy and security",
    what: "Everything stays on your computer: in the project under .scenaria, personal things (settings, project list, signing key, analyses across projects) under ~/.config/scenaria.",
    notes: [
      "Your own .git is never changed (snapshots are kept separately).",
      "Check commands run only on your request and only approved ones.",
      "Models only get what the task needs; keys only go to their own provider.",
    ],
  },
  {
    id: "cli",
    title: "Command line — quick reference",
    what: "Everything works in the terminal too:",
    how: [
      "scenaria start — set up the project, connect agents, open the dashboard",
      "scenaria status · scenaria workspace · scenaria fidelity",
      "scenaria forecast n12 [--quick] · scenaria forecast --prompt \"…\"",
      "scenaria analyst [--scope project|line|all] [--no-model] · scenaria analyst x3 --out-file report.md",
      "scenaria canon … · scenaria relay \"question\"",
    ],
  },
];

export const HELP: Record<"de" | "en", HelpTopic[]> = { de, en };
