/**
 * The ISO/IEC 42001 audit file in the dashboard (C4c-1, Kev 2026-10-16/17): every Annex A control with what this
 * project's records evidence, the organisation's documents, the integrity warnings, the signed approvals, the
 * verdict history and the reseals. Read-only. The person creates the signed audit package here and hands the
 * browser over to an auditor (auditor mode: read only). Recording the organisation's documents follows (C4c-2).
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { api, ApiError, type AuditFile, type AuditPackageResult, type OrgEvidenceState } from "./api";
import { EvidenceActions, EvidenceAdd, EvidenceCopy, normalLink } from "./OrgEvidenceForm";
import { Modal } from "./Dialogs";
import { HelpButton } from "./HelpButton";
import { LockedNote } from "./Approval";
import { ANNEX_A_AREAS, ANNEX_A_GROUPS, COVERAGE_LABEL, EVIDENCE_SOURCES, type ControlStatus, type EvidenceSource } from "../../src/core/iso42001";
import type { Dict } from "./i18n";

/** A plain label for a code of the audit file; unknown codes are shown as they are. */
const L = (m: Record<string, string>, code: string) => m[code] ?? code;

type Filter = "all" | ControlStatus | "alarm";
// "partly" is neutral, never the green of "verified" (review C4c-1 K10): Scenaria alone never evidences a control fully.
const STATUS_CHIP: Record<ControlStatus, string> = { evidenced: "v-passed", partly: "st-partly", organisational: "st-org", not_covered: "v-warning" };
const ORG_CHIP: Record<string, string> = { documented: "v-passed", unconfirmed: "v-warning", none: "" };
const TRUST_CHIP: Record<string, string> = { verified: "v-passed", untrusted: "v-warning", unsigned: "v-warning", tampered: "v-failed" };

/** Only http(s) links become clickable (the server stores nothing else; this keeps any other text inert). */
const safeLink = (u: string) => /^https?:\/\//i.test(u);
const when = (iso: string | null | undefined) => {
  if (!iso) return "–";
  const d = new Date(iso);
  // With the time zone: periods are UTC days, the browser shows local time (review C4c-1 K10). dateStyle and
  // timeStyle cannot be combined with timeZoneName (the browser throws), so the parts are named one by one.
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
};

export function AuditFileDialog(props: {
  t: Dict;
  lang: "de" | "en";
  approved: boolean;
  teamMode: boolean;
  /** true: auditor mode; "stale": the browser still carries an expired or unknown auditor mode (reads nothing, writes nothing). */
  auditView: boolean | "stale";
  onClose: () => void;
  /** The person handed this browser to an auditor (the server removed the approval here). */
  onAuditorMode: () => void;
}) {
  const { t, lang } = props;
  const [file, setFile] = useState<AuditFile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // The dates the shown audit file was computed for: the package signs exactly these (C5, U-K2).
  const [shown, setShown] = useState({ from: "", to: "" });
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [rolesOnly, setRolesOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<AuditPackageResult | null>(null);
  const [handOver, setHandOver] = useState(false);
  // C4c-2: the organisation's evidence is edited here by the person (approval session, never in auditor mode).
  const canEdit = props.approved && props.auditView === false;
  const [evStates, setEvStates] = useState<Map<string, OrgEvidenceState>>(new Map());
  const [adding, setAdding] = useState<string | null>(null);
  const [evMsg, setEvMsg] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);

  const load = (f = from, tt = to) => {
    setLoading(true);
    setErr(null);
    api
      .auditFile(f || undefined, tt || undefined)
      .then((x) => {
        setFile(x);
        setShown({ from: f, to: tt });
        setLocked(false);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.code === "approval_required") {
          setLocked(true);
          setFile(null);
        } else setErr(String(e?.message ?? e));
      })
      .finally(() => setLoading(false));
    if (canEdit)
      api
        .orgEvidence()
        .then((r) => setEvStates(new Map(r.entries.map((x) => [x.entry.id, x]))))
        .catch(() => setEvStates(new Map()));
  };
  /** After a signed change: say what happened and show the new state. */
  const evDone = (msg: string) => {
    setEvMsg(msg);
    setAdding(null);
    setCopyOpen(false);
    load();
  };
  // Reload when the approval arrives (the lock) or the auditor mode starts or ends.
  useEffect(() => {
    load();
  }, [props.approved, props.auditView]);

  const rows = useMemo(() => {
    const cs = file?.controls ?? [];
    return cs.filter((c) => filter === "all" || (filter === "alarm" ? c.alarm : c.status === filter));
  }, [file, filter]);
  const warning = (code: string) => file?.integrity.warnings.find((w) => w.code === code);
  /** Dates typed but not yet shown with "Show": the package would not match the fields. */
  const periodPending = from !== shown.from || to !== shown.to;
  const periodLabel = (f: AuditFile) => (f.period.whole ? t.afWhole : f.period.note[lang]);
  const [donePeriod, setDonePeriod] = useState("");

  const makePackage = async () => {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      // Exactly the period that is shown (not what is typed but not yet shown).
      const p = file?.period;
      setDonePeriod(file ? periodLabel(file) : "");
      setDone(await api.auditPackage({ from: p && !p.whole ? p.from ?? undefined : undefined, to: p && !p.whole ? p.to ?? undefined : undefined, names: rolesOnly ? "roles-only" : "with-names", lang }));
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const startAuditor = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.auditorModeStart();
      setHandOver(false);
      props.onAuditorMode();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const s = file?.summary;
  return (
    <Modal
      wide
      title={
        <>
          {t.afTitle} <HelpButton topic="audit-file" />
        </>
      }
      onClose={props.onClose}
    >
      <div className="modal-body analysis audit-file">
        <p className="hint">{t.afIntro}</p>
        {props.auditView === true && <p className="qnote q-info">{t.afAuditorOn}</p>}
        {props.auditView === "stale" && <p className="qnote q-warn">{t.afAuditorStale}</p>}
        {locked && props.auditView === true && <p className="qnote q-warn">{t.afAuditorStale}</p>}
        {locked && !props.auditView && (props.teamMode ? <p className="qnote q-warn">🔒 {t.afLocked} {t.approvalTeam}</p> : <LockedNote t={t} text={t.afLocked} />)}
        {err && <p className="error">{err}</p>}
        {evMsg && (
          <p className="qnote af-done" role="status">
            ✓ {evMsg}
          </p>
        )}
        {!file && !err && !locked && <p className="muted">…</p>}
        {file && s && (
          <>
            <p className="small muted af-scope">{file.scope[lang]}</p>
            <form
              className="af-period"
              onSubmit={(e) => {
                e.preventDefault();
                load();
              }}
            >
              <span className="af-label">{t.afPeriod}</span>
              <label>
                {t.afFrom} <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                {t.afTo} <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
              </label>
              <button className="btn" type="submit" disabled={loading}>
                {t.afShow}
              </button>
              {(from || to || !file.period.whole) && (
                <button
                  className="btn link"
                  type="button"
                  onClick={() => {
                    setFrom("");
                    setTo("");
                    load("", "");
                  }}
                >
                  {t.afWhole}
                </button>
              )}
              <span className="small muted">
                {file.period.whole ? t.afWhole : file.period.note[lang]} · {t.afSteps(file.period.steps)} · {t.afGenerated(when(file.generatedAt))}
              </span>
            </form>

            <section className={`af-integrity af-${file.integrity.state}`} aria-label={t.afIntegrity}>
              <strong>
                {file.integrity.state === "alarm" ? "⚠ " : file.integrity.state === "ok" ? "✓ " : ""}
                {file.integrity.headline[lang]}
              </strong>
              {file.integrity.warnings.length > 0 && (
                <ul>
                  {file.integrity.warnings.map((w) => (
                    <li key={w.code} className={w.level === "alarm" ? "af-alarm" : ""}>
                      <span className={`chip ${w.level === "alarm" ? "v-failed" : "v-warning"}`}>{w.level === "alarm" ? t.afAlarm : t.afNote}</span> <strong>{w.title[lang]}</strong>
                      {w.count > 1 ? ` (${w.count})` : ""} — {w.explain[lang]}
                      {w.items.length > 0 && (
                        <div className="small muted">
                          {t.afItems}
                          {w.items.join(", ")}
                        </div>
                      )}
                      {w.controls && w.controls.length > 0 && (
                        <div className="small muted">
                          {t.afAffected}
                          {w.controls.join(", ")}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="small muted">{file.integrity.note[lang]}</p>
            </section>

            <div className="ad-verdicts af-filter" role="group" aria-label={t.afFilterGroup}>
              {(["all", "partly", "organisational", "not_covered", "alarm"] as const).map((k) => (
                <button key={k} className={`ad-light ${filter === k ? "on" : ""}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  <span className="ad-num">{k === "all" ? s.controls : k === "alarm" ? s.withAlarm : s[k]}</span>
                  <span>{k === "all" ? t.afFilterAll : k === "alarm" ? t.afFilterAlarm : COVERAGE_LABEL[k][lang]}</span>
                </button>
              ))}
              <div className="ad-light static" title={t.afOrgDoc}>
                <span className="ad-num">
                  {s.orgDocumented}/{s.controls}
                </span>
                <span>{t.afOrgDocumented}</span>
              </div>
            </div>

            {ANNEX_A_AREAS.map((area) => {
              const cs = rows.filter((c) => c.area === area.id);
              if (!cs.length) return null;
              return (
                <section key={area.id} className="af-area">
                  <h4>
                    {area.id} {area.title[lang]}
                  </h4>
                  <div className="table-wrap">
                    <table className="log af-table">
                      <colgroup>
                        <col className="af-c-id" />
                        <col />
                        <col className="af-c-st" />
                        <col className="af-c-org" />
                        <col className="af-c-more" />
                      </colgroup>
                      <tbody>
                        {cs.map((c) => (
                          <Fragment key={c.id}>
                            <tr className={`af-row-c ${open === c.id ? "on" : ""}`}>
                              <td className="af-id">
                                <strong>{c.id}</strong>
                              </td>
                              <td className="af-ti">
                                {c.title[lang]}
                                {c.group !== c.area && <div className="small muted">{ANNEX_A_GROUPS.find((g) => g.id === c.group)?.title[lang]}</div>}
                              </td>
                              <td className="af-st">
                                <span className={`chip ${STATUS_CHIP[c.status]}`}>{COVERAGE_LABEL[c.status][lang]}</span>
                                {c.alarm && <span className="chip v-failed">⚠ {t.afAlarm}</span>}
                                {!c.alarm && c.warnings.length > 0 && <span className="chip v-warning">{t.afNote}</span>}
                              </td>
                              <td className="af-org">
                                {c.orgEvidence.state !== "none" ? <span className={`chip ${ORG_CHIP[c.orgEvidence.state]}`}>{t.afOrgState[c.orgEvidence.state]}</span> : <span className="small muted">{t.afOrgState.none}</span>}
                              </td>
                              <td className="af-mo">
                                <button className="btn link" aria-expanded={open === c.id} aria-label={`${c.id} ${c.title[lang]}`} onClick={() => setOpen(open === c.id ? null : c.id)}>
                                  {open === c.id ? "▴" : "▾"}
                                </button>
                              </td>
                            </tr>
                            {open === c.id && (
                              <tr className="ad-detail">
                                <td colSpan={5} className="af-detail-cell">
                                  <ControlDetail
                                    t={t}
                                    lang={lang}
                                    c={c}
                                    warning={warning}
                                    edit={canEdit ? { states: evStates, adding: adding === c.id, setAdding: (on) => setAdding(on ? c.id : null), onDone: evDone } : undefined}
                                  />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}
            {!rows.length && <p className="muted">{t.afNone}</p>}

            <details className="af-more">
              <summary>{t.afApprovals(file.approvals.length)}</summary>
              {file.approvals.length === 0 ? (
                <p className="muted">{t.afNone}</p>
              ) : (
                <div className="table-wrap">
                  <table className="log af-list">
                    <tbody>
                      {file.approvals.map((a, i) => (
                        <tr key={i}>
                          <td className="small">{when(a.at)}</td>
                          <td>
                            <strong>{L(t.afKindL, a.kind)}</strong> {a.ref} · {L(t.afActionL, a.action)}
                            {a.text && <div className="small">{a.text}</div>}
                            <div className="small muted">
                              {a.by}
                              {a.via ? ` · ${L(t.afViaL, a.via)}` : ""}
                              {a.keyId ? ` · ${t.afKey} ${a.keyId}` : ""}
                              {!a.carries ? ` · ${t.afCarriesNoKind[a.kind] ?? t.afCarriesNo}` : ""}
                              {a.unsigned.length > 0 ? ` · ${t.afUnsigned}${a.unsigned.map((f) => L(t.afFieldL, f)).join(", ")}` : ""}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </details>
            <details className="af-more">
              <summary>{t.afHistory(file.verdictHistory.length)}</summary>
              {file.verdictHistory.length === 0 ? (
                <p className="muted">{t.afNone}</p>
              ) : (
                <ul className="af-history">
                  {file.verdictHistory.map((h) => (
                    <li key={h.node}>
                      <strong>{h.node}</strong> {h.title}
                      {h.stepChanged && <div className="qnote q-warn">{t.afStepChanged}</div>}
                      {h.current && (
                        <div className="small">
                          {t.afCurrent}: {L(t.afActionL, h.current.status)} · {L(t.afOriginL, h.current.origin)} · {h.current.by} · {when(h.current.at)} · {h.current.counts ? t.afVerdictCounts : t.afVerdictNotCounts}
                        </div>
                      )}
                      {h.earlier.map((e, i) => (
                        <div key={i} className="small muted">
                          {t.afEarlier}: {L(t.afActionL, e.status)} · {L(t.afOriginL, e.origin)} · {e.by} · {when(e.at)} → {when(e.replacedAt)} · {L(t.afSigL, e.signature)}
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </details>
            <details className="af-more">
              <summary>{t.afReseals(file.reseals.authentic.length)}</summary>
              {file.reseals.authentic.length === 0 && file.reseals.unproven.length === 0 && <p className="muted">{t.afNone}</p>}
              <ul>
                {file.reseals.authentic.map((r) => (
                  <li key={r.id} className="small">
                    <strong>{r.id}</strong> {when(r.at)} · {L(t.afOriginL, r.kind)} · {r.by} · {L(t.afViaL, r.via)}
                  </li>
                ))}
              </ul>
              {file.reseals.unproven.length > 0 && (
                <p className="qnote q-warn">
                  {t.afUnproven}
                  {file.reseals.unproven.join(", ")}
                </p>
              )}
            </details>
            <details className="af-more">
              <summary>{t.afSourceTable}</summary>
              <div className="table-wrap">
                <table className="log af-list">
                  <tbody>
                    {(Object.keys(file.sources) as EvidenceSource[]).map((k) => {
                      const src = file.sources[k];
                      return (
                        <tr key={k}>
                          <td>
                            <strong>{EVIDENCE_SOURCES[k]?.label[lang] ?? k}</strong>
                          </td>
                          <td>
                            {src.count} — {src.counted[lang]}
                            {src.note && <div className="small muted">{src.note[lang]}</div>}
                            {EVIDENCE_SOURCES[k] && <div className="small muted">{EVIDENCE_SOURCES[k].limits[lang]}</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>

            {canEdit && <p className="small muted">{t.evWhere}</p>}
            {/* Who may read the audit file, shown here (C5, U-K9); changing it stays in the terminal. */}
            <p className="small muted af-access">
              {t.afAccessNow(file.access.mode)}
              {canEdit ? ` ${t.afAccessHow}` : ""}
            </p>

            {!props.auditView && (
              <section className="af-actions">
                {props.teamMode ? (
                  <p className="qnote q-info">{t.afTeamOnly}</p>
                ) : !props.approved ? (
                  <LockedNote t={t} text={t.afPersonOnly} small />
                ) : (
                  <>
                    <div className="af-row">
                      <button className="btn primary" disabled={busy || periodPending} onClick={makePackage} title={t.afPackageHint}>
                        ⤓ {t.afPackage}
                      </button>
                      <label className="check">
                        <input type="checkbox" checked={rolesOnly} onChange={(e) => setRolesOnly(e.target.checked)} /> {t.afRolesOnly}
                      </label>
                    </div>
                    {periodPending ? (
                      <p className="qnote q-warn small" role="status">
                        {t.afPeriodPending}
                      </p>
                    ) : (
                      <p className="small muted">{t.afPackagePeriod(periodLabel(file))}</p>
                    )}
                    <p className="small muted">{t.afPackageHint}</p>
                    {done && (
                      <div className="qnote af-done" role="status">
                        <p>{t.afPackageDone(done.folder, done.where, donePeriod)}</p>
                        <p className="small">
                          {t.afFingerprint} <code>{done.digest.slice(0, 16)}</code> · {t.afKey} <code>{done.keyId}</code>
                        </p>
                        <p className="small muted">{t.afKeyConfirm}</p>
                      </div>
                    )}
                    <div className="af-row">
                      <button className="btn" disabled={busy} aria-expanded={handOver} onClick={() => setHandOver(!handOver)}>
                        {t.afAuditorStart}
                      </button>
                      <button className="btn" aria-expanded={copyOpen} onClick={() => setCopyOpen(!copyOpen)}>
                        {t.evCopyTitle}
                      </button>
                    </div>
                    {copyOpen && <EvidenceCopy t={t} onDone={evDone} />}
                    {handOver && (
                      <div className="af-handover" role="region" aria-label={t.afAuditorStart}>
                        <p>{t.afAuditorExplain}</p>
                        <p className="small muted">{t.afAuditorLimit}</p>
                        <div className="af-row">
                          <button className="btn primary" disabled={busy} onClick={startAuditor}>
                            {t.afAuditorGo}
                          </button>
                          <button className="btn" onClick={() => setHandOver(false)}>
                            {t.cancel}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function ControlDetail(props: {
  t: Dict;
  lang: "de" | "en";
  c: AuditFile["controls"][number];
  warning: (code: string) => AuditFile["integrity"]["warnings"][number] | undefined;
  /** The person's editing (C4c-2); absent for readers and in auditor mode. */
  edit?: { states: Map<string, OrgEvidenceState>; adding: boolean; setAdding: (on: boolean) => void; onDone: (msg: string) => void };
}) {
  const { t, lang, c } = props;
  const srcName = (k: EvidenceSource) => EVIDENCE_SOURCES[k]?.label[lang] ?? k;
  return (
    <div className="af-detail">
      <div className="af-two">
        <div>
          <h5>{t.afScenaria}</h5>
          <p>{c.scenaria[lang]}</p>
          {c.appliesWhen && (
            <p className="small muted">
              {t.afApplies}: {c.appliesWhen[lang]}
            </p>
          )}
          {(c.required.length > 0 || c.supporting.length > 0) && (
            <>
              <h5>{t.afSources}</h5>
              <ul className="af-src">
                {c.required.map((r) => (
                  <li key={`r-${r.source}`}>
                    <span className={`chip ${r.hasData ? "v-passed" : "v-warning"}`}>{t.afRequired}</span> {srcName(r.source)}: {r.count}
                  </li>
                ))}
                {c.supporting.map((r) => (
                  <li key={`s-${r.source}`} className="muted">
                    <span className="chip">{t.afSupporting}</span> {srcName(r.source)}: {r.count}
                  </li>
                ))}
              </ul>
              {c.missing.length > 0 && (
                <p className="qnote q-warn">
                  {t.afMissing}
                  {c.missing.map(srcName).join(", ")}
                </p>
              )}
            </>
          )}
        </div>
        <div>
          <h5>{t.afOrganisation}</h5>
          <p>{c.organisation[lang]}</p>
          <h5>{t.afOrgDoc}</h5>
          {c.orgEvidence.entries.length === 0 ? (
            <p className="small muted">{t.afOrgState.none}</p>
          ) : (
            <ul className="af-docs">
              {c.orgEvidence.entries.map((e) => (
                <li key={e.id}>
                  <strong>{e.title || e.id}</strong>{" "}
                  <span className={`chip ${TRUST_CHIP[e.trust] ?? ""}`}>{e.trust === "verified" && !props.edit ? t.afTrustPerson : t.afTrust[e.trust] ?? e.trust}</span> <span className={`chip ${e.counts ? "v-passed" : ""}`}>{e.counts ? t.afCounts : t.afNotCounts}</span>
                  <div className="small af-url">{safeLink(e.url) ? <a href={e.url} target="_blank" rel="noopener noreferrer">{e.url}</a> : e.url}</div>
                  {normalLink(e.url) && <div className="qnote q-warn">{t.evLinkNormal(normalLink(e.url)!)}</div>}
                  <div className="small muted af-hash">
                    SHA-256 <code>{e.hash}</code>
                  </div>
                  <div className="small">
                    {t.afOwner}: {e.owner.role}
                    {e.owner.name ? ` · ${e.owner.name}` : ""} · {t.afDocDate} {e.date} · {t.afInForce} {when(e.activeFrom)}
                    {e.removedAt ? ` · ${t.afRemoved} ${when(e.removedAt)}` : ""}
                  </div>
                  {e.note && <div className="small muted">{e.note}</div>}
                  {e.copiedFrom && <div className="small muted">{t.afCopied(e.copiedFrom)}</div>}
                  {e.catalogueChanged && <div className="qnote q-warn">{t.afCatalogueChanged}</div>}
                  {props.edit && props.edit.states.get(e.id) && <EvidenceActions t={t} st={props.edit.states.get(e.id)!} onDone={props.edit.onDone} />}
                </li>
              ))}
            </ul>
          )}
          {props.edit &&
            (props.edit.adding ? (
              <EvidenceAdd t={t} control={c.id} controlTitle={c.title[lang]} onDone={props.edit.onDone} onCancel={() => props.edit!.setAdding(false)} />
            ) : (
              <button className="btn" onClick={() => props.edit!.setAdding(true)}>
                + {t.evAdd}
              </button>
            ))}
        </div>
      </div>
      {c.warnings.length > 0 && (
        <>
          <h5>{t.afWarnings}</h5>
          <ul className="af-src">
            {c.warnings.map((code) => {
              const w = props.warning(code);
              return (
                <li key={code}>
                  <span className={`chip ${w?.level === "alarm" ? "v-failed" : "v-warning"}`}>{w?.level === "alarm" ? t.afAlarm : t.afNote}</span> {w ? w.title[lang] : code}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
