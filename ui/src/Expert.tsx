/**
 * The analyst ("Experten-Analyse"): a fact-based expert report on one line, the project or all the
 * person's Scenaria projects — findings through four expert lenses and prioritised recommendations
 * that can be adopted as project rules with one click.
 */
import { LockedNote, useApprovalSignal } from "./Approval";
import { useEffect, useState } from "react";
import { api, type ExpertPage, type ExpertReport, type Finding } from "./api";
import { NodeId } from "./Map";
import type { Dict } from "./i18n";
import type { SessionKeys } from "./Control";

const errText = (e: any) => String(e?.message ?? e);
const sevClass = (s: string) => (s === "high" ? "sev-high" : s === "medium" ? "sev-mid" : "sev-low");
const tone = (n: number) => (n >= 70 ? "good" : n >= 45 ? "mid" : "low");
const LENSES = ["architecture", "goal", "workflow", "governance"] as const;
const KPIS = ["nodes", "decisions", "rationaleRate", "fidelity", "fidelityBreaks", "linesValid", "linesInvalid", "canonActive", "openDecisions"] as const;
const PCT = new Set(["rationaleRate", "fidelity"]);

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Evidence({ ids, onNode }: { ids: string[]; onNode: (id: string) => void }) {
  if (!ids.length) return null;
  return (
    <span className="x-ev">
      {ids.map((id) =>
        /^n\d+$/.test(id) ? (
          <button key={id} className="btn link" onClick={() => onNode(id)}>
            <NodeId id={id} />
          </button>
        ) : (
          <span key={id} className="chip">
            {id}
          </span>
        ),
      )}
    </span>
  );
}

function FindingRow({ t, f, onNode, multi }: { t: Dict; f: Finding; onNode: (id: string) => void; multi: boolean }) {
  return (
    <li className={`${sevClass(f.severity)}${f.contradicted ? " x-contra" : ""}`}>
      <strong>{f.title}</strong> {multi && f.project && <span className="chip">{f.project}</span>}
      {f.metric && (
        <span className="chip" title={f.metric.name}>
          {t.xKpi[f.metric.name] ?? f.metric.name} = {f.metric.value}
        </span>
      )}
      {f.contradicted ? (
        <span className="chip v-failed">✘ {t.xContradicts}</span>
      ) : f.verified ? (
        <span className="chip v-passed" title={t.xVerifiedHint}>
          ✓
        </span>
      ) : (
        <span className="chip v-warning">{t.xUnverified}</span>
      )}
      {f.impact && <div className="muted small">{f.impact}</div>}
      <Evidence ids={f.evidence} onNode={onNode} />
      {f.note && <div className="muted small">ⓘ {f.note}</div>}
    </li>
  );
}

export function ReportView(props: { t: Dict; r: ExpertReport; onNode: (id: string) => void; onAdopt: (index: number) => Promise<void>; toast: (m: string) => void; onEditGoal?: () => void; onOpenCanon?: () => void }) {
  const { t, r } = props;
  const multi = r.facts.length > 1;
  const [adopting, setAdopting] = useState<number | null>(null);
  return (
    <div className="x-report">
      <div className="x-head">
        <div className={`hbig ${tone(r.maturity.score)}`}>
          <span className="hnum">{r.maturity.score}</span>
          <span className="hlabel">{t.xMaturity}</span>
        </div>
        <div className="grow">
          <p>
            <strong>{r.maturity.level}</strong> · {r.model ?? t.xRuleBased} · {new Date(r.createdAt).toLocaleString()} · {r.facts.map((f) => f.project).join(", ")}
          </p>
          {r.maturity.reasoning && <p className="muted small">{r.maturity.reasoning}</p>}
          {r.maturity.model !== undefined && <p className="muted small">{t.xMaturityRuleModel(r.maturity.rule, r.maturity.model)}</p>}
        </div>
        <div className="x-export">
          <button className="btn" onClick={async () => props.toast((await copy(r.markdown)) ? t.copiedShort : r.markdown.slice(0, 80))}>
            {t.xCopyMd}
          </button>
          <button className="btn" onClick={() => download(`scenaria-${r.id}.md`, r.markdown)}>
            {t.xDownloadMd}
          </button>
        </div>
      </div>

      {r.verified === false && <p className="qnote q-warn">⚠ {t.xUnconfirmed}</p>}
      <h4>{t.xSummary}</h4>
      <p>{r.summary}</p>
      {r.modelSummary && (
        <div className="x-model">
          <h4>
            {t.xModelView} <span className="muted small">— {t.xModelViewHint}</span>
          </h4>
          <p>{r.modelSummary}</p>
          {r.unmatchedNumbers?.length ? <p className="small"><span className="chip v-warning">{t.xNumbersUnmatched(r.unmatchedNumbers.join(", "))}</span></p> : null}
        </div>
      )}

      <h4>{t.xRecommendations}</h4>
      <ol className="x-recs">
        {r.recommendations.map((x, i) => {
          const done = r.adopted?.includes(i);
          const canAdopt = r.verified !== false && x.kind !== "task" && !x.contradicted;
          return (
            <li key={i} className={x.contradicted ? "x-contra" : ""}>
              <span className={`chip prio-${x.priority}`}>{x.priority}</span> <strong>{x.title}</strong>{" "}
              <span className="chip">{x.kind === "task" ? t.xTask : t.xRule}</span>{" "}
              <span className="muted small">
                {t.xLens[x.lens]} · {t.xEffort} {x.effort}
              </span>
              {x.contradicted ? <span className="chip v-failed">✘ {t.xContradicts}</span> : !x.verified && <span className="chip v-warning">{t.xUnverified}</span>}
              <div>{x.action}</div>
              {(x.metric || x.expected) && (
                <div className="muted small">
                  → {x.metric ? `${t.xKpi[x.metric] ?? x.metric}: ` : ""}
                  {x.expected}
                </div>
              )}
              <Evidence ids={x.evidence} onNode={props.onNode} />
              <div>
                {x.kind === "task" && x.do === "setGoal" && props.onEditGoal && (
                  <button className="btn link" onClick={props.onEditGoal}>
                    → {t.xDoSetGoal}
                  </button>
                )}
                {x.kind === "task" && x.do === "canon" && props.onOpenCanon && (
                  <button className="btn link" onClick={props.onOpenCanon}>
                    → {t.xDoCanon}
                  </button>
                )}
                {done ? (
                  <span className="chip v-passed">✓ {t.xAdopted}</span>
                ) : (
                  canAdopt && (
                    <button
                      className="btn link"
                      title={t.xAdoptHint}
                      disabled={adopting !== null}
                      onClick={async () => {
                        setAdopting(i);
                        try {
                          await props.onAdopt(i);
                        } finally {
                          setAdopting(null);
                        }
                      }}
                    >
                      {adopting === i ? "…" : `＋ ${t.xAdopt}`}
                    </button>
                  )
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <h4>{t.xFindings}</h4>
      {LENSES.map((lens) => {
        const fs = r.findings.filter((f) => f.lens === lens);
        if (!fs.length) return null;
        return (
          <div key={lens} className="x-lens">
            <h5>{t.xLens[lens]}</h5>
            <ul className="issues">
              {fs.map((f, i) => (
                <FindingRow key={i} t={t} f={f} onNode={props.onNode} multi={multi} />
              ))}
            </ul>
          </div>
        );
      })}

      {r.rootCauses.length > 0 && (
        <>
          <h4>
            {t.xRootCauses} <span className="muted small">— {t.xByModel}</span>
          </h4>
          <ul>
            {r.rootCauses.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </>
      )}
      {r.strengths.length > 0 && (
        <>
          <h4>
            {t.xStrengths} <span className="muted small">— {t.xByModel}</span>
          </h4>
          <ul>
            {r.strengths.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </>
      )}
      {r.model && <p className="muted small">{t.xValidation(r.validation.contradicted ?? 0, r.validation.dropped, r.validation.numbers ?? 0, r.validation.unverified)}</p>}
    </div>
  );
}

export function ExpertPanel(props: { t: Dict; lang: "de" | "en"; keys: SessionKeys; toast: (m: string) => void; onSelectNode: (id: string) => void; onRulesChanged: () => void; onEditGoal?: () => void; onOpenCanon?: () => void }) {
  const { t } = props;
  const [page, setPage] = useState<ExpertPage | null>(null);
  const [report, setReport] = useState<ExpertReport | null>(null);
  const [scope, setScope] = useState<"project" | "line" | "all">("project");
  const [head, setHead] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [approval, setApproval] = useState(false);
  useApprovalSignal(() => setApproval(true));
  const [model, setModel] = useState<{ provider: string; model: string } | null>(null);

  const load = async (show?: string) => {
    const p = await api.expert();
    setPage(p);
    setHead((h) => h || p.facts.lines.find((l) => l.current)?.head || p.facts.lines[0]?.head || "");
    const id = show ?? p.reports[0]?.id;
    if (id) setReport(await api.expertReport(id));
  };
  useEffect(() => {
    load().catch((e) => setErr(errText(e)));
    api
      .settings()
      .then((s) => {
        setApproval(s.approval);
        setModel(s.effective.analyst ?? null);
      })
      .catch(() => {});
  }, []);

  const run = async (noModel: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const llm = !noModel && model && props.keys[model.provider] ? { apiKey: props.keys[model.provider], keyFor: model.provider } : undefined;
      const r = await api.runExpert({ scope, head: scope === "line" ? head : undefined, noModel, lang: props.lang, llm });
      setReport(r);
      await load(r.id);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const k = page?.facts.kpis as unknown as Record<string, number> | undefined;
  return (
    <div className="x-panel">
      <p className="hint">{t.xIntro}</p>
      {!approval && <LockedNote t={t} text={t.settingsLocked} />}
      {err && <p className="error">{err}</p>}

      {k && (
        <section className="a-sec">
          <h3>{t.xFacts}</h3>
          <div className="x-kpis">
            {KPIS.map((key) => (
              <div key={key} className="x-kpi">
                <span className="x-kpi-num">
                  {k[key]}
                  {PCT.has(key) ? " %" : ""}
                </span>
                <span className="muted small">{t.xKpi[key]}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="a-sec">
        <h3>{t.xScope}</h3>
        <div className="x-scope" role="radiogroup">
          {(["project", "line", "all"] as const).map((s) => (
            <label key={s} className="check">
              <input type="radio" name="x-scope" checked={scope === s} disabled={s === "all" && page !== null && !page.person} onChange={() => setScope(s)} />
              <span>{s === "project" ? t.xScopeProject : s === "line" ? t.xScopeLine : t.xScopeAll}</span>
            </label>
          ))}
        </div>
        {scope === "line" && page && (
          <select value={head} onChange={(e) => setHead(e.target.value)}>
            {page.facts.lines.map((l) => (
              <option key={l.head} value={l.head}>
                {l.head} · {l.title} ({l.steps}) {l.current ? "★" : ""}
              </option>
            ))}
          </select>
        )}
        {scope === "all" && page && <p className="muted small">{t.xAllCount(page.projects.length)}: {page.projects.map((x) => x.name).join(", ")}</p>}
        {page && !page.person && <p className="muted small">{t.xAllPersonOnly}</p>}
        <p className="muted small">{model ? `${t.xModelUsed}: ${model.provider}/${model.model}` : t.xNoModel}</p>
        <div className="row">
          <button className="btn primary" disabled={busy || !approval || !model || (scope === "line" && !head)} onClick={() => run(false)}>
            {busy ? t.xRunning : t.xRunModel}
          </button>
          <button className="btn" disabled={busy || !approval || (scope === "line" && !head)} onClick={() => run(true)}>
            {t.xRunRules}
          </button>
          {page && page.reports.length > 0 && (
            <select
              className="hist"
              value={report?.id ?? ""}
              onChange={async (e) => {
                try {
                  setReport(await api.expertReport(e.target.value));
                } catch (er) {
                  setErr(errText(er));
                }
              }}
            >
              {page.reports.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} · {new Date(r.createdAt).toLocaleString()} · {r.scope.kind} · {r.model ?? t.xRuleBased} · {r.maturity.score}
                </option>
              ))}
            </select>
          )}
        </div>
      </section>

      {report ? (
        <section className="a-sec result">
          <ReportView
            t={t}
            r={report}
            toast={props.toast}
            onEditGoal={props.onEditGoal}
            onOpenCanon={props.onOpenCanon}
            onNode={props.onSelectNode}
            onAdopt={async (i) => {
              try {
                await api.adoptRecommendation(report.id, i);
                setReport(await api.expertReport(report.id));
                props.onRulesChanged();
                props.toast(t.xAdopted);
              } catch (e) {
                setErr(errText(e));
              }
            }}
          />
        </section>
      ) : (
        page && <p className="muted">{t.xNoReports}</p>
      )}
    </div>
  );
}
