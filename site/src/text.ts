/**
 * Texts of the landing page — German and English, the same keys in both. Few words on purpose:
 * the page shows what Scenaria does (the drawings, the live example) instead of describing it.
 * Only claims the product keeps today; limits are said where they matter (see docs/KNOWN-LIMITS.md).
 */
import type { Lang } from "../../ui/src/i18n";

export const LINKS = {
  repo: "https://github.com/aigambitkg/scenaria",
  guide: { de: "https://github.com/aigambitkg/scenaria/blob/main/docs/GUIDE.de.md", en: "https://github.com/aigambitkg/scenaria/blob/main/docs/GUIDE.md" },
  limits: "https://github.com/aigambitkg/scenaria/blob/main/docs/KNOWN-LIMITS.md",
  security: "https://github.com/aigambitkg/scenaria/blob/main/SECURITY.md",
  maker: "https://ai-gambit.com",
  imprint: "https://ai-gambit.com/impressum",
  privacy: "https://ai-gambit.com/datenschutz",
} as const;

/** Works today for everyone with git and Node.js 20 or newer (no release needed). */
export const INSTALL = ["git clone https://github.com/aigambitkg/scenaria", "cd scenaria && npm install && npm run build && npm link", "cd ~/dein-projekt && scenaria start"];
export const INSTALL_EN = [...INSTALL.slice(0, 2), "cd ~/your-project && scenaria start"];

export interface SiteText {
  title: string;
  nav: { try: string; how: string; start: string; github: string };
  heroTitle: [string, string];
  heroText: string;
  heroTry: string;
  heroGithub: string;
  facts: [string, string, string];
  demoTitle: string;
  demoText: string;
  demoFrame: string;
  demoLoading: string;
  howTitle: string;
  how: [{ title: string; text: string }, { title: string; text: string }, { title: string; text: string }];
  forTitle: string;
  forWhom: [{ who: string; what: string }, { who: string; what: string }, { who: string; what: string }];
  startTitle: string;
  startText: string;
  startNeeds: string;
  copy: string;
  copied: string;
  startGithub: string;
  startGuide: string;
  status: string;
  statusLink: string;
  foot: { license: string; by: string; imprint: string; privacy: string; security: string; noTracking: string };
}

const de: SiteText = {
  title: "Scenaria – Speicherpunkte für die Arbeit deiner KI",
  nav: { try: "Ausprobieren", how: "So funktioniert es", start: "Loslegen", github: "GitHub" },
  heroTitle: ["Deine KI arbeitet.", "Scenaria merkt sich jeden Stand."],
  heroText: "Du siehst, was sie getan hat, und gehst mit einem Klick zurück. Und wieder vor, wenn du es dir anders überlegst.",
  heroTry: "Jetzt ausprobieren",
  heroGithub: "Auf GitHub ansehen",
  facts: ["Mit jeder KI", "Bleibt auf deinem Rechner", "Open Source, kostenlos"],
  demoTitle: "Probier es aus",
  demoText: "Das ist die echte Oberfläche mit einem erfundenen Projekt. Nichts wird installiert, nichts gespeichert.",
  demoFrame: "Beispielprojekt: Website für eine Bäckerei",
  demoLoading: "Beispiel wird geladen …",
  howTitle: "So funktioniert es",
  how: [
    { title: "Sichern", text: "Nach jedem Schritt der KI. Von selbst." },
    { title: "Nachsehen", text: "Jeder Stand in einem Satz: Auftrag, Ergebnis, geänderte Dateien." },
    { title: "Nur du gibst frei", text: "Sagt die KI „geprüft“, zählt das nicht. Erst dein Urteil zählt, und es ist signiert." },
  ],
  forTitle: "Für wen",
  forWhom: [
    { who: "Für die Arbeit im Büro", what: "Angebote, Texte, Tabellen mit KI bearbeiten, ohne Angst vor dem falschen Klick." },
    { who: "Für KI-Verantwortliche", what: "Ein Verlauf über alle Werkzeuge und Modelle statt einer Historie pro Tool." },
    { who: "Für Prüfungen", what: "Die Aufzeichnung, geordnet nach den Kontrollen der ISO/IEC 42001. Ein Nachweis, kein Zertifikat." },
  ],
  startTitle: "Loslegen",
  startText: "Drei Zeilen im Terminal. Danach öffnet sich Scenaria im Browser und führt dich durch die ersten Schritte.",
  startNeeds: "Du brauchst git und Node.js ab Version 20.",
  copy: "Kopieren",
  copied: "Kopiert",
  startGithub: "Zum Projekt auf GitHub",
  startGuide: "Handbuch lesen",
  status: "Öffentliche Vorschau (0.9). Die automatischen Tests laufen auf macOS, Linux und Windows; auf Windows ist Scenaria am jüngsten. Noch nicht von Dritten geprüft.",
  statusLink: "Was Scenaria nicht kann",
  foot: { license: "MIT-Lizenz", by: "Ein Projekt von AI Gambit", imprint: "Impressum", privacy: "Datenschutz", security: "Sicherheit", noTracking: "Diese Seite setzt keine Cookies und lädt nichts von fremden Servern." },
};

const en: SiteText = {
  title: "Scenaria – save points for your AI's work",
  nav: { try: "Try it", how: "How it works", start: "Get started", github: "GitHub" },
  heroTitle: ["Your AI works.", "Scenaria remembers every state."],
  heroText: "You see what it did, and you go back with one click. And forward again if you change your mind.",
  heroTry: "Try it now",
  heroGithub: "View on GitHub",
  facts: ["With any AI", "Stays on your computer", "Open source, free"],
  demoTitle: "Try it",
  demoText: "This is the real interface with an invented project. Nothing is installed, nothing is stored.",
  demoFrame: "Example project: a website for a bakery",
  demoLoading: "Loading the example …",
  howTitle: "How it works",
  how: [
    { title: "Save", text: "After every step of the AI. By itself." },
    { title: "Look", text: "Every state in one sentence: request, result, changed files." },
    { title: "Only you approve", text: "When the AI says “checked”, it does not count. Only your verdict counts, and it is signed." },
  ],
  forTitle: "Who it is for",
  forWhom: [
    { who: "For office work", what: "Edit offers, texts and tables with AI without fear of the wrong click." },
    { who: "For people responsible for AI", what: "One history across all tools and models instead of one per tool." },
    { who: "For audits", what: "The record, ordered by the controls of ISO/IEC 42001. Evidence, not a certificate." },
  ],
  startTitle: "Get started",
  startText: "Three lines in the terminal. Then Scenaria opens in your browser and walks you through the first steps.",
  startNeeds: "You need git and Node.js 20 or newer.",
  copy: "Copy",
  copied: "Copied",
  startGithub: "The project on GitHub",
  startGuide: "Read the guide",
  status: "Public preview (0.9). The automated tests run on macOS, Linux and Windows; Windows support is the newest. Not yet audited by a third party.",
  statusLink: "What Scenaria does not do",
  foot: { license: "MIT License", by: "A project by AI Gambit", imprint: "Imprint", privacy: "Privacy", security: "Security", noTracking: "This page sets no cookies and loads nothing from other servers." },
};

export const SITE: Record<Lang, SiteText> = { de, en };
