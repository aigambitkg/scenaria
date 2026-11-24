/**
 * The landing page. Its layout is the product's own picture: one line down the page with a mark for every
 * section, like the history in the Simple view — and the second mark IS the Simple view, live, on an example.
 * The drawings are the ones of the introduction (ui/src/TourArt.tsx), the example is the dashboard's own
 * (ui/src/Demo.tsx): what people see here is what they get.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { dict, type Lang } from "../../ui/src/i18n";
import { ArtBack, ArtLock, ArtLook, ArtSave } from "../../ui/src/TourArt";
import { TOUR } from "../../ui/src/tourText";
import { INSTALL, INSTALL_EN, LINKS, SITE } from "./text";

// The example brings the whole Simple view with it: loaded after the page is readable.
const DemoStage = lazy(() => import("../../ui/src/Demo").then((m) => ({ default: m.DemoStage })));

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem("scenaria.site.lang");
    if (saved === "de" || saved === "en") return saved;
  } catch {}
  return (navigator.language || "de").toLowerCase().startsWith("de") ? "de" : "en";
}

function Mark() {
  return (
    <svg className="brand-svg" viewBox="0 0 32 32" width="26" height="26" aria-hidden>
      <rect x="2" y="12" width="9" height="8" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="21" y="4" width="9" height="8" fill="var(--marker-solid)" stroke="currentColor" strokeWidth="2" />
      <rect x="21" y="20" width="9" height="8" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M11 16 21 8M11 16l10 8" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function Landing() {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const s = SITE[lang];
  const x = TOUR[lang];
  const t = dict[lang];
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("scenaria.site.lang", l);
    } catch {}
  };
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = s.title;
  }, [lang, s.title]);

  // Messages of the example ("Back at the state of …" with Undo), shown like in the dashboard.
  const [toasts, setToasts] = useState<{ id: number; msg: string; action?: { label: string; run: () => void } }[]>([]);
  const toastId = useRef(0);
  const toast = useCallback((msg: string, action?: { label: string; run: () => void }) => {
    const id = ++toastId.current;
    setToasts((l) => [...l, { id, msg, action }]);
    setTimeout(() => setToasts((l) => l.filter((y) => y.id !== id)), action ? 14000 : 4500);
  }, []);

  const [copied, setCopied] = useState(false);
  const install = lang === "de" ? INSTALL : INSTALL_EN;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(install.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* the lines can be marked and copied by hand */
    }
  };
  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  };

  return (
    <div className="site">
      <header className="site-top">
        <a className="site-brand" href="#top" onClick={go("top")}>
          <Mark />
          <span>Scenaria</span>
        </a>
        <nav aria-label="Seite">
          <a href="#try" onClick={go("try")}>{s.nav.try}</a>
          <a href="#how" onClick={go("how")}>{s.nav.how}</a>
          <a href="#start" onClick={go("start")}>{s.nav.start}</a>
          <a href={LINKS.repo}>{s.nav.github}</a>
        </nav>
        <div className="lang" role="group" aria-label="Language">
          <button className={lang === "de" ? "on" : ""} aria-pressed={lang === "de"} onClick={() => setLang("de")}>DE</button>
          <button className={lang === "en" ? "on" : ""} aria-pressed={lang === "en"} onClick={() => setLang("en")}>EN</button>
        </div>
      </header>

      <main className="line" id="top">
        <section className="stop hero">
          <div className="hero-text">
            <h1>
              <span>{s.heroTitle[0]}</span> <span>{s.heroTitle[1]}</span>
            </h1>
            <p className="lead">{s.heroText}</p>
            <p className="cta">
              <a className="btn primary big" href="#try" onClick={go("try")}>{s.heroTry}</a>
              <a className="btn big" href={LINKS.repo}>{s.heroGithub}</a>
            </p>
            <ul className="facts">
              {s.facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
          <div className="hero-art">
            <ArtBack x={x} />
          </div>
        </section>

        <section className="stop now" id="try" aria-labelledby="try-h">
          <h2 id="try-h">{s.demoTitle}</h2>
          <p className="sub">{s.demoText}</p>
          <div className="window">
            <div className="window-bar">
              <i /><i /><i />
              <span>{s.demoFrame}</span>
            </div>
            <div className="window-body" role="region" aria-label={s.demoFrame} tabIndex={0}>
              <Suspense fallback={<p className="window-wait">{s.demoLoading}</p>}>
                <DemoStage t={t} lang={lang} toast={toast} embedded key={lang} />
              </Suspense>
            </div>
          </div>
        </section>

        <section className="stop" id="how" aria-labelledby="how-h">
          <h2 id="how-h">{s.howTitle}</h2>
          <ol className="how">
            {[<ArtSave x={x} key="a" />, <ArtLook x={x} key="b" />, <ArtLock x={x} key="c" />].map((art, i) => (
              <li key={i}>
                {art}
                <h3>{s.how[i].title}</h3>
                <p>{s.how[i].text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="stop" aria-labelledby="for-h">
          <h2 id="for-h">{s.forTitle}</h2>
          <dl className="for">
            {s.forWhom.map((f) => (
              <div key={f.who}>
                <dt>{f.who}</dt>
                <dd>{f.what}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="stop last" id="start" aria-labelledby="start-h">
          <h2 id="start-h">{s.startTitle}</h2>
          <p className="sub">{s.startText}</p>
          <div className="term">
            <pre>
              <code>{install.join("\n")}</code>
            </pre>
            <button className="btn" onClick={copy} aria-live="polite">
              {copied ? `✓ ${s.copied}` : s.copy}
            </button>
          </div>
          <p className="needs">{s.startNeeds}</p>
          <p className="cta">
            <a className="btn primary big" href={LINKS.repo}>{s.startGithub}</a>
            <a className="btn big" href={LINKS.guide[lang]}>{s.startGuide}</a>
          </p>
          <p className="status">
            {s.status} <a href={LINKS.limits}>{s.statusLink}</a>
          </p>
        </section>
      </main>

      <footer className="site-foot">
        <span>{s.foot.license}</span>
        <a href={LINKS.maker}>{s.foot.by}</a>
        <a href={LINKS.security}>{s.foot.security}</a>
        <a href={LINKS.imprint}>{s.foot.imprint}</a>
        <a href={LINKS.privacy}>{s.foot.privacy}</a>
        <span className="quiet">{s.foot.noTracking}</span>
      </footer>

      <div className="toasts" aria-live="polite">
        {toasts.map((y) => (
          <div key={y.id} className="toast">
            <span>{y.msg}</span>
            {y.action && (
              <button
                className="btn"
                onClick={() => {
                  setToasts((l) => l.filter((z) => z.id !== y.id));
                  y.action!.run();
                }}
              >
                {y.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
