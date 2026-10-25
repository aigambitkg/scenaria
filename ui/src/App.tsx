import { ReadOnlyContext, requestApproval, useApprovalSignal } from "./Approval";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { api, errorTexts, type Fidelity, type Graph, type ProjectProgress, type ScenariaEvent, type ScenariaNode, type WindowStatus } from "./api";
import { ProgressDialog } from "./Progress";
import { WindowDialog } from "./Window";
import { dict, initialLang, saveLang, type Lang } from "./i18n";
import { ProjectSwitcher } from "./Projects";
import { HelpDialog, Onboarding, onboardingDone, restartOnboarding } from "./Help";
import { HelpContext } from "./HelpButton";
import { HELP, type HelpAction } from "./helpContent";
import { layoutTree, taskOf } from "./layout";
import { NodeId, ScenarioMap } from "./Map";
import { NodePanel } from "./NodePanel";
import { isUnconfirmedPass } from "../../src/core/verdict";
import { AnalysisDialog, CanonDialog, ConversationsDialog, DiffDialog, PromptDialog, ProtocolDialog, RewindDialog } from "./Dialogs";
import { ChatPanel, RelayDialog, SettingsDialog, type SessionKeys } from "./Control";
import { ErrorBoundary } from "./ErrorBoundary";
import { ForecastsDialog } from "./Forecasts";
import { AuditDialog } from "./AuditArea";
import { AuditFileDialog } from "./AuditFile";
import { SimpleView, type Toast } from "./SimpleView";

/** The three views on the same data (Batch B): one per persona. */
export type View = "simple" | "audit" | "manage";
const VIEW_KEY = "scenaria.view.v1";
function initialView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "simple" || v === "audit" || v === "manage") return v;
  } catch {
    /* no storage (private window, preview): the simple view */
  }
  return "simple";
}

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
  // The integrity check could not be loaded: then nothing counts as checked (rule 11), and the Simple view warns.
  const [fidelityError, setFidelityError] = useState(false);
  const [canonOpen, setCanonOpen] = useState(false);
  const [progress, setProgress] = useState<ProjectProgress | null>(null);
  const [progressOpen, setProgressOpen] = useState(false);
  // E3b-2: the context window (measured on the server); the dialog in Audit and Manage, a card in Simple.
  const [windows, setWindows] = useState<WindowStatus | null>(null);
  const [windowOpen, setWindowOpen] = useState(false);
  // The fill grows with every answer, not only at a step: look again every 30 s while the page is visible.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") api.windows().then(setWindows).catch(() => {});
    }, 30_000);
    return () => clearInterval(id);
  }, []);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditFileOpen, setAuditFileOpen] = useState(false);
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
  const [toasts, setToasts] = useState<{ id: number; msg: string; action?: { label: string; run: () => void } }[]>([]);
  const toastId = useRef(0);
  const t = dict[lang];
  const [view, setViewState] = useState<View>(initialView);
  const [extOpen, setExtOpen] = useState(false);
  const setView = (v: View) => {
    setViewState(v);
    setMoreOpen(false);
    setExtOpen(false);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };

  const toast: Toast = useCallback((msg: string, action?: { label: string; run: () => void }) => {
    const id = ++toastId.current;
    setToasts((l) => [...l, { id, msg, action }]);
    // A toast with an action (e.g. Undo) stays longer, so there is time to use it.
    setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), action ? 12000 : 4200);
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
    api.progress().then(setProgress).catch(() => setProgress(null));
    api.windows().then(setWindows).catch(() => setWindows(null));
    api
      .fidelity()
      .then((f) => {
        setFidelity(f);
        setFidelityError(false);
      })
      .catch(() => {
        setFidelity(null);
        setFidelityError(true);
      });
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

  // Rule 11: only the engine's confirmed set — empty while loading or when the check failed.
  const confirmedSet = useMemo(() => new Set(fidelity?.confirmed ?? []), [fidelity]);
  const stats = useMemo(() => {
    const ns = graph?.nodes ?? [];
    return {
      nodes: ns.length,
      tasks: ns.filter((n) => n.type === "goal").length,
      decisions: ns.filter((n) => n.type === "decision").length,
      branches: ns.filter((n) => n.type === "branch").length,
      verified: fidelity?.confirmed?.length ?? 0,
      checked: ns.filter((n) => n.type !== "mission" && n.type !== "goal").length,
      failed: ns.filter((n) => n.verification?.status === "failed").length,
    };
  }, [graph, fidelity]);

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
  const [teamMode, setTeamMode] = useState(true); // until known: no lock button
  // Auditor mode (C4c): the person handed this browser to an auditor; it only reads (the server refuses writes).
  // true: auditor mode; "stale": this browser still carries an expired or unknown auditor mode (it neither reads
  // the audit file nor writes anything until the mode is ended here).
  const [auditView, setAuditView] = useState<boolean | "stale">(false);
  // An approval link opened in an auditor-mode browser ends the mode there and gives no approval (review C4c-1 K1).
  const [auditorLinkNote, setAuditorLinkNote] = useState(() => new URLSearchParams(location.search).get("approval") === "auditor");
  const checkApproval = useCallback(
    () =>
      api.settings().then((st) => {
        setApproved(st.approval);
        setTeamMode(st.teamMode);
        api
          .approval()
          .then((a) => setAuditView(a.auditView === true ? true : a.auditView === "stale" ? "stale" : false))
          .catch(() => {});
        return st;
      }),
    [],
  );
  // Scenaria's own error codes in the person's language (the server answers in English).
  errorTexts.auditor_mode = t.afAuditorRefused;
  errorTexts.auditor_mode_active = t.afAuditorActive;
  errorTexts.not_normal = t.evErrNotNormal;
  errorTexts.changed = t.evErrChanged;
  // Every refused change to the fixed points, in the person's language (E2b review M3).
  for (const [code, text] of Object.entries(t.errCanon)) errorTexts[code] = text;
  errorTexts.plan_first = t.evErrPlanFirst;
  // In auditor mode the dashboard checks in every 2 minutes: while it does, nobody can open an approval link
  // that could land in this browser (review C4c-1 S1).
  useEffect(() => {
    if (auditView !== true) return;
    const id = setInterval(() => {
      api
        .approval()
        .then((a) => setAuditView(a.auditView === true ? true : a.auditView === "stale" ? "stale" : false))
        .catch(() => {});
    }, 120_000);
    return () => clearInterval(id);
  }, [auditView]);
  const endAuditorMode = async () => {
    try {
      await api.auditorModeEnd();
      setAuditView(false);
      toast(t.afAuditorEnded);
    } catch (e: any) {
      toast(String(e?.message ?? e));
    }
  };
  useEffect(() => {
    checkApproval()
      .then((st) => {
        if (st.approval && st.ui.lang !== lang) api.saveSettings({ ui: { lang } }).catch(() => {});
      })
      .catch(() => {});
  }, []);
  // The lock: Scenaria opens a fresh approval link in the default browser. This window shares the
  // browser's cookie, so it becomes approved too once that link is redeemed.
  const openApproval = async () => {
    const r = await requestApproval(t);
    if (r.kind === "error") return toast(r.text);
    if (r.kind === "already") return toast(t.approvalAlready);
    toast(t.approvalOpening);
  };
  // Any button that asked for it (top bar or a dialog): once this window shares the approval, say so.
  useApprovalSignal(() => {
    if (!approved) toast(t.approvalOn);
    setApproved(true);
    setLinkNote(false);
  });
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
    setExtOpen(false);
    switch (a) {
      case "goal":
        if (!auditView) setEditGoal(root?.goal ?? "");
        break;
      case "forecasts":
        setForecastFocus(null);
        break;
      case "audit":
        setAuditOpen(true);
        break;
      case "auditfile":
        setView("audit");
        setAuditFileOpen(true);
        break;
      case "analysis":
      case "expert":
        setAnalysisTab(a === "expert" ? "expert" : "overview");
        setAnalysisOpen(true);
        break;
      case "canon":
        setCanonOpen(true);
        break;
      case "progress":
        setProgressOpen(true);
        break;
      case "window":
        setWindowOpen(true);
        break;
      case "chat":
        if (auditView) break;
        if (view === "simple") setView("manage");
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
  // A screen reader hears the topic's title, not its id (C5, U-K11).
  const helpCtx = useMemo(() => ({ open: (topic: string) => setHelp(topic), label: t.helpOpen, title: (topic: string) => HELP[lang]?.find((x) => x.id === topic)?.title }), [t, lang]);

  const linkBanner = linkNote && !approved && (
    <div className="banner warn" role="status">
      {t.approvalLinkUsed}{" "}
      {!teamMode && (
        <button className="btn" onClick={openApproval}>
          {t.approvalOpen}
        </button>
      )}{" "}
      <button className="btn link" onClick={() => setLinkNote(false)}>
        OK
      </button>
    </div>
  );

  return (
    <HelpContext.Provider value={helpCtx}>
    <ReadOnlyContext.Provider value={auditView !== false}>
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
        <div className="views" role="group" aria-label={t.viewLabel}>
          {(["simple", "audit", "manage"] as const).map((v) => (
            <button key={v} className={view === v ? "on" : ""} aria-pressed={view === v} title={v === "simple" ? t.viewSimpleHint : v === "audit" ? t.viewAuditHint : t.viewManageHint} onClick={() => setView(v)}>
              {v === "simple" ? t.viewSimple : v === "audit" ? t.viewAudit : t.viewManage}
            </button>
          ))}
        </div>
        {graph && view !== "simple" && (
          <div className={`goalbar ${root?.goal ? "" : "missing"}`}>
            <span className="goalbar-label">{t.goal}</span>
            {auditView ? (
              <span className="goalbar-text">{root?.goal ?? "–"}</span>
            ) : editGoal !== null ? (
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
          {view !== "audit" && <span className={`live ${live ? "on" : ""}`}>{live ? t.live : t.offline}</span>}
          {view !== "audit" && !auditView && (
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
          )}
          {view === "manage" && !auditView && (
            <button className={`btn ${side === "chat" ? "primary" : ""}`} onClick={() => setSide(side === "chat" ? "node" : "chat")} title={t.chatHint}>
              {t.chat}
            </button>
          )}
          {view !== "simple" && (
            <button className="btn" onClick={() => setProgressOpen(true)} title={t.pgButtonHint}>
              {t.pgButton}
              {progress && progress.tasks.length > 0 && <span className="hchip">{progress.value} %</span>}
            </button>
          )}
          {view !== "simple" && (
            <button className="btn" onClick={() => setWindowOpen(true)} title={t.cwButtonHint}>
              {t.cwButton}
              {windows?.progress?.stop && <span className="hchip z-red">{t.wpStopChip}</span>}
              {windows?.current?.fill && windows.current.zone && (
                <span className={`hchip z-${windows.current.zone}`} aria-label={`${windows.current.fill.value} % · ${t.cwZones[windows.current.zone]}`}>
                  {windows.current.fill.value} % · {t.cwZones[windows.current.zone]}
                </span>
              )}
            </button>
          )}
          {view !== "simple" && (
            <button className="btn" onClick={() => setCanonOpen(true)} title={t.canonHint}>
              {t.rulesButton}
              {canonInfo && canonInfo.proposed > 0 ? <span className="hchip mid">{canonInfo.proposed}</span> : canonInfo ? <span className="hchip">{canonInfo.active}</span> : null}
            </button>
          )}
          {view !== "simple" && (
            <button
              className="btn"
              onClick={() => {
                setAnalysisTab("overview");
                setAnalysisOpen(true);
              }}
              title={t.xIntro}
            >
              {view === "audit" ? t.projectCheck : t.analysis}
              {health !== null && <span className={`hchip ${health >= 80 ? "good" : health >= 55 ? "mid" : "low"}`}>{health}</span>}
            </button>
          )}
          {view === "audit" && (
            <>
              <button className="btn primary-soft" onClick={() => act("auditfile")} title={t.afButtonHint}>
                {t.afButton}
              </button>
              <button className="btn" onClick={() => act("protocol")}>
                {t.protocol}
              </button>
              <button className="btn" onClick={() => act("conversations")}>
                {t.conversations}
              </button>
            </>
          )}
          {view === "manage" && !auditView && (
            <div className="more">
              <button className="btn" aria-haspopup="menu" aria-expanded={extOpen} title={t.extensionsHint} onClick={() => setExtOpen(!extOpen)}>
                {t.extensions}
                {openDecisions > 0 && <span className="hchip mid">{openDecisions}</span>} ▾
              </button>
              {extOpen && (
                <div className="more-menu" role="menu" onMouseLeave={() => setExtOpen(false)}>
                  <button role="menuitem" onClick={() => act("forecasts")} title={t.fcIntro}>
                    {t.fcButton}
                  </button>
                  <button role="menuitem" onClick={() => act("audit")} title={t.adButtonHint}>
                    {t.adButton}
                  </button>
                  <button role="menuitem" onClick={() => act("relay")}>
                    {t.relay}
                  </button>
                </div>
              )}
            </div>
          )}
          {view === "manage" && (
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
                  <button role="menuitem" onClick={() => act("onboarding")}>
                    {t.obRestart}
                  </button>
                </div>
              )}
            </div>
          )}
          {!approved && !teamMode && !auditView && (
            <button className="btn icon lock" onClick={openApproval} title={t.approvalOpenHint} aria-label={t.approvalOpen}>
              🔒
            </button>
          )}
          <button className="btn icon help-top" onClick={() => setHelp(view === "simple" ? "simple" : "start")} title={t.helpTitle} aria-label={t.helpTitle}>
            ?
          </button>
          {!auditView && (
          <button className="btn icon gear" onClick={() => setSettingsOpen(true)} title={t.settings} aria-label={t.settings}>
            ⚙
          </button>
          )}
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
      {auditorLinkNote && !auditView && (
        <div className="auditor-band" role="status">
          <span>{t.afAuditorLinkEnded}</span>
          <button className="btn" onClick={() => setAuditorLinkNote(false)}>
            OK
          </button>
        </div>
      )}
      {auditView && (
        <div className="auditor-band" role="status">
          <span>🔍 {auditView === "stale" ? t.afAuditorStale : t.afAuditorBanner}</span>
          <button className="btn" onClick={() => act("auditfile")}>
            {t.afButton}
          </button>
          <button className="btn" onClick={endAuditorMode}>
            {t.afAuditorEnd}
          </button>
        </div>
      )}

      {view === "simple" ? (
        <main className="main simple-main">
          {error && <div className="banner error">{error}</div>}
          {linkBanner}
          {editGoal !== null && (
            <form
              className="sv-goal-edit"
              onSubmit={(e) => {
                e.preventDefault();
                saveGoal(editGoal);
              }}
            >
              <label className="field">
                <span>{t.goal}</span>
                <input autoFocus value={editGoal} placeholder={t.goalPlaceholder} onChange={(e) => setEditGoal(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditGoal(null)} />
              </label>
              <button className="btn primary" type="submit">
                {t.save}
              </button>
              <button className="btn" type="button" onClick={() => setEditGoal(null)}>
                {t.cancel}
              </button>
            </form>
          )}
          {graph && (
            <ErrorBoundary scope="simple">
              <SimpleView
                t={t}
                lang={lang}
                nodes={graph.nodes}
                headId={headId}
                goal={root?.goal ?? null}
                fidelity={fidelity}
                fidelityError={fidelityError}
                progress={progress}
                windows={windows}
                onOpenWindow={() => setWindowOpen(true)}
                toast={toast}
                onEditGoal={() => setEditGoal(root?.goal ?? "")}
                onRewound={load}
                onDiff={async (from, to) => {
                  try {
                    setDiff(await api.diff(from, to));
                  } catch (e: any) {
                    toast(e?.message ?? String(e));
                  }
                }}
                onOpenAudit={() => setView("audit")}
                onConnect={() => setSettingsOpen(true)}
              />
            </ErrorBoundary>
          )}
        </main>
      ) : (
      <main className="main">
        <section className="canvas" aria-label="Scenario map">
          {error && <div className="banner error">{error}</div>}
          {linkBanner}
          {graph && rootId ? (
            <ReactFlowProvider>
              <ScenarioMap nodes={graph.nodes} rootId={rootId} headId={headId} selectedKey={selected} onSelect={setSelected} folded={folded} onToggleFold={toggleFold} fidelity={fidelity?.points ?? null} confirmed={confirmedSet} t={t} />
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
          approved={approved}
          onReseal={async () => {
            try {
              const r = await api.reseal();
              toast(`${t.resealedOk} ${r.record}`);
              await load();
            } catch (e: any) {
              toast(e?.message ?? String(e));
            }
          }}
          onVerify={async (id, body) => {
            try {
              const n = await api.verify(id, body);
              toast(`${n.id}: ${isUnconfirmedPass(n.verification) ? t.selfReported : t.verification[n.verification?.status ?? "unverified"]}`);
              await load();
            } catch (e: any) {
              toast(e?.message ?? String(e));
            }
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
      )}

      {view !== "simple" && (
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
      )}

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
      {progressOpen && (
        <ProgressDialog
          p={progress}
          t={t}
          lang={lang}
          onClose={() => setProgressOpen(false)}
          onNode={(id) => {
            if (graph?.nodes.some((x) => x.id === id)) setSelected(id);
            setProgressOpen(false);
          }}
          onOpenCanon={
            view === "simple"
              ? undefined
              : () => {
                  setProgressOpen(false);
                  setCanonOpen(true);
                }
          }
        />
      )}
      {windowOpen && (
        <WindowDialog
          t={t}
          lang={lang}
          approved={approved}
          editable={view === "manage" && !auditView}
          canAct={!auditView}
          onClose={() => setWindowOpen(false)}
          onChanged={() => api.windows().then(setWindows).catch(() => setWindows(null))}
          onNode={(id) => {
            if (graph?.nodes.some((x) => x.id === id)) setSelected(id);
            setWindowOpen(false);
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
      {auditFileOpen && (
        <AuditFileDialog
          t={t}
          lang={lang}
          approved={approved}
          teamMode={teamMode}
          auditView={auditView}
          onClose={() => setAuditFileOpen(false)}
          onAuditorMode={() => {
            setApproved(false);
            setAuditView(true);
            setView("audit");
            toast(t.afAuditorOn);
          }}
        />
      )}
      {auditOpen && (
        <AuditDialog
          t={t}
          lang={lang}
          onClose={() => setAuditOpen(false)}
          onOpenForecasts={() => {
            setAuditOpen(false);
            setForecastFocus(null);
          }}
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
            {x.action && (
              <button
                className="btn"
                onClick={() => {
                  setToasts((l) => l.filter((y) => y.id !== x.id));
                  x.action!.run();
                }}
              >
                {x.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
    </ReadOnlyContext.Provider>
    </HelpContext.Provider>
  );
}
