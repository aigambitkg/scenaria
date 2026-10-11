import { HelpButton } from "./HelpButton";
/**
 * Forecasts ("Prognosen"): see BEFORE choosing how each option — or a prompt — will keep the context
 * and the main goal. Quick forecast (instant, no model) for every decision; the multiverse
 * (archivist = past, craftsman = present, oracle = future) on request or automatically.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type Forecast, type ForecastOption, type ForecastsPage, type QuickForecast, type ScenariaNode } from "./api";
import { Modal } from "./Dialogs";
import { NodeId } from "./Map";
import type { Dict } from "./i18n";
import type { SessionKeys } from "./Control";

const errText = (e: any) => String(e?.message ?? e);
const tone = (n: number) => (n >= 70 ? "good" : n >= 45 ? "mid" : "low");

/** One horizontal bar: predicted context retention. */
export function ScoreBar({ value, label, measured }: { value: number; label?: string; measured?: number }) {
  return (
    <div className="fbar" title={label}>
      <div className={`fbar-fill ${tone(value)}`} style={{ width: `${Math.max(2, value)}%` }} />
      {measured !== undefined && <div className="fbar-actual" style={{ left: `${measured}%` }} title={`${measured}%`} />}
      <span className="fbar-num">
        {label ? `${label} ` : ""}
        {value}%
      </span>
    </div>
  );
}

function QuickChips({ t, q, goal }: { t: Dict; q: QuickForecast; goal?: number }) {
  // With a multiverse, the oracle's goal judgement replaces the word-overlap estimate.
  const g = goal ?? q.goal;
  return (
    <span className="fchips">
      {g !== null && (
        <span className="chip" title={t.fcGoalHint}>
          {t.fcGoal} {g}%
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
            <ScoreBar value={o.score} label={t.fcContextKept} measured={act?.measured} />
            <div className="fopt-meta">
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
            </div>
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

function useApproval() {
  const [approval, setApproval] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setApproval(s.approval);
        setProvider(s.effective.oracle?.provider ?? null);
      })
      .catch(() => {});
  }, []);
  return { approval, provider };
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
  const [tab, setTab] = useState<"open" | "prompt" | "history">("open");
  const { approval, provider } = useApproval();
  const llm = () => (provider && props.keys[provider] ? { apiKey: props.keys[provider], keyFor: provider } : undefined);

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
    setErr(null);
    try {
      await api.runForecast({ node, lang: props.lang, llm: llm() });
      await load();
      props.onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

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
        <p className="hint">{t.fcIntro}</p>
        <div className="fc-stats">
          <span className="chip" title={t.fcCalibrationHint}>
            {t.fcCalibration}: {!c ? "…" : c.evaluated ? `${c.hits}/${c.evaluated} ${t.fcWithin} · Ø ±${c.meanError}` : t.fcNoCalibration}
          </span>
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
        {!approval && <p className="qnote q-warn">🔒 {t.settingsLocked}</p>}
        {!props.nodes.find((n) => n.type === "mission")?.goal && <NoGoalNote t={t} onEditGoal={props.onEditGoal} />}
        {err && <p className="error">{err}</p>}
        <p className="hint">{t.fcWhy}</p>
        <p className="muted small">{t.fcLegend}</p>
        <div className="side-tabs fc-tabs" role="tablist">
          {(["open", "prompt", "history"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {k === "open" ? `${t.fcTabOpen} (${decisions.length})` : k === "prompt" ? t.fcTabPrompt : `${t.fcTabHistory} (${page?.forecasts.length ?? 0})`}
            </button>
          ))}
        </div>

        {tab === "open" && (
          <>
            {!decisions.length && <p className="muted">{t.fcNoOpen}</p>}
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
                  {opts ? (
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
                  {mv?.recommended && <p className="small">★ {mv.recommended.why}</p>}
                  {mv?.warnings.map((w, i) => (
                    <p key={i} className="qnote q-warn">
                      {w}
                    </p>
                  ))}
                  <div className="row">
                    <button className="btn primary" disabled={!approval || Boolean(busy)} onClick={() => runMultiverse(d.id)} title={t.fcMultiverseHint}>
                      {busy === d.id ? t.running : mv ? t.fcRerun : t.fcRunMultiverse}
                    </button>
                  </div>
                </section>
              );
            })}
          </>
        )}

        {tab === "prompt" && <PromptCheck t={t} lang={props.lang} approval={approval} llm={llm} toast={props.toast} onDone={load} />}

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
                  <span className="muted small"> · {new Date(f.createdAt).toLocaleString()}</span>
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
  const run = async (quickOnly: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const f = await api.runForecast({ prompt: text, variants: variants.filter((v) => v.trim()), quick: quickOnly, lang: props.lang, llm: props.llm() });
      setResult(f);
      props.onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
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
      {err && <p className="error">{err}</p>}
      {result && (
        <>
          <OptionForecasts t={t} options={result.options} recommended={result.recommended?.key} actual={result.actual} />
          {result.recommended && <p className="small">★ {result.recommended.why}</p>}
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
      <button className="btn link" onClick={props.onOpen}>
        {t.fcOpen}
      </button>
    </section>
  );
}
