/**
 * Texts of the introduction and of the example to try out — German and English, the same keys in both.
 * Plain words on purpose: the introduction explains only what works for everyone from the first minute
 * (saving, looking, going back, who approves). Everything else is in the help ("?").
 */
import type { Lang } from "./i18n";

export interface TourText {
  title: string;
  stepOf: (i: number, n: number) => string;
  skip: string;
  back: string;
  next: string;
  done: string;
  /** Buttons that start the introduction and the example from the help and the Simple view. */
  startIntro: string;
  startDemo: string;
  introHint: string;

  s1Title: string;
  s1Text: string;
  s1Points: [string, string, string];
  s1Art: { ai: string; files: string; saved: string; caption: string };

  s2Title: string;
  s2Text: string;
  s2Art: { asked: string; askedText: string; did: string; didText: string; files: string; filesText: string; button: string };

  s3Title: string;
  s3Text: string;
  s3Art: { now: string; back: string; undo: string; kept: string };

  s4Title: string;
  s4Text: string;
  s4Points: [string, string, string];
  s4Art: { locked: string; open: string; you: string; ai: string };

  s5Title: string;
  s5Text: string;
  s5Goal: string;
  s5GoalHint: string;
  s5GoalPlaceholder: string;
  s5GoalSaved: string;
  s5Connect: string;
  s5ConnectHint: string;
  s5ConnectButton: string;
  s5Connected: (names: string) => string;
  s5Demo: string;
  s5DemoHint: string;
  s5More: string;

  demoBand: string;
  demoBandText: string;
  demoEnd: string;
  demoTry: string;
  demoTasks: [string, string, string];
  demoAllDone: string;
  demoRestart: string;
  demoNoFolder: string;
  demoNoDiff: string;
  demoNoGoal: string;
  demoProject: string;
}

const de: TourText = {
  title: "Einführung",
  stepOf: (i, n) => `Schritt ${i} von ${n}`,
  skip: "Überspringen",
  back: "Zurück",
  next: "Weiter",
  done: "Fertig",
  startIntro: "Einführung ansehen",
  startDemo: "Am Beispiel ausprobieren",
  introHint: "Neu hier? Die Einführung zeigt in fünf Bildern, wofür Scenaria da ist. Du kannst sie jederzeit wieder starten.",

  s1Title: "Ein Speicherpunkt für alles, was deine KI tut",
  s1Text: "Wenn eine KI an deinen Dateien arbeitet, sichert Scenaria nach jedem Schritt den Stand – wie ein Speicherpunkt in einem Spiel.",
  s1Points: ["Du musst nichts tun: Gesichert wird von selbst.", "Es funktioniert mit jeder KI: Claude, ChatGPT, Copilot, Gemini und anderen.", "Alles bleibt auf deinem Rechner."],
  s1Art: { ai: "Deine KI arbeitet", files: "an deinen Dateien", saved: "Stand gesichert", caption: "Jeder Punkt ist ein gesicherter Stand." },

  s2Title: "Sehen, was die KI gemacht hat",
  s2Text: "In der Ansicht „Einfach“ steht jeder Stand in einem Satz, das Neueste oben. Ein Klick auf „Was hat die KI gemacht?“ zeigt die Einzelheiten.",
  s2Art: { asked: "Auftrag", askedText: "„Baue ein Kontaktformular.“", did: "Ergebnis", didText: "Formular angelegt", files: "Geänderte Dateien", filesText: "kontakt.html (neu)", button: "Was hat die KI gemacht?" },

  s3Title: "Zurück zu jedem Stand – und wieder vor",
  s3Text: "Hat die KI etwas kaputt gemacht? „Zurück zu diesem Stand“ setzt deine Dateien genau dorthin zurück. Was du gerade hattest, wird vorher gesichert: Mit „Rückgängig“ bist du wieder da.",
  s3Art: { now: "Jetzt", back: "Zurück zu diesem Stand", undo: "Rückgängig", kept: "bleibt gesichert" },

  s4Title: "Nur du gibst frei",
  s4Text: "Manches darf nur ein Mensch: die KI verbinden, etwas als geprüft markieren, Regeln festlegen. Dafür gibt es das Schloss 🔒 oben rechts.",
  s4Points: ["Ein Klick auf das Schloss öffnet ein zweites Browser-Fenster. Dort bist du freigeschaltet.", "Das ist Absicht: Eine KI kann dieses Fenster nicht selbst öffnen.", "Sagt die KI „geprüft“, zählt das nicht. Erst dein Urteil zählt."],
  s4Art: { locked: "gesperrt", open: "freigeschaltet", you: "Du", ai: "KI" },

  s5Title: "Loslegen",
  s5Text: "Zwei Dinge, dann läuft es. Beides kannst du auch später machen.",
  s5Goal: "1. Schreib auf, worum es geht",
  s5GoalHint: "Ein Satz. Er steht dann oben, und Scenaria achtet darauf, ob die KI beim Thema bleibt.",
  s5GoalPlaceholder: "z. B. Angebot für die Müller GmbH fertig machen",
  s5GoalSaved: "Gespeichert",
  s5Connect: "2. Verbinde deine KI",
  s5ConnectHint: "Scenaria öffnet dafür das zweite, freigeschaltete Fenster. Dort wählst du deine KI mit einem Klick. Auch ohne Verbindung wird jede Änderung an deinen Dateien gesichert.",
  s5ConnectButton: "KI verbinden",
  s5Connected: (names) => `Verbunden: ${names}`,
  s5Demo: "Erst einmal ausprobieren?",
  s5DemoHint: "Das Beispiel zeigt ein fertiges Projekt. Du kannst alles anklicken; an deinem Projekt ändert sich nichts.",
  s5More: "Die Ansichten „Prüfung“ und „Steuerung“ zeigen dieselben Daten ausführlicher. Du brauchst sie für den Anfang nicht. Hilfe zu allem gibt es unter „?“.",

  demoBand: "Beispiel zum Ausprobieren",
  demoBandText: "Das ist ein erfundenes Projekt. Klick alles an – an deinem eigenen Projekt und deinen Dateien ändert sich nichts.",
  demoEnd: "Beispiel beenden",
  demoTry: "Probier es aus:",
  demoTasks: ["Klick bei einem Schritt auf „Was hat die KI gemacht?“", "Geh mit „Zurück zu diesem Stand“ zu einem früheren Stand", "Hol dir gleich danach mit „Rückgängig“ (unten links) den Stand von eben zurück"],
  demoAllDone: "Das war schon alles. Genau so funktioniert es in deinem Projekt.",
  demoRestart: "Beispiel neu starten",
  demoNoFolder: "Im Beispiel gibt es keine echten Dateien. In deinem Projekt öffnet sich hier der Ordner mit dem Stand von damals.",
  demoNoDiff: "Im Beispiel gibt es keine echten Dateien. In deinem Projekt siehst du hier, was sich geändert hat.",
  demoNoGoal: "Im Beispiel ist das Ziel fest. In deinem Projekt änderst du es mit einem Klick darauf.",
  demoProject: "Beispiel",
};

const en: TourText = {
  title: "Introduction",
  stepOf: (i, n) => `Step ${i} of ${n}`,
  skip: "Skip",
  back: "Back",
  next: "Next",
  done: "Done",
  startIntro: "Watch the introduction",
  startDemo: "Try it on an example",
  introHint: "New here? The introduction shows in five pictures what Scenaria is for. You can start it again at any time.",

  s1Title: "A save point for everything your AI does",
  s1Text: "When an AI works on your files, Scenaria saves the state after every step — like a save point in a game.",
  s1Points: ["You do not have to do anything: saving happens by itself.", "It works with any AI: Claude, ChatGPT, Copilot, Gemini and others.", "Everything stays on your computer."],
  s1Art: { ai: "Your AI works", files: "on your files", saved: "State saved", caption: "Every dot is a saved state." },

  s2Title: "See what the AI did",
  s2Text: "The Simple view shows every state in one sentence, newest first. A click on “What did the AI do?” shows the details.",
  s2Art: { asked: "Request", askedText: "“Build a contact form.”", did: "Result", didText: "Form created", files: "Changed files", filesText: "contact.html (new)", button: "What did the AI do?" },

  s3Title: "Back to any state — and forward again",
  s3Text: "Did the AI break something? “Back to this state” sets your files exactly to that point. What you had is saved first: “Undo” brings you back.",
  s3Art: { now: "Now", back: "Back to this state", undo: "Undo", kept: "stays saved" },

  s4Title: "Only you approve",
  s4Text: "Some things only a person may do: connect the AI, mark something as checked, set rules. That is what the lock 🔒 at the top right is for.",
  s4Points: ["A click on the lock opens a second browser window. There you are unlocked.", "This is on purpose: an AI cannot open that window itself.", "When the AI says “checked”, it does not count. Only your verdict counts."],
  s4Art: { locked: "locked", open: "unlocked", you: "You", ai: "AI" },

  s5Title: "Get started",
  s5Text: "Two things and it runs. You can do both later as well.",
  s5Goal: "1. Write down what this is about",
  s5GoalHint: "One sentence. It is shown at the top, and Scenaria watches whether the AI stays on topic.",
  s5GoalPlaceholder: "e.g. Finish the offer for Miller Ltd",
  s5GoalSaved: "Saved",
  s5Connect: "2. Connect your AI",
  s5ConnectHint: "For this Scenaria opens the second, unlocked window. There you choose your AI with one click. Without a connection every change to your files is saved as well.",
  s5ConnectButton: "Connect an AI",
  s5Connected: (names) => `Connected: ${names}`,
  s5Demo: "Try it first?",
  s5DemoHint: "The example shows a finished project. You can click everything; nothing changes in your project.",
  s5More: "The views “Audit” and “Manage” show the same data in more detail. You do not need them to begin with. Help on everything is under “?”.",

  demoBand: "Example to try out",
  demoBandText: "This is an invented project. Click anything — nothing changes in your own project or your files.",
  demoEnd: "Leave the example",
  demoTry: "Try it:",
  demoTasks: ["Click “What did the AI do?” on a step", "Go to an earlier state with “Back to this state”", "Right after that, get the state from just now back with “Undo” (bottom left)"],
  demoAllDone: "That is all there is to it. It works exactly like this in your project.",
  demoRestart: "Restart the example",
  demoNoFolder: "The example has no real files. In your project this opens the folder with the state from back then.",
  demoNoDiff: "The example has no real files. In your project you see here what changed.",
  demoNoGoal: "The goal of the example is fixed. In your project you change it with a click on it.",
  demoProject: "Example",
};

export const TOUR: Record<Lang, TourText> = { de, en };
