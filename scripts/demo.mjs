#!/usr/bin/env node
// Builds a realistic demo project with a decision tree, a hallucinated step,
// a rewind and an explored alternative. Usage: npm run demo [-- <dir>] [--lang en]
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { Scenaria } from "../dist/core/index.js";

const args = process.argv.slice(2);
const en = args.includes("--lang") && args[args.indexOf("--lang") + 1] === "en";
const dir = resolve(args.find((a) => !a.startsWith("--") && a !== "en" && a !== "de") ?? "scenaria-demo");
if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const w = (p, c) => {
  mkdirSync(dirname(join(dir, p)), { recursive: true });
  writeFileSync(join(dir, p), c);
};
const L = (de, e) => (en ? e : de);

w("README.md", L("# Kontaktformular\n", "# Contact form\n"));
w(".gitignore", "node_modules/\n");

const s = Scenaria.init(dir);
// Mixed vendors on purpose: Scenaria is model-agnostic.
const agent = { agent: "claude-code", model: "claude-opus-5-5", user: "kev", source: "mcp" };
const altAgent = { agent: "cursor", model: "gpt-5", user: "kev", source: "mcp" };

s.startMission({
  title: L("Kontaktformular mit Mailversand", "Contact form with email delivery"),
  goal: L(
    "Ein DSGVO-konformes Kontaktformular für die Website, das Anfragen zuverlässig per Mail an das Vertriebsteam schickt.",
    "A GDPR-compliant contact form for the website that reliably emails enquiries to the sales team.",
  ),
  brief: L(
    "Kunde: Bäckerei Sonnenkorn. Formular mit Name, E-Mail, Nachricht, Einwilligung. Versand an vertrieb@sonnenkorn.example. Keine Cookies.",
    "Client: Sonnenkorn bakery. Form with name, email, message, consent. Deliver to sales@sonnenkorn.example. No cookies.",
  ),
  ...agent,
});

const chatA = { externalId: "demo-claude", source: "transcript", provider: "anthropic", model: "claude-opus-5-5", agent: "claude-code" };
s.logMessages(chatA, [
  { role: "user", text: L("Baue ein DSGVO-konformes Kontaktformular für Sonnenkorn, Versand an den Vertrieb.", "Build a GDPR-compliant contact form for Sonnenkorn that emails sales.") },
  { role: "assistant", text: L("Ich schlage Astro vor: statische Seite, kaum JavaScript. Soll ich so starten?", "I suggest Astro: static site, minimal JavaScript. Shall I start that way?") },
  { role: "user", text: L("Ja, los.", "Yes, go ahead.") },
]);
s.decide({
  question: L("Welches Framework für die Website?", "Which framework for the website?"),
  options: [
    { label: "Next.js", description: L("Voller React-Stack, SSR", "Full React stack, SSR") },
    { label: "Astro", description: L("Statisch, minimal JS", "Static, minimal JS") },
    { label: "Plain HTML", description: L("Kein Build-Schritt", "No build step") },
  ],
  chosen: "Astro",
  rationale: L("Statische Seite, kaum Interaktion, schnelles Hosting", "Static site, little interactivity, cheap hosting"),
  assumptions: [L("Hosting unterstützt statische Seiten", "Hosting supports static sites")],
  confidence: 0.8,
  ...agent,
});

w("package.json", '{ "name": "sonnenkorn", "dependencies": { "astro": "^5" } }\n');
w("src/pages/index.astro", "<h1>Sonnenkorn</h1>\n");
w("src/layouts/Base.astro", "<html><body><slot /></body></html>\n");
s.checkpoint({
  title: L("Astro-Grundgerüst steht", "Astro skeleton in place"),
  outputs: [L("Layout in `src/layouts/Base.astro`", "Layout in `src/layouts/Base.astro`"), L("Startseite `src/pages/index.astro`", "Home page `src/pages/index.astro`")],
  facts: [L("Astro 5 als Abhängigkeit in `package.json`", "Astro 5 declared in `package.json`")],
  ...agent,
});

s.decide({
  question: L("Wie werden die Anfragen verschickt?", "How are enquiries delivered?"),
  options: [
    { label: L("n8n-Webhook", "n8n webhook"), description: L("Workflow verschickt die Mail", "Workflow sends the email") },
    { label: "Resend API", description: L("Transaktionsmail-Dienst", "Transactional email service") },
    { label: "SMTP (Nodemailer)", description: L("Eigener Mailserver", "Own mail server") },
  ],
  chosen: 1,
  rationale: L("Kunde nutzt n8n bereits für andere Abläufe", "Client already runs n8n for other workflows"),
  confidence: 0.55,
  ...agent,
});

s.logMessages(chatA, [
  { role: "assistant", text: L("Für den Versand nehme ich den n8n-Webhook, weil ihr n8n schon nutzt. In welchen Sprachen soll das Formular erscheinen?", "For delivery I'll use the n8n webhook since you already run n8n. Which languages should the form support?") },
  { role: "user", text: L("Deutsch und Englisch bitte.", "German and English, please.") },
]);
s.decide({
  question: L("In welchen Sprachen soll das Formular erscheinen?", "Which languages should the form support?"),
  title: L("Sprache: Formularsprache", "Language: form language"),
  options: [{ label: L("Nur Deutsch", "German only") }, { label: L("Deutsch und Englisch", "German and English") }],
  chosen: 2,
  rationale: L("Antwort der Nutzerin", "Answered by the user"),
  agent: "user",
  source: "hook",
  tags: ["clarifying-question"],
});

w("src/pages/kontakt.astro", "<form method=post action=/api/contact>…</form>\n");
w("src/lib/webhook.ts", "export async function send(data){ return fetch(import.meta.env.N8N_URL,{method:'POST',body:JSON.stringify(data)}) }\n");
w("src/i18n/de.json", '{ "send": "Absenden" }\n');
w("src/i18n/en.json", '{ "send": "Send" }\n');
const good = s.checkpoint({
  title: L("Formular und Webhook-Anbindung", "Form and webhook wiring"),
  outputs: [
    L("Formular in `src/pages/kontakt.astro`", "Form in `src/pages/kontakt.astro`"),
    L("Webhook-Client in `src/lib/webhook.ts`", "Webhook client in `src/lib/webhook.ts`"),
    L("Texte DE/EN in `src/i18n/de.json` und `src/i18n/en.json`", "Copy DE/EN in `src/i18n/de.json` and `src/i18n/en.json`"),
  ],
  facts: [L("Webhook-URL kommt aus der Umgebungsvariable N8N_URL", "Webhook URL comes from env var N8N_URL")],
  openQuestions: [L("Wer pflegt den n8n-Workflow beim Kunden?", "Who maintains the n8n workflow at the client?")],
  ...agent,
});
s.verify(good.id, { status: "passed", notes: L("Dateien und Webhook-Aufruf geprüft", "Files and webhook call checked"), by: "gemini-cli (verifier)" });

// The agent hallucinates: claims a captcha module and a sent test mail.
w("src/pages/kontakt.astro", "<form method=post action=/api/contact data-captcha>…</form>\n");
const bad = s.checkpoint({
  title: L("Spam-Schutz ergänzt", "Spam protection added"),
  outputs: [
    L("Captcha-Prüfung in `src/lib/captcha.ts`", "Captcha check in `src/lib/captcha.ts`"),
    L("Formular nutzt das Captcha", "Form uses the captcha"),
  ],
  facts: [L("Testmail erfolgreich zugestellt", "Test email delivered successfully")],
  irreversible: [L("Testanfrage an den Live-Webhook gesendet", "Test request sent to the live webhook")],
  ...agent,
});
s.verify(bad.id, {
  status: "failed",
  notes: L(
    "`src/lib/captcha.ts` existiert nicht, Zustellung der Testmail ist nicht belegt.",
    "`src/lib/captcha.ts` does not exist, the test email delivery is not evidenced.",
  ),
  by: "gemini-cli (verifier)",
});

// Back to the last good node, with a lesson.
s.rewind(good.id, {
  lesson: L("Captcha-Modul wurde halluziniert – erst Datei anlegen, dann behaupten", "Captcha module was hallucinated — create the file before claiming it"),
  ...agent,
});

// Explore the alternative delivery path.
const decisionId = s.store.listNodes().find((n) => n.type === "decision" && n.options?.some((o) => o.label === "Resend API")).id;
const fork = s.fork(decisionId, "Resend API", {
  lesson: L("Kunde möchte keinen eigenen n8n-Betrieb übernehmen", "Client does not want to operate n8n themselves"),
  ...altAgent,
});
s.logMessages({ externalId: "demo-cursor", source: "proxy", provider: "openai", model: "gpt-5", agent: "cursor" }, [
  { role: "user", text: L("Probier die Variante mit Resend statt n8n.", "Try the Resend variant instead of n8n.") },
  { role: "assistant", text: L("Erledigt: API-Route mit Resend, Schlüssel nur serverseitig.", "Done: API route with Resend, key server-side only."), toolCalls: [{ name: "scenaria_checkpoint" }] },
]);
w("src/pages/kontakt.astro", "<form method=post action=/api/contact>…</form>\n");
w("src/pages/api/contact.ts", "import { Resend } from 'resend'; export const POST = async () => new Response('ok');\n");
const alt = s.checkpoint({
  title: L("Versand über Resend", "Delivery via Resend"),
  outputs: [L("API-Route `src/pages/api/contact.ts`", "API route `src/pages/api/contact.ts`"), L("Formular `src/pages/kontakt.astro`", "Form `src/pages/kontakt.astro`")],
  facts: [L("Resend-Schlüssel nur serverseitig", "Resend key server-side only")],
  ...altAgent,
});
s.verify(alt.id, { by: "scenaria-auto" });
s.writeProtocol();

console.log(`Demo project ready: ${dir}`);
console.log(`Branch ${fork.branch.id} explores "Resend API". Open the map:`);
console.log(`  scenaria ui --root "${dir}"`);
