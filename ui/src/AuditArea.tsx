/**
 * The auditor's area ("Prüf-Bereich"): every forecast with a traffic light, the key figures, the
 * details of each check, and the report to download. Read-only — open to everyone who can open the
 * dashboard; the AI check inside a forecast still needs the person's approval.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type AuditOverview } from "./api";
import { Modal } from "./Dialogs";
import { NodeId } from "./Map";
import { HelpButton } from "./HelpButton";
import { AuditBox } from "./Forecasts";
import type { Dict } from "./i18n";

type Filter = "all" | "unreliable" | "caution" | "reliable";
const LIGHT: Record<string, string> = { reliable: "v-passed", caution: "v-warning", unreliable: "v-failed" };

export function AuditDialog(props: { t: Dict; lang: "de" | "en"; onClose: () => void; onNode: (id: string) => void; onOpenForecasts: () => void }) {
  const { t } = props;
  const [o, setO] = useState<AuditOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api
      .auditOverview(props.lang)
      .then(setO)
      .catch((e) => setErr(String(e?.message ?? e)));
  }, [props.lang]);
  const rows = useMemo(() => (o?.rows ?? []).filter((r) => filter === "all" || r.verdict === filter), [o, filter]);
  const c = o?.counts;
  const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)} %`);
  return (
    <Modal
      wide
      title={
        <>
          {t.adTitle} <HelpButton topic="forecast-check" />
        </>
      }
      onClose={props.onClose}
    >
      <div className="modal-body analysis audit-area">
        <p className="hint">{t.adIntro}</p>
        {err && <p className="error">{err}</p>}
        {!o && !err && <p className="muted">…</p>}
        {o && c && (
          <>
            <div className="ad-verdicts" role="group" aria-label={t.adFilter}>
              {(["all", "unreliable", "caution", "reliable"] as const).map((k) => (
                <button key={k} className={`ad-light ${k} ${filter === k ? "on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  <span className="ad-num">{k === "all" ? c.forecasts : c[k]}</span>
                  <span>{k === "all" ? t.adAll : t.auVerdict[k]}</span>
                </button>
              ))}
            </div>
            <div className="x-kpis">
              <div className="x-kpi" title={t.adSignedHint}>
                <span className="x-kpi-num">
                  {c.signed}/{c.forecasts}
                </span>
                <span className="muted small">{t.adSigned}</span>
              </div>
              <div className="x-kpi" title={t.adBeforeHint}>
                <span className="x-kpi-num">
                  {c.beforeChoice}/{c.decisionForecasts}
                </span>
                <span className="muted small">{t.adBefore}</span>
              </div>
              <div className="x-kpi" title={t.adCheckedHint}>
                <span className="x-kpi-num">
                  {c.aiChecked}/{c.withOracle}
                </span>
                <span className="muted small">{t.adChecked}</span>
              </div>
              <div className="x-kpi" title={t.fcqSkillHint}>
                <span className="x-kpi-num">{o.core.skill ?? "–"}</span>
                <span className="muted small">{t.adCoreSkill(o.core.decisions)}</span>
              </div>
              <div className="x-kpi" title={t.fcqCoverageHint}>
                <span className="x-kpi-num">{pct(o.core.coverage)}</span>
                <span className="muted small">{t.fcqCoverage}</span>
              </div>
              <div className="x-kpi" title={t.fcqOracleHint}>
                <span className="x-kpi-num">{o.oracle.skillVsCore ?? "–"}</span>
                <span className="muted small">{t.adOracleSkill(o.oracle.gamma)}</span>
              </div>
            </div>
            {!o.core.enough && <p className="qnote q-info">{t.fcQualityFew(o.core.decisions, o.core.minDecisions)}</p>}
            <div className="row">
              <button className="btn primary" onClick={() => api.downloadReport("md", props.lang).catch((e) => setErr(String(e?.message ?? e)))}>
                ⤓ {t.adReportMd}
              </button>
              <button className="btn" onClick={() => api.downloadReport("json", props.lang).catch((e) => setErr(String(e?.message ?? e)))}>
                ⤓ {t.adReportJson}
              </button>
              <span className="muted small">{t.adReportHint}</span>
            </div>
            {!rows.length && (
              <p className="muted">
                {o.rows.length ? t.adNoneFilter : t.adNone}{" "}
                {!o.rows.length && (
                  <button className="btn" onClick={props.onOpenForecasts}>
                    {t.adToForecasts}
                  </button>
                )}
              </p>
            )}
            {rows.length > 0 && (
              <div className="table-wrap">
                <table className="log ad-table">
                  <thead>
                    <tr>
                      <th>{t.adVerdict}</th>
                      <th>{t.adForecast}</th>
                      <th>{t.adSubject}</th>
                      <th>{t.adResult}</th>
                      <th>{t.adOpen}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <Fragment key={r.id}>
                        <tr className={open === r.id ? "on" : ""}>
                          <td>
                            <span className={`chip ${LIGHT[r.verdict]}`}>{t.auVerdict[r.verdict]}</span>
                            {!r.verified && <span className="chip v-failed">{t.fcUnverified}</span>}
                          </td>
                          <td>
                            <strong>{r.id}</strong>
                            <div className="muted small">
                              {r.mode === "multiverse" ? t.fcMultiverse : t.fcQuick} · {new Date(r.createdAt).toLocaleDateString()}
                            </div>
                          </td>
                          <td>
                            {r.node && (
                              <button className="btn link inline" onClick={() => props.onNode(r.node!)}>
                                <NodeId id={r.node} />
                              </button>
                            )}{" "}
                            {r.subject}
                          </td>
                          <td className="small">
                            {r.recommended ? `★ ${r.recommended} ` : ""}
                            {r.options.map((x) => `${x.key} ${x.score}%`).join(" · ")}
                            {r.actual.length > 0 && <div className="muted">{t.adActual}: {r.actual.map((a) => `${a.option} ${a.measured}% (±${a.error})`).join(", ")}</div>}
                            {r.deep && <div className="muted">{t.auDeepResult(r.deep.supported, r.deep.total)}</div>}
                          </td>
                          <td>
                            <button className="btn link" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
                              {r.failed.length + r.open.length ? t.adPoints(r.failed.length + r.open.length) : t.adNoPoints} {open === r.id ? "▴" : "▾"}
                            </button>
                          </td>
                        </tr>
                        {open === r.id && (
                          <tr className="ad-detail">
                            <td colSpan={5}>
                              <AuditBox t={t} id={r.id} mode={r.mode} approval={false} startOpen />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h4>{t.adHowTitle}</h4>
            <ul className="ad-how">
              {t.adHow.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
