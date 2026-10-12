import { HelpButton } from "./HelpButton";
import { ErrorBox, NewDecisionForm, PastCheck, ReadyCheck, ResultCard, RunProgress, StartCards, useReadiness } from "./ForecastStart";
/**
 * Forecasts ("Prognosen"): see BEFORE choosing how each option — or a prompt — will keep the context
 * and the main goal. Quick forecast (instant, no model) for every decision; the multiverse
 * (archivist = past, craftsman = present, oracle = future) on request or automatically.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type Audit, type Explain, type Forecast, type ForecastOption, type ForecastQuality, type BenchSummary, type ForecastsPage, type OracleAdjust, type OracleBacktestRun, type OracleQuality, type QuickForecast, type ScenariaNode } from "./api";
import { Modal } from "./Dialogs";
import { NodeId } from "./Map";
import type { Dict } from "./i18n";
import type { SessionKeys } from "./Control";

const errText = (e: any) => String(e?.message ?? e);
type Universe = NonNullable<ForecastOption["universe"]>;
type LlmFn = () => { apiKey: string; keyFor: string } | undefined;
const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;
const tone = (n: number) => (n >= 70 ? "good" : n >= 45 ? "mid" : "low");

/** One horizontal bar: predicted context retention. */
export function ScoreBar({ value, label, measured, band }: { value: number; label?: string; measured?: number; band?: number }) {
  return (
    <div className="fbar" title={label}>
      {band !== undefined && <div className="fbar-band" style={{ left: `${Math.max(0, value - band)}%`, width: `${Math.min(100, value + band) - Math.max(0, value - band)}%` }} />}
      <div className={`fbar-fill ${tone(value)}`} style={{ width: `${Math.max(2, value)}%` }} />
      {measured !== undefined && <div className="fbar-actual" style={{ left: `${measured}%` }} title={`${measured}%`} />}
      <span className="fbar-num">
        {label ? `${label} ` : ""}
        {value}%{band !== undefined ? ` ±${band}` : ""}
      </span>
    </div>
  );
}

/** "Why this number?" — every part of the forecast (model v2), so it can be retraced by hand. */
export function Derivation({ t, e, u }: { t: Dict; e: Explain; u?: Universe }) {
  const pc = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)} %`);
  const risk = e.risk.lessons + e.risk.canon;
  const goalWord = e.goalKind === "task" ? t.fcTaskGoal : t.fcGoal;
  return (
    <div className="fc-why">
      <table className="log">
        <tbody>
          <tr>
            <th>{t.fcOwnWords}</th>
            <td>
              {goalWord} {pc(e.own.anchor)} · {t.fcConnection} {pc(e.own.continuity)}
            </td>
            <td className="num">{e.own.score}</td>
          </tr>
          <tr>
            <th>{t.fcInContext}</th>
            <td>
              {goalWord} {pc(e.inContext.anchor)} · {t.fcConnection} {pc(e.inContext.continuity)}
            </td>
            <td className="num">{e.inContext.score}</td>
          </tr>
          <tr>
            <th>{t.fcLine}</th>
            <td>{t.fcLineHint(e.lineN)}</td>
            <td className="num">{e.line}</td>
          </tr>
          <tr>
            <th>{t.fcReliability}</th>
            <td>{t.fcReliabilityHint}</td>
            <td className="num">{pc(e.reliability)}</td>
          </tr>
          {risk > 0 && (
            <tr>
              <th>{t.fcRisk}</th>
              <td>
                {t.fcLessons} −{e.risk.lessons} · {t.fcFixedPoints} −{e.risk.canon}
              </td>
              <td className="num">−{risk}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="fc-formula">
        P = L + α·({t.fcOwnShort} − L) + β·({t.fcCtxShort} − L) − {t.fcRiskShort} = {e.line} + {e.alpha}·({e.own.score} − {e.line}) + {e.beta}·({e.inContext.score} − {e.line}) − {risk} = <strong>{e.predicted}</strong> ± {e.band}
      </p>
      {u?.own && u.ctx && u.ownAfter !== undefined && u.ctxAfter !== undefined && (
        <div className="fc-oracle">
          <OracleRow t={t} name={t.fcOracleOwn} a={u.own} conf={u.confidence} gamma={u.gamma ?? 1} />
          <OracleRow t={t} name={t.fcOracleCtx} a={u.ctx} conf={u.confidence} gamma={u.gamma ?? 1} />
          <p className="fc-formula">
            {t.fcFormulaOracle} {e.line} + {e.alpha}·({u.ownAfter} − {e.line}) + {e.beta}·({u.ctxAfter} − {e.line}) − {risk} = <strong>{u.capped ? Math.round(e.line + e.alpha * (u.ownAfter - e.line) + e.beta * (u.ctxAfter - e.line) - risk) : u.context}</strong>
            {u.capped ? <> → <strong>{u.context}</strong></> : null}
          </p>
          <p className="muted small">{t.fcCapNote}</p>
          {u.capped && <p className="qnote q-warn">⚑ {t.fcCapped(u.canonRisks.join(", "))}</p>}
          {u.flagResolved && <p className="qnote q-info">{t.fcFlagResolved}</p>}
        </div>
      )}
      <p className="muted small">
        {e.calibrated ? t.fcLearned(e.learnedFrom) : t.fcNotCalibrated(e.learnedFrom)}
        {e.breakRisk ? ` · ⚠ ${t.fcBreakRisk}` : ""}
      </p>
    </div>
  );
}

/** One oracle correction: what was proposed, what counts and why — with its evidence. */
function OracleRow({ t, name, a, conf, gamma }: { t: Dict; name: string; a: OracleAdjust; conf: number; gamma: number }) {
  if (!a.proposed) return null;
  return (
    <div className={`fc-adj ${a.backed ? "" : "unbacked"}`}>
      <strong>{name}</strong> <span className="fc-adj-num">{a.backed ? signed(a.applied) : "0"}</span>
      <span className="muted small"> · {a.backed ? t.fcOracleApplied(a.proposed, conf, gamma, Math.round(a.proposed * conf * gamma), a.applied) : `${signed(a.proposed)} → ${t.fcUnbacked}`}</span>
      {a.why && <div className="small">„{a.why}“</div>}
      {a.refs.length > 0 && (
        <div className="fchips">
          {a.refs.map((r) => (
            <span key={r} className="chip">
              {r}
            </span>
          ))}
        </div>
      )}
      {a.dropped.length > 0 && <div className="muted small">✘ {t.fcDropped(a.dropped.join(", "))}</div>}
      {(a.ignored?.length ?? 0) > 0 && <div className="muted small">· {t.fcIgnored(a.ignored!.join(", "))}</div>}
    </div>
  );
}

const VERDICT_CLASS: Record<string, string> = { reliable: "v-passed", caution: "v-warning", unreliable: "v-failed" };
const CHECK_ICON: Record<string, string> = { ok: "✔", warn: "!", fail: "✘", info: "·" };

/** The Prüf-Experte of one forecast: verdict, checklist and the AI check of the oracle's claims. */
export function AuditBox(props: { t: Dict; id: string; mode?: Forecast["mode"]; approval?: boolean; llm?: LlmFn; compact?: boolean; version?: string; startOpen?: boolean }) {
  const { t } = props;
  const lang = t.langCode;
  const [a, setA] = useState<Audit | null>(null);
  const [open, setOpen] = useState(Boolean(props.startOpen));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .audit(props.id, lang)
      .then((x) => alive && setA(x))
      .catch((e) => alive && setErr(errText(e)));
    return () => {
      alive = false;
    };
  }, [props.id, lang, props.version]);
  if (!a) return err ? <p className="error small">{err}</p> : null;
  const deep = a.deep[0];
  const head = (
    <span className={`chip ${VERDICT_CLASS[a.verdict]}`} title={a.checks.map((c) => `${CHECK_ICON[c.status]} ${c.text}`).join("\n")}>
      {t.auTitle}: {t.auVerdict[a.verdict]}
    </span>
  );
  if (props.compact) return head;
  return (
    <div className={`audit-box ${a.verdict}`}>
      <div className="row">
        {head}
        {deep && <span className={`chip ${deep.verified ? "" : "v-failed"}`}>{deep.verified ? t.auDeepResult(deep.verdicts.filter((x) => x.verdict === "supported").length, deep.verdicts.length) : t.auUnsigned}</span>}
        <button className="btn link" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t.auHide : t.auShow}
        </button>
        <HelpButton topic="forecast-check" />
      </div>
      {open && (
        <>
          <p className="muted small">{t.auHint}</p>
          <ul className="audit-checks">
            {a.checks.map((c, i) => (
              <li key={i} className={`au-${c.status}`}>
                <span className="au-icon">{CHECK_ICON[c.status]}</span> {c.text}
              </li>
            ))}
          </ul>
          {deep?.verified && (
            <div className="audit-deep">
              <p className="small">
                <strong>{t.auDeep}</strong> <span className="muted">({deep.model ?? "–"}, {new Date(deep.createdAt).toLocaleString()})</span>
              </p>
              <ul className="audit-checks">
                {deep.verdicts.map((v) => (
                  <li key={v.claim} className={v.verdict === "supported" ? "au-ok" : v.verdict === "contradicted" ? "au-fail" : "au-warn"}>
                    <span className="au-icon">{v.verdict === "supported" ? "✔" : v.verdict === "contradicted" ? "✘" : "!"}</span> <strong>{v.claim}</strong> {t.auClaim[v.verdict]}
                    {v.refs.length ? <span className="muted small"> [{v.refs.join(", ")}]</span> : null}
                    {v.reason && <div className="muted small">{v.reason}</div>}
                  </li>
                ))}
              </ul>
              <p className="small">
                {t.auAudited}:{" "}
                {Object.entries(deep.audited)
                  .map(([k, n]) => `${k} ${n}%`)
                  .join(" · ")}
              </p>
            </div>
          )}
          {props.mode === "multiverse" && (
            <div className="row">
              <button
                className="btn"
                disabled={!props.approval || busy}
                title={t.auDeepHint}
                onClick={async () => {
                  setBusy(true);
                  setErr(null);
                  try {
                    setA(await api.deepAudit(props.id, lang, props.llm?.()));
                  } catch (e) {
                    setErr(errText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "…" : t.auDeep}
              </button>
              <span className="muted small">{t.auDeepHint}</span>
            </div>
          )}
          {err && <p className="error small">{err}</p>}
        </>
      )}
    </div>
  );
}

function QuickChips({ t, q, goal }: { t: Dict; q: QuickForecast; goal?: number }) {
  // With a multiverse, the oracle's goal judgement replaces the word-overlap estimate.
  const g = goal ?? q.goal;
  return (
    <span className="fchips">
      {g !== null && q.explain?.goalKind !== "none" && (
        <span className="chip" title={t.fcGoalHint}>
          {q.explain?.goalKind === "task" ? t.fcTaskGoal : t.fcGoal} {g}%
        </span>
      )}
      {q.signal === "low" && <span className="chip v-warning">{t.fcLowSignal}</span>}
      {q.warnings.length > 0 && (
        <span className="chip v-warning" title={q.warnings.join("\n")}>
          ⚠ {t.fcLessons} {q.warnings.length}
        </span>
      )}
      {q.canonHints.length > 0 && (
        <span className="chip" title={q.canonHints.join("\n")}>
          ⚑ {q.canonTouched.join(", ")}
        </span>
      )}
      {q.explored && (
        <span className="chip" title={t.fcExploredHint}>
          {t.fcExplored} {q.explored.measured}%
        </span>
      )}
    </span>
  );
}

/** Option rows of a forecast (quick or multiverse), with the universes when present. */
export function OptionForecasts(props: { t: Dict; options: ForecastOption[]; recommended?: string; actual?: Forecast["actual"]; onChoose?: (o: ForecastOption) => void; compact?: boolean }) {
  const { t } = props;
  // Universes start open for up to two options (full view); the toggle really toggles.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [why, setWhy] = useState<Record<string, boolean>>({});
  const isOpen = (k: string) => open[k] ?? (!props.compact && props.options.length <= 2);
  const best = Math.max(...props.options.map((o) => o.score));
  const close = props.options.length > 1 && best - Math.min(...props.options.map((o) => o.score)) < 6;
  const allLow = props.options.every((o) => o.quick.signal === "low");
  return (
    <div className="fopts">
      {props.options.map((o) => {
        const act = props.actual?.find((a) => a.option === o.key);
        const u = o.universe;
        return (
          <div key={o.key} className={`fopt ${props.recommended === o.key ? "rec" : ""}`}>
            <div className="fopt-head">
              <span className="fopt-key">{o.key}</span>
              <strong className="fopt-label">{o.label}</strong>
              {props.recommended === o.key && <span className="chip mark">★ {t.fcRecommended}</span>}
              {props.onChoose && (
                <button className="btn link" onClick={() => props.onChoose!(o)}>
                  {t.chooseOption}
                </button>
              )}
            </div>
            <ScoreBar value={o.score} label={t.fcContextKept} measured={act?.measured} band={!u ? o.quick.explain?.band : undefined} />
            <div className="fopt-meta">
              {u && u.core !== undefined && (
                <span className={`chip ${u.capped ? "v-warning" : ""}`} title={u.capped ? t.fcCapped(u.canonRisks.join(", ")) : undefined}>
                  {t.fcCore} {u.core}% → {t.fcWithOracle} {o.score}%
                </span>
              )}
              <QuickChips t={t} q={o.quick} goal={u?.goal} />
              {act && (
                <span className={`chip ${act.error <= 15 ? "v-passed" : "v-warning"}`} title={t.fcActualHint}>
                  {t.fcActual} {act.measured}% · ±{act.error}
                </span>
              )}
              {u && (
                <button className="btn link" onClick={() => setOpen({ ...open, [o.key]: !isOpen(o.key) })}>
                  {isOpen(o.key) ? t.fcHideUniverse : t.fcShowUniverse}
                </button>
              )}
              {o.quick.explain && (
                <button className="btn link" aria-expanded={Boolean(why[o.key])} onClick={() => setWhy({ ...why, [o.key]: !why[o.key] })}>
                  {why[o.key] ? t.fcHideWhy : t.fcWhyNumber}
                </button>
              )}
            </div>
            {o.quick.explain && why[o.key] && <Derivation t={t} e={o.quick.explain} u={u} />}
            {u && isOpen(o.key) && (
              <div className="universe">
                <div>
                  <h5>{t.fcPast}</h5>
                  <p>{u.past || "—"}</p>
                </div>
                <div>
                  <h5>{t.fcPresent}</h5>
                  {u.trajectory.length > 0 && (
                    <ol>
                      {u.trajectory.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ol>
                  )}
                  {u.loses.length > 0 && (
                    <p className="loses">
                      <strong>{t.fcLoses}:</strong> {u.loses.join(" · ")}
                    </p>
                  )}
                </div>
                <div>
                  <h5>{t.fcFuture}</h5>
                  <p>{u.outcome || u.future || "—"}</p>
                  {u.risks.length > 0 && <p className="muted small">⚠ {u.risks.join(" · ")}</p>}
                  {(u.pastRefs?.length ?? 0) > 0 && <p className="muted small">↩ {u.pastRefs!.join(", ")}</p>}
                  {u.canonRisks.length > 0 && <p className="small">⚑ {t.fcCanonRisk}: {u.canonRisks.join(", ")}</p>}
                  <p className="muted small">
                    {t.fcGoal} {u.goal}% · {t.fcConfidence} {Math.round(u.confidence * 100)}%
                  </p>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {(close || allLow) && <p className="qnote q-info">{t.fcIndistinct}</p>}
    </div>
  );
}

/** The plain-language result of a saved forecast, with the auditor's verdict. */
function LastResult({ t, f, onDetails, onNode }: { t: Dict; f: Forecast; onDetails?: () => void; onNode?: (id: string) => void }) {
  const [audit, setAudit] = useState<Audit | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .audit(f.id, t.langCode)
      .then((a) => alive && setAudit(a))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [f.id, t.langCode]);
  return (
    <>
      {onNode && (
        <p className="small">
          {f.subject.kind === "decision" ? (
            <>
              <button className="btn link inline" onClick={() => onNode((f.subject as { node: string }).node)}>
                <NodeId id={f.subject.node} />
              </button>{" "}
              {f.subject.question}
            </>
          ) : (
            <em>„{f.subject.text.slice(0, 100)}“</em>
          )}
        </p>
      )}
      <ResultCard t={t} f={f} audit={audit} onDetails={onDetails} />
    </>
  );
}

/** The forecasts page: open decisions, prompt check, history and hit rate. */
/** Without a main goal every forecast is imprecise: say so, with the way out. */
export function NoGoalNote({ t, onEditGoal }: { t: Dict; onEditGoal?: () => void }) {
  return (
    <p className="qnote q-warn">
      {t.fcNoGoal}{" "}
      {onEditGoal && (
        <button className="btn link inline" onClick={onEditGoal}>
          {t.fcSetGoal}
        </button>
      )}
    </p>
  );
}

export function ForecastsDialog(props: { t: Dict; lang: "de" | "en"; keys: SessionKeys; nodes: ScenariaNode[]; headId: string | null; focus?: string | null; toast: (m: string) => void; onClose: () => void; onNode: (id: string) => void; onChanged: () => void; onOpenSettings: () => void; onEditGoal: () => void }) {
  const { t } = props;
  const [page, setPage] = useState<ForecastsPage | null>(null);
  const [quick, setQuick] = useState<Record<string, ForecastOption[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const focusNode = props.focus ? props.nodes.find((n) => n.id === props.focus) : undefined;
  type Tab = "start" | "open" | "prompt" | "past" | "history" | "quality";
  const [tab, setTab] = useState<Tab>(focusNode?.type === "decision" ? (focusNode.chosen ? "past" : "open") : "start");
  const [auditOpen, setAuditOpen] = useState<string | null>(null);
  const hasGoal = Boolean(props.nodes.find((n) => n.type === "mission")?.goal);
  const ready = useReadiness(props.keys, hasGoal);
  const { approval, provider } = ready;
  const canRun = approval && Boolean(ready.model) && !ready.keyMissing;
  const llm = () => (provider && props.keys[provider] ? { apiKey: props.keys[provider], keyFor: provider } : undefined);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [fresh, setFresh] = useState<Record<string, Forecast>>({});
  const [writing, setWriting] = useState(false);
  const [pendingRun, setPendingRun] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, boolean>>({});
  const decided = props.nodes.filter((n) => n.type === "decision" && n.chosen && (n.options?.length ?? 0) > 1).length;

  const onLine = useMemo(() => {
    const byId = new Map(props.nodes.map((n) => [n.id, n]));
    const out = new Set<string>();
    let cur = props.headId ? byId.get(props.headId) : undefined;
    while (cur) {
      out.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return out;
  }, [props.nodes, props.headId]);
  // Open decisions first (current line first), then the focused one if it is decided.
  const decisions = useMemo(() => {
    const open = props.nodes.filter((n) => n.type === "decision" && !n.chosen && (n.options?.length ?? 0) > 1);
    open.sort((a, b) => Number(onLine.has(b.id)) - Number(onLine.has(a.id)) || b.createdAt.localeCompare(a.createdAt));
    const focus = props.focus ? props.nodes.find((n) => n.id === props.focus) : undefined;
    return focus && !open.includes(focus) ? [focus, ...open] : open;
  }, [props.nodes, onLine, props.focus]);

  const load = async () => {
    const p = await api.forecasts();
    setPage(p);
    const q: Record<string, ForecastOption[]> = {};
    for (const d of decisions.slice(0, 20)) {
      try {
        q[d.id] = (await api.quickDecision(d.id)).options;
      } catch {
        /* ignore */
      }
    }
    setQuick(q);
  };
  useEffect(() => {
    load().catch((e) => setErr(errText(e)));
  }, [decisions.map((d) => d.id).join(",")]);
  // While an automatic forecast runs, refresh now and then.
  useEffect(() => {
    if (!page?.running) return;
    const id = setInterval(() => {
      api.forecasts().then(setPage).catch(() => {});
    }, 4000);
    return () => clearInterval(id);
  }, [page?.running]);

  const latest = (node: string) => page?.forecasts.find((f) => f.verified && f.mode === "multiverse" && f.subject.kind === "decision" && f.subject.node === node);

  const runMultiverse = async (node: string) => {
    setBusy(node);
    setErrs((x) => ({ ...x, [node]: "" }));
    try {
      const f = await api.runForecast({ node, lang: props.lang, llm: llm() });
      setFresh((x) => ({ ...x, [node]: f }));
      setBusy(null);
      await load();
      props.onChanged();
    } catch (e) {
      setErrs((x) => ({ ...x, [node]: errText(e) }));
    } finally {
      setBusy(null);
    }
  };
  // A decision written down with "save and forecast": run as soon as it is in the list.
  useEffect(() => {
    if (pendingRun && decisions.some((d) => d.id === pendingRun) && !busy) {
      const id = pendingRun;
      setPendingRun(null);
      runMultiverse(id);
    }
  }, [pendingRun, decisions.map((d) => d.id).join(",")]);

  const [pick, setPick] = useState<{ node: string; key: string; label: string; why: string } | null>(null);
  const choose = async () => {
    if (!pick?.why.trim()) return;
    try {
      await api.choose(pick.node, pick.key, pick.why.trim());
      props.toast(`${pick.node} → ${pick.label}`);
      setPick(null);
      props.onChanged();
      await load();
    } catch (e) {
      setErr(errText(e));
    }
  };

  const c = page?.calibration;
  return (
    <Modal wide title={<>{t.fcTitle} <HelpButton topic="forecasts" /></>} onClose={props.onClose}>
      <div className="modal-body analysis forecasts">
        <div className="fc-stats">
          <button className="chip" title={t.fcCalibrationHint} onClick={() => setTab("quality")}>
            {t.fcCalibration}: {!c ? "…" : c.evaluated ? `${c.hits}/${c.evaluated} ${t.fcWithin} · Ø ±${c.meanError}` : t.fcNoCalibration} · {t.fcTabQuality} →
          </button>
          {page && (
            <span className={`chip ${page.auto.auto ? "v-passed" : ""}`}>
              {t.fcAuto}: {page.auto.auto ? `${t.on} · ${page.auto.usedToday}/${page.auto.dailyLimit} ${t.fcToday}` : t.off}{" "}
              <button className="btn link inline" onClick={props.onOpenSettings}>
                {t.settings}
              </button>
            </span>
          )}
          {page?.running && <span className="chip v-warning">⟳ {t.fcRunning} {page.running}</span>}
        </div>
        {err && <ErrorBox t={t} message={err} onOpenSettings={props.onOpenSettings} />}
        <div className="side-tabs fc-tabs" role="tablist">
          {(["start", "open", "prompt", "past", "history", "quality"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {k === "start" ? t.fcTabStart : k === "open" ? `${t.fcTabOpen} (${decisions.filter((d) => !d.chosen).length})` : k === "prompt" ? t.fcTabPrompt : k === "past" ? `${t.fcTabPast} (${decided})` : k === "history" ? `${t.fcTabHistory} (${page?.forecasts.length ?? 0})` : t.fcTabQuality}
            </button>
          ))}
        </div>

        {tab === "start" && (
          <section className="a-sec fc-start">
            <p className="hint">{t.fcIntro}</p>
            <ReadyCheck t={t} r={ready} onOpenSettings={props.onOpenSettings} onEditGoal={props.onEditGoal} />
            <h3>{t.stTitle}</h3>
            <StartCards
              t={t}
              open={decisions.filter((d) => !d.chosen).length}
              past={decided}
              onOpen={() => setTab("open")}
              onNew={() => {
                setWriting(true);
                setTab("open");
              }}
              onPrompt={() => setTab("prompt")}
              onPast={() => setTab("past")}
            />
            {page?.forecasts.find((f) => f.verified) && (
              <>
                <h4>{t.stLast}</h4>
                <LastResult t={t} f={page.forecasts.find((f) => f.verified)!} onNode={props.onNode} />
              </>
            )}
          </section>
        )}
        {tab !== "start" && tab !== "history" && tab !== "quality" && !canRun && <ReadyCheck t={t} r={ready} onOpenSettings={props.onOpenSettings} onEditGoal={props.onEditGoal} />}
        {tab === "past" && <PastCheck t={t} lang={props.lang} approval={approval} ready={canRun} focus={focusNode?.chosen ? focusNode.id : null} llm={llm} onNode={props.onNode} onBusy={() => {}} onOpenSettings={props.onOpenSettings} />}

        {tab === "open" && (
          <>
            {canRun && !hasGoal && <NoGoalNote t={t} onEditGoal={props.onEditGoal} />}
            {writing || !decisions.length ? (
              <NewDecisionForm
                t={t}
                approval={approval}
                ready={canRun}
                onCancel={decisions.length ? () => setWriting(false) : undefined}
                onCreated={(id, run) => {
                  setWriting(false);
                  props.onChanged();
                  if (run) setPendingRun(id);
                  props.toast(id);
                }}
              />
            ) : (
              <div className="row">
                <button className="btn" onClick={() => setWriting(true)}>
                  + {t.ndTitle}
                </button>
              </div>
            )}
            <p className="muted small">{t.fcLegend}</p>
            {decisions.map((d) => {
              const mv = latest(d.id);
              const opts = mv?.options ?? quick[d.id];
              return (
                <section key={d.id} className={`a-sec fc-dec ${onLine.has(d.id) ? "current" : ""}`}>
                  <h3>
                    <button className="btn link" onClick={() => props.onNode(d.id)}>
                      <NodeId id={d.id} />
                    </button>
                    {d.question ?? d.title}
                    {onLine.has(d.id) && <span className="chip">{t.fcCurrentLine}</span>}
                    {d.chosen && <span className="chip v-passed">{t.chosen}</span>}
                    <span className="chip">{mv ? `${t.fcMultiverse} · ${new Date(mv.createdAt).toLocaleString()}` : t.fcQuickOnly}</span>
                  </h3>
                  {page?.failed[d.id] && <p className="qnote q-bad">{t.fcFailed}: {page.failed[d.id]}</p>}
                  {busy === d.id && <RunProgress t={t} kind="multiverse" />}
                  {errs[d.id] && <ErrorBox t={t} message={errs[d.id]} onOpenSettings={props.onOpenSettings} />}
                  {mv && <LastResult t={t} f={fresh[d.id] ?? mv} onDetails={() => setDetails({ ...details, [d.id]: !details[d.id] })} />}
                  {mv && !details[d.id] && !d.chosen && (
                    <div className="row choose-row">
                      <span className="small">{t.chooseOption}:</span>
                      {mv.options.map((o) => (
                        <button key={o.key} className={`btn ${mv.recommended?.key === o.key ? "primary" : ""}`} onClick={() => setPick({ node: d.id, key: o.key, label: o.label, why: o.universe ? `${t.fcBecause}: ${o.universe.outcome}`.slice(0, 300) : "" })}>
                          {o.key} {o.label.slice(0, 40)}
                        </button>
                      ))}
                    </div>
                  )}
                  {opts && mv && !details[d.id] ? null : opts ? (
                    <OptionForecasts
                      t={t}
                      options={opts}
                      recommended={mv?.recommended?.key}
                      actual={mv?.actual}
                      onChoose={d.chosen ? undefined : (o) => setPick({ node: d.id, key: o.key, label: o.label, why: o.universe ? `${t.fcBecause}: ${o.universe.outcome}`.slice(0, 300) : "" })}
                    />
                  ) : (
                    <p className="muted">…</p>
                  )}
                  {pick?.node === d.id && (
                    <form
                      className="choose-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        choose();
                      }}
                    >
                      <strong>{pick.key}</strong>
                      <input autoFocus value={pick.why} placeholder={t.chooseRationale} onChange={(e) => setPick({ ...pick, why: e.target.value })} />
                      <button className="btn primary" type="submit" disabled={!pick.why.trim()}>
                        {t.chooseConfirm}
                      </button>
                      <button className="btn" type="button" onClick={() => setPick(null)}>
                        ✕
                      </button>
                    </form>
                  )}
                  {mv && <AuditBox t={t} id={mv.id} mode={mv.mode} approval={approval} llm={llm} version={String(page?.calibration.evaluated)} />}
                  <div className="row">
                    <button className="btn primary" disabled={!canRun || Boolean(busy)} onClick={() => runMultiverse(d.id)} title={canRun ? t.fcMultiverseHint : t.rdNotReady}>
                      {busy === d.id ? t.running : mv ? t.fcRerun : t.fcRunMultiverse}
                    </button>
                    {!canRun && (
                      <button className="btn link" onClick={() => setTab("start")}>
                        {t.rdNotReady.split("–")[0].split("—")[0].trim()} →
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
          </>
        )}

        {tab === "prompt" && <PromptCheck t={t} lang={props.lang} approval={approval} llm={llm} toast={props.toast} onDone={load} />}

        {tab === "quality" && <QualityPanel t={t} approval={approval} live={c} llm={llm} />}
        {tab === "history" && (
          <section className="a-sec">
            {!page?.forecasts.length && <p className="muted">{t.fcNoHistory}</p>}
            <ul className="fc-history">
              {page?.forecasts.slice(0, 60).map((f) => (
                <li key={f.id}>
                  <strong>{f.id}</strong> <span className="chip">{f.mode === "multiverse" ? t.fcMultiverse : t.fcQuick}</span> <span className="chip">{t.fcTriggers[f.trigger] ?? f.trigger}</span>{" "}
                  {!f.verified && <span className="chip v-failed">{t.fcUnverified}</span>}{" "}
                  {f.subject.kind === "decision" ? (
                    <>
                      <button className="btn link" onClick={() => props.onNode((f.subject as { node: string }).node)}>
                        <NodeId id={f.subject.node} />
                      </button>{" "}
                      {f.subject.question}
                    </>
                  ) : (
                    <em>„{f.subject.text.slice(0, 80)}“</em>
                  )}
                  {f.recommended && <span className="muted small"> → {f.recommended.key}</span>}
                  {f.actual?.length ? <span className="muted small"> · {f.actual.map((a) => `${a.option}: ${t.fcPredicted} ${a.predicted}% / ${t.fcActual} ${a.measured}%`).join(", ")}</span> : null}
                  {f.actualLine && !f.actual?.length ? <span className="muted small"> · {t.fcLineAfter} {f.actualLine.measured}%</span> : null}
                  <span className="muted small"> · {new Date(f.createdAt).toLocaleString()}</span>{" "}
                  {f.verified && (
                    <button className="btn link inline" aria-expanded={auditOpen === f.id} onClick={() => setAuditOpen(auditOpen === f.id ? null : f.id)}>
                      {t.fcAudit}
                    </button>
                  )}
                  {auditOpen === f.id && <AuditBox t={t} id={f.id} mode={f.mode} approval={approval} llm={llm} />}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}

/** Check a prompt (and alternative wordings) before giving it to an agent. */
function PromptCheck(props: { t: Dict; lang: "de" | "en"; approval: boolean; llm: () => { apiKey: string; keyFor: string } | undefined; toast: (m: string) => void; onDone: () => void }) {
  const { t } = props;
  const [text, setText] = useState("");
  const [variants, setVariants] = useState<string[]>([]);
  const [quick, setQuick] = useState<number | null>(null);
  const [result, setResult] = useState<Forecast | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Instant check while typing (no model).
  useEffect(() => {
    if (text.trim().length < 3) {
      setQuick(null);
      return;
    }
    const id = setTimeout(() => {
      api
        .quickPrompt(text)
        .then((r) => setQuick(r.quick.score))
        .catch(() => setQuick(null));
    }, 350);
    return () => clearTimeout(id);
  }, [text]);
  const [running, setRunning] = useState(false);
  const run = async (quickOnly: boolean) => {
    setBusy(true);
    setRunning(!quickOnly);
    setErr(null);
    try {
      const f = await api.runForecast({ prompt: text, variants: variants.filter((v) => v.trim()), quick: quickOnly, lang: props.lang, llm: props.llm() });
      setResult(f);
      props.onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
      setRunning(false);
    }
  };
  // Without the approval session: the same quick check, computed but not saved (no hit rate).
  const localQuick = async () => {
    setErr(null);
    try {
      const all = [text, ...variants.filter((v) => v.trim())];
      const scores = await Promise.all(all.map((x) => api.quickPrompt(x)));
      setResult({
        id: "",
        subject: { kind: "prompt", text, at: null },
        createdAt: new Date().toISOString(),
        mode: "quick",
        trigger: "person",
        models: {},
        warnings: [],
        options: scores.map((r, i) => ({ key: i === 0 ? "p" : `v${i}`, label: i === 0 ? t.fcAsWritten : `${t.fcVariant} ${i}`, text: all[i], quick: r.quick, score: r.quick.score })),
      });
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <section className="a-sec">
      <p className="hint">{t.fcPromptHint}</p>
      <label className="fc-field">
        <span>{t.fcPrompt}</span>
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={t.fcPromptPh} />
      </label>
      {quick !== null && (
        <div className="fc-live">
          <span className="muted small">{t.fcLive}</span>
          <ScoreBar value={quick} />
        </div>
      )}
      {variants.map((v, i) => (
        <label key={i} className="fc-field">
          <span>
            {t.fcVariant} {i + 1}{" "}
            <button className="btn link inline" onClick={() => setVariants(variants.filter((_, k) => k !== i))}>
              ✕
            </button>
          </span>
          <textarea rows={3} value={v} onChange={(e) => setVariants(variants.map((x, k) => (k === i ? e.target.value : x)))} />
        </label>
      ))}
      <div className="row">
        {variants.length < 3 && (
          <button className="btn" onClick={() => setVariants([...variants, ""])}>
            + {t.fcAddVariant}
          </button>
        )}
        <button className="btn" disabled={busy || text.trim().length < 3} onClick={() => (props.approval ? run(true) : localQuick())}>
          {t.fcQuickCheck}
        </button>
        <button className="btn primary" disabled={busy || text.trim().length < 3 || !props.approval} onClick={() => run(false)} title={t.fcMultiverseHint}>
          {busy ? t.running : t.fcRunMultiverse}
        </button>
      </div>
      {running && <RunProgress t={t} kind="multiverse" />}
      {err && <ErrorBox t={t} message={err} />}
      {result && (
        <>
          {result.id ? <LastResult t={t} f={result} /> : <ResultCard t={t} f={result} />}
          <OptionForecasts t={t} options={result.options} recommended={result.recommended?.key} actual={result.actual} />
          {result.id && <AuditBox t={t} id={result.id} mode={result.mode} approval={props.approval} llm={props.llm} />}
          {result.id && <div className="row">
            <span className="muted small">{t.fcMarkUsedHint}</span>
            {result.options.map((o) => (
              <button
                key={o.key}
                className={`btn ${result.used === o.key ? "primary" : ""}`}
                onClick={async () => {
                  try {
                    setResult(await api.markUsed(result.id, o.key));
                    props.toast(t.fcMarked);
                  } catch (e) {
                    setErr(errText(e));
                  }
                }}
              >
                {t.fcUsed}: {o.key}
              </button>
            ))}
          </div>}
        </>
      )}
    </section>
  );
}

/** Compact forecast inside the node panel of a decision. */
export function DecisionForecast(props: { t: Dict; node: ScenariaNode; graphVersion?: number; onOpen: () => void; hasGoal: boolean; onEditGoal: () => void; chosenAt?: string }) {
  const { t } = props;
  const [opts, setOpts] = useState<ForecastOption[] | null>(null);
  const [mv, setMv] = useState<Forecast | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .quickDecision(props.node.id)
      .then((r) => alive && setOpts(r.options))
      .catch(() => alive && setOpts(null));
    api
      .forecasts()
      .then((p) => {
        if (!alive) return;
        const mine = p.forecasts.filter((f) => f.verified && f.subject.kind === "decision" && f.subject.node === props.node.id);
        // The multiverse if there is one; for a decided decision otherwise the snapshot taken BEFORE the choice.
        setMv(mine.find((f) => f.mode === "multiverse") ?? (props.node.chosen ? mine[mine.length - 1] ?? null : null));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [props.node.id, props.graphVersion]);
  const options = mv?.options ?? opts;
  if (!options?.length) return null;
  return (
    <section className="p-sec forecast-inline">
      <h3>
        {props.node.chosen ? t.fcInlineDecided : t.fcInline} <span className="chip">{mv?.mode === "multiverse" ? t.fcMultiverse : t.fcQuick}</span>
        {props.node.chosen && (mv ? !props.chosenAt || mv.createdAt <= props.chosenAt ? <span className="chip">{t.fcMadeBefore}</span> : <span className="chip v-warning">{t.fcMadeAfter}</span> : <span className="chip v-warning">{t.fcComputedNow}</span>)}
      </h3>
      {!props.hasGoal && <NoGoalNote t={t} onEditGoal={props.onEditGoal} />}
      <div className="compact-universe">
        <OptionForecasts t={t} options={options} recommended={mv?.recommended?.key} actual={mv?.actual} compact />
      </div>
      {mv && <AuditBox t={t} id={mv.id} compact version={String(props.graphVersion ?? "")} />}
      <button className="btn link" onClick={props.onOpen}>
        {props.node.chosen ? t.fcPastLink : t.fcOpen}
      </button>
    </section>
  );
}

/** Forecast quality: the backtest (every past decision forecast as of its own time) and the test bench. */
export function QualityPanel({ t, approval, live, llm }: { t: Dict; approval: boolean; live?: ForecastsPage["calibration"]; llm?: LlmFn }) {
  const [q, setQ] = useState<ForecastQuality | null>(null);
  const [bench, setBench] = useState<BenchSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api
      .forecastQuality()
      .then(setQ)
      .catch((e) => setErr(errText(e)));
  }, []);
  const pc = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)} %`);
  const verdict = !q ? null : !q.enough ? "few" : q.skill !== null && q.skill > 0 ? "good" : "bad";
  return (
    <div className="fc-quality">
      <p className="hint">
        {t.fcQualityIntro} <HelpButton topic="forecast-check" />
      </p>
      {err && <p className="error">{err}</p>}
      <h4>{t.fcqBacktest}</h4>
      {q && (
        <>
          {verdict === "few" && <p className="qnote q-info">{t.fcQualityFew(q.decisions, q.minDecisions)}</p>}
          {verdict === "good" && <p className="qnote q-good">{t.fcQualityGood(q.skill!)}</p>}
          {verdict === "bad" && <p className="qnote q-warn">{t.fcQualityBad}</p>}
          <div className="x-kpis">
            <div className="x-kpi">
              <span className="x-kpi-num">{q.decisions}</span>
              <span className="muted small">{t.fcqCases(q.n)}</span>
            </div>
            <div className="x-kpi" title={t.fcqMaeHint}>
              <span className="x-kpi-num">{q.mae ?? "–"}</span>
              <span className="muted small">{t.fcqMae}</span>
            </div>
            <div className="x-kpi" title={t.fcqBaselineHint}>
              <span className="x-kpi-num">{q.maeBaseline ?? "–"}</span>
              <span className="muted small">{t.fcqBaseline}</span>
            </div>
            <div className="x-kpi" title={t.fcqSkillHint}>
              <span className="x-kpi-num">{q.skill ?? "–"}</span>
              <span className="muted small">Skill</span>
            </div>
            <div className="x-kpi" title={t.fcqCoverageHint}>
              <span className="x-kpi-num">{pc(q.coverage)}</span>
              <span className="muted small">{t.fcqCoverage}</span>
            </div>
            <div className="x-kpi" title={t.fcqBreaksHint}>
              <span className="x-kpi-num">
                {q.breaks.hits}/{q.breaks.actual}
              </span>
              <span className="muted small">{t.fcqBreaks(pc(q.breaks.precision))}</span>
            </div>
            <div className="x-kpi" title={t.fcqRankingHint}>
              <span className="x-kpi-num">
                {q.ranking.concordant}/{q.ranking.pairs}
              </span>
              <span className="muted small">{t.fcqRanking}</span>
            </div>
          </div>
          <p className="muted small">
            {t.fcqWeights(q.calibration.alpha, q.calibration.beta, q.calibration.n, q.calibration.calibrated)} {t.fcqLoo}
            {q.excluded ? ` ${t.fcqExcluded(q.excluded)}` : ""}
          </p>
          {q.cases.length > 0 && (
            <table className="log fc-cases">
              <thead>
                <tr>
                  <th>{t.fcqDecision}</th>
                  <th>{t.fcqForecast}</th>
                  <th>{t.fcqActual}</th>
                  <th>{t.fcqError}</th>
                  <th>{t.fcqBaselineShort}</th>
                </tr>
              </thead>
              <tbody>
                {q.cases.map((c) => (
                  <tr key={`${c.decision}-${c.option}`}>
                    <td>
                      <NodeId id={c.decision} /> {c.label}
                      {c.predictedBreak ? " ⚠" : ""}
                    </td>
                    <td>{c.predicted}</td>
                    <td>
                      {c.actual} <span className="muted small">({c.actualNodes})</span>
                      {c.broke ? " ↯" : ""}
                    </td>
                    <td className={c.error <= c.band ? "" : "sev-high"} title={`±${c.band}`}>
                      {c.error}
                    </td>
                    <td>{c.baselineError}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {live && (
        <>
          <h4>{t.fcqLive}</h4>
          <p className="muted small">{t.fcqLiveText(live.evaluated, live.meanError, live.multiverse?.evaluated ?? 0, live.multiverse?.meanError ?? null, live.legacy ?? 0)}</p>
        </>
      )}
      <OracleQualitySection t={t} approval={approval} llm={llm} />
      <h4>{t.fcqBench}</h4>
      <p className="muted small">{t.fcqBenchHint}</p>
      <button
        className="btn"
        disabled={busy || !approval}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            setBench(await api.benchmark());
          } catch (e) {
            setErr(errText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : t.fcqBenchRun}
      </button>
      {bench && (
        <div className="fc-bench">
          <p>
            {t.fcqBenchClear(bench.clear.ranking, bench.clear.n, bench.clear.flagged)} · {t.fcqBenchNeutral(bench.neutral.passed, bench.neutral.n, bench.neutral.falseAlarms)} · {t.fcqMae} {bench.mae}
          </p>
          <ul className="issues">
            {bench.results.map((r) => (
              <li key={r.id} className={r.passed ? "" : r.kind === "limit" ? "sev-low" : "sev-high"}>
                {r.passed ? "✔" : "✘"} <strong>{r.id}</strong> <span className="chip">{t.fcqKind[r.kind]}</span> {t.fcqForecast} {r.predicted.on}/{r.predicted.off} · {t.fcqActual} {r.measured.on}/{r.measured.off}
                {r.falseAlarm ? ` · ${t.fcqFalseAlarm}` : ""}
                {r.limit ? <span className="muted small"> — {r.limit}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Does the oracle improve the core? Live cases, oracle backtest, γ. */
function OracleQualitySection({ t, approval, llm }: { t: Dict; approval: boolean; llm?: LlmFn }) {
  const [q, setQ] = useState<(OracleQuality & { runs: OracleBacktestRun[] }) | null>(null);
  const [limit, setLimit] = useState(5);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    api
      .oracleQuality()
      .then(setQ)
      .catch((e) => setErr(errText(e)));
  useEffect(() => {
    load();
  }, []);
  const last = q?.runs[0];
  return (
    <>
      <h4>{t.fcqOracle}</h4>
      <p className="muted small">{t.fcqOracleHint}</p>
      {q && (
        <>
          {q.skillVsCore === null ? (
            <p className="qnote q-info">{t.fcqOracleNone}</p>
          ) : (
            <p className={`qnote ${q.skillVsCore > 0 ? "q-good" : "q-warn"}`}>
              {q.skillVsCore > 0 ? t.fcqOracleBetter(q.skillVsCore) : t.fcqOracleWorse(q.skillVsCore)} <span className="muted small">({t.fcqOracleCorrected(q.corrected)})</span>
            </p>
          )}
          {q.skillVsCore !== null && !q.enough && <p className="qnote q-info">{t.fcqOracleFew(q.decisions, q.minDecisions)}</p>}
          <p className="small">{t.fcqOracleGamma(q.gamma, q.gammaN)}</p>
          <p className="muted small">{t.fcqOracleRow(t.fcqOracleLive, q.live.n, q.live.maeCore, q.live.maeOracle)}</p>
          <p className="muted small">
            {t.fcqOracleRow(t.fcqOracleBt, q.backtest.n, q.backtest.maeCore, q.backtest.maeOracle)} · {q.backtest.runs} {t.fcqOracleRuns}
          </p>
          {last && last.cases.length > 0 && (
            <table className="log fc-cases">
              <thead>
                <tr>
                  <th>{t.fcqDecision}</th>
                  <th>{t.fcCore}</th>
                  <th>{t.fcWithOracle}</th>
                  <th>{t.fcqActual}</th>
                </tr>
              </thead>
              <tbody>
                {last.cases.map((c) => (
                  <tr key={`${c.decision}-${c.option}`}>
                    <td>
                      <NodeId id={c.decision} /> {c.label}
                    </td>
                    <td className={Math.abs(c.core - c.actual) <= Math.abs(c.oracle - c.actual) ? "" : "muted"}>{c.core}</td>
                    <td className={Math.abs(c.oracle - c.actual) < Math.abs(c.core - c.actual) ? "" : "muted"}>{c.oracle}</td>
                    <td>{c.actual}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <div className="row">
        <label className="small">
          <input type="number" min={1} max={10} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} style={{ width: "4em" }} /> {t.fcqOracleLimit}
        </label>
        <button
          className="btn"
          disabled={!approval || busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await api.oracleBacktest(limit, t.langCode, llm?.());
              await load();
            } catch (e) {
              setErr(errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "…" : t.fcqOracleRun(limit * 3)}
        </button>
      </div>
      {err && <p className="error small">{err}</p>}
    </>
  );
}
