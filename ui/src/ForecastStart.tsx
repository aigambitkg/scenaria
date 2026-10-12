/**
 * The simple way into forecasts — for people without a technical background:
 *   "Bereit?"        what is needed (model, approval, main goal) and the button that fixes it,
 *   three big paths  open decision (or write one down) · prompt · check a past decision,
 *   progress         which role is working right now, how long it takes,
 *   result card      the answer in plain words, errors with what to do about them.
 */
import { useEffect, useRef, useState } from "react";
import { api, type Audit, type Forecast, type OracleBacktestRun, type SettingsPage } from "./api";
import { NodeId } from "./Map";
import type { Dict } from "./i18n";
import type { SessionKeys } from "./Control";

const errText = (e: any) => String(e?.message ?? e);
const LOCAL = new Set(["ollama", "lmstudio", "custom"]);

export type Readiness = { settings: SettingsPage | null; approval: boolean; model: string | null; provider: string | null; keyMissing: boolean; goal: boolean };

export function useReadiness(keys: SessionKeys, hasGoal: boolean): Readiness {
  const [settings, setSettings] = useState<SettingsPage | null>(null);
  useEffect(() => {
    api
      .settings()
      .then(setSettings)
      .catch(() => {});
  }, []);
  const eff = settings?.effective.oracle ?? null;
  const provider = eff?.provider ?? null;
  const keyMissing = Boolean(provider && !LOCAL.has(provider) && !eff?.baseUrl && !keys[provider] && !(settings?.envKeys[provider]?.length ?? 0));
  return { settings, approval: Boolean(settings?.approval), model: eff ? `${eff.provider} · ${eff.model}` : null, provider, keyMissing, goal: hasGoal };
}

/** "Ready?" — every precondition in one line, with the button that fixes it. */
export function ReadyCheck({ t, r, onOpenSettings, onEditGoal }: { t: Dict; r: Readiness; onOpenSettings: () => void; onEditGoal: () => void }) {
  if (!r.settings) return null;
  const rows: { ok: boolean | "warn"; text: string; fix?: { label: string; run: () => void } }[] = [
    { ok: Boolean(r.model), text: r.model ? t.rdModel(r.model) : t.rdNoModel, fix: r.model ? undefined : { label: t.rdOpenSettings, run: onOpenSettings } },
    ...(r.keyMissing ? [{ ok: false as const, text: t.rdNoKey(r.provider!), fix: { label: t.rdOpenSettings, run: onOpenSettings } }] : []),
    { ok: r.approval, text: r.approval ? t.rdApproval : t.rdNoApproval },
    { ok: r.goal ? true : "warn", text: r.goal ? t.rdGoal : t.rdNoGoal, fix: r.goal ? undefined : { label: t.fcSetGoal, run: onEditGoal } },
  ];
  const ready = rows.every((x) => x.ok !== false);
  return (
    <div className={`ready ${ready ? "ok" : "no"}`} role="status">
      <strong>{ready ? t.rdReady : t.rdNotReady}</strong>
      <ul>
        {rows.map((x, i) => (
          <li key={i} className={x.ok === true ? "au-ok" : x.ok === "warn" ? "au-warn" : "au-fail"}>
            <span className="au-icon">{x.ok === true ? "✔" : x.ok === "warn" ? "!" : "✘"}</span> {x.text}{" "}
            {x.fix && (
              <button className="btn link inline" onClick={x.fix.run}>
                {x.fix.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The three big ways in. */
export function StartCards({ t, open, past, onOpen, onNew, onPrompt, onPast }: { t: Dict; open: number; past: number; onOpen: () => void; onNew: () => void; onPrompt: () => void; onPast: () => void }) {
  return (
    <div className="start-cards">
      <button className="start-card" onClick={open ? onOpen : onNew}>
        <span className="start-ico">◆</span>
        <strong>{t.stDecision}</strong>
        <span>{open ? t.stDecisionOpen(open) : t.stDecisionNone}</span>
        <span className="start-go">{open ? t.stShow : t.stWrite} →</span>
      </button>
      <button className="start-card" onClick={onPrompt}>
        <span className="start-ico">✎</span>
        <strong>{t.stPrompt}</strong>
        <span>{t.stPromptText}</span>
        <span className="start-go">{t.stCheck} →</span>
      </button>
      <button className="start-card" onClick={onPast}>
        <span className="start-ico">↺</span>
        <strong>{t.stPast}</strong>
        <span>{past ? t.stPastText(past) : t.stPastNone}</span>
        <span className="start-go">{t.stCheck} →</span>
      </button>
    </div>
  );
}

/** Write down a decision to forecast: a question and at least two options. */
export function NewDecisionForm({ t, approval, ready, onCreated, onCancel }: { t: Dict; approval: boolean; ready: boolean; onCreated: (id: string, run: boolean) => void; onCancel?: () => void }) {
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState<{ label: string; description: string }[]>([
    { label: "", description: "" },
    { label: "", description: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = q.trim().length >= 3 && opts.filter((o) => o.label.trim()).length >= 2;
  const create = async (run: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const d = await api.createDecision(q.trim(), opts.filter((o) => o.label.trim()).map((o) => ({ label: o.label.trim(), description: o.description.trim() || undefined })));
      onCreated(d.id, run);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="new-decision">
      <h4>{t.ndTitle}</h4>
      <p className="muted small">{t.ndHint}</p>
      <label className="fc-field">
        <span>{t.ndQuestion}</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.ndQuestionPh} />
      </label>
      {opts.map((o, i) => (
        <div key={i} className="nd-opt">
          <span className="fopt-key">{String.fromCharCode(97 + i)}</span>
          <input value={o.label} onChange={(e) => setOpts(opts.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} placeholder={t.ndOption(i + 1)} />
          <input value={o.description} onChange={(e) => setOpts(opts.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)))} placeholder={t.ndDescription} />
          {opts.length > 2 && (
            <button className="btn link inline" aria-label="✕" onClick={() => setOpts(opts.filter((_, k) => k !== i))}>
              ✕
            </button>
          )}
        </div>
      ))}
      <div className="row">
        {opts.length < 6 && (
          <button className="btn" onClick={() => setOpts([...opts, { label: "", description: "" }])}>
            + {t.ndAddOption}
          </button>
        )}
        <button className="btn primary" disabled={!valid || busy || !approval || !ready} onClick={() => create(true)} title={!ready ? t.rdNotReady : undefined}>
          {t.ndCreateRun}
        </button>
        <button className="btn" disabled={!valid || busy || !approval} onClick={() => create(false)}>
          {t.ndCreate}
        </button>
        {onCancel && (
          <button className="btn link" onClick={onCancel}>
            {t.cancel}
          </button>
        )}
      </div>
      {!approval && <p className="qnote q-warn">🔒 {t.rdNoApproval}</p>}
      {err && <ErrorBox t={t} message={err} />}
    </div>
  );
}

const STEPS: Record<string, string[]> = {
  multiverse: ["archivist", "craftsman", "oracle"],
  backtest: ["archivist", "craftsman", "oracle"],
  audit: ["auditor"],
};

/** While the person's model works: which role, how long. Polls the server. */
export function RunProgress({ t, kind }: { t: Dict; kind: "multiverse" | "audit" | "backtest" }) {
  const [p, setP] = useState<{ step: string; subject: string; index?: number; total?: number; startedAt: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const start = useRef(Date.now());
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .forecastProgress()
        .then((r) => alive && r.job && setP(r.job))
        .catch(() => {});
    tick();
    const id = setInterval(() => {
      tick();
      setNow(Date.now());
    }, 700);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const steps = STEPS[kind];
  const cur = p ? steps.indexOf(p.step) : -1;
  const secs = Math.round((now - (p ? Date.parse(p.startedAt) : start.current)) / 1000);
  return (
    <div className="run-progress" role="status" aria-live="polite">
      <div className="row">
        <span className="spinner" aria-hidden /> <strong>{t.pgRunning[kind]}</strong>
        {p?.total ? <span className="chip">{t.pgDecision(p.index ?? 1, p.total, p.subject)}</span> : null}
        <span className="muted small">{t.pgElapsed(secs)}</span>
      </div>
      <ol className="pg-steps">
        {steps.map((st, i) => (
          <li key={st} className={i < cur || p?.step === "done" ? "done" : i === cur ? "now" : ""}>
            {i < cur || p?.step === "done" ? "✔" : i === cur ? "●" : "○"} {t.pgStep[st]}
          </li>
        ))}
      </ol>
      {secs > 20 && <p className="muted small">{t.pgSlow}</p>}
    </div>
  );
}

/** An error with what to do about it. */
export function ErrorBox({ t, message, onOpenSettings }: { t: Dict; message: string; onOpenSettings?: () => void }) {
  const m = message.toLowerCase();
  const hint = /kein modell|no model/.test(m)
    ? t.erNoModel
    : /approval|freigabe/.test(m)
      ? t.erApproval
      : /401|403|api key|apikey|x-api-key|unauthorized|invalid.*key/.test(m)
        ? t.erKey
        : /econnrefused|fetch failed|11434|connect/.test(m)
          ? t.erConnect
          : /abort|timeout|timed out/.test(m)
            ? t.erTimeout
            : /läuft gerade|already running/.test(m)
              ? t.erBusy
              : /json/.test(m)
                ? t.erJson
                : null;
  return (
    <div className="err-box" role="alert">
      <strong>{t.erTitle}</strong> <span>{message}</span>
      {hint && <p className="small">→ {hint}</p>}
      {onOpenSettings && /kein modell|no model|401|403|key|connect|11434/.test(m) && (
        <button className="btn" onClick={onOpenSettings}>
          {t.rdOpenSettings}
        </button>
      )}
    </div>
  );
}

/** The answer of a forecast in plain words: recommendation, numbers, verdict, what to look at. */
export function ResultCard({ t, f, audit, onDetails }: { t: Dict; f: Forecast; audit?: Audit | null; onDetails?: () => void }) {
  const sorted = [...f.options].sort((a, b) => b.score - a.score);
  const rec = f.options.find((o) => o.key === f.recommended?.key) ?? sorted[0];
  const band = rec?.quick.explain?.band;
  const open = audit?.checks.filter((c) => c.status === "warn" || c.status === "fail") ?? [];
  return (
    <div className={`result-card ${audit?.verdict ?? ""}`}>
      <div className="row">
        <strong className="result-title">{t.rsTitle}</strong>
        {audit && <span className={`chip ${audit.verdict === "reliable" ? "v-passed" : audit.verdict === "caution" ? "v-warning" : "v-failed"}`}>{t.auTitle}: {t.auVerdict[audit.verdict]}</span>}
        <span className="muted small">{f.mode === "multiverse" ? t.fcMultiverse : t.fcQuick} · {new Date(f.createdAt).toLocaleString()}</span>
      </div>
      {rec && (
        <p className="result-main">
          ★ {t.rsRecommend(rec.key, rec.label, rec.score, band)}
          {rec.universe?.core !== undefined && rec.universe.core !== rec.score ? ` ${t.rsCorrected(rec.universe.core, rec.score)}` : ""}
        </p>
      )}
      <ul className="result-opts">
        {sorted.map((o) => (
          <li key={o.key}>
            <span className="fopt-key">{o.key}</span> {o.label}: <strong>{o.score} %</strong>
            {o.universe?.outcome ? <span className="muted"> — {o.universe.outcome}</span> : null}
          </li>
        ))}
      </ul>
      {f.recommended?.why && <p className="small">{t.rsWhy}: {f.recommended.why}</p>}
      {f.warnings.map((w, i) => (
        <p key={i} className="qnote q-warn">
          {w}
        </p>
      ))}
      {audit && (
        <p className="small">
          {open.length ? t.rsOpenChecks(open.length) : t.rsAllChecks}
          {open.slice(0, 3).map((c, i) => (
            <span key={i} className="muted">
              {" "}
              · {c.text}
            </span>
          ))}
        </p>
      )}
      <p className="muted small">{t.rsMeaning}</p>
      {onDetails && (
        <button className="btn link" onClick={onDetails}>
          {t.rsDetails}
        </button>
      )}
    </div>
  );
}

type PastRow = { id: string; question: string; at: string; chosen?: string; chosenLabel?: string; options: number; measurable: number };

/** "Check a past decision": what would the oracle have said then — and what really happened? */
export function PastCheck(props: { t: Dict; lang: "de" | "en"; approval: boolean; ready: boolean; focus?: string | null; llm: () => { apiKey: string; keyFor: string } | undefined; onNode: (id: string) => void; onBusy: (b: boolean) => void; onOpenSettings: () => void }) {
  const { t } = props;
  const [rows, setRows] = useState<PastRow[] | null>(null);
  const [runs, setRuns] = useState<OracleBacktestRun[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    api
      .pastDecisions()
      .then(setRows)
      .catch((e) => setErr(errText(e)));
    api
      .oracleQuality()
      .then((q) => setRuns(q.runs))
      .catch(() => {});
  };
  useEffect(load, []);
  const latestFor = (id: string) => runs.find((r) => r.verified && r.decisions?.some((d) => d.id === id));
  const run = async (id: string) => {
    setBusy(id);
    props.onBusy(true);
    setErr(null);
    try {
      await api.oracleBacktestDecisions([id], props.lang, props.llm());
      load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
      props.onBusy(false);
    }
  };
  return (
    <section className="a-sec">
      <p className="hint">{t.ptIntro}</p>
      {err && <ErrorBox t={t} message={err} onOpenSettings={props.onOpenSettings} />}
      {busy && <RunProgress t={t} kind="backtest" />}
      {rows && !rows.length && <p className="muted">{t.ptNone}</p>}
      {rows?.map((d) => {
        const r = latestFor(d.id);
        const res = r?.decisions?.find((x) => x.id === d.id);
        const opts = r?.options?.filter((o) => o.decision === d.id) ?? [];
        return (
          <section key={d.id} className={`a-sec fc-dec ${props.focus === d.id ? "current" : ""}`}>
            <h3>
              <button className="btn link" onClick={() => props.onNode(d.id)}>
                <NodeId id={d.id} />
              </button>
              {d.question}
            </h3>
            <p className="small">
              {t.ptChosen}: <strong>{d.chosen} {d.chosenLabel}</strong> · {d.measurable ? t.ptMeasurable(d.measurable) : t.ptNotMeasurable}
            </p>
            {res && (
              <div className="result-card">
                <p className="result-main">
                  {res.recommended ? t.ptWouldHave(res.recommended, opts.find((o) => o.option === res.recommended)?.label ?? "") : t.ptNoRec}{" "}
                  {res.recommended && (res.recommended === d.chosen ? t.ptSame : t.ptDifferent(d.chosen ?? "–"))}
                </p>
                <div className="table-wrap">
                <table className="log fc-cases">
                  <thead>
                    <tr>
                      <th>{t.fcqDecision}</th>
                      <th>{t.fcCore}</th>
                      <th>{t.fcWithOracle}</th>
                      <th>{t.ptReal}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opts.map((o) => (
                      <tr key={o.option}>
                        <td>
                          <span className="fopt-key">{o.option}</span> {o.label} {o.chosen ? <span className="chip v-passed">{t.chosen}</span> : null}
                          {o.own?.backed && o.own.why ? <div className="muted small">„{o.own.why}“ [{o.own.refs.join(", ")}]</div> : null}
                        </td>
                        <td>{o.core}</td>
                        <td>{o.oracle}</td>
                        <td>{o.actual === null ? <span className="muted small">{o.chosen ? t.ptTooShort : t.ptNotTaken}</span> : <strong>{o.actual}</strong>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
                {res.why && <p className="small">{t.rsWhy}: {res.why}</p>}
                {res.warnings.map((w, i) => (
                  <p key={i} className="qnote q-warn">
                    {w}
                  </p>
                ))}
                <p className="muted small">{t.ptMeaning}</p>
              </div>
            )}
            <div className="row">
              <button className="btn primary" disabled={!props.approval || !props.ready || Boolean(busy)} onClick={() => run(d.id)}>
                {busy === d.id ? t.running : res ? t.ptAgain : t.ptRun}
              </button>
              <span className="muted small">{t.ptCost}</span>
            </div>
          </section>
        );
      })}
    </section>
  );
}
