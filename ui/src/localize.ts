/**
 * The engine records some texts in English (titles of automatic saves, the result of automatic checks, reasons
 * of the gate, entries of the technical log). They are stored that way on purpose: the record is the same for
 * every reader and every model. This file turns the ones people meet in the dashboard into German when the
 * dashboard is set to German. English stays as it is; a text that is not recognised stays as it is too —
 * better an English sentence than a wrong translation.
 *
 * No imports: the tests load this file on its own (test/simpleui.test.mjs).
 */
export type Lang = "de" | "en";

type Rule = [RegExp, (m: RegExpExecArray) => string];

const files = (n: string) => (n === "1" ? "1 Datei" : `${n} Dateien`);

/** Whole texts: the pattern must match from start to end. */
const WHOLE: Rule[] = [
  // titles of steps Scenaria creates itself
  [/^Autosave before rewind to (n\d+)$/, (m) => `Automatisch gesichert vor dem Zurückgehen zu ${m[1]}`],
  [/^Autosave before (?:fork|branch) (?:at|from|of) (n\d+)$/, (m) => `Automatisch gesichert vor dem anderen Weg ab ${m[1]}`],
  [/^Autosave$/, () => "Automatisch gesichert"],
  [/^Manual checkpoint$/, () => "Manuell gesichert"],
  [/^Saved manually$/, () => "Manuell gesichert"],
  [/^Alternative: (.+)$/, (m) => `Anderer Weg: ${m[1]}`],
  [/^Pasted answers$/, () => "Eingefügte Antworten"],

  // names of the automatic checks
  [/^snapshot restorable$/, () => "Stand wiederherstellbar"],
  [/^claimed files exist$/, () => "Genannte Dateien vorhanden"],
  [/^decision documented$/, () => "Entscheidung begründet"],
  [/^decision context$/, () => "Zusammenhang der Entscheidung"],
  [/^confidence$/, () => "Sicherheit der KI"],
  [/^changes documented$/, () => "Änderungen beschrieben"],
  [/^snapshot completeness$/, () => "Stand vollständig"],
  [/^irreversible side effects$/, () => "Nicht umkehrbare Wirkungen"],
  [/^command: not run$/, () => "Prüfbefehl: nicht ausgeführt"],
  [/^command: (.+)$/, (m) => `Prüfbefehl: ${m[1]}`],

  // details of the automatic checks
  [/^([0-9a-f]{6,12}) · (\d+) files$/, (m) => `${m[1]} · ${files(m[2])}`],
  [/^snapshot object missing$/, () => "Der gesicherte Stand fehlt"],
  [/^node has no file snapshot$/, () => "Zu diesem Schritt gibt es keinen gesicherten Stand"],
  [/^(\d+) file claim\(s\) confirmed$/, (m) => `${m[1] === "1" ? "1 genannte Datei" : `${m[1]} genannte Dateien`} vorhanden`],
  [/^missing: (.+)$/, (m) => `Fehlt: ${m[1]}`],
  [/^option \+ rationale recorded$/, () => "Wahl und Begründung aufgezeichnet"],
  [/^no option chosen yet$/, () => "Noch keine Option gewählt"],
  [/^rationale missing$/, () => "Begründung fehlt"],
  [/^no context recorded \(why did this decision come up\?\)$/, () => "Kein Zusammenhang aufgezeichnet (warum kam diese Entscheidung auf?)"],
  [/^link to the main goal missing \(servesGoal\)$/, () => "Bezug zum Hauptziel fehlt"],
  [/^context \+ goal link recorded$/, () => "Zusammenhang und Bezug zum Hauptziel aufgezeichnet"],
  [/^low confidence \((\d+) %\)$/, (m) => `Geringe Sicherheit (${m[1]} %)`],
  [/^(\d+) changed file\(s\) with outputs$/, (m) => `${m[1] === "1" ? "1 geänderte Datei" : `${m[1]} geänderte Dateien`} mit Beschreibung`],
  [/^files changed but no outputs documented$/, () => "Dateien geändert, aber nichts dazu beschrieben"],
  [/^rewind cannot undo: (.+)$/, (m) => `Zurückgehen macht das nicht rückgängig: ${m[1]}`],
  [/^skipped — only runs when the node is HEAD and the working tree matches its snapshot$/, () => "Übersprungen – läuft nur auf dem aktuellen Schritt und wenn die Dateien seinem Stand entsprechen"],
  [/^skipped — the verify command comes from the project's config.*$/, () => "Übersprungen – den Prüfbefehl startest nur du, am Terminal: scenaria verify --run"],
  [/^exit 0$/, () => "Erfolgreich beendet"],
  [/^exit (\w+) · ([\s\S]*)$/, (m) => `Beendet mit Fehler (${m[1]}) · ${m[2]}`],

  // reasons of the gate (rules & milestones)
  [/^not yet proven on this line: (.+?) \(run the canon checks on this line, or confirm them in the dashboard\)$/, (m) => `Auf dieser Linie noch nicht bewiesen: ${m[1]} (führe die Prüfungen auf dieser Linie aus oder bestätige sie hier)`],
  [/^check result of canon (.+?) was changed outside Scenaria — run the check again$/, (m) => `Das Prüfergebnis von ${m[1]} wurde außerhalb von Scenaria verändert – führe die Prüfung noch einmal aus`],
  [/^approved canon (.+?) is missing from canon\.json \(deleted outside Scenaria\)$/, (m) => `Freigegebene Regel ${m[1]} fehlt (außerhalb von Scenaria gelöscht)`],
  [/^canon (.+?) changed outside Scenaria — not binding until re-approved$/, (m) => `${m[1]} wurde außerhalb von Scenaria verändert – gilt erst wieder nach deiner Freigabe`],
  [/^canon (.+?) signed by an untrusted approver key — not binding until re-approved or the key is trusted$/, (m) => `${m[1]} wurde mit einem unbekannten Schlüssel freigegeben – gilt erst nach deiner Freigabe oder wenn du dem Schlüssel vertraust`],

  // the list of AIs in the settings
  [/^(.+) \(global, by hand\)$/, (m) => `${m[1]} (gilt für alle Projekte; Eintrag von Hand, siehe Hilfe „Agenten verbinden“)`],

  // answers of the server people run into
  [/^No model configured — choose one in Settings\.$/, () => "Noch kein Modell eingerichtet – wähle eines in den Einstellungen."],

  // entries of the technical log
  [/^approval link opened in the default browser \(asked by a client marked as the dashboard(?:; user agent: [^)]*)?\)?.*$/, () => "Freigabe-Fenster im Standard-Browser geöffnet (angefragt vom Dashboard)"],
  [/^approval link opened in the default browser \(asked by (.+?), not marked as the dashboard.*$/, (m) => `Freigabe-Fenster im Standard-Browser geöffnet (angefragt von ${m[1]}, nicht vom Dashboard)`],
  [/^agents connected by (.+?): (.+)$/, (m) => `KI verbunden von ${m[1]}: ${m[2]}`],
  [/^settings changed by (.+?) \(models\/agents\)$/, (m) => `Einstellungen geändert von ${m[1]} (Modelle/Agenten)`],
  [/^default model set to (.+?) by (.+)$/, (m) => `Standard-Modell auf ${m[1]} gesetzt von ${m[2]}`],
  [/^start icon created by (.+)$/, (m) => `Start-Symbol angelegt von ${m[1]}`],
  [/^auditor mode started in a browser \(read-only, 8 h\)$/, () => "Prüfermodus in einem Browser gestartet (nur lesen, 8 Stunden)"],
  [/^auditor mode ended in a browser$/, () => "Prüfermodus in einem Browser beendet"],
  [/^auditor mode ended in a browser \(an approval link was opened there; no approval given\)$/, () => "Prüfermodus in einem Browser beendet (dort wurde ein Freigabe-Link geöffnet; keine Freigabe erteilt)"],
  [/^the config of \.scenaria\/shadow\.git held settings Scenaria never writes.*$/, () => "Die Konfiguration des Schattenarchivs enthielt fremde Einstellungen (außerhalb von Scenaria geändert); sie wurden entfernt, bevor git lief"],
  [/^rule (r\d+) added: (.+)$/, (m) => `Regel ${m[1]} hinzugefügt: ${m[2]}`],
  [/^(k\d+) proposed \((past|future)\): (.+)$/, (m) => `${m[1]} vorgeschlagen (${m[2] === "past" ? "Vergangenheit" : "Zukunft"}): ${m[3]}`],
  [/^(k\d+) added \((past|future)\): (.+)$/, (m) => `${m[1]} hinzugefügt (${m[2] === "past" ? "Vergangenheit" : "Zukunft"}): ${m[3]}`],
  [/^(k\d+) approved(.*)$/, (m) => `${m[1]} freigegeben${m[2]}`],
  [/^(k\d+) rejected(.*)$/, (m) => `${m[1]} abgelehnt${m[2]}`],
  [/^(k\d+) retired(.*)$/, (m) => `${m[1]} ausgemustert${m[2]}`],
  [/^canon checks: (.+)$/, (m) => `Prüfungen der Regeln: ${m[1].replace(/\bpassed\b/g, "bestanden").replace(/\bfailed\b/g, "nicht bestanden")}`],
];

/** The kinds of entries in the technical log. */
const EVENT_DE: Record<string, string> = {
  init: "Projekt angelegt",
  mission: "Aufgabe",
  decision: "Entscheidung",
  choose: "Wahl",
  checkpoint: "Stand gesichert",
  branch: "Anderer Weg",
  autosave: "Automatisch gesichert",
  rewind: "Zurückgegangen",
  verify: "Prüfung",
  update: "Hinweis",
  messages: "Unterhaltung",
  goal: "Ziel",
  migrate: "Umstellung",
  rule: "Regel",
  analysis: "Analyse",
  canon: "Regeln & Meilensteine",
};

const VERDICT_DE: Record<string, string> = { passed: "bestanden", failed: "nicht bestanden", warning: "mit Hinweis" };

/** A text the engine wrote, in the reader's language where Scenaria knows it. */
export function localizeEngineText(text: string | null | undefined, lang: Lang): string {
  const s = text ?? "";
  if (lang !== "de" || !s) return s;
  for (const [re, to] of WHOLE) {
    const m = re.exec(s);
    // Who did it is recorded as "(local approval link)" / "(team approver link)": say that in German too.
    if (m) return to(m).replace("(local approval link)", "(lokale Freigabe)").replace("(team approver link)", "(Team-Freigabe)");
  }
  return s;
}

/** Several reasons joined by " · " or "; " (the gate, the check details). */
export function localizeEngineList(texts: readonly string[], lang: Lang): string[] {
  return texts.map((t) => localizeEngineText(t, lang));
}

/** The kind of a log entry ("checkpoint", "rewind", …) in the reader's language. */
export function localizeEventType(type: string, lang: Lang): string {
  return lang === "de" ? EVENT_DE[type] ?? type : type;
}

/** A verdict word of the log ("passed", "failed", "warning"). */
export function localizeVerdict(status: string, lang: Lang): string {
  return lang === "de" ? VERDICT_DE[status] ?? status : status;
}
