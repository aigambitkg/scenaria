/**
 * ISO/IEC 42001:2023, Annex A: the control catalogue for the audit file (Batch C).
 *
 * - Control IDs follow the standard. Titles and texts are short descriptions of our own; the standard's text
 *   is copyrighted and is never copied here. The standard itself is authoritative.
 * - `coverage` is the best Scenaria can reach for a control, decided at design time:
 *     evidenced       Scenaria records what an auditor needs for this control, within its scope
 *                     (no control reaches this today: every control leaves a duty to the organisation);
 *     partly          Scenaria records part of it (`required` sources); the organisation documents the rest;
 *     organisational  the organisation must provide the evidence; Scenaria at most supports it (`supporting`).
 *   The status shown for a project (C2) is computed from its real data and can be lower, i.e. "not_covered"
 *   when a required source has nothing in the chosen period. It is never higher than `coverage`.
 * - Every evidence source states how far it can be trusted (`assurance`), whether it is in the hash chain
 *   (`chained`), whether it belongs to the project or to the machine (`scope`), whether it carries times for
 *   a period filter (`timed`), and its limits in plain words. The audit file shows these limits.
 * - Scope: Scenaria provides evidence of how AI agents worked in projects (decisions, changes, checks,
 *   approvals, attribution as recorded). It does not provide evidence of how AI models are developed or
 *   trained, nor of policies or impact assessments. Never present more coverage than that.
 *
 * Shared with the dashboard, so this file must have NO imports.
 */

export type Lang2 = { de: string; en: string };
export type Coverage = "evidenced" | "partly" | "organisational";
/** What C2 shows for a project: the coverage reached, or nothing because a required source is empty. */
export type ControlStatus = Coverage | "not_covered";

/** How far a source can be trusted, strongest first. */
export type Assurance = "signed" | "chained" | "recorded" | "self-reported" | "derived";

export type EvidenceSource =
  | "decisions"
  | "checkpoints"
  | "snapshots"
  | "attribution"
  | "conversations"
  | "ledger"
  | "signatures"
  | "reseals"
  | "approvals"
  | "verdicts"
  | "auditors"
  | "irreversible"
  | "rewinds"
  | "goal"
  | "canon"
  | "rules"
  | "health"
  | "fidelity"
  | "models";

export interface EvidenceSourceInfo {
  label: Lang2;
  /** What Scenaria records, in plain words, for the auditor. */
  what: Lang2;
  /** Where the evidence stops. Shown next to the source in the audit file. */
  limits: Lang2;
  assurance: Assurance;
  /** Covered by the hash-chained ledger: fully, in part, or not. */
  chained: "yes" | "partly" | "no";
  /** Kept per project, or only on this machine (current state, not per project). */
  scope: "project" | "machine";
  /** Carries the times a period filter needs. */
  timed: "yes" | "partly" | "no";
}

export const ANNEX_A_STANDARD = "ISO/IEC 42001:2023";

export const ANNEX_A_SCOPE: Lang2 = {
  de: "Scenaria liefert Nachweise dafür, wie KI-Agenten in Projekten gearbeitet haben: Entscheidungen, Änderungen, Prüfungen, Freigaben und wer laut Aufzeichnung was getan hat. Es liefert keine Nachweise dafür, wie KI-Modelle entwickelt oder trainiert werden, und ersetzt keine Richtlinien oder Folgenabschätzungen der Organisation. Aufgezeichnet wird nur, was angebundene Agenten melden oder was Scenaria selbst erfasst. Die Kurztitel sind eigene Worte; maßgeblich ist der Text der Norm.",
  en: "Scenaria provides evidence of how AI agents worked in projects: decisions, changes, checks, approvals and who did what as recorded. It does not provide evidence of how AI models are developed or trained, and it does not replace the organisation's policies or impact assessments. Only what connected agents report, or what Scenaria captures itself, is recorded. The short titles are our own words; the standard's text is authoritative.",
};

export const COVERAGE_LABEL: Record<ControlStatus, Lang2> = {
  evidenced: { de: "belegt", en: "evidenced" },
  partly: { de: "teilweise belegt", en: "partly evidenced" },
  organisational: { de: "Nachweis durch die Organisation", en: "evidence by the organisation" },
  not_covered: { de: "nicht abgedeckt", en: "not covered" },
};

export const ASSURANCE_LABEL: Record<Assurance, Lang2> = {
  signed: { de: "signiert", en: "signed" },
  chained: { de: "in der Hash-Kette", en: "hash-chained" },
  recorded: { de: "aufgezeichnet", en: "recorded" },
  "self-reported": { de: "Selbstauskunft", en: "self-reported" },
  derived: { de: "berechnet", en: "derived" },
};

export const EVIDENCE_SOURCES: Record<EvidenceSource, EvidenceSourceInfo> = {
  decisions: {
    label: { de: "Entscheidungen", en: "Decisions" },
    what: { de: "Jede aufgezeichnete Entscheidung mit Frage, Optionen, gewählter Option, Begründung, Ausgangslage, Bezug zum Ziel, erwartetem Ergebnis und Zuversicht (0–1).", en: "Every recorded decision with question, options, chosen option, rationale, situation, link to the goal, expected outcome and confidence (0–1)." },
    limits: { de: "Nur Entscheidungen, die der Agent meldet (bei Claude Code zusätzlich Rückfragen und Planfreigaben).", en: "Only decisions the agent reports (with Claude Code also questions and plan approvals)." },
    assurance: "self-reported",
    chained: "yes",
    scope: "project",
    timed: "yes",
  },
  checkpoints: {
    label: { de: "Zwischenstände", en: "Checkpoints" },
    what: { de: "Fortschritt mit Ergebnissen, Fakten, offenen Fragen und geänderten Dateien.", en: "Progress with results, facts, open questions and changed files." },
    limits: { de: "Inhalt laut Agent; die geänderten Dateien stammen aus dem Dateistand.", en: "Content as stated by the agent; the changed files come from the file snapshot." },
    assurance: "self-reported",
    chained: "yes",
    scope: "project",
    timed: "yes",
  },
  snapshots: {
    label: { de: "Dateistände", en: "File snapshots" },
    what: { de: "Der Stand der Projektdateien zu jedem Schritt, wiederherstellbar.", en: "The state of the project files at every step, restorable." },
    limits: { de: "Ohne Dateien, die per .gitignore ausgeschlossen sind; braucht git.", en: "Without files excluded by .gitignore; needs git." },
    assurance: "chained",
    chained: "yes",
    scope: "project",
    timed: "yes",
  },
  attribution: {
    label: { de: "Zuordnung (wer, womit)", en: "Attribution" },
    what: { de: "Bei jedem Schritt: Agent, Modell, Benutzerkonto und Weg, wie vom Aufrufer angegeben.", en: "For every step: agent, model, user account and channel, as stated by the caller." },
    limits: { de: "Nicht authentifiziert. Dass über den Freigabeweg der Person oder durch einen Prüf-Agenten freigegeben oder geprüft wurde, zeigen nur signierte Freigaben und Prüfurteile.", en: "Not authenticated. Only signed approvals and verdicts show that something was approved or checked through the person's approval path or by an audit agent." },
    assurance: "self-reported",
    chained: "yes",
    scope: "project",
    timed: "yes",
  },
  conversations: {
    label: { de: "Gesprächsverlauf", en: "Conversations" },
    what: { de: "Anfragen und Antworten der KI, mit dem Schritt verknüpft, zu dem sie gehören.", en: "Requests and AI answers, linked to the step they belong to." },
    limits: { de: "Nur über Proxy, Claude-Code-Transkript oder Import erfasst; nicht in der Hash-Kette.", en: "Only captured through the proxy, Claude Code transcripts or imports; not in the hash chain." },
    assurance: "recorded",
    chained: "no",
    scope: "project",
    timed: "yes",
  },
  ledger: {
    label: { de: "Manipulationsnachweis (Hash-Kette)", en: "Tamper evidence (hash chain)" },
    what: { de: "Verkettetes Protokoll aller Schritte; nachträgliche Änderungen an Schritten werden sichtbar.", en: "Chained log of all steps; later edits to steps become visible." },
    limits: { de: "Deckt die Schritte ab, nicht Gesprächsverläufe, Projektregeln und das Ereignisprotokoll. Macht Manipulation sichtbar, verhindert sie nicht.", en: "Covers the steps, not conversations, project rules and the event log. Makes tampering visible, does not prevent it." },
    assurance: "chained",
    chained: "yes",
    scope: "project",
    timed: "yes",
  },
  signatures: {
    label: { de: "Signaturen", en: "Signatures" },
    what: { de: "Freigaben, Prüfurteile, Neu-Versiegelungen und Berichte sind signiert und an Projekt und Inhalt gebunden.", en: "Approvals, verdicts, reseals and reports are signed and bound to the project and the content." },
    limits: { de: "Der Schlüssel der Person liegt auf diesem Rechner. Voraussetzung, die Scenaria nicht erzwingt: Agenten laufen in einer Sandbox ohne Zugriff auf den Scenaria-Konfigurationsordner und starten Scenaria nicht unter dem Konto der Person. Eine Signatur belegt den Freigabeweg in Scenaria, nicht, welcher Mensch am Rechner saß.", en: "The person's key is on this machine. A precondition Scenaria does not enforce: agents run in a sandbox without access to the Scenaria config folder and do not start Scenaria under the person's account. A signature proves Scenaria's approval path, not which human sat at the machine." },
    assurance: "signed",
    chained: "partly",
    scope: "project",
    timed: "yes",
  },
  reseals: {
    label: { de: "Neu-Versiegelungen", en: "Reseals" },
    what: { de: "Jedes Zurücksetzen des Manipulationsnachweises, durch die Person oder einen Prüf-Agenten, mit Nachweis.", en: "Every reset of the tamper evidence, by the person or an audit agent, with a record." },
    limits: { de: "Der alte Stand bleibt erhalten; der Anker liegt auf diesem Rechner.", en: "The old state is kept; the anchor is on this machine." },
    assurance: "signed",
    chained: "no",
    scope: "project",
    timed: "yes",
  },
  approvals: {
    label: { de: "Signierte Freigaben", en: "Signed approvals" },
    what: { de: "Freigaben einer Person oder eines Prüf-Agenten: feste Regeln anlegen, annehmen, ablehnen, beenden oder als erfüllt bestätigen, Projektregeln anlegen, annehmen, ablehnen oder bestätigen, Prüfurteile, Neu-Versiegelungen und Prüfläufe je Arbeitslinie, mit Zeitpunkt und Weg (Dashboard oder Terminal).", en: "Approvals by a person or an audit agent: adding, accepting, rejecting, retiring or confirming fixed rules, adding, accepting, rejecting or confirming project rules, verdicts, reseals and checks per line of work, with time and channel (dashboard or terminal)." },
    limits: { de: "Andere Aktionen im Dashboard, etwa Rücksprünge, sind nicht an eine Freigabe gebunden und zählen hier nicht; ebenso wenig in Claude Code bestätigte Pläne (nicht signiert).", en: "Other dashboard actions, such as rewinds, are not bound to an approval and do not count here; nor do plans confirmed in Claude Code (not signed)." },
    assurance: "signed",
    chained: "partly",
    scope: "project",
    timed: "yes",
  },
  verdicts: {
    label: { de: "Prüfurteile", en: "Verdicts" },
    what: { de: "Prüfergebnisse mit Herkunft: Person, unabhängiger Prüf-Agent, Selbstauskunft des Agenten oder automatische Prüfung. Nur Person und Prüf-Agent zählen als geprüft.", en: "Check results with their origin: person, independent audit agent, agent self-report or automatic check. Only the person and an audit agent count as verified." },
    limits: { de: "Signiert sind nur Urteile der Person und registrierter Prüf-Agenten. Ein Urteil zählt nur mit gültiger Signatur und solange die Arbeit unverändert ist. Ältere Urteile ohne Herkunft zählen nicht.", en: "Only verdicts of the person and of registered audit agents are signed. A verdict counts only with a valid signature and while the work is unchanged. Older verdicts without an origin do not count." },
    assurance: "chained",
    chained: "yes",
    scope: "project",
    timed: "yes",
  },
  auditors: {
    label: { de: "Registrierte Prüf-Agenten", en: "Registered audit agents" },
    what: { de: "Prüf-Agenten mit eigenem Schlüssel außerhalb von Scenaria, von der Person registriert.", en: "Audit agents with their own key outside Scenaria, registered by the person." },
    limits: { de: "Die Unabhängigkeit erklärt die Person bei der Registrierung. Das Verzeichnis gilt für diesen Rechner und zeigt nur den aktuellen Stand.", en: "Independence is the person's statement at registration. The registry applies to this machine and shows only the current state." },
    assurance: "recorded",
    chained: "no",
    scope: "machine",
    timed: "partly",
  },
  irreversible: {
    label: { de: "Nicht umkehrbare Effekte", en: "Irreversible effects" },
    what: { de: "Wirkungen nach außen (gesendete Mails, Pushes, Schreibzugriffe auf fremde Systeme), am Schritt markiert.", en: "Effects outside the files (sent mails, pushes, writes to other systems), flagged at the step." },
    limits: { de: "Vom Agenten gemeldet; bei Claude Code zusätzlich an Shell-Befehlen erkannt. Aktionen über Konnektoren werden nicht selbst erkannt.", en: "Reported by the agent; with Claude Code also detected from shell commands. Actions through connectors are not detected by Scenaria." },
    assurance: "self-reported",
    chained: "yes",
    scope: "project",
    timed: "yes",
  },
  rewinds: {
    label: { de: "Rücksprünge und Lehren", en: "Rewinds and lessons" },
    what: { de: "Irrwege, zu denen zurückgesprungen wurde, mit der festgehaltenen Lehre.", en: "Dead ends that were rewound, with the lesson recorded." },
    limits: { de: "Wann steht im Ereignisprotokoll (nicht in der Hash-Kette); wer zurückgesprungen ist, wird nicht aufgezeichnet, außer an der Zwischensicherung, wenn dabei geänderte Dateien gesichert wurden. Die Lehre steht am Schritt (in der Hash-Kette).", en: "When is in the event log (not in the hash chain); who rewound is not recorded, except on the autosave made when changed files were saved first. The lesson is on the step (in the hash chain)." },
    assurance: "recorded",
    chained: "partly",
    scope: "project",
    timed: "yes",
  },
  goal: {
    label: { de: "Projektziel und Aufgaben", en: "Main goal and tasks" },
    what: { de: "Das Hauptziel des Projekts, seine früheren Fassungen und die Ziele der einzelnen Aufgaben.", en: "The project's main goal, its earlier versions and the goals of each task." },
    limits: { de: "Frühere Fassungen haben nur ein Enddatum und keine Angabe, wer das Ziel geändert hat. Auch Agenten können das Hauptziel setzen.", en: "Earlier versions only carry an end date and do not say who changed the goal. Agents can set the main goal too." },
    assurance: "recorded",
    chained: "yes",
    scope: "project",
    timed: "partly",
  },
  canon: {
    label: { de: "Feste Regeln und Meilensteine", en: "Fixed rules and milestones" },
    what: { de: "Von einer Person freigegebene, signierte Festpunkte, optional mit Prüfbefehl, und ob eine Arbeitslinie sie einhält.", en: "Fixed points approved and signed by a person, optionally with a check command, and whether a line of work keeps them." },
    limits: { de: "Agenten können nur vorschlagen. Eingehalten heißt: nicht als gebrochen gemeldet und, wenn vorhanden, Prüfbefehl bestanden. Einen Bruch erkennt Scenaria nicht selbst.", en: "Agents can only propose. Kept means: not reported as broken and, where there is one, the check passed. Scenaria does not detect a break by itself." },
    assurance: "signed",
    chained: "no",
    scope: "project",
    timed: "yes",
  },
  rules: {
    label: { de: "Projektregeln", en: "Project rules" },
    what: { de: "Regeln, die Agenten in der Kontext-Kapsel mitgegeben werden, mit Herkunft (manuell, Analyse, Agent) und der signierten Entscheidung der Person: wer, über welchen Weg, wann.", en: "Rules handed to agents in the context capsule, with their origin (manual, analysis, agent) and the person's signed decision: who, through which channel, when." },
    limits: { de: "Agenten bekommen nur Regeln mit gültiger Signatur der Person oder eines Teammitglieds, dessen Schlüssel dieser Rechner vertraut (im Team müssen sich alle gegenseitig vertrauen); Agenten können nur vorschlagen. Eine Änderung an der Datei, eine zurückgespielte ältere Fassung, eine wieder eingefügte entfernte Regel oder eine Regel aus einem anderen Projekt wird erkannt, sobald dieser Rechner den neueren Stand einmal gesehen hat; ein neuer Rechner vertraut der ersten gültigen Fassung. Der Name in der Entscheidung ist eine Angabe. Voraussetzung, die Scenaria nicht erzwingt: Agenten laufen in einer Sandbox ohne Zugriff auf den Scenaria-Konfigurationsordner (Schlüssel, vertraute Schlüssel, Marken) und starten Scenaria nicht unter dem Benutzerkonto der Person. Ältere Regeln zählen erst nach einer Bestätigung. Ob Regeln eingehalten werden, prüft Scenaria nicht.", en: "Agents receive only rules with a valid signature of the person or of a teammate whose key this machine trusts (in a team, everyone must trust each other); agents can only propose. An edit to the file, an older version restored, a removed rule put back or a rule from another project is detected once this machine has seen the newer state; a new machine trusts the first valid version. The name in the decision is a statement. A precondition Scenaria does not enforce: agents run in a sandbox without access to the Scenaria config folder (key, trusted keys, marks) and do not start Scenaria under the person's account. Older rules count only after a confirmation. Scenaria does not check whether rules are kept." },
    assurance: "signed",
    chained: "no",
    scope: "project",
    timed: "yes",
  },
  health: {
    label: { de: "Projekt-Check", en: "Health check" },
    what: { de: "Feste Prüfregeln über die Aufzeichnung: fehlende Begründungen, offene Entscheidungen, gescheiterte Prüfungen, Qualität je Agent und Modell.", en: "Fixed rules over the record: missing rationales, open decisions, failed checks, quality per agent and model." },
    limits: { de: "Berechnet aus den Aufzeichnungen, so gut wie diese.", en: "Derived from the records, as good as they are." },
    assurance: "derived",
    chained: "no",
    scope: "project",
    timed: "yes",
  },
  fidelity: {
    label: { de: "Beim Thema bleiben", en: "Context fidelity" },
    what: { de: "Wie gut jeder Schritt beim Projektziel und bei seiner Arbeitslinie bleibt, mit Brüchen und Abdriften.", en: "How well each step stays with the main goal and its line of work, with breaks and drift." },
    limits: { de: "Eine Heuristik über Wortähnlichkeit, keine inhaltliche Bewertung.", en: "A heuristic based on word overlap, not an assessment of content." },
    assurance: "derived",
    chained: "no",
    scope: "project",
    timed: "yes",
  },
  models: {
    label: { de: "Eingesetzte Modelle und Anbieter", en: "Models and providers in use" },
    what: { de: "Welche KI-Modelle und Anbieter verwendet wurden, soweit angegeben oder über Proxy und Transkript erfasst.", en: "Which AI models and providers were used, as stated or captured through the proxy and transcripts." },
    limits: { de: "Ohne Proxy, Claude-Code-Transkript oder Angabe des Agenten bleibt das Modell leer.", en: "Without the proxy, a Claude Code transcript or the agent stating it, the model stays empty." },
    assurance: "self-reported",
    chained: "partly",
    scope: "project",
    timed: "yes",
  },
};

export const ANNEX_A_AREAS: { id: string; title: Lang2 }[] = [
  { id: "A.2", title: { de: "Richtlinien zum Umgang mit KI", en: "Policies on AI" } },
  { id: "A.3", title: { de: "Interne Organisation", en: "Internal organisation" } },
  { id: "A.4", title: { de: "Ressourcen für KI-Systeme", en: "Resources for AI systems" } },
  { id: "A.5", title: { de: "Folgen von KI-Systemen abschätzen", en: "Assessing the impact of AI systems" } },
  { id: "A.6", title: { de: "Lebenszyklus von KI-Systemen", en: "AI system life cycle" } },
  { id: "A.7", title: { de: "Daten für KI-Systeme", en: "Data for AI systems" } },
  { id: "A.8", title: { de: "Informationen für Beteiligte", en: "Information for interested parties" } },
  { id: "A.9", title: { de: "Nutzung von KI-Systemen", en: "Use of AI systems" } },
  { id: "A.10", title: { de: "Beziehungen zu Dritten und Kunden", en: "Third parties and customers" } },
];

/** Sub-groups an auditor expects in A.6. */
export const ANNEX_A_GROUPS: { id: string; title: Lang2 }[] = [
  { id: "A.6.1", title: { de: "Leitlinien für die Entwicklung", en: "Guidance for development" } },
  { id: "A.6.2", title: { de: "Phasen des Lebenszyklus", en: "Life cycle stages" } },
];

/** When A.6 evidence from Scenaria applies at all: for development controls … */
export const A6_APPLIES: Lang2 = {
  de: "Gilt nur, wenn im Projekt das KI-System selbst entwickelt wird. Bei anderer Arbeit mit KI-Hilfe stützt Scenaria diese Kontrolle nicht.",
  en: "Applies only when the project develops the AI system itself. For other AI-assisted work, Scenaria does not support this control.",
};
/** … and for operation controls (monitoring, event logs), which describe the agents' own work. */
export const A6_APPLIES_AGENTS: Lang2 = {
  de: "Gilt nur, wenn die eingesetzten KI-Agenten selbst das KI-System im Geltungsbereich sind.",
  en: "Applies only when the AI agents in use are themselves the AI system in scope.",
};
const A6_OPERATION = new Set(["A.6.2.6", "A.6.2.8"]);

export interface AnnexAControl {
  id: string;
  area: string;
  /** A.6.1 / A.6.2 inside A.6; otherwise the area. */
  group: string;
  title: Lang2;
  coverage: Coverage;
  /** Sources that must hold data for the coverage to count (C2). Empty for organisational controls. */
  required: EvidenceSource[];
  /** Sources that support the control without carrying it. */
  supporting: EvidenceSource[];
  /** What Scenaria shows for this control. */
  scenaria: Lang2;
  /** What the organisation must provide itself. */
  organisation: Lang2;
  /** A condition under which Scenaria's evidence applies (A.6). */
  appliesWhen?: Lang2;
}

type Def = [id: string, title: [string, string], coverage: Coverage, required: EvidenceSource[], supporting: EvidenceSource[], scenaria: [string, string], organisation: [string, string]];

const c = ([id, title, coverage, required, supporting, scenaria, organisation]: Def): AnnexAControl => {
  const parts = id.split(".");
  const area = parts.slice(0, 2).join(".");
  return {
    id,
    area,
    group: parts.length === 4 ? parts.slice(0, 3).join(".") : area,
    title: { de: title[0], en: title[1] },
    coverage,
    required,
    supporting,
    scenaria: { de: scenaria[0], en: scenaria[1] },
    organisation: { de: organisation[0], en: organisation[1] },
    ...(area === "A.6" ? { appliesWhen: A6_OPERATION.has(id) ? A6_APPLIES_AGENTS : A6_APPLIES } : {}),
  };
};

const NONE: [string, string] = ["Keine eigenen Nachweise.", "No evidence of its own."];

const DEFS: Def[] = [
  // A.2 Policies on AI
  ["A.2.2", ["Eine KI-Richtlinie festlegen", "Set an AI policy"], "organisational", [], ["canon", "rules"],
    ["Zeigt, welche festen Regeln und Projektregeln in den Projekten gelten und ob die festen Regeln eingehalten werden.", "Shows which fixed rules and project rules apply in the projects, and whether the fixed rules are kept."],
    ["Die KI-Richtlinie selbst, beschlossen und bekanntgemacht.", "The AI policy itself, adopted and communicated."]],
  ["A.2.3", ["KI-Richtlinie mit anderen Richtlinien abstimmen", "Align the AI policy with other policies"], "organisational", [], [],
    NONE,
    ["Abgleich mit Informationssicherheit, Datenschutz, Qualität und weiteren Richtlinien.", "Alignment with information security, privacy, quality and other policies."]],
  ["A.2.4", ["KI-Richtlinie regelmäßig überprüfen", "Review the AI policy regularly"], "organisational", [], [],
    NONE,
    ["Überprüfungsrhythmus, Protokolle der Überprüfungen und Änderungen.", "Review schedule, review records and changes."]],

  // A.3 Internal organisation
  ["A.3.2", ["Rollen und Verantwortung für KI festlegen", "Define AI roles and responsibilities"], "partly", ["approvals", "verdicts"], ["attribution", "auditors"],
    ["Signierte Freigaben und Prüfurteile zeigen, über welchen Weg freigegeben und geprüft wurde, und trennen Selbstauskunft von unabhängiger Prüfung. Wer sonst gehandelt hat, steht so in der Aufzeichnung, wie es angegeben wurde.", "Signed approvals and verdicts show through which channel work was approved and checked, and separate self-reports from independent checks. Who else acted is recorded as stated."],
    ["Die festgelegten Rollen und Zuständigkeiten (z. B. RACI), Benennungen.", "The defined roles and responsibilities (e.g. RACI), appointments."]],
  ["A.3.3", ["Bedenken melden können", "Enable reporting of concerns"], "organisational", [], [],
    NONE,
    ["Meldeweg für Bedenken, Schutz der Meldenden, Bearbeitung der Meldungen.", "A channel for concerns, protection of those reporting, handling of reports."]],

  // A.4 Resources for AI systems
  ["A.4.2", ["Ressourcen dokumentieren", "Document resources"], "partly", ["attribution"], ["models"],
    ["Listet, welche Agenten und Modelle laut Aufzeichnung in welchem Projekt gearbeitet haben.", "Lists which agents and models worked in which project, as recorded."],
    ["Gesamtübersicht der Ressourcen je KI-System über Scenaria hinaus.", "Overall inventory of resources per AI system beyond Scenaria."]],
  ["A.4.3", ["Datenressourcen dokumentieren", "Document data resources"], "organisational", [], [],
    NONE,
    ["Welche Daten verwendet werden, Herkunft, Zweck, Rechte.", "Which data is used, its origin, purpose and rights."]],
  ["A.4.4", ["Werkzeuge dokumentieren", "Document tooling"], "partly", ["attribution"], ["models"],
    ["Zeigt die Agenten und Modelle, die laut Aufzeichnung je Schritt eingesetzt wurden.", "Shows the agents and models used per step, as recorded."],
    ["Freigegebene Werkzeugliste, Versionen, Verantwortliche.", "Approved tool list, versions, owners."]],
  ["A.4.5", ["System- und Rechenressourcen dokumentieren", "Document system and computing resources"], "organisational", [], ["models"],
    ["Zeigt, welche Modelle und Anbieter laut Aufzeichnung genutzt wurden.", "Shows which models and providers were used, as recorded."],
    ["Infrastruktur, Rechenkapazität, Hosting-Orte.", "Infrastructure, computing capacity, hosting locations."]],
  ["A.4.6", ["Menschliche Ressourcen dokumentieren", "Document human resources"], "organisational", [], ["attribution"],
    ["Zeigt die Benutzerkonten, die laut Aufzeichnung beteiligt waren.", "Shows the user accounts that took part, as recorded."],
    ["Benötigte Kompetenzen, Schulungen, Qualifikationsnachweise.", "Required skills, training, proof of qualification."]],

  // A.5 Assessing the impact of AI systems
  ["A.5.2", ["Verfahren zur Folgenabschätzung haben", "Have an impact assessment process"], "organisational", [], [],
    NONE,
    ["Beschriebenes Verfahren für Folgenabschätzungen.", "A documented process for impact assessments."]],
  ["A.5.3", ["Folgenabschätzungen festhalten", "Keep records of impact assessments"], "organisational", [], [],
    NONE,
    ["Die durchgeführten Folgenabschätzungen und ihre Ergebnisse.", "The impact assessments carried out and their results."]],
  ["A.5.4", ["Folgen für Einzelne und Gruppen bewerten", "Weigh effects on individuals and groups"], "organisational", [], [],
    NONE,
    ["Bewertung der Folgen für Betroffene.", "Assessment of the effects on those affected."]],
  ["A.5.5", ["Folgen für die Gesellschaft bewerten", "Weigh effects on society"], "organisational", [], [],
    NONE,
    ["Bewertung gesellschaftlicher Folgen.", "Assessment of effects on society."]],

  // A.6 AI system life cycle
  ["A.6.1.2", ["Ziele für verantwortungsvolle Entwicklung setzen", "Set objectives for responsible development"], "partly", ["goal", "canon"], ["rules"],
    ["Hauptziel und signierte feste Regeln sind festgehalten; Projektregeln werden den Agenten in der Kontext-Kapsel mitgegeben.", "The main goal and signed fixed rules are recorded; project rules are handed to the agents in the context capsule."],
    ["Die übergeordneten Ziele für verantwortungsvolle Entwicklung.", "The overall objectives for responsible development."]],
  ["A.6.1.3", ["Verantwortungsvolle Entwicklungsprozesse festlegen", "Define responsible development processes"], "partly", ["decisions", "approvals"], ["canon", "verdicts"],
    ["Zeigt den gelebten Prozess: aufgezeichnete Entscheidungen mit Begründung, signierte Freigaben, Prüfungen mit Herkunft.", "Shows the process as lived: recorded decisions with rationale, signed approvals, checks with their origin."],
    ["Der beschriebene Entwicklungsprozess.", "The documented development process."]],
  ["A.6.2.2", ["Anforderungen festhalten", "Capture requirements"], "partly", ["goal"], ["canon", "decisions"],
    ["Aufgabenziele, Meilensteine und die Entscheidungen, die Anforderungen geprägt haben.", "Task goals, milestones and the decisions that shaped the requirements."],
    ["Die vollständige Anforderungsspezifikation.", "The full requirements specification."]],
  ["A.6.2.3", ["Entstehung nachvollziehbar machen", "Make design and build traceable"], "partly", ["decisions", "checkpoints", "snapshots"], ["attribution", "conversations"],
    ["Jeder aufgezeichnete Schritt der KI-gestützten Arbeit: Entscheidung mit Begründung, Ergebnis, Dateistand, Zuordnung und, wenn erfasst, das Gespräch dazu.", "Every recorded step of the AI-assisted work: decision with rationale, result, file state, attribution and, where captured, the conversation behind it."],
    ["Entwurfsdokumentation des KI-Systems (Architektur, Modell- und Datenwahl); Arbeit außerhalb von Scenaria.", "Design documentation of the AI system (architecture, model and data choices); work outside Scenaria."]],
  ["A.6.2.4", ["Prüfen und abnehmen", "Verify and validate"], "partly", ["verdicts"], ["canon", "auditors", "approvals"],
    ["Signierte Prüfurteile mit Herkunft; Prüfbefehle für feste Regeln je Arbeitslinie; registrierte Prüf-Agenten.", "Signed verdicts with their origin; checks for fixed rules per line of work; registered audit agents."],
    ["Testkonzept und Abnahmekriterien für das KI-System selbst (z. B. Modellgüte).", "Test plan and acceptance criteria for the AI system itself (e.g. model performance)."]],
  ["A.6.2.5", ["Inbetriebnahme planen", "Plan deployment"], "organisational", [], ["irreversible", "checkpoints"],
    ["Markiert gemeldete Wirkungen nach außen wie Pushes und Veröffentlichungen am jeweiligen Schritt.", "Flags reported effects outside the files, such as pushes and releases, at the step."],
    ["Einführungsplan und Freigabe zur Inbetriebnahme des KI-Systems.", "Deployment plan and release approval for the AI system."]],
  ["A.6.2.6", ["Betrieb überwachen", "Monitor operation"], "partly", ["health"], ["fidelity", "rewinds", "verdicts"],
    ["Laufende Überwachung der Agentenarbeit: Projekt-Check, Abdriften vom Ziel (Heuristik), Rücksprünge, gescheiterte Prüfungen.", "Ongoing monitoring of the agents' work: health check, drift from the goal (heuristic), rewinds, failed checks."],
    ["Überwachung des KI-Systems im Betrieb außerhalb von Scenaria.", "Monitoring of the AI system in operation outside Scenaria."]],
  ["A.6.2.7", ["Technische Dokumentation bereitstellen", "Provide technical documentation"], "organisational", [], ["checkpoints", "decisions", "snapshots"],
    ["Die aufgezeichnete Entstehungsgeschichte mit Dateiständen kann als Anlage dienen.", "The recorded history with file states can serve as an annex."],
    ["Technische Dokumentation des KI-Systems für ihre Zielgruppen.", "Technical documentation of the AI system for its audiences."]],
  ["A.6.2.8", ["Ereignisse protokollieren", "Keep event logs"], "partly", ["ledger"], ["signatures", "reseals", "attribution", "conversations"],
    ["Hash-verkettetes Protokoll aller Schritte mit Zuordnung; Manipulationen und Neu-Versiegelungen werden sichtbar. Gesprächsverläufe, Projektregeln und das Ereignisprotokoll sind nicht in der Kette.", "A hash-chained log of all steps with attribution; tampering and reseals become visible. Conversations, project rules and the event log are not in the chain."],
    ["Aufbewahrungsfristen, Protokollierung außerhalb von Scenaria, Vollständigkeit der Agenten-Anbindung.", "Retention periods, logging outside Scenaria, completeness of the agent connection."]],

  // A.7 Data for AI systems
  ["A.7.2", ["Daten für Entwicklung und Verbesserung festlegen", "Define data for development and improvement"], "organisational", [], [],
    NONE,
    ["Datenmanagement für Entwicklung und Verbesserung.", "Data management for development and improvement."]],
  ["A.7.3", ["Datenbeschaffung regeln", "Govern data acquisition"], "organisational", [], [],
    NONE,
    ["Woher Daten kommen, Auswahlkriterien, Rechte.", "Where data comes from, selection criteria, rights."]],
  ["A.7.4", ["Datenqualität sichern", "Ensure data quality"], "organisational", [], [],
    NONE,
    ["Qualitätsanforderungen an Daten und ihre Prüfung.", "Quality requirements for data and how they are checked."]],
  ["A.7.5", ["Datenherkunft nachweisen", "Show where data came from"], "partly", ["snapshots"], ["conversations", "attribution"],
    ["Für die Agentenarbeit: welche Dateien und, wenn erfasst, welche Eingaben zu welchem Ergebnis geführt haben und wem die Änderung zugeordnet ist.", "For the agents' work: which files and, where captured, which inputs led to which result, and to whom the change is attributed."],
    ["Herkunft der Trainings- und Betriebsdaten.", "Provenance of training and operating data."]],
  ["A.7.6", ["Datenaufbereitung dokumentieren", "Document data preparation"], "organisational", [], [],
    NONE,
    ["Aufbereitungsschritte und Kriterien.", "Preparation steps and criteria."]],

  // A.8 Information for interested parties
  ["A.8.2", ["Nutzende verständlich informieren", "Inform users clearly"], "organisational", [], ["checkpoints", "decisions"],
    ["Der aufgezeichnete Verlauf in einfachen Worten kann als Grundlage für Nutzerinformationen dienen.", "The recorded history in plain words can serve as a basis for user information."],
    ["Nutzerinformation und Dokumentation des KI-Systems.", "User information and documentation of the AI system."]],
  ["A.8.3", ["Extern berichten", "Report externally"], "organisational", [], [],
    NONE,
    ["Was wem nach außen berichtet wird, und wie.", "What is reported externally, to whom and how."]],
  ["A.8.4", ["Vorfälle kommunizieren", "Communicate incidents"], "organisational", [], ["rewinds", "verdicts", "irreversible", "ledger"],
    ["Hält Vorfälle in der Agentenarbeit fest, die als Grundlage dienen können: Irrwege mit Lehre, gescheiterte Prüfungen, Wirkungen nach außen, Manipulationsalarme.", "Records incidents in the agents' work that can serve as a basis: dead ends with lessons, failed checks, external effects, tamper alarms."],
    ["Meldeplan für Vorfälle, Empfänger, Fristen, und die Meldungen selbst.", "Incident communication plan, recipients, deadlines, and the communications themselves."]],
  ["A.8.5", ["Beteiligte informieren", "Inform interested parties"], "organisational", [], [],
    NONE,
    ["Welche Informationen Beteiligte erhalten.", "Which information interested parties receive."]],

  // A.9 Use of AI systems
  ["A.9.2", ["Verantwortungsvolle Nutzung regeln", "Govern responsible use"], "partly", ["approvals", "verdicts"], ["rewinds", "canon"],
    ["Zeigt menschliche Aufsicht: signierte Freigaben, unabhängige Prüfung, Rücksprung bei Fehlern.", "Shows human oversight: signed approvals, independent checks, rewinds after mistakes."],
    ["Die Regeln zur Nutzung von KI in der Organisation.", "The organisation's rules for using AI."]],
  ["A.9.3", ["Ziele für verantwortungsvolle Nutzung setzen", "Set objectives for responsible use"], "partly", ["goal"], ["fidelity", "rules"],
    ["Ziel und Regeln je Projekt, dazu eine Heuristik, ob die Arbeit beim Ziel bleibt.", "Goal and rules per project, plus a heuristic of whether the work stays with the goal."],
    ["Die übergeordneten Nutzungsziele.", "The overall objectives for use."]],
  ["A.9.4", ["Bestimmungsgemäß nutzen", "Use as intended"], "organisational", [], ["goal", "fidelity"],
    ["Zeigt per Heuristik, ob die Arbeit beim Projektziel bleibt. Das ist nicht dasselbe wie der vorgesehene Einsatzzweck eines KI-Systems.", "Shows by heuristic whether the work stays with the main goal. That is not the same as an AI system's intended use."],
    ["Festgelegter vorgesehener Einsatzzweck je KI-System und wie er eingehalten wird.", "The defined intended use per AI system and how it is kept."]],

  // A.10 Third parties and customers
  ["A.10.2", ["Verantwortung zwischen Beteiligten aufteilen", "Split responsibilities between parties"], "organisational", [], ["attribution"],
    ["Zeigt, welchem Agenten oder Modell ein Beitrag laut Aufzeichnung zugeordnet ist.", "Shows which agent or model a contribution is attributed to, as recorded."],
    ["Vereinbarte Aufteilung der Verantwortung (Verträge, Vereinbarungen).", "The agreed allocation of responsibilities (contracts, agreements)."]],
  ["A.10.3", ["Lieferanten steuern", "Manage suppliers"], "organisational", [], ["models", "conversations"],
    ["Zeigt, welche KI-Anbieter und Modelle laut Aufzeichnung genutzt wurden.", "Shows which AI providers and models were used, as recorded."],
    ["Lieferantenbewertung und Verträge.", "Supplier assessment and contracts."]],
  ["A.10.4", ["Kundenerwartungen berücksichtigen", "Consider customer expectations"], "organisational", [], [],
    NONE,
    ["Kundenanforderungen und deren Berücksichtigung.", "Customer requirements and how they are met."]],
];

export const ANNEX_A_CONTROLS: AnnexAControl[] = DEFS.map(c);

/** The controls of one area, in catalogue order. */
export function controlsOfArea(area: string): AnnexAControl[] {
  return ANNEX_A_CONTROLS.filter((x) => x.area === area);
}

/** All sources a control names, required first. */
export function sourcesOf(control: AnnexAControl): EvidenceSource[] {
  return [...control.required, ...control.supporting];
}

/** Counts per coverage level, for a summary line. */
export function coverageSummary(): Record<Coverage, number> {
  const out: Record<Coverage, number> = { evidenced: 0, partly: 0, organisational: 0 };
  for (const x of ANNEX_A_CONTROLS) out[x.coverage]++;
  return out;
}
