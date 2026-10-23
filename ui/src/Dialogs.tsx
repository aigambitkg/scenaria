import { LockedNote, ReadOnlyContext, useApprovalSignal } from "./Approval";
import { HelpButton } from "./HelpButton";
import { Why, WhyList } from "./Why";
import { ExpertPanel } from "./Expert";
import type { SessionKeys } from "./Control";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type AnalysisRecord, type CanonEvent, type CanonSuggestion, type ConversationMessage, type ConversationSession, type Metrics, type ProjectRule, type ScenariaEvent, type StringPayload } from "./api";
import { MessageList } from "./NodePanel";
import type { Dict } from "./i18n";
import { NodeId } from "./Map";
import { GateSection } from "./Control";

export function Modal(props: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("textarea, input, button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? "wide" : ""}`} role="dialog" aria-modal="true" ref={ref}>
        <header className="modal-head">
          <h2>{props.title}</h2>
          <button className="btn icon" onClick={props.onClose} aria-label="close">
            ✕
          </button>
        </header>
        {props.children}
      </div>
    </div>
  );
}

export function RewindDialog(props: {
  t: Dict;
  mode: "rewind" | "fork";
  targetId: string;
  label: string;
  onCancel: () => void;
  onConfirm: (lesson: string, restoreFiles: boolean) => Promise<void>;
}) {
  const { t } = props;
  const [lesson, setLesson] = useState("");
  const [restore, setRestore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal
      title={
        <>
          {props.mode === "rewind" ? t.rewindTitle : t.forkTitle} <NodeId id={props.targetId} /> <span className="muted">{props.label}</span>
        </>
      }
      onClose={props.onCancel}
    >
      <div className="modal-body">
        <p>{props.mode === "rewind" ? t.rewindBody : t.forkBody}</p>
        <label className="field">
          <span>{t.lesson}</span>
          <textarea rows={3} value={lesson} placeholder={t.lessonPlaceholder} onChange={(e) => setLesson(e.target.value)} />
        </label>
        {props.mode === "rewind" && (
          <label className="check">
            <input type="checkbox" checked={restore} onChange={(e) => setRestore(e.target.checked)} />
            <span>{t.restoreFiles}</span>
          </label>
        )}
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
              await props.onConfirm(lesson, restore);
            } catch (e: any) {
              setErr(e?.message ?? String(e));
              setBusy(false);
            }
          }}
        >
          {props.mode === "rewind" ? t.confirmRewind : t.confirmFork}
        </button>
      </footer>
    </Modal>
  );
}

export function DiffDialog(props: { t: Dict; from: string; to: string; stat: string; patch: string; onClose: () => void }) {
  const lines = props.patch.split("\n");
  return (
    <Modal
      wide
      title={
        <>
          {props.t.diffTitle} <NodeId id={props.from} /> → {/^n\d+$/.test(props.to) ? <NodeId id={props.to} /> : props.to}
        </>
      }
      onClose={props.onClose}
    >
      <div className="modal-body diff">
        {props.patch.trim() ? (
          <>
            <pre className="diff-stat">{props.stat}</pre>
            <pre className="diff-patch">
              {lines.map((l, i) => (
                <span
                  key={i}
                  className={
                    l.startsWith("+++") || l.startsWith("---") ? "dh" : l.startsWith("+") ? "da" : l.startsWith("-") ? "dd" : l.startsWith("@@") ? "dm" : l.startsWith("diff ") ? "df" : ""
                  }
                >
                  {l + "\n"}
                </span>
              ))}
            </pre>
          </>
        ) : (
          <p className="muted">{props.t.noDiff}</p>
        )}
      </div>
    </Modal>
  );
}

export function ProtocolDialog(props: { t: Dict; events: ScenariaEvent[]; onSelect: (id: string) => void; onClose: () => void }) {
  const { t } = props;
  return (
    <Modal wide title={t.protocol} onClose={props.onClose}>
      <div className="modal-body">
        <table className="log">
          <thead>
            <tr>
              <th>{t.time}</th>
              <th>{t.event}</th>
              <th>{t.node}</th>
              <th>{t.details}</th>
            </tr>
          </thead>
          <tbody>
            {[...props.events].reverse().map((e, i) => {
              const d = (e.data ?? {}) as Record<string, any>;
              const details =
                e.type === "rewind"
                  ? `${d.from ?? "?"} → ${d.to}${d.autosave ? ` (autosave ${d.autosave})` : ""}${d.lesson ? ` — ${d.lesson}` : ""}`
                  : e.type === "verify"
                    ? `${d.status}${d.notes ? ` — ${d.notes}` : ""}`
                    : e.type === "branch"
                      ? `${d.decision} · option ${d.option}`
                      : d.message ?? "";
              return (
                <tr key={i}>
                  <td className="muted">{new Date(e.ts).toLocaleString()}</td>
                  <td>{e.type}</td>
                  <td>
                    {e.nodeId ? (
                      <button className="btn link" onClick={() => props.onSelect(e.nodeId!)}>
                        <NodeId id={e.nodeId} />
                      </button>
                    ) : null}
                  </td>
                  <td>{details}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

export function ConversationsDialog(props: { t: Dict; onClose: () => void; onSelectNode: (id: string) => void }) {
  const { t } = props;
  const [sessions, setSessions] = useState<ConversationSession[] | null>(null);
  const [open, setOpen] = useState<{ session: ConversationSession; messages: ConversationMessage[] } | null>(null);
  useEffect(() => {
    api.conversations().then(setSessions).catch(() => setSessions([]));
  }, []);
  return (
    <Modal wide title={open ? `${open.session.id} · ${open.session.title ?? ""}` : t.conversations} onClose={props.onClose}>
      <div className="modal-body">
        {!open && sessions && sessions.length === 0 && <p className="muted">{t.noConversations}</p>}
        {!open && sessions && sessions.length > 0 && (
          <table className="log">
            <thead>
              <tr>
                <th>ID</th>
                <th>{t.conversation}</th>
                <th>Provider</th>
                <th>{t.model}</th>
                <th>{t.messagesShort}</th>
                <th>{t.time}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((c) => (
                <tr key={c.id}>
                  <td>
                    <button className="btn link" onClick={async () => setOpen(await api.conversation(c.id))}>
                      {c.id}
                    </button>
                  </td>
                  <td>{c.title ?? "—"}</td>
                  <td>{c.provider ?? c.source}</td>
                  <td>{c.model ?? ""}</td>
                  <td>{c.messageCount}</td>
                  <td className="muted">{new Date(c.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {open && (
          <>
            <button className="btn link" onClick={() => setOpen(null)}>
              ← {t.conversations}
            </button>
            <MessageList msgs={open.messages} t={t} limit={200} />
            <p className="muted">
              {[...new Set(open.messages.map((m) => m.headAt).filter(Boolean))].map((id) => (
                <button key={id} className="btn link" onClick={() => props.onSelectNode(id!)}>
                  {id}{" "}
                </button>
              ))}
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type Kind = "mcp" | "cli" | "chat";

/** Ready-to-paste prompts: nobody has to explain Scenaria to an agent by hand. */
export function PromptDialog(props: { t: Dict; lang: "de" | "en"; toast: (m: string) => void; onClose: () => void; onApplied: () => void }) {
  const { t } = props;
  const [kind, setKind] = useState<Kind>("mcp");
  const [withCtx, setWithCtx] = useState(false);
  const [text, setText] = useState("");
  const [tokens, setTokens] = useState(0);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    api
      .prompt(kind, props.lang, withCtx)
      .then((r) => {
        setText(r.text);
        setTokens(r.tokens);
      })
      .catch((e) => setText(String(e?.message ?? e)));
  }, [kind, withCtx, props.lang]);
  return (
    <Modal wide title={<>{t.promptTitle} <HelpButton topic="agents" /></>} onClose={props.onClose}>
      <div className="modal-body prompt-dlg">
        <div className="tabs" role="tablist">
          {(["mcp", "cli", "chat"] as Kind[]).map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
              {t.promptKinds[k]}
            </button>
          ))}
        </div>
        <p className="hint">{t.promptHints[kind]}</p>
        <textarea ref={ref} className="prompt-text" readOnly value={text} rows={14} onFocus={(e) => e.currentTarget.select()} />
        <div className="row between">
          <label className="check">
            <input type="checkbox" checked={withCtx} onChange={(e) => setWithCtx(e.target.checked)} />
            <span>{t.withContext}</span>
          </label>
          <span className="muted">≈ {tokens} {t.tokens}</span>
          <button
            className="btn primary"
            onClick={async () => {
              if (await copyText(text)) props.toast(t.promptCopied);
              else {
                ref.current?.focus();
                ref.current?.select();
              }
            }}
          >
            {t.copy}
          </button>
        </div>
        {kind === "chat" && (
          <section className="paste">
            <h3>{t.pasteAnswer}</h3>
            <p className="hint">{t.pasteHint}</p>
            <textarea rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"```scenaria\n{\"decision\": {…}}\n```"} />
            <div className="row">
              <button
                className="btn"
                disabled={busy || !paste.trim()}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await api.ingestText(paste);
                    setResult(`${r.created.length} ${t.applied}${r.skipped ? ` · ${r.skipped} ${t.alreadyKnown}` : ""}${r.errors.length ? ` · ${r.errors.join("; ")}` : ""}`);
                    if (r.created.length) {
                      setPaste("");
                      props.onApplied();
                    }
                  } catch (e: any) {
                    setResult(String(e?.message ?? e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t.applyBlocks}
              </button>
              {result && <span className="muted">{result}</span>}
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}

const PROVIDERS = ["ollama", "lmstudio", "openai", "anthropic", "gemini", "mistral", "openrouter", "groq", "custom"];
const MODEL_HINT: Record<string, string> = {
  ollama: "llama3.3",
  lmstudio: "local-model",
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-5-5",
  gemini: "gemini-2.5-flash",
  mistral: "mistral-large-latest",
  openrouter: "meta-llama/llama-3.3-70b-instruct",
  groq: "llama-3.3-70b-versatile",
  custom: "model name",
};

function sevClass(s?: string) {
  return s === "high" ? "sev-high" : s === "medium" ? "sev-mid" : "sev-low";
}

/** Health check (no LLM) + pattern analysis with any LLM + project rules. */
export function AnalysisDialog(props: { t: Dict; lang: "de" | "en"; keys: SessionKeys; initialTab?: "overview" | "expert"; onOpenCanon?: () => void; toast: (m: string) => void; onClose: () => void; onSelectNode: (id: string) => void; onEditGoal: () => void }) {
  const { t } = props;
  const [tab, setTab] = useState<"overview" | "expert">(props.initialTab ?? "overview");
  const [m, setM] = useState<Metrics | null>(null);
  const [rules, setRules] = useState<ProjectRule[]>([]);
  const [proposals, setProposals] = useState<ProjectRule[]>([]);
  const [ruleApproval, setRuleApproval] = useState(false);
  const [proposalCount, setProposalCount] = useState(0);
  const [unconfirmed, setUnconfirmed] = useState<(ProjectRule & { trust: string })[]>([]);
  const [tamperedRules, setTamperedRules] = useState<(ProjectRule & { trust: string })[]>([]);
  const [missingRules, setMissingRules] = useState<string[]>([]);
  const [needsYou, setNeedsYou] = useState(0);
  const [newRule, setNewRule] = useState("");
  const [records, setRecords] = useState<AnalysisRecord[]>([]);
  const [current, setCurrent] = useState<AnalysisRecord | null>(null);
  const [provider, setProvider] = useState("ollama");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [envKeys, setEnvKeys] = useState<string[]>([]);
  const [teamMode, setTeamMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [showAllIssues, setShowAllIssues] = useState(false);

  const reload = async () => {
    // The proposals must never keep the rest of the dialog from loading.
    const [mm, rr, recs, pp] = await Promise.all([api.analysis(), api.rules(), api.analyses(), api.ruleProposals().catch(() => ({ proposals: [] as ProjectRule[], count: 0, unconfirmed: [], tampered: [], missing: [] as string[], needsYou: 0, approval: false }))]);
    setM(mm);
    setRules(rr);
    setProposals(pp.proposals);
    setProposalCount(pp.count);
    setUnconfirmed(pp.unconfirmed);
    setTamperedRules(pp.tampered);
    setMissingRules(pp.missing);
    setNeedsYou(pp.needsYou);
    setRuleApproval(pp.approval);
    setRecords(recs);
    setCurrent((c) => recs.find((r) => r.id === c?.id) ?? recs[0] ?? null);
  };
  // Approval mode arrived (lock clicked, link opened): unlock the rule buttons.
  useApprovalSignal(() => {
    reload().catch(() => {});
  });
  useEffect(() => {
    reload().catch((e) => setErr(String(e?.message ?? e)));
    api
      .analysisConfig()
      .then((c) => {
        setEnvKeys(c.envKeys);
        setTeamMode(c.teamMode);
        if (c.config) {
          setProvider(PROVIDERS.includes(c.config.provider) ? c.config.provider : "custom");
          setModel(c.config.model);
          setBaseUrl(c.config.baseUrl ?? "");
        }
      })
      .catch(() => {});
  }, []);

  const llm = () => ({ provider: provider === "custom" ? "custom" : provider, model: model || MODEL_HINT[provider], baseUrl: baseUrl || undefined });
  const needsUrl = provider === "custom";
  const issues = m ? (showAllIssues ? m.issues : m.issues.slice(0, 8)) : [];

  return (
    <Modal wide title={<>{t.analysisTitle} <HelpButton topic="analysis" /></>} onClose={props.onClose}>
      <div className="modal-body analysis">
        <div className="side-tabs fc-tabs" role="tablist">
          {(["overview", "expert"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {k === "overview" ? t.xTabOverview : `★ ${t.xTabExpert}`}
            </button>
          ))}
        </div>
        {tab === "expert" && <ExpertPanel t={t} lang={props.lang} keys={props.keys} toast={props.toast} onSelectNode={props.onSelectNode} onRulesChanged={() => reload().catch(() => {})} onEditGoal={props.onEditGoal} onOpenCanon={props.onOpenCanon} />}
        {tab === "overview" && (<>
        <p className="hint">{t.xOverviewHint}</p>
        {err && <p className="error">{err}</p>}
        {m && (
          <section className="a-sec health">
            <div className={`hbig ${m.health >= 80 ? "good" : m.health >= 55 ? "mid" : "low"}`}>
              <span className="hnum">{m.health}</span>
              <span className="hlabel">{t.health}</span>
            </div>
            <Why d={m.why?.health} shown={m.health} t={t} lang={props.lang} label={`${t.health} ${m.health}`} />
            <div className="hfacts">
              <p>
                {t.goal}:{" "}
                {m.goalSet ? (
                  <strong>✓</strong>
                ) : (
                  <button className="btn link" onClick={props.onEditGoal}>
                    {t.setGoal}
                  </button>
                )}
                {" · "}
                {t.decisionQuality}: <strong>{Math.round(m.decisionQuality * 100)} %</strong>
              </p>
              <p className="muted">
                {m.counts.tasks} {t.statusTasks} · {m.counts.decisions} {t.decisionsShort} · {m.counts.branches} {t.statusBranches} · {m.counts.rewinds} {t.rewinds} · {m.counts.passed}✓ / {m.counts.failed}✘
              </p>
              {m.why && <WhyList items={(["tasks", "decisions", "branches", "rewinds", "passed", "failed", "openDecisions", "selfReported", "irreversible"] as const).map((k) => [m.why.counts[k], m.counts[k]])} t={t} lang={props.lang} title={t.whyCounts} />}
            </div>
          </section>
        )}

        {m && (
          <section className="a-sec">
            <h3>{t.issues}</h3>
            {m.issues.length === 0 ? (
              <p className="muted">{t.noIssues}</p>
            ) : (
              <ul className="issues">
                {issues.map((i, k) => (
                  <li key={k} className={sevClass(i.severity)}>
                    {i.nodeId && (
                      <button className="btn link" onClick={() => props.onSelectNode(i.nodeId!)}>
                        <NodeId id={i.nodeId} />
                      </button>
                    )}{" "}
                    {t.issueText[i.code] ? t.issueText[i.code](i.subject ?? "", i.value) : i.message}
                  </li>
                ))}
                {m.issues.length > 8 && !showAllIssues && (
                  <li>
                    <button className="btn link" onClick={() => setShowAllIssues(true)}>
                      {t.showMore} (+{m.issues.length - 8})
                    </button>
                  </li>
                )}
              </ul>
            )}
          </section>
        )}

        {m && Object.keys(m.byModel).length > 0 && (
          <section className="a-sec">
            <h3>{t.agentsModels}</h3>
            <table className="log">
              <thead>
                <tr>
                  <th></th>
                  <th>{t.decisionsShort}</th>
                  <th>{t.decisionQuality}</th>
                  <th>{t.confidence}</th>
                  <th>{t.revised}</th>
                  <th>✘</th>
                </tr>
              </thead>
              <tbody>
                {[...Object.entries(m.byAgent).map(([k, v]) => [t.kindAgent, k, v] as const), ...Object.entries(m.byModel).map(([k, v]) => [t.kindModel, k, v] as const)].map(([kind, k, v]) => (
                  <tr key={kind + k}>
                    <td>
                      <span className="muted">{kind}</span> {k}
                    </td>
                    <td>{v.decisions}</td>
                    <td>{Math.round(v.avgQuality * 100)} %</td>
                    <td>{v.avgConfidence === null ? "–" : `${Math.round(v.avgConfidence * 100)} %`}</td>
                    <td>{v.revised}</td>
                    <td>{v.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section className="a-sec">
          <h3>{t.rulesTitle}</h3>
          <p className="hint">{t.rulesHint}</p>
          {!ruleApproval && <LockedNote t={t} text={[proposalCount > 0 ? t.ruleProposalsWaiting(proposalCount) : "", needsYou > 0 ? t.rulesNeedYou(needsYou) : "", t.rulesLocked].filter(Boolean).join(" ")} small />}
          {missingRules.length > 0 && <p className="qnote q-bad">{t.rulesMissing(missingRules.join(", "))}</p>}
          {[
            { list: tamperedRules, title: t.rulesTamperedTitle, hint: t.rulesTamperedHint, cls: "rule-proposals rule-bad" },
            { list: unconfirmed, title: t.rulesUnconfirmedTitle, hint: t.rulesUnconfirmedHint, cls: "rule-proposals" },
          ]
            .filter((g) => g.list.length > 0)
            .map((g) => (
              <div key={g.title} className={g.cls}>
                <h4>{g.title}</h4>
                <p className="hint">{g.hint}</p>
                <ul className="rules">
                  {g.list.map((r) => (
                    <li key={r.id}>
                      <span className="muted">{r.id}</span> {r.text}{" "}
                      <span className="muted">
                        · {r.trust === "tampered" ? "" : `${r.trust === "untrusted" ? t.ruleUntrusted : t.ruleUnsigned} · `}
                        {t.ruleOrigin(r.source, (r.createdAt ?? "").slice(0, 10))}
                      </span>{" "}
                      <button
                        className="btn"
                        disabled={!ruleApproval}
                        onClick={async () => {
                          try {
                            await api.confirmRule(r.id, r.text);
                            props.toast(t.ruleConfirmed);
                          } catch (e: any) {
                            setErr(String(e?.message ?? e));
                          }
                          reload();
                        }}
                      >
                        {t.ruleConfirm}
                      </button>{" "}
                      <button
                        className="btn"
                        disabled={!ruleApproval}
                        onClick={async () => {
                          try {
                            await api.deleteRule(r.id);
                          } catch (e: any) {
                            setErr(String(e?.message ?? e));
                          }
                          reload();
                        }}
                      >
                        {t.remove}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          {rules.length > 0 && (
            <ul className="rules">
              {rules.map((r) => (
                <li key={r.id}>
                  <span className="muted">{r.id}</span> {r.text}{" "}
                  <button
                    className="btn icon"
                    aria-label={t.remove}
                    title={t.remove}
                    disabled={!ruleApproval}
                    onClick={async () => {
                      try {
                        await api.deleteRule(r.id);
                      } catch (e: any) {
                        setErr(String(e?.message ?? e));
                      }
                      reload();
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          {proposals.length > 0 && (
            <div className="rule-proposals">
              <h4>{t.ruleProposalsTitle}</h4>
              <p className="hint">{t.ruleProposalsHint}</p>
              <ul className="rules">
                {proposals.map((r) => (
                  <li key={r.id}>
                    <span className="muted">{r.id}</span> {r.text} <span className="muted">· {r.proposedBy ? t.ruleFrom(r.proposedBy) : t.ruleFromAgent}</span>{" "}
                    <button
                      className="btn"
                      disabled={!ruleApproval}
                      onClick={async () => {
                        try {
                          await api.approveRule(r.id, r.text);
                          props.toast(t.ruleAccepted);
                        } catch (e: any) {
                          setErr(String(e?.message ?? e));
                        }
                        reload();
                      }}
                    >
                      {t.ruleApprove}
                    </button>{" "}
                    <button
                      className="btn"
                      disabled={!ruleApproval}
                      onClick={async () => {
                        try {
                          await api.rejectRule(r.id);
                          props.toast(t.ruleRejected);
                        } catch (e: any) {
                          setErr(String(e?.message ?? e));
                        }
                        reload();
                      }}
                    >
                      {t.ruleReject}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newRule.trim() || !ruleApproval) return;
              try {
                await api.addRule(newRule);
                setNewRule("");
              } catch (e: any) {
                setErr(String(e?.message ?? e));
              }
              reload();
            }}
          >
            <input className="grow" value={newRule} placeholder={t.rulePlaceholder} disabled={!ruleApproval} onChange={(e) => setNewRule(e.target.value)} />
            <button className="btn" type="submit" disabled={!newRule.trim() || !ruleApproval}>
              {t.addRule}
            </button>
          </form>
        </section>

        <section className="a-sec">
          <h3>{t.aiAnalysis}</h3>
          <p className="hint">{t.aiHint}</p>
          <div className="llm-form">
            <label>
              <span>{t.provider}</span>
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setModel("");
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p === "custom" ? t.customProvider : p}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t.modelLabel}</span>
              <input value={model} placeholder={MODEL_HINT[provider]} onChange={(e) => setModel(e.target.value)} />
            </label>
            {(needsUrl || baseUrl) && !teamMode && (
              <label className="wide">
                <span>{t.baseUrl}</span>
                <input value={baseUrl} placeholder="http://127.0.0.1:11434/v1" onChange={(e) => setBaseUrl(e.target.value)} />
              </label>
            )}
            {!["ollama", "lmstudio"].includes(provider) && (
              <label className="wide">
                <span>{t.apiKey}</span>
                <input type="password" autoComplete="off" value={apiKey} placeholder={envKeys.length ? `${t.envKeyFound}: ${envKeys.join(", ")}` : t.apiKeyHint} onChange={(e) => setApiKey(e.target.value)} />
              </label>
            )}
          </div>
          <div className="row">
            <button
              className="btn primary"
              disabled={busy || (needsUrl && !baseUrl)}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const rec = await api.runAnalysis({ ...llm(), apiKey: apiKey || undefined, lang: props.lang });
                  setCurrent(rec);
                  await reload();
                  setCurrent(rec);
                } catch (e: any) {
                  setErr(String(e?.message ?? e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? t.running : t.runAnalysis}
            </button>
            <button
              className="btn"
              disabled={needsUrl && !baseUrl}
              onClick={async () => {
                await api.saveAnalysisConfig({ ...llm() } as any);
                props.toast(t.savedDefault);
              }}
            >
              {t.saveDefault}
            </button>
            <button
              className="btn"
              onClick={async () => {
                const d = await api.dossier(props.lang);
                props.toast((await copyText(d.text)) ? `${t.dossierCopied} (≈ ${d.tokens} ${t.tokens})` : d.text.slice(0, 100));
              }}
            >
              {t.copyDossier}
            </button>
          </div>
          <details className="paste">
            <summary>{t.pasteResult}</summary>
            <textarea rows={4} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{"summary": "…", "rules": [ … ]}' />
            <button
              className="btn"
              disabled={!pasted.trim()}
              onClick={async () => {
                try {
                  const rec = await api.importAnalysis(pasted, props.lang);
                  setPasted("");
                  await reload();
                  setCurrent(rec);
                } catch (e: any) {
                  setErr(String(e?.message ?? e));
                }
              }}
            >
              {t.importResult}
            </button>
          </details>
        </section>

        {current && (
          <section className="a-sec result">
            <h3>
              {t.resultOf} {new Date(current.createdAt).toLocaleString()} · <span className="muted">{current.provider}/{current.model}</span>
              {records.length > 1 && (
                <select className="hist" value={current.id} onChange={(e) => setCurrent(records.find((r) => r.id === e.target.value) ?? null)}>
                  {records.map((r) => (
                    <option key={r.id} value={r.id}>
                      {new Date(r.createdAt).toLocaleString()} · {r.model}
                    </option>
                  ))}
                </select>
              )}
            </h3>
            {current.insights.summary && <p>{current.insights.summary}</p>}
            {current.insights.goalAlignment && (
              <p>
                <strong>{t.goalAlignment}:</strong> {current.insights.goalAlignment.score ?? "?"}/100 — {current.insights.goalAlignment.notes}
              </p>
            )}
            {(current.insights.patterns?.length ?? 0) > 0 && (
              <>
                <h4>{t.patterns}</h4>
                <ul className="patterns">
                  {current.insights.patterns!.map((x, i) => (
                    <li key={i} className={x.kind === "good" ? "good" : "bad"}>
                      <strong>{x.title}</strong> {x.impact ? `— ${x.impact}` : ""} <Evidence ids={x.evidence} onSelect={props.onSelectNode} />
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(current.insights.issues?.length ?? 0) > 0 && (
              <>
                <h4>{t.issues}</h4>
                <ul className="issues">
                  {current.insights.issues!.map((x, i) => (
                    <li key={i} className={sevClass(x.severity)}>
                      <strong>{x.title}</strong> {x.fix ? `→ ${x.fix}` : ""} <Evidence ids={x.evidence} onSelect={props.onSelectNode} />
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(current.insights.rules?.length ?? 0) > 0 && (
              <>
                <h4>{t.recommendedRules}</h4>
                <ul className="rules">
                  {current.insights.rules!.map((r, i) => {
                    const taken = rules.some((x) => x.text.toLowerCase() === r.text.toLowerCase());
                    return (
                      <li key={i}>
                        {r.text} {r.why ? <span className="muted">— {r.why}</span> : null} <Evidence ids={r.evidence} onSelect={props.onSelectNode} />{" "}
                        <button
                          className="btn"
                          disabled={taken || !ruleApproval}
                          title={!ruleApproval && !taken ? t.rulesLocked : undefined}
                          onClick={async () => {
                            try {
                              await api.acceptRule(current.id, i);
                              props.toast(t.ruleAccepted);
                            } catch (e: any) {
                              setErr(String(e?.message ?? e));
                            }
                            reload();
                          }}
                        >
                          {taken ? t.accepted : t.acceptRule}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {(current.insights.tokenTips?.length ?? 0) > 0 && (
              <>
                <h4>{t.tokenTips}</h4>
                <ul>
                  {current.insights.tokenTips!.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}
        </>)}
      </div>
    </Modal>
  );
}

function Evidence({ ids, onSelect }: { ids?: string[]; onSelect: (id: string) => void }) {
  if (!ids?.length) return null;
  return (
    <span className="evidence">
      {ids
        .filter((id) => /^n\d+$/.test(id))
        .slice(0, 6)
        .map((id) => (
          <button key={id} className="btn link" onClick={() => onSelect(id)}>
            <NodeId id={id} />
          </button>
        ))}
    </span>
  );
}

/** Canon events: the project's fixed points. Agents and the archivist propose — the person decides here. */
export function CanonDialog(props: { t: Dict; lang: "de" | "en"; toast: (m: string) => void; onClose: () => void; onSelectNode: (id: string) => void; onChanged: () => void }) {
  const readOnly = useContext(ReadOnlyContext);
  const { t } = props;
  const [events, setEvents] = useState<CanonEvent[]>([]);
  const [sugs, setSugs] = useState<CanonSuggestion[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [approval, setApproval] = useState(false);
  useApprovalSignal(() => setApproval(true));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adopt, setAdopt] = useState<Record<string, string | undefined>>({});
  const [form, setForm] = useState({ kind: "past", text: "", check: "", due: "", hard: true, task: "", weight: "", artifact: "" });
  const [verdict, setVerdict] = useState<StringPayload | null>(null);
  // E2: completion criteria — the tasks to choose from, weights typed per criterion, missing ones the person can let go.
  const [tasks, setTasks] = useState<{ id: string; title: string }[]>([]);
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [letGo, setLetGo] = useState<{ id: string; text: string }[]>([]);

  const reload = async () => {
    const r = await api.canon();
    setEvents(r.events);
    setSugs(r.suggestions);
    setFileError(r.error);
    setMissing(r.missing ?? []);
    setLetGo(r.letGo ?? []);
    setApproval(r.approval);
    try {
      const g = await api.graph();
      setTasks(g.nodes.filter((n) => n.type === "goal").map((n) => ({ id: n.id, title: n.title })));
      if (g.state.head) setVerdict(await api.stringAt(g.state.head));
    } catch {
      setVerdict(null);
    }
  };
  useEffect(() => {
    reload().catch((e) => setErr(String(e?.message ?? e)));
  }, []);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      await reload();
      props.onChanged();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      // Show what is stored now (e.g. a proposal that changed since it was shown — E2b review M2).
      await reload().catch(() => {});
    } finally {
      setBusy(null);
    }
  };
  const locked = !approval || Boolean(busy);
  const active = events.filter((e) => e.status === "active");
  const proposed = events.filter((e) => e.status === "proposed");
  const tampered = events.filter((e) => e.status === "tampered" || e.status === "untrusted");
  const pending = (e: CanonEvent) => e.status === "proposed" || e.status === "tampered" || e.status === "untrusted";
  const closed = events.filter((e) => e.status === "rejected" || e.status === "retired");
  /**
   * The weight in a criterion's field: undefined = untouched (the field shows the stored weight, which is signed as
   * shown); null = touched but not a whole number from 1 to 100 (empty too) — the buttons stay off (E2b review M1).
   */
  const typedWeight = (e: CanonEvent): number | null | undefined => {
    const w = weights[e.id];
    if (w === undefined) return undefined;
    return /^\d{1,3}$/.test(w.trim()) && Number(w) >= 1 && Number(w) <= 100 ? Number(w) : null;
  };
  const forget = (id: string) =>
    setWeights((x) => {
      const { [id]: _, ...rest } = x;
      return rest;
    });
  /** A criterion (and any fixed point) is approved exactly as shown here (E2a review M3). */
  const shownAs = (e: CanonEvent) => ({ text: e.text, task: e.task, weight: e.weight, artifact: e.artifact });
  const weightField = (e: CanonEvent) => (
    <>
      <label className="field inline pg-weight">
        <span>{t.canonWeight}</span>
        <input
          type="number"
          min={1}
          max={100}
          step={1}
          inputMode="numeric"
          disabled={locked}
          value={weights[e.id] ?? String(e.weight ?? "")}
          title={t.canonWeightHint}
          aria-label={`${t.canonWeight} ${e.id}`}
          aria-invalid={typedWeight(e) === null}
          // Text the browser cannot read as a number ("5-") arrives as "" with badInput: invalid, never "unchanged".
          onChange={(x) => setWeights({ ...weights, [e.id]: x.target.validity.badInput ? "?" : x.target.value })}
        />
      </label>
      {typedWeight(e) === null && <span className="small error-text">{t.canonWeightInvalid}</span>}
    </>
  );
  const row = (e: CanonEvent) => (
    <li key={e.id} className={`canon-item k-${e.kind} ${e.status === "tampered" || e.status === "untrusted" ? "tampered" : ""}`}>
      <div className="canon-main">
        <span className="canon-id">{e.id}</span>
        <span className={`chip ${e.kind === "past" ? "k-past" : "k-future"}`}>{t.canonKinds[e.kind]}</span>
        <span className="chip">{e.hard ? t.canonHard : t.canonSoft}</span>
        {e.due && <span className="chip">{t.canonDue} {e.due}</span>}
        {e.lastCheck && <span className={`chip v-${e.lastCheck.status}`}>{e.lastCheck.status === "passed" ? "✓" : "✘"} {e.lastCheck.how === "manual" ? t.canonConfirmed : t.canonChecked}</span>}
        {e.status === "untrusted" && (
          <span className="chip v-failed">
            ⛔ {t.canonUntrusted} {e.keyId}
          </span>
        )}
        {e.status === "tampered" && <span className="chip v-failed">⛔ {t.canonTampered}</span>}
        {e.task && <span className="chip k-future">{t.canonCriterionOf(e.task)}</span>}
        {e.task && <span className="chip">{e.weight !== undefined ? `${t.canonWeight} ${e.weight}` : t.pgNoWeight}</span>}
        {e.artifact && (
          <span className="chip">
            {t.canonFile} <code className="cmd">{e.artifact}</code>
          </span>
        )}
      </div>
      <p>{e.text}</p>
      {e.check && !pending(e) && (
        <p className="small">
          {t.canonRuns}: <code className="cmd">{e.check}</code>
        </p>
      )}
      {/* Not yet binding: any command is only a suggestion until the person adopts exactly this text. */}
      {pending(e) &&
        [...new Set([e.check, e.suggestedCheck].filter((c): c is string => Boolean(c)))].map((cmd) => (
          <div key={cmd} className="small suggested">
            {t.canonSuggestedCheck}: <code className="cmd">{cmd}</code>
            <label className="check">
              <input type="checkbox" checked={adopt[e.id] === cmd} onChange={(x) => setAdopt({ ...adopt, [e.id]: x.target.checked ? cmd : undefined })} />
              <span>{t.canonAdoptCheck}</span>
            </label>
          </div>
        ))}
      <p className="muted small">
        {e.evidence?.length ? (
          <>
            {t.canonEvidence}:{" "}
            {e.evidence.map((r) =>
              /^n\d+/.test(r) ? (
                <button key={r} className="btn link" onClick={() => props.onSelectNode(r.split(".")[0])}>
                  <NodeId id={r.split(".")[0]} />
                </button>
              ) : (
                <span key={r}>{r} </span>
              ),
            )}
            {" · "}
          </>
        ) : null}
        {e.status === "proposed" ? `${t.canonFrom} ${e.proposedBy ?? e.source}` : e.decidedBy ? `${e.status === "active" ? t.canonApprovedBy : e.status} ${e.decidedBy} (${e.decidedVia ?? "?"})` : ""}
      </p>
      <div className="row">
        {pending(e) && (
          <>
            {e.task && weightField(e)}
            <button
              className="btn ok"
              disabled={locked || (Boolean(e.task) && typedWeight(e) === null)}
              onClick={() => {
                const w = typedWeight(e);
                return run(e.id, async () => {
                  await api.decideCanon(e.id, "approve", { ...(adopt[e.id] ? { adoptCheck: adopt[e.id] } : {}), expect: shownAs(e), ...(e.task && typeof w === "number" && w !== e.weight ? { weight: w } : {}) });
                  forget(e.id);
                });
              }}
            >
              {e.status === "proposed" ? t.canonApprove : t.canonReapprove}
            </button>
            <button className="btn bad" disabled={locked} onClick={() => run(e.id, () => api.decideCanon(e.id, "reject"))}>
              {t.canonReject}
            </button>
          </>
        )}
        {e.status === "active" && (
          <>
            {e.task && (
              <>
                {weightField(e)}
                <button
                  className="btn"
                  disabled={locked || typeof typedWeight(e) !== "number" || typedWeight(e) === e.weight}
                  onClick={() => {
                    const w = typedWeight(e);
                    if (typeof w !== "number") return;
                    return run(e.id, async () => {
                      await api.decideCanon(e.id, "reweigh", { weight: w });
                      forget(e.id); // the field shows the new stored weight (E2b review L8)
                    });
                  }}
                >
                  {t.canonReweigh}
                </button>
              </>
            )}
            {e.kind === "future" && (
              <button className="btn" disabled={locked} onClick={() => run(e.id, () => api.decideCanon(e.id, "confirm"))}>
                {t.canonConfirm}
              </button>
            )}
            <button className="btn" disabled={locked} onClick={() => run(e.id, () => api.decideCanon(e.id, "retire"))}>
              {t.canonRetire}
            </button>
          </>
        )}
      </div>
    </li>
  );
  return (
    <Modal wide title={<>{t.canonTitle} <HelpButton topic="canon" /></>} onClose={props.onClose}>
      <div className="modal-body analysis canon">
        <p className="hint">{t.canonIntro}</p>
        {!approval && <LockedNote t={t} text={t.canonLocked} />}
        {fileError && <p className="error">{fileError}</p>}
        {missing.filter((id) => !letGo.some((g) => g.id === id)).length > 0 && (
          <p className="error">
            ⛔ {missing.filter((id) => !letGo.some((g) => g.id === id)).join(", ")}: {t.canonMissing}
          </p>
        )}
        {letGo.length > 0 && (
          <div className="error">
            <p>⛔ {t.canonLetGoHint}</p>
            <ul className="pg-unsettled">
              {letGo.map((g) => (
                <li key={g.id}>
                  <span className="canon-id">{g.id}</span> {g.text || "–"}{" "}
                  <button className="btn" disabled={locked} onClick={() => run(`go-${g.id}`, () => api.decideCanon(g.id, "retire"))}>
                    {t.canonLetGo}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {err && <p className="error">{err}</p>}
        {verdict && (
          <section className={`a-sec verdict-box v-${verdict.verdict}`}>
            <strong>
              {t.canonVerdict}: {t.canonVerdicts[verdict.verdict]}
            </strong>{" "}
            <span className="muted">{verdict.string}</span>
            {verdict.reasons.length > 0 && <p className="small">{verdict.reasons.join(" · ")}</p>}
          </section>
        )}
        <GateSection t={t} locked={locked} toast={props.toast} onNode={props.onSelectNode} onChanged={() => reload().catch(() => {})} reloadKey={events} />
        {tampered.length > 0 && (
          <section className="a-sec">
            <h3>⛔ {t.canonTamperedTitle}</h3>
            <p className="hint">{t.canonTamperedHint}</p>
            <ul className="canon-list">{tampered.map(row)}</ul>
          </section>
        )}
        {proposed.length > 0 && (
          <section className="a-sec">
            <h3>
              {t.canonProposals} <span className="count">{proposed.length}</span>
            </h3>
            <ul className="canon-list">{proposed.map(row)}</ul>
          </section>
        )}
        <section className="a-sec">
          <h3>
            {t.canonActive} <span className="count">{active.length}</span>
            <button
              className="btn"
              disabled={locked || !active.some((e) => e.check)}
              onClick={() =>
                run("check", async () => {
                  const r = await api.checkCanon();
                  props.toast(r.map((x) => `${x.id} ${x.status === "passed" ? "✓" : "✘"}`).join(" · ") || t.canonNoChecks);
                })
              }
            >
              {busy === "check" ? t.running : t.canonRunChecks}
            </button>
          </h3>
          {active.length ? <ul className="canon-list">{active.map(row)}</ul> : <p className="muted">{t.canonNone}</p>}
        </section>
        <section className="a-sec">
          <h3>{t.canonArchivist}</h3>
          <p className="hint">{t.canonArchivistHint}</p>
          {sugs.length > 0 ? (
            <ul className="canon-list">
              {sugs.map((sg, i) => (
                <li key={i} className="canon-item">
                  <div className="canon-main">
                    <span className={`chip ${sg.kind === "past" ? "k-past" : "k-future"}`}>{t.canonKinds[sg.kind]}</span>
                    <span className="muted small">{sg.why}</span>
                  </div>
                  <p>{sg.text}</p>
                  <button className="btn ok" disabled={locked} onClick={() => run(`s${i}`, () => api.addCanon({ kind: sg.kind, text: sg.text, hard: true, evidence: sg.evidence }))}>
                    {t.canonAdopt}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t.canonNoSuggestions}</p>
          )}
          {!readOnly && (
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={() =>
              run("llm", async () => {
                const r = await api.archivist(props.lang);
                props.toast(`${r.proposed.length} ${t.canonLlmProposed} (${r.model})`);
              })
            }
          >
            {busy === "llm" ? t.running : t.canonAskLlm}
          </button>
          )}
        </section>
        {!readOnly && (
        <section className="a-sec">
          <h3>{t.canonNew}</h3>
          <form
            className="canon-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (form.text.trim().length < 4 || locked) return;
              run("add", async () => {
                const crit = form.kind === "future" && form.task;
                await api.addCanon({
                  kind: form.kind,
                  text: form.text,
                  hard: form.hard,
                  check: form.check || undefined,
                  due: form.kind === "future" && form.due ? form.due : undefined,
                  ...(crit ? { task: form.task, weight: form.weight.trim() ? Number(form.weight) : undefined, artifact: form.artifact.trim() || undefined } : {}),
                });
                setForm({ ...form, text: "", check: "", due: "", weight: "", artifact: "" });
              });
            }}
          >
            <div className="seg" role="radiogroup">
              {(["past", "future"] as const).map((k) => (
                <button type="button" key={k} role="radio" aria-checked={form.kind === k} className={form.kind === k ? "on" : ""} onClick={() => setForm({ ...form, kind: k })}>
                  {t.canonKinds[k]}
                </button>
              ))}
            </div>
            <input value={form.text} placeholder={form.kind === "past" ? t.canonPastPh : t.canonFuturePh} onChange={(e) => setForm({ ...form, text: e.target.value })} />
            <input value={form.check} placeholder={t.canonCheckPh} onChange={(e) => setForm({ ...form, check: e.target.value })} />
            {form.kind === "future" && <input type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />}
            {form.kind === "future" && (
              <label className="field">
                <span>{t.canonTask}</span>
                <select value={form.task} onChange={(e) => setForm({ ...form, task: e.target.value })}>
                  <option value="">{t.canonTaskNone}</option>
                  {tasks.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.id} · {x.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {form.kind === "future" && form.task && (
              <>
                <label className="field inline pg-weight">
                  <span>{t.canonWeight}</span>
                  <input type="number" min={1} max={100} step={1} inputMode="numeric" value={form.weight} title={t.canonWeightHint} onChange={(e) => setForm({ ...form, weight: e.target.value })} />
                </label>
                <input value={form.artifact} placeholder={t.canonArtifactPh} aria-label={t.canonFile} onChange={(e) => setForm({ ...form, artifact: e.target.value })} />
              </>
            )}
            <label className="check">
              <input type="checkbox" checked={form.hard} onChange={(e) => setForm({ ...form, hard: e.target.checked })} />
              <span>{t.canonHardLabel}</span>
            </label>
            <button className="btn primary" type="submit" disabled={locked || form.text.trim().length < 4}>
              {t.canonAdd}
            </button>
          </form>
        </section>
        )}
        {closed.length > 0 && (
          <details className="a-sec">
            <summary>
              {t.canonClosed} ({closed.length})
            </summary>
            <ul className="canon-list">
              {closed.map((e) => (
                <li key={e.id} className="canon-item closed">
                  <span className="canon-id">{e.id}</span> <span className="chip">{e.status}</span> {e.text}
                  {e.reason ? <span className="muted small"> — {e.reason}</span> : null}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  );
}
