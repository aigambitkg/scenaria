/**
 * The drawings of the introduction. Built in (no file is loaded from anywhere), drawn with the dashboard's own
 * colours, and every word in them comes from tourText.ts, so they exist in German and English.
 * Each drawing has a text alternative (`aria-label`); the step's text says the same in words.
 */
import type { TourText } from "./tourText";

const INK = "var(--ink)";
const SOFT = "var(--ink-3)";
const MARK = "var(--marker-solid)";
const PAPER = "var(--surface)";

function Frame(props: { label: string; children: React.ReactNode; height?: number }) {
  return (
    <svg className="tour-art" viewBox={`0 0 480 ${props.height ?? 210}`} role="img" aria-label={props.label} xmlns="http://www.w3.org/2000/svg">
      {props.children}
    </svg>
  );
}

/** A small "AI" mark: a box with a four-pointed spark. */
function AiMark({ x, y, s = 40 }: { x: number; y: number; s?: number }) {
  const c = s / 2;
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={s} height={s} rx="6" fill={PAPER} stroke={INK} strokeWidth="2" />
      <path d={`M${c} ${s * 0.2} L${c + s * 0.09} ${c - s * 0.09} L${s * 0.8} ${c} L${c + s * 0.09} ${c + s * 0.09} L${c} ${s * 0.8} L${c - s * 0.09} ${c + s * 0.09} L${s * 0.2} ${c} L${c - s * 0.09} ${c - s * 0.09} Z`} fill={INK} />
    </g>
  );
}

/** A sheet of paper with a folded corner and a few lines. */
function Sheet({ x, y, mark }: { x: number; y: number; mark?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d="M0 0h26l10 10v38H0z" fill={mark ? MARK : PAPER} stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <path d="M26 0v10h10" fill="none" stroke={INK} strokeWidth="2" strokeLinejoin="round" />
      <path d="M7 20h22M7 28h22M7 36h14" stroke={INK} strokeWidth="1.5" />
    </g>
  );
}

function Person({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} fill={PAPER} stroke={INK} strokeWidth="2">
      <circle cx="16" cy="10" r="9" />
      <path d="M0 40c0-12 7-18 16-18s16 6 16 18z" strokeLinejoin="round" />
    </g>
  );
}

function Lock({ x, y, open }: { x: number; y: number; open?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d={open ? "M7 14V8a7 7 0 0 1 14 0" : "M7 14V9a7 7 0 0 1 14 0v5"} fill="none" stroke={INK} strokeWidth="2.5" transform={open ? "translate(12 0)" : undefined} />
      <rect x="2" y="14" width="24" height="18" rx="2" fill={open ? MARK : PAPER} stroke={INK} strokeWidth="2" />
      <circle cx="14" cy="23" r="2.5" fill={INK} />
    </g>
  );
}

/** 1 — the AI works on the files, and every step leaves a saved state on the line. */
export function ArtSave({ x }: { x: TourText }) {
  const a = x.s1Art;
  const dots = [70, 155, 240, 325, 410];
  return (
    <Frame label={`${a.ai} ${a.files}. ${a.caption}`}>
      <AiMark x={96} y={14} />
      <text x={116} y={74} textAnchor="middle" className="ta-label">{a.ai}</text>
      <path d="M150 34h150" stroke={INK} strokeWidth="2" strokeDasharray="5 5" />
      <path d="M292 27l10 7-10 7" fill="none" stroke={INK} strokeWidth="2" />
      <Sheet x={322} y={8} />
      <Sheet x={336} y={16} mark />
      <text x={354} y={86} textAnchor="middle" className="ta-label">{a.files}</text>

      <path d="M40 150h400" stroke={INK} strokeWidth="2" />
      {dots.map((d, i) => (
        <g key={d}>
          <path d={`M${d} 110v32`} stroke={SOFT} strokeWidth="1.5" strokeDasharray="3 4" />
          <circle cx={d} cy={150} r={i === dots.length - 1 ? 9 : 7} fill={i === dots.length - 1 ? MARK : PAPER} stroke={INK} strokeWidth="2" />
        </g>
      ))}
      <g transform="translate(346 96)">
        <rect width="128" height="24" rx="3" fill={PAPER} stroke={INK} strokeWidth="1.5" />
        <path d="M10 12l4 4 7-8" fill="none" stroke="var(--pass)" strokeWidth="2.5" />
        <text x="28" y="16.5" className="ta-small">{a.saved}</text>
      </g>
      <text x={240} y={190} textAnchor="middle" className="ta-caption">{a.caption}</text>
    </Frame>
  );
}

/** 2 — one line of the Simple view, opened: request, result, changed files. */
export function ArtLook({ x }: { x: TourText }) {
  const a = x.s2Art;
  return (
    <Frame label={`${a.button} ${a.asked}: ${a.askedText} ${a.did}: ${a.didText}. ${a.files}: ${a.filesText}`} height={220}>
      <text x={58} y={34} textAnchor="end" className="ta-time">10:42</text>
      <path d="M78 6v208" stroke={INK} strokeWidth="2" />
      <path d="M71 29h14" stroke={INK} strokeWidth="2" />
      <rect x={98} y={17} width={150} height={22} fill={MARK} opacity="0.7" />
      <text x={102} y={33} className="ta-line">{a.didText}</text>
      <text x={102} y={62} className="ta-link">{a.button}</text>
      <path d={`M102 67h${Math.min(300, a.button.length * 7.4)}`} stroke={MARK} strokeWidth="3" />
      <path d="M118 74v10" stroke={INK} strokeWidth="1.5" />
      <rect x={98} y={84} width={360} height={118} rx="3" fill={PAPER} stroke={INK} strokeWidth="1.5" />
      {(
        [
          [a.asked, a.askedText],
          [a.did, a.didText],
          [a.files, a.filesText],
        ] as const
      ).map(([k, v], i) => (
        <g key={k} transform={`translate(112 ${108 + i * 34})`}>
          <text className="ta-key">{k}</text>
          <text y={17} className="ta-small">{v}</text>
        </g>
      ))}
    </Frame>
  );
}

/** 3 — going back to an earlier state; the states after it stay saved, and "undo" leads forward again. */
export function ArtBack({ x }: { x: TourText }) {
  const a = x.s3Art;
  const dots = [60, 150, 240, 330, 420];
  return (
    <Frame label={`${a.back}. ${a.undo}.`} height={200}>
      <path d="M40 110h200" stroke={INK} strokeWidth="2" />
      <path d="M240 110h180" stroke={SOFT} strokeWidth="2" strokeDasharray="6 6" />
      {dots.map((d, i) => (
        <circle key={d} cx={d} cy={110} r={i === 2 ? 10 : 7} fill={i === 2 ? MARK : PAPER} stroke={i > 2 ? SOFT : INK} strokeWidth="2" strokeDasharray={i > 2 ? "3 3" : undefined} />
      ))}
      {/* back: from "now" (last) to the third state */}
      <path d="M420 96C400 40 280 34 246 88" fill="none" stroke={INK} strokeWidth="2.5" />
      <path d="M240 78l5 14 12-8" fill="none" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
      <text x={330} y={34} textAnchor="middle" className="ta-label">{a.back}</text>
      <text x={448} y={114} className="ta-small">{a.now}</text>
      <text x={330} y={98} textAnchor="middle" className="ta-caption">{a.kept}</text>
      {/* undo: forward again */}
      <path d="M246 132C280 186 400 184 418 132" fill="none" stroke={SOFT} strokeWidth="2" strokeDasharray="5 5" />
      <path d="M408 138l10-8 6 12" fill="none" stroke={SOFT} strokeWidth="2" strokeLinejoin="round" />
      <text x={332} y={192} textAnchor="middle" className="ta-label">{a.undo}</text>
    </Frame>
  );
}

/** 4 — the lock opens a second, unlocked window; a person can do that, an AI cannot. */
export function ArtLock({ x }: { x: TourText }) {
  const a = x.s4Art;
  const win = (wx: number, open: boolean) => (
    <g transform={`translate(${wx} 14)`}>
      <rect width="170" height="104" rx="4" fill={PAPER} stroke={open ? INK : SOFT} strokeWidth="2" />
      <path d="M0 22h170" stroke={open ? INK : SOFT} strokeWidth="2" />
      <circle cx="12" cy="11" r="3" fill={open ? INK : SOFT} />
      <circle cx="24" cy="11" r="3" fill={open ? INK : SOFT} />
      <Lock x={132} y={30} open={open} />
      <path d="M14 44h96M14 60h78M14 76h88" stroke={open ? INK : SOFT} strokeWidth="2" strokeDasharray={open ? undefined : "4 4"} />
      <text x={85} y={126} textAnchor="middle" className="ta-label">{open ? a.open : a.locked}</text>
    </g>
  );
  return (
    <Frame label={`${a.locked} → ${a.open}. ${a.you}: ✓ · ${a.ai}: ✗`} height={220}>
      {win(30, false)}
      <path d="M210 66h54" stroke={INK} strokeWidth="2.5" />
      <path d="M256 58l10 8-10 8" fill="none" stroke={INK} strokeWidth="2.5" />
      {win(280, true)}
      <g transform="translate(96 160)">
        <Person x={0} y={0} />
        <text x={44} y={28} className="ta-label">{a.you}</text>
        <path d="M96 22l8 8 14-16" fill="none" stroke="var(--pass)" strokeWidth="3" />
      </g>
      <g transform="translate(286 160)">
        <AiMark x={0} y={2} s={36} />
        <text x={48} y={28} className="ta-label">{a.ai}</text>
        <path d="M96 12l18 18M114 12l-18 18" stroke="var(--fail)" strokeWidth="3" />
      </g>
    </Frame>
  );
}
