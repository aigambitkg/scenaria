import { useMemo, useRef, useState } from "react";
import { Why } from "./Why";
import type { Dict } from "./i18n";
import type { FidelityPoint } from "./api";
import { NodeId } from "./Map";

/** Flags worth showing on the line (task/lowSignal/noGoal are context, not events). */
const EVENT_FLAGS = ["tampered", "builtOnTampered", "canonBroken", "break", "goalChanged", "branch", "drift", "failed"] as const;
type EventFlag = (typeof EVENT_FLAGS)[number];
const GLYPH: Record<EventFlag, string> = { tampered: "⛔", builtOnTampered: "⚠", canonBroken: "⚑", break: "↯", goalChanged: "◎", branch: "⑂", drift: "↗", failed: "✘" };
const TONE: Record<EventFlag, string> = { tampered: "fail", builtOnTampered: "fail", canonBroken: "fail", break: "warn", goalChanged: "lesson", branch: "muted", drift: "warn", failed: "fail" };

export function scoreTone(score: number) {
  return score >= 75 ? "good" : score >= 50 ? "mid" : "low";
}

function events(p: FidelityPoint): EventFlag[] {
  return EVENT_FLAGS.filter((f) => p.flags.includes(f));
}

/** Markers on the line: where something happens — "builds on manipulated" stays in the tooltip (it would repeat on every later point). */
function markers(p: FidelityPoint): EventFlag[] {
  return events(p).filter((f) => f !== "builtOnTampered");
}

/**
 * Context fidelity along the path root → selected node: one line, 0–100 %.
 * Markers show where context broke off, the goal changed, the line branched,
 * or content no longer matches the integrity ledger (manipulated).
 */
export function FidelityChart(props: { path: FidelityPoint[]; selectedId: string; t: Dict; onSelect: (id: string) => void }) {
  const { path, t } = props;
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const W = 340;
  const H = 120;
  const pad = { l: 26, r: 10, t: 16, b: 14 };
  const n = path.length;
  const x = (i: number) => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
  const y = (v: number) => pad.t + ((100 - v) * (H - pad.t - pad.b)) / 100;
  const line = useMemo(() => path.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(""), [path]);
  const area = n > 1 ? `${line}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` : "";
  const cur = path[n - 1];
  if (!cur) return null;
  const present = Array.from(new Set(path.flatMap(markers)));
  const anchorPct = cur.anchor === null ? null : Math.round(cur.anchor * 100);
  const noGoal = cur.flags.includes("noGoal");
  const h = hover !== null ? path[hover] : null;

  const pick = (clientX: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || !n) return null;
    const px = ((clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    return best;
  };

  return (
    <section className="p-sec fidelity">
      <h3>{t.fidelity}</h3>
      <div className="fid-head">
        <span className={`fid-num ${scoreTone(cur.score)}`}>{cur.score} %</span>
        <Why d={cur.why} shown={cur.score} t={t} label={`${t.fidelity} ${cur.score} %`} />
        <span className="fid-sub">
          {t.fidelityAt} <NodeId id={cur.id} />
          <br />
          {anchorPct === null ? t.noGoalLine : `${noGoal ? t.lineToTask : t.lineToGoal}: ${anchorPct} %`}
        </span>
      </div>
      <div className="fid-chart">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${t.fidelity}: ${path.map((p) => `${p.id} ${p.score} %`).join(", ")}`}
          onPointerMove={(e) => setHover(pick(e.clientX))}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => {
            const i = pick(e.clientX);
            if (i !== null) props.onSelect(path[i].id);
          }}
        >
          {[0, 50, 100].map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="fid-grid" />
              <text x={pad.l - 5} y={y(v) + 3.5} className="fid-axis" textAnchor="end">
                {v}
              </text>
            </g>
          ))}
          {area && <path d={area} className="fid-area" />}
          <path d={line} className="fid-line" />
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t - 6} y2={y(0)} className="fid-cross" />}
          {path.map((p, i) => (
            <g key={p.id}>
              <circle cx={x(i)} cy={y(p.score)} r={p.id === props.selectedId ? 5.5 : 4} className={`fid-dot ${p.id === props.selectedId ? "sel" : ""} ${p.integrity === "tampered" ? "bad" : ""}`} />
              {markers(p)
                .slice(0, 2)
                .map((f, k) => (
                  <text key={f} x={x(i)} y={Math.max(9, y(p.score) - 9 - k * 11)} textAnchor="middle" className={`fid-flag t-${TONE[f]}`}>
                    {GLYPH[f]}
                  </text>
                ))}
            </g>
          ))}
        </svg>
        {h && (
          <div className="fid-tip" style={{ left: `${Math.min(70, Math.max(0, (x(hover!) / W) * 100 - 15))}%` }}>
            <div>
              <strong>{h.score} %</strong> <NodeId id={h.id} /> <span className="muted">{t.types[h.type as keyof Dict["types"]] ?? h.type}</span>
            </div>
            <div className="fid-tip-title">{h.title}</div>
            <div className="muted">
              {t.fidAnchor} {h.anchor === null ? "–" : `${Math.round(h.anchor * 100)} %`} · {t.fidContinuity} {Math.round(h.continuity * 100)} % · {t.fidReliability} {Math.round(h.epistemic * 100)} %
            </div>
            {events(h).map((f) => (
              <div key={f} className={`t-${TONE[f]}`}>
                {GLYPH[f]} {t.fidFlags[f]}
              </div>
            ))}
          </div>
        )}
      </div>
      {present.length > 0 && (
        <ul className="fid-legend">
          {present.map((f) => (
            <li key={f}>
              <span className={`t-${TONE[f]}`}>{GLYPH[f]}</span> {t.fidFlags[f]}
            </li>
          ))}
        </ul>
      )}
      <details className="fid-table">
        <summary>{t.fidTable}</summary>
        <table className="log">
          <tbody>
            {path.map((p) => (
              <tr key={p.id}>
                <td>
                  <button className="btn link" onClick={() => props.onSelect(p.id)}>
                    <NodeId id={p.id} />
                  </button>
                </td>
                <td>{p.score} %</td>
                <td className="muted">{p.title.length > 48 ? p.title.slice(0, 47) + "…" : p.title}</td>
                <td>{markers(p).map((f) => GLYPH[f]).join(" ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <p className="hint">{t.fidHint}</p>
    </section>
  );
}
