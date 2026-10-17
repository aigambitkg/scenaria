/**
 * Batch E1b: "How is this number computed?" for any number with a derivation (src/core/derivation.ts).
 * Hover shows the one-line sentence (title); a click, a tap or Enter/Space opens the whole derivation in place
 * (sentence, formula with version, inputs) — phones and keyboards have no hover. Escape closes it again while
 * the focus is inside it (never a key meant for something else, review E1b K1).
 * The number is recomputed here from the inputs as they came from the server, and compared with the value it
 * came with AND the number shown next to it (review E1b K2).
 */
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { expand, recompute, type CompactDerivation, type Derivation, type InputValue } from "../../src/core/derivation";
import type { Dict } from "./i18n";

const isFull = (d: Derivation | CompactDerivation): d is Derivation => Array.isArray((d as Derivation).inputs);

const fmtNum = (v: number, lang: "de" | "en") => {
  const s = String(Math.round(v * 10000) / 10000);
  return lang === "de" ? s.replace(".", ",") : s;
};

/** Internal finding codes ("tampered: n3") in plain words; unknown codes stay as they are. */
function item(x: string, t: Dict): string {
  const m = /^([a-z_]+): (.*)$/.exec(x);
  if (!m || !t.whyCode[m[1]]) return x;
  return `${t.whyCode[m[1]]}: ${m[2]}`;
}

function Value({ v, t, lang }: { v: InputValue; t: Dict; lang: "de" | "en" }) {
  if (v === null) return <>–</>;
  if (v === true) return <>{t.whyYes}</>;
  if (v === false) return <>{t.whyNo}</>;
  if (typeof v === "number") return <>{fmtNum(v, lang)}</>;
  if (Array.isArray(v)) {
    if (!v.length) return <>{t.whyNone}</>;
    // Every item, so the count can be recounted (review E1b K6); long lists scroll.
    return (
      <span className="why-items">
        <b>{v.length}</b>: {v.map((x) => item(String(x), t)).join(", ")}
      </span>
    );
  }
  return <>{String(v)}</>;
}

/** The whole derivation (also used inside lists). `original` is the derivation as it came; `shown` the number on screen. */
export function WhyBody({ d, original, shown, t, lang }: { d: Derivation; original?: Derivation | CompactDerivation; shown?: number; t: Dict; lang: "de" | "en" }) {
  const src = original ?? d;
  const again = recompute(src);
  const ok = again !== null && again === src.value && (shown === undefined || again === shown);
  return (
    <div className="why-body">
      <p>{d.sentence[lang]}</p>
      <p className="small">
        <span className="why-label">{t.whyFormula}</span> <code>{d.formula}</code>: {d.expression[lang]}
      </p>
      {d.inputs.length > 0 && (
        <table className="why-inputs">
          <tbody>
            {/* The rule of a count is in the sentence, in the reader's language (review E1b K7). */}
            {d.inputs
              .filter((i) => i.name !== "rule")
              .map((i) => (
                <tr key={i.name}>
                  <th scope="row">{i.label[lang]}</th>
                  <td className={typeof i.value === "number" || typeof i.value === "boolean" || i.value === null ? "why-num" : undefined}>
                    <Value v={i.value} t={t} lang={lang} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      <p className={`small ${ok ? "why-ok" : "why-bad"}`}>{ok ? t.whyChecked(again!) : t.whyMismatch(String(again ?? "–"), String(shown ?? src.value))}</p>
    </div>
  );
}

/** A small "How computed?" button next to a number; opens the derivation in place. */
export function Why({ d, shown, t, lang = t.langCode, label }: { d: Derivation | CompactDerivation | null | undefined; shown?: number; t: Dict; lang?: "de" | "en"; label?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  const full = !d ? null : isFull(d) ? d : expand(d);
  if (!full || !d) return null;
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== "Escape" || !open) return;
    // Only while the focus is in this derivation: the key does not also close the dialog around it.
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    setOpen(false);
    btn.current?.focus();
  };
  return (
    <span className={`why ${open ? "open" : ""}`} onKeyDown={onKeyDown}>
      <button
        ref={btn}
        type="button"
        className="btn link why-btn"
        title={full.sentence[lang]}
        aria-expanded={open}
        aria-controls={id}
        aria-label={`${t.whyBtn}${label ? `: ${label}` : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        ⓘ <span className="why-word">{t.whyBtn}</span>
      </button>
      {open && (
        <span className="why-pop" id={id} role="region" aria-label={t.whyBtn}>
          <WhyBody d={full} original={d} shown={shown} t={t} lang={lang} />
        </span>
      )}
    </span>
  );
}

/** One "How computed?" for a group of numbers (e.g. the audit file's counts, which sit in buttons). */
export function WhyList({ items, t, lang = t.langCode, title }: { items: [Derivation | null | undefined, number | undefined][]; t: Dict; lang?: "de" | "en"; title: string }) {
  const list = items.filter((x): x is [Derivation, number | undefined] => Boolean(x[0]));
  if (!list.length) return null;
  return (
    <details className="why-list">
      <summary>
        ⓘ {t.whyBtn} – {title}
      </summary>
      {list.map(([d, shown]) => (
        <div key={d.key} className="why-item">
          <WhyBody d={d} shown={shown} t={t} lang={lang} />
        </div>
      ))}
    </details>
  );
}
