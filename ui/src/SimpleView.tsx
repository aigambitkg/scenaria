/**
 * The Simple view (persona: an office user who is new to AI).
 *
 * One column, read top to bottom: what this is about, then the history of saved states in plain words,
 * newest first, drawn as a vertical time axis (the scenario map's t-axis turned on its side). Every step
 * answers two questions: "What did the AI do?" and "Can I go back to this?". Nothing here needs the words
 * node, branch, capsule or canon.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type ConversationMessage, type Fidelity, type ScenariaNode } from "./api";
import type { Dict, Lang } from "./i18n";
import { verdictView } from "../../src/core/verdict";
import { Modal } from "./Dialogs";

export type Toast = (msg: string, action?: { label: string; run: () => void }) => void;

/** Root → … → HEAD. */
function pathTo(nodes: ScenariaNode[], head: string | null): ScenariaNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: ScenariaNode[] = [];
  const seen = new Set<string>();
  let cur = head ? byId.get(head) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** Who did it, in words a person uses. */
export function whoDidIt(n: ScenariaNode, t: Dict): string {
  const a = (n.agent ?? "").toLowerCase();
  if (n.source === "ui" || a === "dashboard") return t.svYou;
  if (n.source === "watch" || a === "scenaria" || a === "watch") return t.svAutomatic;
  const known: Record<string, string> = {
    "claude-code": "Claude Code",
    "claude-desktop": "Claude",
    cursor: "Cursor",
    "vscode-copilot": "GitHub Copilot",
    "gemini-cli": "Gemini",
    codex: "Codex",
    windsurf: "Windsurf",
    chat: "Scenaria-Chat",
  };
  return known[a] ?? (n.agent || t.svTheAi);
}

/** One plain sentence for a step. */
export function sentenceFor(n: ScenariaNode, nodes: ScenariaNode[], t: Dict): { head: string; sub?: string } {
  const option = (d: ScenariaNode, id?: string) => d.options?.find((o) => o.id === id)?.label;
  switch (n.type) {
    case "mission":
      return { head: t.svStarted };
    case "goal":
      return { head: `${t.svNewTask}: ${n.title}`, sub: n.goal && n.goal !== n.title ? n.goal : undefined };
    case "decision":
      return {
        head: `${t.svDecision}: ${n.question ?? n.title}${n.chosen ? ` → ${option(n, n.chosen)}` : ` (${t.svOpen})`}`,
        sub: n.rationale ? `${t.svBecause} ${n.rationale}` : undefined,
      };
    case "branch": {
      const parent = nodes.find((p) => p.id === n.parentId);
      return { head: `${t.svTriedOther}: ${parent ? option(parent, n.viaOption) ?? n.title : n.title}` };
    }
    case "autosave":
      return { head: n.title || t.svAutoSaved, sub: n.changedFiles?.length ? t.svFilesChanged(n.changedFiles.length) : undefined };
    default:
      return { head: n.title, sub: n.changedFiles?.length ? t.svFilesChanged(n.changedFiles.length) : n.outputs?.[0] };
  }
}

function fmtTime(iso: string, lang: Lang) {
  return new Date(iso).toLocaleTimeString(lang === "de" ? "de-DE" : "en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** "today"/"yesterday" in the middle of a sentence. */
function dayInSentence(iso: string, lang: Lang, t: Dict) {
  const l = dayLabel(iso, lang, t);
  return l === t.svToday || l === t.svYesterday ? l.toLowerCase() : l;
}

/** "~ a.md" / "+ b.md" / "- c.md" (as recorded) → plain words. */
function plainFile(f: string, t: Dict) {
  const m = /^([+~-])\s+(.*)$/.exec(f);
  if (!m) return f;
  return m[1] === "+" ? `${m[2]} (${t.svNewFile})` : m[1] === "-" ? `${m[2]} (${t.svDeletedFile})` : m[2];
}

function dayLabel(iso: string, lang: Lang, t: Dict) {
  const d = new Date(iso);
  const today = new Date();
  // Calendar arithmetic (not "minus 24 h"), so the clock change in spring/autumn does not shift "yesterday".
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12);
  if (dayKey(iso) === dayKey(today.toISOString())) return t.svToday;
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return t.svYesterday;
  return d.toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", { weekday: "long", day: "numeric", month: "long" });
}

function ago(iso: string, lang: Lang, t: Dict) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (s < 60) return t.svJustNow;
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86_400) return rtf.format(-Math.round(s / 3600), "hour");
  return rtf.format(-Math.round(s / 86_400), "day");
}

/** Show these steps? The project root and empty task headers carry no state of their own. */
const isStep = (n: ScenariaNode) => n.type !== "mission";

export function SimpleView(props: {
  t: Dict;
  lang: Lang;
  nodes: ScenariaNode[];
  headId: string | null;
  goal: string | null;
  fidelity: Fidelity | null;
  /** The integrity check failed to load: nothing counts as checked, and the person is warned. */
  fidelityError?: boolean;
  onEditGoal: () => void;
  onRewound: () => Promise<void>;
  onDiff: (from: string, to: string) => void;
  onOpenAudit: () => void;
  onConnect: () => void;
  toast: Toast;
}) {
  const { t, lang, nodes, headId } = props;
  const [limit, setLimit] = useState(40);
  const [showOther, setShowOther] = useState(false);
  const [confirm, setConfirm] = useState<ScenariaNode | null>(null);

  const line = useMemo(() => pathTo(nodes, headId), [nodes, headId]);
  const onLine = useMemo(() => new Set(line.map((n) => n.id)), [line]);
  const others = useMemo(() => nodes.filter((n) => !onLine.has(n.id) && isStep(n)), [nodes, onLine]);
  const shown = useMemo(() => {
    const list = [...line.filter(isStep), ...(showOther ? others : [])];
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }, [line, others, showOther, limit]);
  const total = line.filter(isStep).length + (showOther ? others.length : 0);
  // Only the engine's confirmed set counts (rule 11) — never the stored fields, also not while loading.
  const confirmed = useMemo(() => new Set(props.fidelity?.confirmed ?? []), [props.fidelity]);

  // Group by day, newest first.
  const days = useMemo(() => {
    const out: { key: string; label: string; steps: ScenariaNode[] }[] = [];
    for (const n of shown) {
      const k = dayKey(n.createdAt);
      const last = out[out.length - 1];
      if (last?.key === k) last.steps.push(n);
      else out.push({ key: k, label: dayLabel(n.createdAt, lang, t), steps: [n] });
    }
    return out;
  }, [shown, lang, t]);

  const f = props.fidelity;
  const tamperedStep = Boolean(f && Object.values(f.points ?? {}).some((p) => p.integrity === "tampered"));
  const alarm = Boolean(props.fidelityError || tamperedStep || (f && (f.ledgerBrokenAt || f.ledgerMissing || f.ledgerReplaced || f.ledgerDiverged || f.resealsUnproven?.length || f.verdictsRemoved?.length || f.verdictsUntrusted?.length)));
  // "The state at the end of that day" = the step that was current at midnight (from the event log), so an
  // evening "go back" counts. Without an answer: that day's newest saved state, also on a line left later.
  const [dayEnds, setDayEnds] = useState<Record<string, string | null>>({});
  const pastDays = useMemo(() => days.slice(1).map((d) => ({ key: d.key, at: d.steps[0].createdAt })), [days]);
  useEffect(() => {
    for (const d of pastDays) {
      if (d.key in dayEnds) continue;
      const x = new Date(d.at);
      const midnight = new Date(x.getFullYear(), x.getMonth(), x.getDate() + 1);
      api
        .headAt(midnight.toISOString())
        .then((r) => setDayEnds((m) => ({ ...m, [d.key]: r.id })))
        .catch(() => setDayEnds((m) => ({ ...m, [d.key]: null })));
    }
  }, [pastDays, dayEnds]);
  const endOfDayFor = (key: string) => {
    const fromLog = dayEnds[key] ? nodes.find((n) => n.id === dayEnds[key] && isStep(n)) : undefined;
    if (fromLog) return fromLog;
    return nodes
      .filter((n) => isStep(n) && n.snapshot && dayKey(n.createdAt) === key)
      .reduce<ScenariaNode | undefined>((best, n) => (!best || n.createdAt > best.createdAt ? n : best), undefined);
  };
  // What going back cannot undo: effects outside the files on the steps that will be left.
  const leaving = useMemo(() => {
    if (!confirm) return [];
    const keep = new Set(pathTo(nodes, confirm.id).map((n) => n.id));
    return line.filter((n) => !keep.has(n.id)).flatMap((n) => n.irreversible ?? []);
  }, [confirm, nodes, line]);
  const lastStep = line.filter(isStep).at(-1) ?? null;

  return (
    <div className="simple">
      <section className="sv-head">
        <h1 className="sv-goal">
          {props.goal ? (
            <button className="sv-goal-text" onClick={props.onEditGoal} title={t.editGoal}>
              {props.goal}
            </button>
          ) : (
            <button className="btn primary" onClick={props.onEditGoal}>
              {t.svSetGoal}
            </button>
          )}
        </h1>
        <p className="sv-status">
          {lastStep ? t.svStatus(line.filter(isStep).length, ago(lastStep.createdAt, lang, t)) : t.svNothingYet}
        </p>
        {alarm && (
          <p className="sv-alarm" role="alert">
            {props.fidelityError ? t.svIntegrityUnknown : t.svAlarm}{" "}
            <button className="btn" onClick={props.onOpenAudit}>
              {t.svAlarmOpen}
            </button>
          </p>
        )}
      </section>

      {!lastStep ? (
        <section className="sv-empty">
          <p>{t.svEmpty}</p>
          <button className="btn primary" onClick={props.onConnect}>
            {t.svConnect}
          </button>
        </section>
      ) : (
        <ol className="sv-days">
          {days.map((d, di) => {
            const endOfDay = di > 0 ? endOfDayFor(d.key) : undefined;
            return (
              <li key={d.key} className="sv-day">
                <div className="sv-day-head">
                  <h2>{d.label}</h2>
                  {endOfDay && endOfDay.id !== headId && (
                    <button className="btn" onClick={() => setConfirm(endOfDay)}>
                      {t.svBackToDay(d.label)}
                    </button>
                  )}
                </div>
                <ol className="sv-steps">
                  {d.steps.map((n) => (
                    <Step
                      key={n.id}
                      n={n}
                      t={t}
                      lang={lang}
                      nodes={nodes}
                      isNow={n.id === headId}
                      abandoned={!onLine.has(n.id)}
                      confirmed={confirmed.has(n.id)}
                      onBack={() => setConfirm(n)}
                      onDiff={props.onDiff}
                      toast={props.toast}
                    />
                  ))}
                </ol>
              </li>
            );
          })}
        </ol>
      )}

      {lastStep && (
        <footer className="sv-foot">
          {total > limit && (
            <button className="btn" onClick={() => setLimit(limit + 40)}>
              {t.svOlder}
            </button>
          )}
          {others.length > 0 && (
            <label className="check">
              <input type="checkbox" checked={showOther} onChange={(e) => setShowOther(e.target.checked)} />
              <span>{t.svShowOther(others.length)}</span>
            </label>
          )}
        </footer>
      )}

      {confirm && (
        <BackDialog
          t={t}
          lang={lang}
          target={confirm}
          leaving={leaving}
          onCancel={() => setConfirm(null)}
          onDone={async (autosave, warnings) => {
            setConfirm(null);
            await props.onRewound();
            // Effects outside the files were already listed (translated) in the dialog; show the other warnings.
            warnings.filter((w) => !(leaving.length && /^Not undoable by rewind/i.test(w))).forEach((w) => props.toast(w));
            // Undo = back to where we were: the autosave of unsaved work, or the step we left.
            const undo = autosave ?? headId;
            props.toast(t.svWentBack(dayInSentence(confirm.createdAt, lang, t), fmtTime(confirm.createdAt, lang)), undo
              ? {
                  label: t.svUndo,
                  run: async () => {
                    try {
                      await api.rewind(undo, "", true);
                      await props.onRewound();
                      props.toast(t.svUndone);
                    } catch (e: any) {
                      props.toast(e?.message ?? String(e));
                    }
                  },
                }
              : undefined);
          }}
        />
      )}
    </div>
  );
}

function Step(props: {
  n: ScenariaNode;
  t: Dict;
  lang: Lang;
  nodes: ScenariaNode[];
  isNow: boolean;
  abandoned: boolean;
  confirmed?: boolean;
  onBack: () => void;
  onDiff: (from: string, to: string) => void;
  toast: Toast;
}) {
  const { n, t, lang } = props;
  const s = sentenceFor(n, props.nodes, t);
  const view = verdictView(n.verification, props.confirmed);
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState<ConversationMessage | null | undefined>(undefined);
  useEffect(() => {
    if (!open || asked !== undefined) return;
    api
      .nodeMessages(n.id)
      .then((m) => setAsked([...m.leading].reverse().find((x) => x.role === "user") ?? null))
      .catch(() => setAsked(null));
  }, [open, asked, n.id]);
  const request = asked?.text ?? n.trigger;
  const files = n.changedFiles ?? [];
  const verdictText =
    view.cls === "passed" ? t.svChecked : view.cls === "failed" ? t.svProblem : view.cls === "warning" ? t.svLook : view.cls === "self" ? t.passNotCounted[view.reason ?? "agent"] : null;

  return (
    <li className={`sv-step ${props.isNow ? "now" : ""} ${props.abandoned ? "abandoned" : ""}`}>
      <time className="sv-time" dateTime={n.createdAt}>
        {fmtTime(n.createdAt, lang)}
      </time>
      <div className="sv-body">
        <p className="sv-line">
          {props.isNow && <span className="sv-now">{t.svNow}</span>}
          <span className="sv-text">{s.head}</span>
        </p>
        <p className="sv-meta">
          {whoDidIt(n, t)}
          {s.sub ? ` — ${s.sub}` : ""}
          {props.abandoned ? ` (${t.svAbandoned})` : ""}
          {verdictText && <span className={`sv-verdict v-${view.cls}`}>{verdictText}</span>}
        </p>
        <div className="sv-actions">
          <button className="btn link" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t.svHide : t.svWhatDidAi}
          </button>
          {!props.isNow && n.snapshot && (
            <button className="btn" onClick={props.onBack}>
              {t.svBack}
            </button>
          )}
        </div>
        {open && (
          <div className="sv-detail">
            {request && (
              <p>
                <span className="muted">{t.svAsked}</span> {request.length > 400 ? `${request.slice(0, 400)} …` : request}
              </p>
            )}
            {(n.outputs?.length ?? 0) > 0 && (
              <ul>
                {n.outputs!.slice(0, 6).map((o, i) => (
                  <li key={i}>{o.replace(/`/g, "")}</li>
                ))}
              </ul>
            )}
            {files.length > 0 && (
              <p>
                <span className="muted">{t.svFiles}</span> {files.slice(0, 12).map((x) => plainFile(x, t)).join(", ")}
                {files.length > 12 ? ` ${t.svAndMore(files.length - 12)}` : ""}
              </p>
            )}
            {(n.irreversible?.length ?? 0) > 0 && (
              <div className="qnote q-warn">
                <p>{t.svOutside}</p>
                <ul>
                  {n.irreversible!.slice(0, 6).map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
            {!request && !n.outputs?.length && !files.length && !n.irreversible?.length && <p className="muted">{t.svNoDetail}</p>}
            <p className="row">
              {n.parentId && files.length > 0 && (
                <button className="btn" onClick={() => props.onDiff(n.parentId!, n.id)}>
                  {t.svShowChanges}
                </button>
              )}
              {n.snapshot && (
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      const r = await api.folder(n.id, true);
                      props.toast(r.folder ? t.svFolderOpened : t.svNoFolder);
                    } catch (e: any) {
                      props.toast(e?.message ?? String(e));
                    }
                  }}
                >
                  {t.svOpenFolder}
                </button>
              )}
            </p>
          </div>
        )}
      </div>
    </li>
  );
}

function BackDialog(props: { t: Dict; lang: Lang; target: ScenariaNode; leaving: string[]; onCancel: () => void; onDone: (autosaveId: string | null, warnings: string[]) => Promise<void> }) {
  const { t, lang, target } = props;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const when = `${dayInSentence(target.createdAt, lang, t)}, ${fmtTime(target.createdAt, lang)}`;
  return (
    <Modal title={t.svBackTitle(when)} onClose={props.onCancel}>
      <div className="modal-body">
        <p>{t.svBackBody}</p>
        {props.leaving.length > 0 && (
          <div className="qnote q-warn">
            <p>{t.svCannotUndo}</p>
            <ul>
              {props.leaving.slice(0, 8).map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        )}
        <details>
          <summary>{t.svNoteForAi}</summary>
          <label className="field">
            <span className="muted">{t.svNoteHint}</span>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t.lessonPlaceholder} />
          </label>
        </details>
        {err && <p className="error">{err}</p>}
      </div>
      <footer className="modal-foot">
        <button className="btn" onClick={props.onCancel}>
          {t.cancel}
        </button>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await api.rewind(target.id, note, true);
              await props.onDone(r.autosave?.id ?? null, r.warnings ?? []);
            } catch (e: any) {
              setErr(e?.message ?? String(e));
              setBusy(false);
            }
          }}
        >
          {t.svBack}
        </button>
      </footer>
    </Modal>
  );
}
