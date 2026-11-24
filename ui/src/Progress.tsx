/**
 * Batch E2b: progress in the dashboard — per task and for the project, each with "How computed?".
 *
 * The numbers come from the server (src/core/progress.ts) and are only shown here: computed from evidence about
 * the task's completion criteria, capped by gates. The derivation is recomputed in the browser (Why.tsx), so a
 * number that does not follow from its inputs shows as such. Nothing here can change progress; criteria are
 * approved in the fixed-points dialog.
 */
import { type CriterionProgress, type ProjectProgress, type TaskProgress } from "./api";
import type { Dict, Lang } from "./i18n";
import { Why } from "./Why";
import { Modal } from "./Dialogs";
import { NodeId } from "./Map";
import { HelpButton } from "./HelpButton";

const GATE_TICKS = [10, 20, 40, 60, 80, 90];

/** A bar with the gates as ticks; the value as text next to it (the bar alone never carries the meaning). */
export function ProgressBar({ value, label, t }: { value: number; label: string; t: Dict }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="pg-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-valuetext={t.pgBar(v)} aria-label={label}>
      <span className="pg-fill" style={{ width: `${v}%` }} />
      {GATE_TICKS.map((g) => (
        <span key={g} className="pg-tick" style={{ left: `${g}%` }} aria-hidden="true" />
      ))}
    </div>
  );
}

const levelWord = (c: CriterionProgress, t: Dict) => t.pgLevels[String(c.level)] ?? String(c.level);

function Criterion({ c, t, lang, onNode }: { c: CriterionProgress; t: Dict; lang: Lang; onNode?: (id: string) => void }) {
  return (
    <li className={`pg-crit lv-${String(c.level).replace(".", "")}`}>
      <div className="pg-crit-head">
        <span className="canon-id">{c.id}</span>
        <span className={`chip pg-level lv-${String(c.level).replace(".", "")}`}>{levelWord(c, t)}</span>
        <span className="chip">{c.weight === null ? t.pgNoWeight : `${t.pgWeight} ${c.weight}`}</span>
        {c.artifact && (
          <span className="chip">
            {t.pgFile} <code className="cmd">{c.artifact}</code>
          </span>
        )}
      </div>
      <p>{c.text}</p>
      <p className="small muted">
        {t.pgHow[c.how] ?? c.how}
        {c.evidence.length > 0 && (
          <>
            {" · "}
            {t.pgEvidence}:{" "}
            {c.evidence.map((id) =>
              onNode ? (
                <button key={id} className="btn link" onClick={() => onNode(id)}>
                  <NodeId id={id} />
                </button>
              ) : (
                <span key={id}>{id} </span>
              ),
            )}
          </>
        )}
      </p>
      {c.notes.map((n, i) => (
        <p key={i} className="small pg-note">
          {n[lang]}
        </p>
      ))}
    </li>
  );
}

/** "done" is the agent's own mark (a new task closes the last one): never shown, as if it were proof. */
function StatusChips({ p, t }: { p: TaskProgress; t: Dict }) {
  if (p.status !== "abandoned" && p.status !== "missing" && !p.offLine) return null;
  return (
    <p className="small">
      {p.status === "abandoned" && <span className="chip v-warning">{t.pgAbandoned}</span>}
      {p.status === "missing" && <span className="chip v-failed">⛔ {t.pgMissingTask}</span>}
      {p.offLine && <span className="chip">{t.pgOffLine}</span>}
    </p>
  );
}

/** One task: value, bar, what is next; the criteria and gates behind "Details". */
export function TaskProgressBlock({ p, t, lang, onNode, open }: { p: TaskProgress; t: Dict; lang: Lang; onNode?: (id: string) => void; open?: boolean }) {
  const title = p.title || t.pgMissingTask;
  return (
    <section className="a-sec pg-task">
      <h3>
        <span className="pg-task-title">
          {p.task} · {title}
        </span>{" "}
        <span className="pg-value">{p.value} %</span>
      </h3>
      {/* The derivation sits next to the heading, not in it (a heading is read as one line — E2b review). */}
      <p className="pg-why">
        <Why d={p.derivation} shown={p.value} t={t} lang={lang} label={title} />
      </p>
      <ProgressBar value={p.value} label={title} t={t} />
      <StatusChips p={p} t={t} />
      {p.next && (
        <p className="pg-next">
          <strong>{t.pgNext}:</strong> {p.next[lang]}
        </p>
      )}
      <details className="pg-details" open={open}>
        <summary>{t.pgDetails}</summary>
        {p.criteria.length > 0 && (
          <>
            <h4>{t.pgCriteria}</h4>
            <ul className="canon-list pg-crits">
              {p.criteria.map((c) => (
                <Criterion key={c.id} c={c} t={t} lang={lang} onNode={onNode} />
              ))}
            </ul>
          </>
        )}
        {p.unsettled.length > 0 && (
          <>
            <h4>{t.pgUnsettled}</h4>
            <ul className="pg-unsettled">
              {p.unsettled.map((u) => (
                <li key={u.id} className="small">
                  <span className="canon-id">{u.id}</span> {u.text || "–"} <span className="muted">({t.pgUnsettledStatus[u.status] ?? u.status})</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <h4>{t.pgGates}</h4>
        <ol className="pg-gates">
          {p.gates.map((g) => (
            <li key={g.cap} className={g.met ? "met" : "open"}>
              <span aria-hidden="true">{g.met ? "✓" : "○"}</span> <b>{g.cap} %</b> {g.name[lang]} <span className="muted small">({g.met ? t.pgGateMet : t.pgGateOpen})</span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

/** The whole picture: the project value and every task with criteria (the same data as the header chip, kept current by the app). */
export function ProgressDialog({ p, t, lang, onClose, onNode, onOpenCanon }: { p: ProjectProgress | null; t: Dict; lang: Lang; onClose: () => void; onNode?: (id: string) => void; onOpenCanon?: () => void }) {
  return (
    <Modal
      wide
      title={
        <>
          {t.pgTitle} <HelpButton topic="progress" />
        </>
      }
      onClose={onClose}
    >
      <div className="modal-body analysis pg">
        <p className="hint">{t.pgIntro}</p>
        {!p && <p className="muted">{t.pgLoading}</p>}
        {p && (
          <>
            <section className="a-sec pg-project">
              <h3>
                {t.pgProject} <span className="pg-value">{p.tasks.length ? `${p.value} %` : "–"}</span>
              </h3>
              {p.tasks.length > 0 && (
                <p className="pg-why">
                  <Why d={p.derivation} shown={p.value} t={t} lang={lang} label={t.pgProject} />
                </p>
              )}
              {p.tasks.length > 0 ? <ProgressBar value={p.value} label={t.pgProject} t={t} /> : <p className="muted">{t.pgNoTasks}</p>}
              {onOpenCanon && (
                <button className="btn" onClick={onOpenCanon}>
                  {t.pgOpenCanon}
                </button>
              )}
            </section>
            {p.tasks.map((x) => (
              <TaskProgressBlock key={x.task} p={x} t={t} lang={lang} onNode={onNode} />
            ))}
            {p.without.length > 0 && (
              <section className="a-sec">
                <h3>{t.pgWithout}</h3>
                <p className="small muted">{p.without.map((w) => `${w.task} ${w.title}`).join(" · ")}</p>
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** The Simple view's card: the current task only, in plain words. */
export function ProgressCard({ p, task, t, lang }: { p: ProjectProgress | null; task: string | null; t: Dict; lang: Lang }) {
  if (!p || !task) return null;
  const tp = p.tasks.find((x) => x.task === task);
  // Nothing to measure yet (no approved criteria for this task): no card. An empty box at the top of the
  // Simple view only raised a question; the Progress dialog in the other views explains how to get there.
  if (!tp) return null;
  return (
    <section className="sv-card pg-card" aria-label={t.pgSimpleTitle}>
      <h2>{t.pgSimpleTitle}</h2>
      {tp ? (
        <>
          <p className="pg-big">
            <span className="pg-value">{tp.value} %</span> <Why d={tp.derivation} shown={tp.value} t={t} lang={lang} label={t.pgSimpleTitle} />
          </p>
          <ProgressBar value={tp.value} label={t.pgSimpleTitle} t={t} />
          <StatusChips p={tp} t={t} />
          {tp.next && (
            <p className="pg-next">
              <strong>{t.pgNext}:</strong> {tp.next[lang]}
            </p>
          )}
          <details className="pg-details">
            <summary>{t.pgDetails}</summary>
            <ul className="canon-list pg-crits">
              {tp.criteria.map((c) => (
                <Criterion key={c.id} c={c} t={t} lang={lang} />
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p className="muted">{t.pgSimpleNone}</p>
      )}
    </section>
  );
}
