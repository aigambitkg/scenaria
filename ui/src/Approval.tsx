import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Dict } from "./i18n";

/** Fired once when this browser window has the approval mode (another window redeemed the link). */
const EVENT = "scenaria-approval";

/** Run `cb` when the approval mode arrives (every open dialog unlocks itself). */
export function useApprovalSignal(cb: () => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const h = () => ref.current();
    window.addEventListener(EVENT, h);
    return () => window.removeEventListener(EVENT, h);
  }, []);
}

let watching = false;
/** After Scenaria opened a window in approval mode: check a few times whether this one shares it. */
function watchApproval() {
  if (watching) return;
  watching = true;
  const delays = [2000, 4000, 8000, 15000];
  const tick = (i: number) =>
    setTimeout(() => {
      api
        .settings()
        .then((st) => {
          if (st.approval) {
            watching = false;
            window.dispatchEvent(new Event(EVENT));
          } else if (i + 1 < delays.length) tick(i + 1);
          else watching = false;
        })
        .catch(() => {
          watching = false;
        });
    }, delays[i]);
  tick(0);
}

/**
 * Ask the running Scenaria to open a fresh single-use approval link in the default browser.
 * The code never reaches this page: the server hands it straight to the operating system.
 */
export async function requestApproval(t: Dict): Promise<{ kind: "already" | "opened" } | { kind: "error"; text: string }> {
  try {
    const r = await api.openApproval();
    if (r.already) {
      window.dispatchEvent(new Event(EVENT));
      return { kind: "already" };
    }
    watchApproval();
    return { kind: "opened" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const wait = /try again in (\d+) s/.exec(msg);
    if (wait) return { kind: "error", text: t.approvalBusy(Number(wait[1])) };
    return { kind: "error", text: /Team mode/i.test(msg) ? t.approvalTeam : /cannot open your browser/i.test(msg) ? t.approvalNoBrowser : msg };
  }
}

/** A locked notice with the one button that unlocks it. */
export function LockedNote(props: { t: Dict; text: string; small?: boolean }) {
  const { t } = props;
  const [state, setState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useApprovalSignal(() => setState(t.approvalOn));
  return (
    <div className={`qnote q-warn locked${props.small ? " small" : ""}`} role="status">
      <span>🔒 {props.text}</span>{" "}
      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await requestApproval(t);
          setBusy(false);
          setState(r.kind === "error" ? r.text : r.kind === "already" ? t.approvalAlready : t.approvalOpening);
        }}
      >
        {t.approvalOpen}
      </button>
      {state && <p className="small">{state}</p>}
    </div>
  );
}
