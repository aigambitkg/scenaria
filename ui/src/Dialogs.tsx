import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ScenariaEvent } from "./api";
import type { Dict } from "./i18n";
import { NodeId } from "./Map";

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
