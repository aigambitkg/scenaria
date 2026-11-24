/**
 * The introduction: five pictures that say what Scenaria is for, in plain words. It opens on the first visit,
 * can be skipped, and can be started again at any time (help "?", the Simple view, Manage → More).
 * It explains only what works for everyone from the first minute; the last step lets people do the two
 * things that get them going, or try everything on an example first (Demo.tsx).
 * Whether it was seen is remembered only in this browser (Help.tsx), never in the project.
 */
import { useEffect, useState } from "react";
import { api, type SettingsPage } from "./api";
import { Modal } from "./Dialogs";
import { markOnboardingDone } from "./Help";
import type { HelpAction } from "./helpContent";
import type { Lang } from "./i18n";
import { ArtBack, ArtLock, ArtLook, ArtSave } from "./TourArt";
import { TOUR } from "./tourText";

export const TOUR_STEPS = ["save", "look", "back", "lock", "start"] as const;

export function Tour(props: { lang: Lang; goal: string | null; readOnly?: boolean; onClose: () => void; onAction: (a: HelpAction) => void; onGoalSaved: () => void; onDemo: () => void; toast: (m: string) => void }) {
  const x = TOUR[props.lang];
  const [i, setI] = useState(0);
  const [goal, setGoal] = useState(props.goal ?? "");
  const [goalSaved, setGoalSaved] = useState(Boolean(props.goal));
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<SettingsPage | null>(null);
  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
  }, []);
  const step = TOUR_STEPS[i];
  const connected = settings?.agents.filter((a) => a.connected) ?? [];
  const finish = () => {
    markOnboardingDone();
    props.onClose();
  };
  const leaveFor = (run: () => void) => {
    markOnboardingDone();
    run();
  };
  return (
    <Modal title={`${x.title} · ${x.stepOf(i + 1, TOUR_STEPS.length)}`} onClose={finish}>
      <div className="modal-body tour">
        <ol className="ob-dots" aria-label={x.stepOf(i + 1, TOUR_STEPS.length)}>
          {TOUR_STEPS.map((s, k) => (
            <li key={s} className={k === i ? "on" : ""}>
              <button aria-label={x.stepOf(k + 1, TOUR_STEPS.length)} aria-current={k === i ? "step" : undefined} onClick={() => setI(k)} />
            </li>
          ))}
        </ol>

        {step === "save" && (
          <>
            <ArtSave x={x} />
            <h3>{x.s1Title}</h3>
            <p>{x.s1Text}</p>
            <ul className="ob-list">
              {x.s1Points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </>
        )}

        {step === "look" && (
          <>
            <ArtLook x={x} />
            <h3>{x.s2Title}</h3>
            <p>{x.s2Text}</p>
          </>
        )}

        {step === "back" && (
          <>
            <ArtBack x={x} />
            <h3>{x.s3Title}</h3>
            <p>{x.s3Text}</p>
          </>
        )}

        {step === "lock" && (
          <>
            <ArtLock x={x} />
            <h3>{x.s4Title}</h3>
            <p>{x.s4Text}</p>
            <ul className="ob-list">
              {x.s4Points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </>
        )}

        {step === "start" && (
          <>
            <h3>{x.s5Title}</h3>
            <p>{x.s5Text}</p>
            {!props.readOnly && (
              <>
                <section className="tour-do">
                  <h4>
                    {goalSaved ? "✓ " : ""}
                    {x.s5Goal}
                  </h4>
                  <p className="muted small">{x.s5GoalHint}</p>
                  <form
                    className="row"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!goal.trim()) return;
                      setSaving(true);
                      try {
                        await api.setGoal(goal.trim());
                        setGoalSaved(true);
                        props.onGoalSaved();
                        props.toast(x.s5GoalSaved);
                      } catch (er: any) {
                        props.toast(String(er?.message ?? er));
                      } finally {
                        setSaving(false);
                      }
                    }}
                  >
                    <input
                      className="grow"
                      value={goal}
                      placeholder={x.s5GoalPlaceholder}
                      aria-label={x.s5Goal}
                      onChange={(e) => {
                        setGoal(e.target.value);
                        setGoalSaved(false);
                      }}
                    />
                    <button className="btn primary" type="submit" disabled={!goal.trim() || saving || goalSaved}>
                      {goalSaved ? x.s5GoalSaved : props.lang === "de" ? "Speichern" : "Save"}
                    </button>
                  </form>
                </section>
                <section className="tour-do">
                  <h4>
                    {connected.length ? "✓ " : ""}
                    {x.s5Connect}
                  </h4>
                  <p className="muted small">{connected.length ? x.s5Connected(connected.map((a) => a.label).join(", ")) : x.s5ConnectHint}</p>
                  <button className="btn" onClick={() => leaveFor(() => props.onAction("connect"))}>
                    {x.s5ConnectButton}
                  </button>
                </section>
              </>
            )}
            <section className="tour-do">
              <h4>{x.s5Demo}</h4>
              <p className="muted small">{x.s5DemoHint}</p>
              <button className="btn" onClick={() => leaveFor(props.onDemo)}>
                {x.startDemo}
              </button>
            </section>
            <p className="muted small">{x.s5More}</p>
          </>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn link" onClick={finish}>
          {x.skip}
        </button>
        <span className="grow" />
        {i > 0 && (
          <button className="btn" onClick={() => setI(i - 1)}>
            {x.back}
          </button>
        )}
        {i < TOUR_STEPS.length - 1 ? (
          <button className="btn primary" onClick={() => setI(i + 1)}>
            {x.next}
          </button>
        ) : (
          <button className="btn primary" onClick={finish}>
            {x.done}
          </button>
        )}
      </div>
    </Modal>
  );
}
