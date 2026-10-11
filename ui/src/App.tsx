import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { api, type Graph, type ScenariaEvent, type ScenariaNode } from "./api";
import { dict, initialLang, saveLang, type Lang } from "./i18n";
import { layoutTree } from "./layout";
import { NodeId, ScenarioMap } from "./Map";
import { NodePanel } from "./NodePanel";
import { ConversationsDialog, DiffDialog, ProtocolDialog, RewindDialog } from "./Dialogs";

type Pending =
  | { mode: "rewind"; node: ScenariaNode }
  | { mode: "fork"; decision: ScenariaNode; optionId: string; label: string }
  | null;

export function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [lang, setLang] = useState<Lang>(initialLang);
  const [missionId, setMissionId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [diff, setDiff] = useState<{ from: string; to: string; stat: string; patch: string } | null>(null);
  const [log, setLog] = useState<ScenariaEvent[] | null>(null);
  const [convos, setConvos] = useState(false);
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
      setMissionId((m) => (m && g.nodes.some((n) => n.id === m) ? m : g.state.activeMission));
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

  const missions = useMemo(() => (graph?.nodes ?? []).filter((n) => n.type === "mission"), [graph]);
  const headId = graph?.state.head ?? null;

  // When HEAD moves (agent activity) select it, unless the user picked something else in this mission.
  const lastHead = useRef<string | null>(null);
  useEffect(() => {
    if (headId && headId !== lastHead.current) {
      lastHead.current = headId;
      const head = graph?.nodes.find((n) => n.id === headId);
      if (head) {
        setMissionId(head.missionId);
        setSelected(headId);
      }
    }
  }, [headId, graph]);

  const placed = useMemo(() => {
    if (!graph || !missionId || !selected) return null;
    return layoutTree(graph.nodes, missionId).placed.find((p) => p.key === selected) ?? null;
  }, [graph, missionId, selected]);

  const stats = useMemo(() => {
    const ns = (graph?.nodes ?? []).filter((n) => n.missionId === missionId);
    return {
      nodes: ns.length,
      decisions: ns.filter((n) => n.type === "decision").length,
      branches: ns.filter((n) => n.type === "branch").length,
      verified: ns.filter((n) => n.verification?.status === "passed").length,
      checked: ns.filter((n) => n.type !== "mission").length,
      failed: ns.filter((n) => n.verification?.status === "failed").length,
    };
  }, [graph, missionId]);

  const switchLang = (l: Lang) => {
    setLang(l);
    saveLang(l);
  };

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

  return (
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
          {graph && <span className="project">{graph.config.projectName}</span>}
        </div>
        {missions.length > 0 && (
          <label className="mission-select">
            <span>{t.mission}</span>
            <select value={missionId ?? ""} onChange={(e) => { setMissionId(e.target.value); setSelected(null); }}>
              {missions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id} — {m.title}
                </option>
              ))}
            </select>
          </label>
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
          <button className="btn" onClick={() => setConvos(true)}>
            {t.conversations}
          </button>
          <button className="btn" onClick={async () => setLog((await api.log()).events)}>
            {t.protocol}
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
          {graph && missionId ? (
            <ReactFlowProvider>
              <ScenarioMap nodes={graph.nodes} missionId={missionId} headId={headId} selectedKey={selected} onSelect={setSelected} t={t} />
            </ReactFlowProvider>
          ) : graph ? (
            <div className="empty">
              <h1>{t.noMission}</h1>
              <p>{t.noMissionHint}</p>
            </div>
          ) : null}
        </section>
        <NodePanel
          placed={placed}
          allNodes={graph?.nodes ?? []}
          headId={headId}
          t={t}
          toast={toast}
          graphVersion={graph?.version}
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
        />
      </main>

      <footer className="statusbar">
        {headId && (
          <span>
            {t.statusHead} <NodeId id={headId} />
          </span>
        )}
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
        {graph && !graph.snapshots && <span className="warn">{t.snapshotsOff}</span>}
        <span className="root" title={graph?.root}>
          {graph?.root}
        </span>
      </footer>

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
            const n = graph?.nodes.find((x) => x.id === id);
            if (n) {
              setMissionId(n.missionId);
              setSelected(id);
            }
            setLog(null);
          }}
        />
      )}
      {convos && (
        <ConversationsDialog
          t={t}
          onClose={() => setConvos(false)}
          onSelectNode={(id) => {
            const n = graph?.nodes.find((x) => x.id === id);
            if (n) {
              setMissionId(n.missionId);
              setSelected(id);
            }
            setConvos(false);
          }}
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
  );
}
