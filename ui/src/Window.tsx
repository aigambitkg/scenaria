/**
 * Batch E3b-2: the context window in the dashboard — how full each AI's working memory is, in all three views.
 *
 * Everything here is shown, never computed: the numbers come from the server (src/core/window.ts, measured from the
 * provider's token counts) with their derivation, recomputed in the browser by Why.tsx. The automatic saves come from
 * src/core/windowact.ts. The values of the rule are the person's: the form below writes only in the approval session
 * (the server refuses everyone else) and never in the auditor mode.
 *
 * Batch E4: progress per window (src/core/windowprogress.ts) — each window's points with their derivation, the
 * warning, the escalation, the handover checks and the stop after two full windows without progress. Only the person
 * lifts a stop: the form below sends it only in the approval session (the server refuses everyone else).
 */
import { useContext, useEffect, useRef, useState } from "react";
import { api, ApiError, type ContextSettingsView, type ContextValues, type Handover, type LocalModel, type ProgressValues, type WindowInfo, type WindowProgressStatus, type WindowStatus, type WindowStop } from "./api";
import type { Dict, Lang } from "./i18n";
import { Why } from "./Why";
import { Modal } from "./Dialogs";
import { NodeId } from "./Map";
import { HelpButton } from "./HelpButton";
import { LockedNote, ReadOnlyContext, useApprovalSignal } from "./Approval";
import { parsePercent, parseTokens } from "../../src/core/numbers";

const pct = (x: number, lang: Lang) => (lang === "de" ? String(x).replace(".", ",") : String(x));
const tok = (x: number, lang: Lang) => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, lang === "de" ? "." : ",");
const tokens = (x: number, lang: Lang) => `${tok(x, lang)} ${lang === "de" ? "Tokens" : "tokens"}`;
const ver = (rule: string) => rule.split(" ")[0] || "v1.0";
/** When a window was last measured: the time today, else date and time (local). */
export function measuredAt(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  const loc = lang === "de" ? "de-DE" : "en-GB";
  const time = d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(loc, { day: "2-digit", month: "2-digit" })} ${time}`;
}
/** Date and time in the reader's local time (the same clock as "measured" and the timeline). */
const localTime = (iso: string, lang: Lang) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(lang === "de" ? "de-DE" : "en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
};
/** The approver label the server writes ("kev (local approval link)") in the reader's language. */
const byText = (by: string, t: Dict) => by.replace(" (local approval link)", ` (${t.cwViaLocal})`).replace(" (team approver link)", ` (${t.cwViaTeam})`);
/** Where C_max comes from, in the reader's language. */
const cMaxFrom = (src: { source: string; read: string } | undefined, t: Dict) =>
  !src ? "" : src.source.startsWith("entered by the person") ? t.cwByPerson(src.read) : t.cwByProvider(src.source, src.read);

/** The zone as a chip: the word always carries the meaning, the colour only helps. */
export function ZoneChip({ zone, t }: { zone: string; t: Dict }) {
  return <span className={`chip cw-zone z-${zone}`}>{t.cwZones[zone] ?? zone}</span>;
}

/** One window in plain words (office user), with "How computed?" for the fill and when it was measured. */
function PlainLine({ w, t, lang }: { w: WindowInfo; t: Dict; lang: Lang }) {
  if (!w.measurable || !w.fill || !w.zone) return <p className="cw-line muted">{t.cwWhy[w.why ?? "no-sample"] ?? w.why}</p>;
  return (
    <p className="cw-line">
      <ZoneChip zone={w.zone} t={t} /> {t.cwSimpleLine(pct(w.fill.value, lang), t.cwZones[w.zone], t.cwMeans[w.zone])}{" "}
      <Why d={w.fill} shown={w.fill.value} t={t} lang={lang} label={t.cwSimpleTitle} /> <span className="muted small">{t.cwMeasured(measuredAt(w.lastAt, lang))}</span>
    </p>
  );
}

/** A bar with the lines of the rule as ticks (the soft one placed where orange really starts); the value as text. */
function FillBar({ w, t, lang }: { w: WindowInfo; t: Dict; lang: Lang }) {
  if (!w.fill || !w.zone) return null;
  const v = Math.max(0, Math.min(100, w.fill.value));
  const get = (k: string) => Number(new RegExp(`(?:^|\\s)${k}=(\\d+(?:\\.\\d+)?)`).exec(w.rule)?.[1] ?? NaN);
  const yellow = get("yellow");
  const red = get("red");
  const lines = [yellow, red, get("emergency")].filter((x) => Number.isFinite(x));
  // As derivation.ts places the orange line: the soft threshold between the yellow and the red line.
  const soft = w.soft && Number.isFinite(yellow) && Number.isFinite(red) ? Math.min(red, Math.max(yellow, w.soft.value)) : undefined;
  return (
    <div className={`pg-bar cw-bar z-${w.zone}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} aria-valuetext={`${pct(w.fill.value, lang)} % (${t.cwZones[w.zone]})`} aria-label={t.cwSimpleTitle}>
      <span className="pg-fill" style={{ width: `${v}%` }} />
      {[...lines, ...(soft !== undefined ? [soft] : [])].map((g, i) => (
        <span key={i} className="pg-tick" style={{ left: `${Math.min(100, g)}%` }} aria-hidden="true" />
      ))}
    </div>
  );
}

/** The Simple view's card: the AI's newest window only, in plain words. */
export function WindowCard({ ws, t, lang, onHandover, onOpenWindow }: { ws: WindowStatus | null; t: Dict; lang: Lang; onHandover: () => void; onOpenWindow?: () => void }) {
  if (!ws) return null;
  const st = ws.progress?.stop ?? null;
  const w = ws.current;
  const urgent = w?.zone === "red" || w?.zone === "emergency";
  // "Scenaria has saved" only when a save of red or higher is on the current line (not after a rewind, not if it failed).
  const saved = Boolean(w?.cuts.some((c) => c.onLine && (c.zone === "red" || c.zone === "emergency")));
  return (
    <section className="sv-card cw-card" aria-label={t.cwSimpleTitle}>
      <h2>{t.cwSimpleTitle}</h2>
      {st && (
        <div className="qnote q-warn cw-stop" role="alert">
          <p>
            <strong>{t.wpStop(stopIds(st), stopTask(st, lang), localTime(st.since, lang))}</strong>
          </p>
          {HOOK_OFF(ws.progress) && <p className="small">{t.wpNotWired}</p>}
          {st.likelyParallel && <p className="small">{t.wpLikelyParallel}</p>}
          <p className="small">{t.wpStopWhat}</p>
          {onOpenWindow && (
            <p>
              <button className="btn" onClick={onOpenWindow}>
                {t.wpOpenStop}
              </button>
            </p>
          )}
        </div>
      )}
      {!st && ws.progress?.warning && <p className="qnote q-info small">{t.wpWarning(ws.progress.warning.window, ws.progress.warning.focus ?? "–")}</p>}
      {!st && ws.progress?.escalation && <p className="qnote q-warn small">{t.wpEscalation(ws.progress.escalation.window, pct(ws.progress.escalation.fill, lang), ws.progress.escalation.task)}</p>}
      {ws.settings.trust === "invalid" && <p className="qnote q-warn small">{ws.settings.text[lang]}</p>}
      {!w ? (
        <p className="muted">{t.cwSimpleNone}</p>
      ) : (
        <>
          <PlainLine w={w} t={t} lang={lang} />
          <FillBar w={w} t={t} lang={lang} />
          {urgent && <p className="small">{saved ? t.cwWhatNowSaved : t.cwWhatNow}</p>}
          {w.zone && (urgent || w.zone === "orange") && (
            <p>
              <button className="btn" onClick={onHandover}>
                {t.cwHandover}
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function WindowDetail({ w, t, lang, onNode }: { w: WindowInfo; t: Dict; lang: Lang; onNode?: (id: string) => void }) {
  return (
    <section className="a-sec cw-window">
      <h3>
        {w.id} · {w.agent} · {w.model ?? "?"} {w.zone && <ZoneChip zone={w.zone} t={t} />}
      </h3>
      <PlainLine w={w} t={t} lang={lang} />
      <FillBar w={w} t={t} lang={lang} />
      {w.fill && w.soft && (
        <ul className="small cw-facts">
          <li>
            {w.tokens !== null && `${tokens(w.tokens, lang)} · `}C_eff {w.cEff !== undefined ? tok(w.cEff, lang) : "?"}
            {w.next && ` · ${t.cwNext(pct(w.next.at, lang), t.cwZones[w.next.zone])}`}
          </li>
          <li>
            {t.cwSoft} {pct(w.soft.value, lang)} % <Why d={w.soft} shown={w.soft.value} t={t} lang={lang} label={t.cwSoft} />
          </li>
          <li className="muted">
            {t.cwCols.start}: {t.cwStart[w.start] ?? w.start}
            {w.end && ` · ${t.cwCols.end}: ${t.cwStart[w.end] ?? w.end}`} · {t.cwRule} {ver(w.rule)}
            {w.modelSource && ` · ${cMaxFrom(w.modelSource, t)}`}
          </li>
        </ul>
      )}
      {w.cuts.length > 0 && (
        <p className="small">
          {t.cwCols.saved}:{" "}
          {w.cuts.map((c) => (
            <span key={c.node} className="cw-cut">
              {onNode ? (
                <button className="btn link" onClick={() => onNode(c.node)}>
                  <NodeId id={c.node} />
                </button>
              ) : (
                c.node
              )}{" "}
              <ZoneChip zone={c.zone} t={t} /> {pct(c.fill, lang)} % · {ver(c.rule)}
              {!c.onLine && <span className="muted"> {t.cwOffLine}</span>}{" "}
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

/** The task with its title (E5 review L8). */
const stopTask = (st: WindowStop, lang: Lang) => (st.title ? (lang === "de" ? `${st.task} „${st.title}“` : `${st.task} "${st.title}"`) : st.task);
/** The hook before every tool is not wired: the stop is shown but not enforced (E5 review L11). */
const HOOK_OFF = (wp?: { hookWired?: boolean } | null) => wp?.hookWired === false;
const stopIds = (st: WindowStop) => st.windows.map((w) => w.split("@")[0]).join(", ");

/** Lifting a stop: the person names why, sees what would be signed, then confirms (no browser dialog). */
function LiftForm({ st, t, onLifted }: { st: WindowStop; t: Dict; onLifted: () => void }) {
  // No reason is chosen for the person: what is signed is what they picked (review 3, L5).
  const [choice, setChoice] = useState<number | null>(null);
  const [other, setOther] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const presets = t.wpLiftPresets as readonly string[];
  const why = choice === null ? "" : choice < presets.length ? presets[choice] : other.trim();
  const lift = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.liftStop(why);
      setConfirm(false);
      // The form goes away with the stop: the section says it and takes the focus (review 3, L4).
      onLifted();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      setMsg({ ok: false, text: (code && t.wpErr[code]) || String((e as Error)?.message ?? e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="cw-lift"
      onSubmit={(e) => {
        e.preventDefault();
        if (!why) {
          setMsg({ ok: false, text: t.wpErr.why });
          return;
        }
        setMsg(null);
        setConfirm(true);
      }}
    >
      <fieldset>
        <legend>{t.wpLiftWhy}</legend>
        {[...presets, t.wpLiftOther].map((label, i) => (
          <label key={i} className="cw-radio">
            <input
              type="radio"
              name="cw-lift-why"
              checked={choice === i}
              onChange={() => {
                setChoice(i);
                setConfirm(false);
              }}
            />{" "}
            {label}
          </label>
        ))}
        {choice === presets.length && (
          <label className="cw-other">
            <span>{t.wpLiftOtherText}</span>
            <input
              value={other}
              maxLength={300}
              onChange={(e) => {
                setOther(e.target.value);
                setConfirm(false);
              }}
            />
          </label>
        )}
      </fieldset>
      <p>
        <button type="submit" className="btn primary" disabled={busy}>
          {t.wpLiftTitle}
        </button>
      </p>
      {confirm && (
        <div className="qnote q-info cw-confirm" role="alertdialog" aria-label={t.wpLiftTitle}>
          <p>{t.wpLiftConfirm(st.task, why)}</p>
          <p>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void lift()} autoFocus>
              {t.wpLiftYes}
            </button>{" "}
            <button type="button" className="btn" onClick={() => setConfirm(false)}>
              {t.cwCancel}
            </button>
          </p>
        </div>
      )}
      {msg && (
        <p className={`qnote ${msg.ok ? "q-info" : "q-warn"}`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
    </form>
  );
}

/** Progress per window: the stop (and lifting it), the warning, each window's points with "How computed?", the handovers. */
function ProgressSection({ wp, t, lang, canAct, approved, lifted, onLifted }: { wp: WindowProgressStatus; t: Dict; lang: Lang; canAct: boolean; approved: boolean; lifted: boolean; onLifted: () => void }) {
  const readOnly = useContext(ReadOnlyContext);
  const st = wp.stop;
  const doneRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (lifted && !st) doneRef.current?.focus();
  }, [lifted, st]);
  const ended = wp.windows.filter((a) => a.state !== "running" || a.value !== null);
  return (
    <section className="a-sec cw-progress">
      <h3>{t.wpTitle}</h3>
      <p className="hint small">{t.wpIntro(wp.min, wp.tolerance, wp.k)}</p>
      {wp.changed && wp.changed.by !== "restarted" && <p className="qnote q-warn small">{t.wpChanged}</p>}
      {st && (
        <div className="qnote q-warn cw-stop" role="alert">
          <p>
            <strong>{t.wpStop(stopIds(st), stopTask(st, lang), localTime(st.since, lang))}</strong>
          </p>
          {HOOK_OFF(wp) && <p className="small">{t.wpNotWired}</p>}
          {st.recorded && <p className="small">{t.wpStopRecorded}</p>}
          {st.likelyParallel && <p className="small">{t.wpLikelyParallel}</p>}
          <p className="small">{t.wpStopWhat}</p>
          {canAct && approved && !readOnly ? <LiftForm st={st} t={t} onLifted={onLifted} /> : canAct && !readOnly ? <LockedNote t={t} text={t.wpLiftLocked} small /> : <p className="small muted">{t.wpLiftReader}</p>}
          {!st.likelyParallel && <p className="small muted">{t.wpParallel}</p>}
        </div>
      )}
      {!st && wp.warning && <p className="qnote q-info small">{t.wpWarning(wp.warning.window, wp.warning.focus ?? "–")}</p>}
      {wp.escalation && <p className="qnote q-warn small">{t.wpEscalation(wp.escalation.window, pct(wp.escalation.fill, lang), wp.escalation.task)}</p>}
      {wp.noCriteria && <p className="qnote q-info small">{t.wpNoCriteria(wp.noCriteria.task ?? "–")}</p>}
      {lifted && !st && (
        <p ref={doneRef} tabIndex={-1} className="qnote q-info" role="status">
          {t.wpLiftDone}
        </p>
      )}
      {wp.lift && <p className="small muted">{t.wpLifted(localTime(wp.lift.at, lang), byText(wp.lift.by, t), wp.lift.why)}</p>}
      {!ended.length ? (
        <p className="muted small">{t.wpNone}</p>
      ) : (
        <div className="cw-table-wrap">
          <table className="cw-table cw-ptable">
            <thead>
              <tr>
                {(["window", "agent", "points", "state", "task"] as const).map((c) => (
                  <th key={c} scope="col">
                    {t.wpCols[c]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ended.slice(0, 20).map((a) => (
                <tr key={`${a.window}@${a.startedAt}`}>
                  <td>{a.window}</td>
                  <td>{a.agent}</td>
                  <td>
                    {a.value !== null ? (
                      <>
                        {t.wpPoints(a.value)} {a.points && <Why d={a.points} shown={a.value} t={t} lang={lang} label={`${a.window}`} />}
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td>
                    {t.wpState[a.state] ?? a.state}
                    {a.why && <span className="muted"> ({t.wpWhy[a.why] ?? a.why}{a.why === "capped" && a.gate ? ` · ${t.wpGate(a.gate)}` : ""})</span>}
                    {a.lifted && <span className="muted"> · {t.wpBeforeLift}</span>}
                  </td>
                  <td>{a.focus ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {wp.windows.some((a) => a.source === "proxy") && <p className="small muted">{t.wpProxyNote}</p>}
      {wp.handovers.some((h) => h.loss) && (
        <>
          <h4>{t.wpHandovers}</h4>
          <ul className="small cw-facts">
            {wp.handovers
              .filter((h) => h.loss)
              .slice(0, 5)
              .map((h) => (
                <li key={`${h.to}@${h.toStartedAt}`}>
                  {t.wpHandoverLine(h.from, h.to)}: {h.loss!.sentence[lang]} <Why d={h.loss!} shown={h.loss!.value} t={t} lang={lang} label={t.wpHandovers} />
                  {!h.final && <span className="muted"> ({t.wpProvisional})</span>}
                  {h.final && <span className={h.ok ? "muted" : ""}> · {h.ok ? t.wpHandoverOk : t.wpHandoverBad}</span>}
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The handover for a new window (read-only, computed by the server when asked). */
export function HandoverDialog({ t, window, onClose }: { t: Dict; window?: string; onClose: () => void }) {
  const [h, setH] = useState<Handover | null>(null);
  const [err, setErr] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api.handover(window).then(setH).catch(() => setErr(true));
  }, [window]);
  return (
    <Modal wide title={t.cwHandoverTitle} onClose={onClose}>
      <div className="modal-body">
        <p className="hint">{t.cwHandoverHint}</p>
        {err && <p className="qnote q-warn">{t.cwLoadErr}</p>}
        {!h && !err && <p className="muted">…</p>}
        {h && (
          <>
            <p>
              <button
                className="btn"
                onClick={() => {
                  try {
                    void navigator.clipboard?.writeText(h.markdown).then(() => setCopied(true));
                  } catch {
                    /* the text stays selectable below */
                  }
                }}
              >
                {t.cwCopy}
              </button>{" "}
              {copied && <span className="small">{t.cwCopied}</span>}
            </p>
            <pre className="cw-handover" tabIndex={0} lang="en">
              {h.markdown}
            </pre>
          </>
        )}
      </div>
    </Modal>
  );
}

const KEYS: (keyof ContextValues)[] = ["yellow", "red", "emergency", "p95start", "margin", "aModel"];
/** E4: the person's values for progress per window (whole points). */
const PKEYS: (keyof ProgressValues)[] = ["minProgress", "tolerance"];
const pShort = (t: Dict, k: keyof ProgressValues) => t.pFields[k].replace(/\s*\([^)]*\)\s*$/, "");
const pText = (t: Dict, k: keyof ProgressValues, x: number) => `${pShort(t, k)} ${t.wpPoints(x).replace(/^\+/, "")}`;
/** "Red from (%)" → "Red from". */
const short = (t: Dict, k: keyof ContextValues) => t.cwFields[k].replace(/\s*\([^)]*\)\s*$/, "");
/** "Red from 72 %", "A_model 200,000 tokens". */
const valueText = (t: Dict, k: keyof ContextValues, x: number, lang: Lang) => `${short(t, k)} ${k === "aModel" ? tokens(x, lang) : `${pct(x, lang)} %`}`;

/** The person's values of the rule: shown to everyone; changed only in the approval session (never as an auditor). */
function SettingsSection({ t, lang, approved, editable, onSaved }: { t: Dict; lang: Lang; approved: boolean; editable: boolean; onSaved: () => void }) {
  const readOnly = useContext(ReadOnlyContext);
  const [cs, setCs] = useState<ContextSettingsView | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [models, setModels] = useState<{ id: string; cMax: string }[]>([]);
  /** `field`: the form field it is about (focus goes there); otherwise focus goes to the message (a server answer). */
  const [msg, setMsg] = useState<{ ok: boolean; text: string; field?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** What would be signed, shown first; only "Yes, save" sends it (no browser dialog). Any edit clears it. */
  const [pending, setPending] = useState<{ body: { values?: Partial<ContextValues>; progress?: Partial<ProgressValues>; models?: LocalModel[]; reset?: boolean }; text: string } | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const load = () =>
    api
      .contextSettings()
      .then((x) => {
        setCs(x);
        setForm({ ...Object.fromEntries(KEYS.map((k) => [k, k === "aModel" ? tok(x.values[k], lang) : pct(x.values[k], lang)])), ...Object.fromEntries(PKEYS.map((k) => [k, String(x.progress[k])])) });
        setModels(x.models.map((m) => ({ id: m.id, cMax: tok(m.cMax, lang) })));
      })
      .catch(() => setCs(null));
  useEffect(() => {
    void load();
  }, [approved]);
  useApprovalSignal(() => void load());
  useEffect(() => {
    if (!msg) return;
    if (msg.field) document.getElementById(`cw-f-${msg.field}`)?.focus();
    else statusRef.current?.focus();
  }, [msg]);
  if (!cs) return null;
  const canEdit = editable && approved && !readOnly && cs.approval;
  const edit = (fn: () => void) => {
    setPending(null);
    fn();
  };
  const submit = async (body: { values?: Partial<ContextValues>; progress?: Partial<ProgressValues>; models?: LocalModel[]; reset?: boolean }) => {
    setPending(null);
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.setContextSettings(body);
      setMsg({ ok: true, text: t.cwSavedOk(ver(r.rule)) });
      onSaved();
      await load();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      const key = e instanceof ApiError ? e.key : undefined;
      const base = (code && t.cwErr[code]) || String((e as Error)?.message ?? e);
      const label = key && key in t.cwFields ? short(t, key as keyof ContextValues) : key && key in t.pFields ? pShort(t, key as keyof ProgressValues) : null;
      setMsg({ ok: false, text: label ? `${base} (${label})` : base, ...(label ? { field: key } : {}) });
    } finally {
      setBusy(false);
    }
  };
  /** Read the form; an empty or unreadable field is named, never sent as 0. */
  const readForm = (): { values: ContextValues; progress: ProgressValues; models: LocalModel[] } | null => {
    const values: Partial<ContextValues> = {};
    const progress: Partial<ProgressValues> = {};
    for (const k of PKEYS) {
      const x = parsePercent(form[k] ?? "");
      if (x === null) {
        setMsg({ ok: false, text: `${t.cwErr.not_a_number} (${pShort(t, k)})`, field: k });
        return null;
      }
      progress[k] = x;
    }
    for (const k of KEYS) {
      const x = k === "aModel" ? parseTokens(form[k] ?? "") : parsePercent(form[k] ?? "");
      if (x === null) {
        setMsg({ ok: false, text: `${t.cwErr.not_a_number} (${short(t, k)})`, field: k });
        return null;
      }
      values[k] = x;
    }
    const ms: LocalModel[] = [];
    for (const m of models) {
      if (!m.id.trim() && !m.cMax.trim()) continue;
      const n = parseTokens(m.cMax);
      if (!m.id.trim() || n === null) {
        setMsg({ ok: false, text: !m.id.trim() ? t.cwErr.model_id : `${t.cwErr.model_size} (${m.id.trim()})` });
        return null;
      }
      ms.push({ id: m.id.trim(), cMax: n });
    }
    return { values: values as ContextValues, progress: progress as ProgressValues, models: ms };
  };
  /** Looser than the start values, named before signing (an AI manager sees it at once). */
  const looserText = (v: ContextValues, pv?: ProgressValues) => {
    const d = cs.defaults;
    const l = (["yellow", "red", "emergency", "aModel"] as const).filter((k) => v[k] > d[k]).map((k) => valueText(t, k, v[k], lang));
    if (v.p95start === 0 && v.margin === 0) l.push(t.cwNoBuffer);
    // E4: fewer points per window, or more loss at a handover, lets more through.
    if (pv && pv.minProgress < cs.progressDefaults.minProgress) l.push(pText(t, "minProgress", pv.minProgress));
    if (pv && pv.tolerance > cs.progressDefaults.tolerance) l.push(pText(t, "tolerance", pv.tolerance));
    return l.length ? ` ${t.cwLooserWarn(l.join(", "))}` : "";
  };
  return (
    <section className="a-sec cw-settings">
      <h3>
        {t.cwSettings} <span className="chip">{ver(cs.rule)}</span>
      </h3>
      <p className={cs.trust === "invalid" ? "qnote q-warn" : cs.looser.length ? "qnote q-info" : "small"}>{byText(cs.text?.[lang] ?? "", t)}</p>
      <p className="hint small">{canEdit ? t.cwSettingsHint : t.cwSettingsHintReader}</p>
      {canEdit ? (
        <form
          className="cw-form"
          onSubmit={(e) => {
            e.preventDefault();
            const r = readForm();
            if (!r) return;
            const shown = [...KEYS.map((k) => valueText(t, k, r.values[k], lang)), ...PKEYS.map((k) => pText(t, k, r.progress[k])), ...r.models.map((m) => `${m.id} ${tokens(m.cMax, lang)}`)].join(" · ");
            setMsg(null);
            setPending({ body: r, text: `${t.cwConfirmSave(ver(cs.rule))} ${shown}.${looserText(r.values, r.progress)}` });
          }}
        >
          <div className="cw-fields">
            {KEYS.map((k) => (
              <label key={k}>
                <span>{t.cwFields[k]}</span>
                <input
                  id={`cw-f-${k}`}
                  inputMode={k === "aModel" ? "numeric" : "decimal"}
                  value={form[k] ?? ""}
                  onChange={(e) => edit(() => setForm({ ...form, [k]: e.target.value }))}
                  aria-invalid={msg?.field === k ? true : undefined}
                  aria-describedby={msg?.field === k ? `cw-b-${k} cw-status` : `cw-b-${k}`}
                />
                <small id={`cw-b-${k}`} className="muted">
                  {k === "aModel" ? t.cwBounds(tok(cs.bounds[k][0], lang), tok(cs.bounds[k][1], lang)) : t.cwBounds(pct(cs.bounds[k][0], lang), pct(cs.bounds[k][1], lang))} · {t.cwStartValue(k === "aModel" ? tok(cs.defaults[k], lang) : `${pct(cs.defaults[k], lang)} %`)}
                </small>
              </label>
            ))}
          </div>
          <h4>{t.wpTitle}</h4>
          <p className="hint small">{t.pFieldsHint}</p>
          <div className="cw-fields">
            {PKEYS.map((k) => (
              <label key={k}>
                <span>{t.pFields[k]}</span>
                <input
                  id={`cw-f-${k}`}
                  inputMode="numeric"
                  value={form[k] ?? ""}
                  onChange={(e) => edit(() => setForm({ ...form, [k]: e.target.value }))}
                  aria-invalid={msg?.field === k ? true : undefined}
                  aria-describedby={msg?.field === k ? `cw-b-${k} cw-status` : `cw-b-${k}`}
                />
                <small id={`cw-b-${k}`} className="muted">
                  {t.cwBounds(String(cs.progressBounds[k][0]), String(cs.progressBounds[k][1]))} · {t.cwStartValue(String(cs.progressDefaults[k]))}
                </small>
              </label>
            ))}
          </div>
          <h4>{t.cwModels}</h4>
          <p className="hint small">{t.cwModelsHint}</p>
          {models.map((m, i) => (
            <div key={i} className="cw-model">
              <label>
                <span>{t.cwModelId}</span>
                <input value={m.id} onChange={(e) => edit(() => setModels(models.map((x, j) => (j === i ? { ...x, id: e.target.value } : x))))} />
              </label>
              <label>
                <span>{t.cwModelSize}</span>
                <input inputMode="numeric" value={m.cMax} onChange={(e) => edit(() => setModels(models.map((x, j) => (j === i ? { ...x, cMax: e.target.value } : x))))} />
              </label>
              <button type="button" className="btn" onClick={() => edit(() => setModels(models.filter((_, j) => j !== i)))}>
                {t.cwRemove}
              </button>
            </div>
          ))}
          <p>
            <button type="button" className="btn" onClick={() => edit(() => setModels([...models, { id: "", cMax: "" }]))}>
              {t.cwAddModel}
            </button>
          </p>
          <p className="cw-actions">
            <button type="submit" className="btn primary" disabled={busy}>
              {t.cwSave}
            </button>{" "}
            <button type="button" className="btn" disabled={busy} onClick={() => setPending({ body: { reset: true }, text: t.cwConfirmReset })}>
              {t.cwReset}
            </button>
          </p>
          {pending && (
            <div className="qnote q-info cw-confirm" role="alertdialog" aria-label={t.cwSave}>
              <p>{pending.text}</p>
              <p>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void submit(pending.body)} autoFocus>
                  {t.cwYes}
                </button>{" "}
                <button type="button" className="btn" onClick={() => setPending(null)}>
                  {t.cwCancel}
                </button>
              </p>
            </div>
          )}
        </form>
      ) : (
        <>
          <ul className="small cw-values">
            {KEYS.map((k) => (
              <li key={k}>{valueText(t, k, cs.values[k], lang)}</li>
            ))}
            {PKEYS.map((k) => (
              <li key={k}>{pText(t, k, cs.progress[k])}</li>
            ))}
            {cs.models.map((m) => (
              <li key={m.id}>{t.cwLocalModel(m.id, tokens(m.cMax, lang))}</li>
            ))}
          </ul>
          {editable && !readOnly && !approved && <LockedNote t={t} text={t.cwLocked} small />}
        </>
      )}
      {msg && (
        <p id="cw-status" ref={statusRef} tabIndex={-1} className={`qnote ${msg.ok ? "q-info" : "q-warn"}`} role="status">
          {msg.text}
        </p>
      )}
      {cs.history.length > 0 && (
        <details className="small">
          <summary>{t.cwHistory(cs.history.length)}</summary>
          <ol className="cw-history">
            {cs.history.map((h) => (
              <li key={h.rev}>
                {t.cwHistoryLine(h.rev, localTime(h.at, lang), byText(h.by, t), h.via)}
                {h.keyId && <span className="muted"> · {t.cwKey(h.keyId)}</span>} — <code className="cmd">{h.rule}</code>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

/** The whole picture: every window, the automatic saves, the rule's values (Audit: read; Manage: the person edits). */
export function WindowDialog(props: { t: Dict; lang: Lang; approved: boolean; editable: boolean; canAct?: boolean; onClose: () => void; onNode?: (id: string) => void; onChanged?: () => void }) {
  const { t, lang } = props;
  const [ws, setWs] = useState<WindowStatus | null>(null);
  const [err, setErr] = useState(false);
  const [handover, setHandover] = useState<string | undefined | null>(null);
  const load = () =>
    api
      .windows()
      .then((x) => {
        setWs(x);
        setErr(false);
      })
      .catch(() => setErr(true));
  const [lifted, setLifted] = useState(false);
  const progressSection = (wp: WindowProgressStatus) => (
    <ProgressSection
      wp={wp}
      t={t}
      lang={lang}
      canAct={props.canAct ?? props.editable}
      approved={props.approved}
      lifted={lifted}
      onLifted={() => {
        setLifted(true);
        void load();
        props.onChanged?.();
      }}
    />
  );
  useEffect(() => {
    void load();
    // The fill grows with every answer, not only at a step: look again while the dialog is open.
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <Modal
        wide
        title={
          <>
            {t.cwTitle} <HelpButton topic="window" />
          </>
        }
        onClose={props.onClose}
      >
        <div className="modal-body analysis cw">
          <p className="hint">{t.cwIntro}</p>
          {err && <p className="qnote q-warn">{t.cwLoadErr}</p>}
          {!ws && !err && <p className="muted">…</p>}
          {ws && (
            <>
              {ws.changed && ws.changed.by !== "restarted" && <p className="qnote q-warn">{t.cwChanged}</p>}
              {ws.changed?.by === "restarted" && <p className="qnote q-info small">{t.cwRestarted}</p>}
              {/* A stop comes first: it is what the person has to act on. */}
              {ws.progress?.stop && progressSection(ws.progress)}
              {!ws.windows.length && <p className="muted">{t.cwNoWindows}</p>}
              {ws.current && (
                <>
                  <h3 className="cw-h">{t.cwCurrent}</h3>
                  <WindowDetail w={ws.current} t={t} lang={lang} onNode={props.onNode} />
                  <p>
                    <button className="btn" onClick={() => setHandover(ws.current?.id)}>
                      {t.cwHandover}
                    </button>
                  </p>
                </>
              )}
              {ws.progress && !ws.progress.stop && progressSection(ws.progress)}
              {ws.windows.length > 1 && (
                <section className="a-sec">
                  <h3>{t.cwAll}</h3>
                  <div className="cw-table-wrap">
                    <table className="cw-table">
                      <thead>
                        <tr>
                          {(["id", "agent", "model", "start", "end", "measured", "fill", "saved"] as const).map((c) => (
                            <th key={c} scope="col">
                              {t.cwCols[c]}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {ws.windows.map((w) => (
                          <tr key={w.id}>
                            <td>{w.id}</td>
                            <td>{w.agent}</td>
                            <td>{w.model ?? "–"}</td>
                            <td>{t.cwStart[w.start] ?? w.start}</td>
                            <td>{w.end ? t.cwStart[w.end] ?? w.end : "–"}</td>
                            <td>{measuredAt(w.lastAt, lang)}</td>
                            <td>
                              {w.fill && w.zone ? (
                                <>
                                  {pct(w.fill.value, lang)} % <ZoneChip zone={w.zone} t={t} /> <Why d={w.fill} shown={w.fill.value} t={t} lang={lang} label={`${w.id}`} />
                                </>
                              ) : (
                                <span className="muted">{t.cwWhy[w.why ?? "no-sample"] ?? w.why}</span>
                              )}
                            </td>
                            <td>{w.cuts.length ? w.cuts.map((c) => `${c.node} (${ver(c.rule)})`).join(", ") : "–"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              <SettingsSection
                t={t}
                lang={lang}
                approved={props.approved}
                editable={props.editable}
                onSaved={() => {
                  void load();
                  props.onChanged?.();
                }}
              />
            </>
          )}
        </div>
      </Modal>
      {/* Outside the parent dialog: Escape closes the handover alone. */}
      {handover !== null && <HandoverDialog t={t} window={handover} onClose={() => setHandover(null)} />}
    </>
  );
}
