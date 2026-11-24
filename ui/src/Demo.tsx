/**
 * The example to try out. It shows the real Simple view on an invented project (demoData.ts, recorded by the
 * real engine) and answers the view's questions itself — nothing is sent to the server, so nothing in the
 * person's project or files changes. Going back and undoing move a marker inside this example only.
 * Three small tasks lead through what matters: look, go back, undo.
 */
import { useMemo, useRef, useState } from "react";
import type { ScenariaNode } from "./api";
import { ReadOnlyContext } from "./Approval";
import { DEMO_DATA } from "./demoData";
import type { Dict, Lang } from "./i18n";
import { SimpleBackendContext, SimpleView, type SimpleBackend } from "./SimpleView";
import { TOUR } from "./tourText";

type Toast = (msg: string, action?: { label: string; run: () => void }) => void;

/** The example's steps with times of today: the newest a few minutes ago, the others before it. */
export function demoNodes(lang: Lang, now = Date.now()): ScenariaNode[] {
  const raw = DEMO_DATA[lang].nodes as unknown as (ScenariaNode & { minute: number })[];
  const last = Math.max(...raw.map((n) => n.minute));
  // Keep every step on today's date, also shortly after midnight.
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);
  const end = Math.max(startOfDay + (last + 1) * 60_000, now - 4 * 60_000);
  return raw.map(({ minute, ...n }) => ({ ...n, createdAt: new Date(end - (last - minute) * 60_000).toISOString() }) as ScenariaNode);
}

export function Demo(props: { t: Dict; lang: Lang; toast: Toast; onClose: () => void }) {
  const { t, lang } = props;
  const x = TOUR[lang];
  const data = DEMO_DATA[lang];
  const nodes = useMemo(() => demoNodes(lang), [lang]);
  const [head, setHead] = useState<string>(data.head);
  const [done, setDone] = useState<[boolean, boolean, boolean]>([false, false, false]);
  const tick = (k: 0 | 1 | 2) => setDone((d) => (d[k] ? d : (d.map((v, j) => v || j === k) as [boolean, boolean, boolean])));

  // Where the example stood before the last step back: going there again is the "undo".
  const headRef = useRef<string>(data.head);
  const cameFrom = useRef<string | null>(null);
  const backend: SimpleBackend = useMemo(
    () => ({
      // Going back: only the example's marker moves; nothing is sent to the server.
      rewind: async (id: string) => {
        const target = nodes.find((n) => n.id === id);
        if (!target) throw new Error(id);
        const undo = cameFrom.current === id;
        cameFrom.current = undo ? null : headRef.current;
        headRef.current = id;
        setHead(id);
        tick(undo ? 2 : 1);
        return { target, autosave: null, warnings: [] };
      },
      nodeMessages: async (id: string) => {
        tick(0);
        const text = (data.asked as Record<string, string>)[id];
        return { leading: text ? [{ role: "user", text } as never] : [], after: [] };
      },
      folder: async () => {
        throw new Error(x.demoNoFolder);
      },
      headAt: async () => ({ id: null }),
    }),
    [nodes, data, x],
  );
  const all = done.every(Boolean);

  return (
    <div className="demo" role="dialog" aria-modal="true" aria-label={x.demoBand}>
      <header className="demo-band">
        <div>
          <strong>🎓 {x.demoBand}</strong>
          <span>{x.demoBandText}</span>
        </div>
        <button className="btn primary" onClick={props.onClose}>
          {x.demoEnd}
        </button>
      </header>
      <aside className="demo-tasks" aria-live="polite">
        <strong>{all ? x.demoAllDone : x.demoTry}</strong>
        <ol>
          {x.demoTasks.map((task, k) => (
            <li key={task} className={done[k] ? "ok" : ""}>
              <span aria-hidden>{done[k] ? "✓" : k + 1}</span> {task}
            </li>
          ))}
        </ol>
        {all && (
          <p className="row">
            <button className="btn primary" onClick={props.onClose}>
              {x.demoEnd}
            </button>
            <button
              className="btn"
              onClick={() => {
                headRef.current = data.head;
                cameFrom.current = null;
                setHead(data.head);
                setDone([false, false, false]);
              }}
            >
              {x.demoRestart}
            </button>
          </p>
        )}
      </aside>
      <main className="main simple-main demo-main">
        {/* The example never changes anything on the server, so it is not "read-only" in the auditor's sense: buttons stay. */}
        <ReadOnlyContext.Provider value={false}>
          <SimpleBackendContext.Provider value={backend}>
            <SimpleView
              t={t}
              lang={lang}
              nodes={nodes}
              headId={head}
              goal={data.goal}
              fidelity={null}
              progress={null}
              windows={null}
              toast={props.toast}
              onEditGoal={() => props.toast(x.demoNoGoal)}
              onRewound={async () => {}}
              onDiff={() => props.toast(x.demoNoDiff)}
              onOpenAudit={() => {}}
              onConnect={() => {}}
            />
          </SimpleBackendContext.Provider>
        </ReadOnlyContext.Provider>
      </main>
    </div>
  );
}
