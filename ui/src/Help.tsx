/**
 * Help ("?") and onboarding. The help explains every function in plain words (from helpContent.ts);
 * the onboarding is a short first-run tour with live status that can be skipped and restarted.
 * Progress of the tour lives only in this browser (localStorage, guarded) — never in the project.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type SettingsPage } from "./api";
import { Modal } from "./Dialogs";
import { HELP, type HelpAction, type HelpTopic } from "./helpContent";
import type { Dict } from "./i18n";

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

export function HelpDialog(props: { t: Dict; lang: "de" | "en"; topic?: string | null; onClose: () => void; onAction: (a: HelpAction) => void }) {
  const { t } = props;
  const [q, setQ] = useState("");
  const topics = HELP[props.lang];
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

type StepId = "welcome" | "goal" | "agents" | "history" | "views" | "more";
const STEPS: StepId[] = ["welcome", "goal", "agents", "history", "views", "more"];

export function Onboarding(props: { t: Dict; lang: "de" | "en"; goal: string | null; onClose: () => void; onAction: (a: HelpAction) => void; onGoalSaved: () => void; toast: (m: string) => void }) {
  const { t } = props;
  const [i, setI] = useState(0);
  const [goal, setGoal] = useState(props.goal ?? "");
  const [settings, setSettings] = useState<SettingsPage | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
  }, []);
  const step = STEPS[i];
  const connected = settings?.agents.filter((a) => a.connected) ?? [];
  const done: Record<StepId, boolean> = {
    welcome: true,
    goal: Boolean(props.goal),
    agents: connected.length > 0,
    history: true,
    views: true,
    more: true,
  };
  const finish = () => {
    setOnboardingDone(true);
    props.onClose();
  };
  const go = (a: HelpAction) => {
    setOnboardingDone(true);
    props.onAction(a);
  };
  return (
    <Modal title={`${t.obTitle} · ${i + 1}/${STEPS.length}`} onClose={finish}>
      <div className="modal-body onboarding">
        <ol className="ob-dots" aria-label={t.obProgress}>
          {STEPS.map((s, k) => (
            <li key={s} className={`${k === i ? "on" : ""} ${k !== 0 && done[s] && s !== "history" && s !== "views" && s !== "more" ? "ok" : ""}`}>
              <button aria-label={`${k + 1}`} onClick={() => setI(k)} />
            </li>
          ))}
        </ol>

        {step === "welcome" && (
          <>
            <h3>{t.obWelcome}</h3>
            <p>{t.obWelcomeText}</p>
            <ul className="ob-list">
              <li>🌳 {t.obPoint1}</li>
              <li>🔮 {t.obPoint2}</li>
              <li>⚑ {t.obPoint3}</li>
              <li>★ {t.obPoint4}</li>
            </ul>
          </>
        )}

        {step === "goal" && (
          <>
            <h3>{done.goal ? "✓ " : ""}{t.obGoal}</h3>
            <p>{t.obGoalText}</p>
            <form
              className="row"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!goal.trim()) return;
                setSaving(true);
                try {
                  await api.setGoal(goal.trim());
                  props.onGoalSaved();
                  props.toast(t.obGoalSaved);
                  setI(i + 1);
                } catch (er: any) {
                  props.toast(String(er?.message ?? er));
                } finally {
                  setSaving(false);
                }
              }}
            >
              <input className="grow" value={goal} placeholder={t.obGoalPlaceholder} onChange={(e) => setGoal(e.target.value)} aria-label={t.obGoal} />
              <button className="btn primary" type="submit" disabled={!goal.trim() || saving}>
                {t.save}
              </button>
            </form>
          </>
        )}

        {step === "agents" && (
          <>
            <h3>{done.agents ? "✓ " : ""}{t.obAgents}</h3>
            <p>{t.obAgentsText}</p>
            {settings && <p className="muted small">{connected.length ? `${t.obConnected}: ${connected.map((a) => a.label).join(", ")}` : t.obNoAgent}</p>}
            <div className="row">
              <button className="btn" onClick={() => go("prompt")}>
                {t.obCopyPrompt}
              </button>
              <button className="btn" onClick={() => go("settings")}>
                {t.obConnectAgents}
              </button>
            </div>
            <p className="muted small">{t.obAgentsCli}</p>
          </>
        )}

        {step === "history" && (
          <>
            <h3>{t.obHistory}</h3>
            <p>{t.obHistoryText}</p>
          </>
        )}

        {step === "views" && (
          <>
            <h3>{t.obViews}</h3>
            <p>{t.obViewsText}</p>
            {settings && (
              <p className="muted small">
                {settings.effective.chat ? `${t.obModelNow}: ${settings.effective.chat.provider}/${settings.effective.chat.model}` : t.obNoModel}
              </p>
            )}
            <button className="btn" onClick={() => go("settings")}>
              {t.obChooseModel}
            </button>
          </>
        )}

        {step === "more" && (
          <>
            <h3>{t.obMore}</h3>
            <ul className="ob-list">
              <li>
                <strong>⚑ {t.canon}</strong> — {t.obCanonText}{" "}
                <button className="btn link" onClick={() => go("canon")}>
                  → {t.obOpen}
                </button>
              </li>
              <li>
                <strong>★ {t.xTabExpert}</strong> — {t.obExpertText}{" "}
                <button className="btn link" onClick={() => go("expert")}>
                  → {t.obOpen}
                </button>
              </li>
              <li>
                <strong>▾ {t.pjHint}</strong> — {t.obProjectsText}
              </li>
              <li>
                <strong>?</strong> — {t.obHelpText}
              </li>
            </ul>
          </>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn link" onClick={finish}>
          {t.obSkip}
        </button>
        <span className="grow" />
        {i > 0 && (
          <button className="btn" onClick={() => setI(i - 1)}>
            {t.obBack}
          </button>
        )}
        {i < STEPS.length - 1 ? (
          <button className="btn primary" onClick={() => setI(i + 1)}>
            {t.obNext}
          </button>
        ) : (
          <button className="btn primary" onClick={finish}>
            {t.obDone}
          </button>
        )}
      </div>
    </Modal>
  );
}

export function restartOnboarding() {
  setOnboardingDone(false);
}
