/**
 * Project switcher: the person's Scenaria projects on this computer — switch the dashboard with one
 * click. Agents keep working in their own project; only the dashboard changes.
 */
import { useEffect, useRef, useState } from "react";
import { api, type ProjectsPage } from "./api";
import type { Dict } from "./i18n";

const errText = (e: any) => String(e?.message ?? e);

function ago(iso: string, lang: "de" | "en") {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const min = Math.round(ms / 60000);
  if (min < 60) return rtf.format(-min, "minute");
  const h = Math.round(min / 60);
  if (h < 48) return rtf.format(-h, "hour");
  return rtf.format(-Math.round(h / 24), "day");
}

export function ProjectSwitcher(props: { t: Dict; lang: "de" | "en"; name: string; toast: (m: string) => void; onSwitched: () => void }) {
  const { t } = props;
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ProjectsPage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const box = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      setPage(await api.projects());
    } catch (e) {
      setErr(errText(e));
    }
  };
  useEffect(() => {
    if (!open) return;
    setErr(null);
    load();
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const switchTo = async (root: string) => {
    setBusy(root);
    setErr(null);
    try {
      const r = await api.switchProject(root);
      props.toast(t.pjSwitched(r.name));
      setOpen(false);
      props.onSwitched();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const others = page?.projects ?? [];
  return (
    <div className="pj" ref={box}>
      <button className="project pj-btn" aria-haspopup="listbox" aria-expanded={open} title={t.pjHint} onClick={() => setOpen(!open)}>
        {props.name} <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="pj-menu" role="listbox" aria-label={t.pjTitle}>
          <div className="pj-head">
            <strong>{t.pjTitle}</strong>
            <span className="muted small">{t.pjExplain}</span>
          </div>
          {err && <p className="error small">{err}</p>}
          {page && !page.person && <p className="qnote q-warn small">🔒 {t.pjLocked}</p>}
          {page && page.person && !page.canSwitch && <p className="muted small">{t.pjNoSwitch}</p>}
          {page?.person && (
            <ul className="pj-list">
              {others.map((x) => (
                <li key={x.root} className={`${x.current ? "on" : ""} ${x.exists ? "" : "gone"}`}>
                  <button className="pj-item" role="option" aria-selected={x.current} disabled={x.current || !x.exists || !page.canSwitch || busy !== null} onClick={() => switchTo(x.root)}>
                    <span className="pj-name">
                      {x.current ? "● " : ""}
                      {x.name}
                    </span>
                    <span className="muted small pj-path" title={x.root}>
                      {x.root}
                    </span>
                    <span className="muted small">{x.exists ? (x.current ? t.pjCurrent : ago(x.lastSeen, props.lang)) : t.pjMissing}</span>
                  </button>
                  {!x.current && (
                    <button
                      className="btn icon"
                      title={t.pjForget}
                      aria-label={`${t.pjForget}: ${x.name}`}
                      onClick={async () => {
                        await api.forgetProject(x.root).catch((e) => setErr(errText(e)));
                        load();
                      }}
                    >
                      ✕
                    </button>
                  )}
                  {busy === x.root && <span className="muted small">…</span>}
                </li>
              ))}
              {others.length <= 1 && <li className="muted small">{t.pjOnlyOne}</li>}
            </ul>
          )}
          {page?.person && page.canSwitch && (
            <form
              className="row pj-open"
              onSubmit={(e) => {
                e.preventDefault();
                if (path.trim()) switchTo(path.trim());
              }}
            >
              <input className="grow" value={path} placeholder={t.pjPathPlaceholder} onChange={(e) => setPath(e.target.value)} aria-label={t.pjOpenPath} />
              <button className="btn" type="submit" disabled={!path.trim() || busy !== null}>
                {t.pjOpen}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
