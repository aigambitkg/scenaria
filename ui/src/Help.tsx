/**
 * Help ("?") and onboarding. The help explains every function in plain words (from helpContent.ts);
 * the onboarding is a short first-run tour with live status that can be skipped and restarted.
 * Progress of the tour lives only in this browser (localStorage, guarded) — never in the project.
 */
import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Dialogs";
import { HELP, type HelpAction, type HelpTopic } from "./helpContent";
import type { Dict } from "./i18n";
import { TOUR } from "./tourText";

/** Help topics about functions the dashboard shows only once a language model is set up. */
export const NEEDS_MODEL = new Set(["forecasts", "forecast-check", "chat", "relay"]);

const ONBOARDED = "scenaria.onboarded.v1";
export function onboardingDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDED) === "1";
  } catch {
    return true; // no storage (private mode, preview): never nag
  }
}
function setOnboardingDone(v: boolean) {
  try {
    if (v) localStorage.setItem(ONBOARDED, "1");
    else localStorage.removeItem(ONBOARDED);
  } catch {
    /* ignore */
  }
}

function Topic({ t, x, open, onAction }: { t: Dict; x: HelpTopic; open: boolean; onAction: (a: HelpAction) => void }) {
  return (
    <details className="help-topic" open={open} id={`help-${x.id}`}>
      <summary>{x.title}</summary>
      <div className="help-body">
        <p>{x.what}</p>
        {x.when && (
          <p>
            <strong>{t.helpWhen}</strong> {x.when}
          </p>
        )}
        {x.how && (
          <>
            <h5>{t.helpHow}</h5>
            <ol>
              {x.how.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </>
        )}
        {x.example && (
          <p className="help-example">
            <strong>{t.helpExample}</strong> {x.example}
          </p>
        )}
        {x.terms && (
          <dl className="help-terms">
            {x.terms.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {x.notes && (
          <ul className="help-notes">
            {x.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        {x.open && (
          <button className="btn" onClick={() => onAction(x.open!.action)}>
            → {x.open.label}
          </button>
        )}
      </div>
    </details>
  );
}

export function HelpDialog(props: { t: Dict; lang: "de" | "en"; topic?: string | null; hasModel?: boolean; onClose: () => void; onAction: (a: HelpAction) => void }) {
  const { t } = props;
  const x = TOUR[props.lang];
  const [q, setQ] = useState("");
  // Topics about functions that need a language model say so in their title while none is set up.
  const topics = useMemo(() => HELP[props.lang].map((h) => (!props.hasModel && NEEDS_MODEL.has(h.id) ? { ...h, title: `${h.title} ${t.needsModelTag}` } : h)), [props.lang, props.hasModel, t]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return topics;
    return topics.filter((x) => JSON.stringify(x).toLowerCase().includes(s));
  }, [q, topics]);
  useEffect(() => {
    if (props.topic) document.getElementById(`help-${props.topic}`)?.scrollIntoView({ block: "start" });
  }, [props.topic]);
  return (
    <Modal wide title={t.helpTitle} onClose={props.onClose}>
      <div className="modal-body help">
        <div className="help-start">
          <p>{x.introHint}</p>
          <button className="btn primary" onClick={() => props.onAction("onboarding")}>
            ▶ {x.startIntro}
          </button>
          <button className="btn" onClick={() => props.onAction("demo")}>
            {x.startDemo}
          </button>
        </div>
        <p className="hint">{t.helpIntro}</p>
        <input className="help-search" type="search" value={q} placeholder={t.helpSearch} aria-label={t.helpSearch} onChange={(e) => setQ(e.target.value)} />
        <nav className="help-index" aria-label={t.helpTitle}>
          {shown.map((x) => (
            <a key={x.id} href={`#help-${x.id}`} onClick={(e) => {
              e.preventDefault();
              const el = document.getElementById(`help-${x.id}`) as HTMLDetailsElement | null;
              if (el) {
                el.open = true;
                el.scrollIntoView({ block: "start", behavior: "smooth" });
              }
            }}>
              {x.title}
            </a>
          ))}
        </nav>
        {!shown.length && <p className="muted">{t.helpNothing}</p>}
        {shown.map((x) => (
          <Topic key={x.id} t={t} x={x} open={Boolean(q.trim()) || x.id === (props.topic ?? "start")} onAction={props.onAction} />
        ))}
      </div>
    </Modal>
  );
}

/** The introduction itself is Tour.tsx; this file only remembers, in this browser, whether it was seen. */
export function markOnboardingDone() {
  setOnboardingDone(true);
}

export function restartOnboarding() {
  setOnboardingDone(false);
}
