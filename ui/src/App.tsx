import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { api, type Fidelity, type Graph, type ScenariaEvent, type ScenariaNode } from "./api";
import { dict, initialLang, saveLang, type Lang } from "./i18n";
import { ProjectSwitcher } from "./Projects";
import { HelpDialog, Onboarding, onboardingDone, restartOnboarding } from "./Help";
import { HelpContext } from "./HelpButton";
import type { HelpAction } from "./helpContent";
import { layoutTree, taskOf } from "./layout";
import { NodeId, ScenarioMap } from "./Map";
import { NodePanel } from "./NodePanel";
import { AnalysisDialog, CanonDialog, ConversationsDialog, DiffDialog, PromptDialog, ProtocolDialog, RewindDialog } from "./Dialogs";
import { ChatPanel, RelayDialog, SettingsDialog, type SessionKeys } from "./Control";
import { ErrorBoundary } from "./ErrorBoundary";
import { ForecastsDialog } from "./Forecasts";
import { AuditDialog } from "./AuditArea";

type Pending =
  | { mode: "rewind"; node: ScenariaNode }
  | { mode: "fork"; decision: ScenariaNode; optionId: string; label: string }
  | null;

function fmtK(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

export function App(props: { keys: SessionKeys; setKeys: Dispatch<SetStateAction<SessionKeys>>; onProjectSwitched: () => void }) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [lang, setLang] = useState<Lang>(initialLang);
  const [selected, setSelected] = useState<string | null>(null);
  /** Tasks the user opened or closed by hand (otherwise: only the current task is open). */
  const [foldOverride, setFoldOverride] = useState<Record<string, boolean>>({});
  const [promptOpen, setPromptOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [editGoal, setEditGoal] = useState<string | null>(null);
  const [health, setHealth] = useState<number | null>(null);
  const [headCtx, setHeadCtx] = useState<{ tokens: number; historyTokens: number } | null>(null);
  const [fidelity, setFidelity] = useState<Fidelity | null>(null);
  const [canonOpen, setCanonOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [canonInfo, setCanonInfo] = useState<{ active: number; proposed: number } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [diff, setDiff] = useState<{ from: string; to: string; stat: string; patch: string } | null>(null);
  const [log, setLog] = useState<ScenariaEvent[] | null>(null);
  const [convos, setConvos] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [relayOpen, setRelayOpen] = useState(false);
  const [analysisTab, setAnalysisTab] = useState<"overview" | "expert">("overview");
  /** Help: false = closed, string = open at that topic. */
  const [help, setHelp] = useState<string | false>(false);
  const [onboarding, setOnboarding] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [projectsSignal, setProjectsSignal] = useState(0);
  /** Forecasts page: false = closed, null = open without focus, "n12" = focused on a decision. */
  const [forecastFocus, setForecastFocus] = useState<string | null | false>(false);
  const [side, setSide] = useState<"node" | "chat">("node");
  /** API keys typed into Settings: memory only (never stored, gone when the tab closes) — kept across project switches. */
  const { keys, setKeys } = props;
  const switched = useRef(props.onProjectSwitched);
  switched.current = props.onProjectSwitched;
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const toastId = useRef(0);
  const t = dict[lang];

  const toast = useCallback((msg: string) => {
    const id = ++toastId.current;
    setToasts((l) => [...l, { id, msg }]);
    setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), 4200);
  }, []);

  const load = useCallback(async () => {
    try {
      const g = await api.graph();
      setGraph(g);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    load();
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    try {
      es = new EventSource("/api/events");
      es.addEventListener("hello", () => setLive(true));
      es.addEventListener("change", () => load());
      // The person switched the dashboard to another project (here or in another tab).
      es.addEventListener("project", () => switched.current());
      es.onerror = () => setLive(false);
    } catch {
      poll = setInterval(load, 3000);
    }
    return () => {
      es?.close();
      if (poll) clearInterval(poll);
    };
  }, [load]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // A used or wrong approval link lands here (no dead page): say what happened, clean the URL.
  const [linkNote, setLinkNote] = useState(() => new URLSearchParams(location.search).get("approval") === "invalid");
  useEffect(() => {
    if (linkNote) history.replaceState(null, "", location.pathname);
  }, [linkNote]);

  const headId = graph?.state.head ?? null;
  const root = useMemo(() => {
    const ns = graph?.nodes ?? [];
    return ns.find((n) => n.id === (graph?.state.projectRoot ?? "n0")) ?? ns.find((n) => !n.parentId) ?? null;
  }, [graph]);
  const rootId = root?.id ?? null;

  // When HEAD moves (agent activity) select it.
  const lastHead = useRef<string | null>(null);
  useEffect(() => {
    if (headId && headId !== lastHead.current) {
      lastHead.current = headId;
      setSelected(headId);
    }
  }, [headId]);

  // Folding: every task is folded except the current one and the selected one, unless toggled by hand.
  const folded = useMemo(() => {
    const ns = graph?.nodes ?? [];
    const open = new Set([taskOf(ns, headId), taskOf(ns, selected)].filter(Boolean) as string[]);
    return new Set(ns.filter((n) => n.type === "goal" && (foldOverride[n.id] ?? !open.has(n.id))).map((n) => n.id));
  }, [graph, headId, selected, foldOverride]);
  const toggleFold = useCallback((id: string) => setFoldOverride((o) => ({ ...o, [id]: !folded.has(id) })), [folded]);

  useEffect(() => {
    api.analysis().then((m) => setHealth(m.health)).catch(() => setHealth(null));
    api.fidelity().then(setFidelity).catch(() => setFidelity(null));
    api
      .canon()
      .then((c) => setCanonInfo({ active: c.events.filter((e) => e.status === "active").length, proposed: c.events.filter((e) => e.status === "proposed").length }))
      .catch(() => setCanonInfo(null));
    if (headId) api.context(headId).then((c) => setHeadCtx(c)).catch(() => setHeadCtx(null));
  }, [graph?.version, headId]);

  const placed = useMemo(() => {
    if (!graph || !rootId || !selected) return null;
    return layoutTree(graph.nodes, rootId, folded).placed.find((p) => p.key === selected) ?? null;
  }, [graph, rootId, selected, folded]);

  const stats = useMemo(() => {
    const ns = graph?.nodes ?? [];
    return {
      nodes: ns.length,
      tasks: ns.filter((n) => n.type === "goal").length,
      decisions: ns.filter((n) => n.type === "decision").length,
      branches: ns.filter((n) => n.type === "branch").length,
      verified: ns.filter((n) => n.verification?.status === "passed").length,
      checked: ns.filter((n) => n.type !== "mission" && n.type !== "goal").length,
      failed: ns.filter((n) => n.verification?.status === "failed").length,
    };
  }, [graph]);

  const saveGoal = async (goal: string) => {
    if (!goal.trim()) return;
    await api.setGoal(goal.trim());
    setEditGoal(null);
    toast(t.goalSaved);
    load();
  };

  const switchLang = (l: Lang) => {
    setLang(l);
    saveLang(l);
    // Background work (automatic forecasts) writes in the person's language — only with the approval session.
    if (approved) api.saveSettings({ ui: { lang: l } }).catch(() => {});
  };
  // Once at start: align the saved language with this browser's (if this window may change settings).
  const [approved, setApproved] = useState(false);
  useEffect(() => {
    api
      .settings()
      .then((st) => {
        setApproved(st.approval);
        if (st.approval && st.ui.lang !== lang) api.saveSettings({ ui: { lang } }).catch(() => {});
      })
      .catch(() => {});
  }, []);
  const openDecisions = useMemo(() => (graph?.nodes ?? []).filter((n) => n.type === "decision" && !n.chosen && (n.options?.length ?? 0) > 1).length, [graph]);

  const confirmPending = async (lesson: string, restoreFiles: boolean) => {
    if (!pending) return;
    if (pending.mode === "rewind") {
      const r = await api.rewind(pending.node.id, lesson, restoreFiles);
      toast(`${t.rewound} ${r.target.id}${r.autosave ? ` · ${t.autosavedAs} ${r.autosave.id}` : ""}`);
      r.warnings.forEach((w) => toast(w));
    } else {
      const r = await api.fork(pending.decision.id, pending.optionId, lesson);
      toast(`${t.forked} ${r.branch.id}: ${pending.label}${r.autosave ? ` · ${t.autosavedAs} ${r.autosave.id}` : ""}`);
      r.warnings.forEach((w) => toast(w));
      setSelected(r.branch.id);
    }
    setPending(null);
    await load();
  };

  // First visit in this browser: the short introduction (skippable, restart via More → Introduction).
  const askedOnboarding = useRef(false);
  useEffect(() => {
    if (graph && !askedOnboarding.current) {
      askedOnboarding.current = true;
      if (!onboardingDone()) setOnboarding(true);
    }
  }, [graph]);

  /** Help topics and the introduction open functions directly. */
  const act = (a: HelpAction) => {
    setHelp(false);
    setOnboarding(false);
    setMoreOpen(false);
    switch (a) {
      case "goal":
        setEditGoal(root?.goal ?? "");
        break;
      case "forecasts":
        setForecastFocus(null);
        break;
      case "audit":
        setAuditOpen(true);
        break;
      case "analysis":
      case "expert":
        setAnalysisTab(a === "expert" ? "expert" : "overview");
        setAnalysisOpen(true);
        break;
      case "canon":
        setCanonOpen(true);
        break;
      case "chat":
        setSide("chat");
        break;
      case "relay":
        setRelayOpen(true);
        break;
      case "settings":
        setSettingsOpen(true);
        break;
      case "prompt":
        setPromptOpen(true);
        break;
      case "conversations":
        setConvos(true);
        break;
      case "protocol":
        api.log().then((r) => setLog(r.events)).catch(() => {});
        break;
      case "projects":
        setProjectsSignal((n) => n + 1);
        break;
      case "onboarding":
        restartOnboarding();
        setOnboarding(true);
        break;
    }
  };
  const helpCtx = useMemo(() => ({ open: (topic: string) => setHelp(topic), label: t.helpOpen }), [t]);

  return (
    <HelpContext.Provider value={helpCtx}>
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
            <rect x="2" y="12" width="9" height="8" fill="none" stroke="currentColor" strokeWidth="2" />
            <rect x="21" y="4" width="9" height="8" className="brand-mark" stroke="currentColor" strokeWidth="2" />
            <rect x="21" y="20" width="9" height="8" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M11 16 21 8M11 16l10 8" stroke="currentColor" strokeWidth="2" />
          </svg>
          <span className="brand-name">Scenaria</span>
          {graph && <ProjectSwitcher t={t} lang={lang} name={graph.config.projectName} toast={toast} onSwitched={props.onProjectSwitched} openSignal={projectsSignal} />}
        </div>
        {graph && (
          <div className={`goalbar ${root?.goal ? "" : "missing"}`}>
            <span className="goalbar-label">{t.goal}</span>
            {editGoal !== null ? (
              <form
                className="goalbar-edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveGoal(editGoal);
                }}
              >
                <input autoFocus value={editGoal} placeholder={t.goalPlaceholder} onChange={(e) => setEditGoal(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditGoal(null)} />
                <button className="btn primary" type="submit">
                  {t.save}
                </button>
              </form>
            ) : (
              <button className="goalbar-text" title={t.editGoal} onClick={() => setEditGoal(root?.goal ?? "")}>
                {root?.goal ?? t.setGoal} <span aria-hidden>✎</span>
              </button>
            )}
          </div>
        )}
        <div className="top-actions">
          <span className={`live ${live ? "on" : ""}`}>{live ? t.live : t.offline}</span>
          <button
            className="btn"
            onClick={async () => {
              const n = await api.checkpoint(lang === "de" ? "Manuell gesichert" : "Saved manually");
              toast(n ? `${t.saved} ${n.id}` : t.nothingToSave);
              load();
            }}
          >
            {t.saveNow}
          </button>
          <button className={`btn ${side === "chat" ? "primary" : ""}`} onClick={() => setSide(side === "chat" ? "node" : "chat")} title={t.chatHint}>
            {t.chat}
          </button>
          <button className="btn" onClick={() => setForecastFocus(null)} title={t.fcIntro}>
            {t.fcButton}
            {openDecisions > 0 && <span className="hchip mid">{openDecisions}</span>}
          </button>
          <button className="btn" onClick={() => setAuditOpen(true)} title={t.adButtonHint}>
            {t.adButton}
          </button>
          <button className="btn" onClick={() => setCanonOpen(true)} title={t.canonHint}>
            {t.canon}
            {canonInfo && canonInfo.proposed > 0 ? <span className="hchip mid">{canonInfo.proposed}</span> : canonInfo ? <span className="hchip">{canonInfo.active}</span> : null}
          </button>
          <button
            className="btn"
            onClick={() => {
              setAnalysisTab("overview");
              setAnalysisOpen(true);
            }}
            title={t.xIntro}
          >
            {t.analysis}
            {health !== null && <span className={`hchip ${health >= 80 ? "good" : health >= 55 ? "mid" : "low"}`}>{health}</span>}
          </button>
          <div className="more">
            <button className="btn" aria-haspopup="menu" aria-expanded={moreOpen} title={t.moreHint} onClick={() => setMoreOpen(!moreOpen)}>
              {t.more} ▾
            </button>
            {moreOpen && (
              <div className="more-menu" role="menu" onMouseLeave={() => setMoreOpen(false)}>
                <button role="menuitem" onClick={() => act("prompt")} title={t.promptHintShort}>
                  {t.agentPrompt}
                </button>
                <button role="menuitem" onClick={() => act("conversations")}>
                  {t.conversations}
                </button>
                <button role="menuitem" onClick={() => act("protocol")}>
                  {t.protocol}
                </button>
                <button role="menuitem" onClick={() => act("relay")}>
                  {t.relay}
                </button>
                <button role="menuitem" onClick={() => act("onboarding")}>
                  {t.obRestart}
                </button>
              </div>
            )}
          </div>
          <button className="btn icon help-top" onClick={() => setHelp("start")} title={t.helpTitle} aria-label={t.helpTitle}>
            ?
          </button>
          <button className="btn icon gear" onClick={() => setSettingsOpen(true)} title={t.settings} aria-label={t.settings}>
            ⚙
          </button>
          <div className="lang" role="group" aria-label="Language">
            <button className={lang === "de" ? "on" : ""} onClick={() => switchLang("de")}>
              DE
            </button>
            <button className={lang === "en" ? "on" : ""} onClick={() => switchLang("en")}>
              EN
            </button>
          </div>
        </div>
      </header>

      <main className="main">
        <section className="canvas" aria-label="Scenario map">
          {error && <div className="banner error">{error}</div>}
          {linkNote && (
            <div className="banner warn" role="status">
              {t.approvalLinkUsed}{" "}
              <button className="btn link" onClick={() => setLinkNote(false)}>
                OK
              </button>
            </div>
          )}
          {graph && rootId ? (
            <ReactFlowProvider>
              <ScenarioMap nodes={graph.nodes} rootId={rootId} headId={headId} selectedKey={selected} onSelect={setSelected} folded={folded} onToggleFold={toggleFold} fidelity={fidelity?.points ?? null} t={t} />
            </ReactFlowProvider>
          ) : graph ? (
            <div className="empty">
              <h1>{t.noMission}</h1>
              <p>{t.noMissionHint}</p>
              <p className="row">
                <button className="btn primary" onClick={() => act("prompt")}>
                  {t.agentPrompt}
                </button>
                <button className="btn" onClick={() => act("onboarding")}>
                  {t.obRestart}
                </button>
                <button className="btn" onClick={() => setHelp("start")}>
                  {t.helpTitle}
                </button>
              </p>
            </div>
          ) : null}
        </section>
        <div className="side">
          <div className="side-tabs" role="tablist">
            <button role="tab" aria-selected={side === "node"} className={side === "node" ? "on" : ""} onClick={() => setSide("node")}>
              {t.chatNode}
            </button>
            <button role="tab" aria-selected={side === "chat"} className={side === "chat" ? "on" : ""} onClick={() => setSide("chat")}>
              {t.chat}
            </button>
          </div>
          <ErrorBoundary scope="side" key={side}>
          {side === "chat" ? (
            <ChatPanel
              t={t}
              lang={lang}
              keys={keys}
              toast={toast}
              onNode={(id) => {
                if (graph?.nodes.some((x) => x.id === id)) setSelected(id);
              }}
              onChanged={load}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenRelay={() => setRelayOpen(true)}
            />
          ) : (
        <NodePanel
          placed={placed}
          allNodes={graph?.nodes ?? []}
          headId={headId}
          t={t}
          toast={toast}
          graphVersion={graph?.version}
          folded={folded}
          onToggleFold={toggleFold}
          fidelity={fidelity}
          onSelect={setSelected}
          onEditGoal={() => setEditGoal(root?.goal ?? "")}
          onUpdate={async (id, patch) => {
            await api.updateNode(id, patch);
            await load();
          }}
          onRewind={(node) => setPending({ mode: "rewind", node })}
          onFork={(decision, optionId, label) => setPending({ mode: "fork", decision, optionId, label })}
          onDiff={async (from, to) => {
            try {
              setDiff(await api.diff(from, to));
            } catch (e: any) {
              toast(e?.message ?? String(e));
            }
          }}
          onVerify={async (id, body) => {
            const n = await api.verify(id, body);
            toast(`${n.id}: ${t.verification[n.verification?.status ?? "unverified"]}`);
            await load();
          }}
          onForecast={(id) => setForecastFocus(id)}
          onChoose={async (id, option, rationale) => {
            await api.choose(id, option, rationale);
            toast(`${id} ✓`);
            await load();
          }}
        />
          )}
          </ErrorBoundary>
        </div>
      </main>

      <footer className="statusbar">
        {headId && (
          <span>
            {t.statusHead} <NodeId id={headId} />
          </span>
        )}
        <span>
          {t.statusTasks} <strong>{stats.tasks}</strong>
        </span>
        <span>
          {t.statusNodes} <strong>{stats.nodes}</strong>
        </span>
        <span>
          {t.statusDecisions} <strong>{stats.decisions}</strong>
        </span>
        <span>
          {t.statusBranches} <strong>{stats.branches}</strong>
        </span>
        <span>
          {t.statusVerified} <strong>{stats.verified}</strong>/{stats.checked}
          {stats.failed ? <em className="failed">{stats.failed} ✘</em> : null}
        </span>
        {headCtx && headCtx.historyTokens > headCtx.tokens && (
          <span title={t.capsuleExplain}>
            {t.capsule} ≈ <strong>{fmtK(headCtx.tokens)}</strong> {t.tokens} <span className="muted">({t.insteadOf} ≈ {fmtK(headCtx.historyTokens)})</span>
          </span>
        )}
        {graph && !graph.snapshots && <span className="warn">{t.snapshotsOff}</span>}
        <span className="root" title={graph?.root}>
          {graph?.root}
        </span>
      </footer>

      <ErrorBoundary
        scope="dialogs"
        onReset={() => {
          setSettingsOpen(false);
          setRelayOpen(false);
          setForecastFocus(false);
          setCanonOpen(false);
          setAnalysisOpen(false);
          setPromptOpen(false);
          setConvos(false);
          setLog(null);
          setDiff(null);
          setPending(null);
        }}
      >
      {pending && (
        <RewindDialog
          t={t}
          mode={pending.mode}
          targetId={pending.mode === "rewind" ? pending.node.id : pending.decision.id}
          label={pending.mode === "rewind" ? pending.node.title : pending.label}
          onCancel={() => setPending(null)}
          onConfirm={confirmPending}
        />
      )}
      {diff && <DiffDialog t={t} {...diff} onClose={() => setDiff(null)} />}
      {log && (
        <ProtocolDialog
          t={t}
          events={log}
          onClose={() => setLog(null)}
          onSelect={(id) => {
            if (graph?.nodes.some((x) => x.id === id)) setSelected(id);
            setLog(null);
          }}
        />
      )}
      {convos && (
        <ConversationsDialog
          t={t}
          onClose={() => setConvos(false)}
          onSelectNode={(id) => {
            if (graph?.nodes.some((x) => x.id === id)) setSelected(id);
            setConvos(false);
          }}
        />
      )}
      {canonOpen && (
        <CanonDialog
          t={t}
          lang={lang}
          toast={toast}
          onClose={() => setCanonOpen(false)}
          onChanged={load}
          onSelectNode={(id) => {
            if (graph?.nodes.some((x) => x.id === id)) setSelected(id);
            setCanonOpen(false);
          }}
        />
      )}
      {forecastFocus !== false && (
        <ForecastsDialog
          t={t}
          lang={lang}
          keys={keys}
          nodes={graph?.nodes ?? []}
          headId={headId}
          focus={forecastFocus}
          toast={toast}
          onClose={() => setForecastFocus(false)}
          onChanged={load}
          onOpenSettings={() => setSettingsOpen(true)}
          onEditGoal={() => {
            setForecastFocus(false);
            setEditGoal(root?.goal ?? "");
          }}
          onNode={(id) => {
            if (graph?.nodes.some((x) => x.id === id)) setSelected(id);
            setForecastFocus(false);
            setSide("node");
          }}
        />
      )}
      {auditOpen && (
        <AuditDialog
          t={t}
          lang={lang}
          onClose={() => setAuditOpen(false)}
          onNode={(id) => {
            if (graph?.nodes.some((x) => x.id === id)) setSelected(id);
            setAuditOpen(false);
            setSide("node");
          }}
        />
      )}
      {settingsOpen && <SettingsDialog t={t} keys={keys} onKey={(p, k) => setKeys((o) => ({ ...o, [p]: k }))} toast={toast} onClose={() => setSettingsOpen(false)} onSaved={load} />}
      {relayOpen && (
        <RelayDialog
          t={t}
          lang={lang}
          keys={keys}
          toast={toast}
          onClose={() => setRelayOpen(false)}
          onChanged={load}
          onNode={(id) => {
            if (graph?.nodes.some((x) => x.id === id)) setSelected(id);
            setRelayOpen(false);
            setSide("node");
          }}
        />
      )}
      {promptOpen && <PromptDialog t={t} lang={lang} toast={toast} onClose={() => setPromptOpen(false)} onApplied={load} />}
      {analysisOpen && (
        <AnalysisDialog
          t={t}
          lang={lang}
          keys={keys}
          initialTab={analysisTab}
          toast={toast}
          onOpenCanon={() => {
            setAnalysisOpen(false);
            setCanonOpen(true);
          }}
          onClose={() => setAnalysisOpen(false)}
          onSelectNode={(id) => {
            if (graph?.nodes.some((x) => x.id === id)) setSelected(id);
            setAnalysisOpen(false);
          }}
          onEditGoal={() => {
            setAnalysisOpen(false);
            setEditGoal(root?.goal ?? "");
          }}
        />
      )}
      </ErrorBoundary>
      {help !== false && <HelpDialog t={t} lang={lang} topic={help} onClose={() => setHelp(false)} onAction={act} />}
      {onboarding && (
        <Onboarding
          t={t}
          lang={lang}
          goal={root?.goal ?? null}
          toast={toast}
          onGoalSaved={load}
          onAction={act}
          onClose={() => setOnboarding(false)}
        />
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className="toast">
            {x.msg}
          </div>
        ))}
      </div>
    </div>
    </HelpContext.Provider>
  );
}
