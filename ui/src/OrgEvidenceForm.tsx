/**
 * The organisation's evidence in the dashboard (C4c-2, Kev 2026-10-17): record a document at its control, remove
 * or discard an entry, confirm a teammate's or a changed-catalogue entry, take over entries from another of the
 * person's projects. Every change is the person's (approval session) and signed with their key.
 *
 * The rule from C3 holds here too: the person signs only what they saw. Recording shows the checked, normalised
 * values first (dryRun) and then sends exactly those; removing shows what would happen to which entry and sends
 * its outcome and digest along (refused if the file changed meanwhile); confirming sends the digest of the entry
 * shown; taking over sends the ids of the plan shown. The document itself never leaves the browser: only its
 * SHA-256 is computed here.
 */
import { useEffect, useState } from "react";
import { api, type CopyPlan, type OrgEvidenceInput, type OrgEvidenceState, type RemovePlanView } from "./api";
import type { Dict } from "./i18n";

/** Larger files are refused in the browser (reading them would take the page down); paste the hash instead. */
const MAX_HASH_BYTES = 512 * 1024 * 1024;

/** SHA-256 of a file the person chose, computed in this browser (the file is never uploaded). */
export async function sha256OfFile(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("no_crypto");
  if (file.size > MAX_HASH_BYTES) throw new Error("too_large");
  const d = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return "sha256:" + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The normal form of a link (an international or look-alike domain as punycode), when it differs from the text
 * shown — so a look-alike "exаmple.org" never passes as example.org (review C4c-2 K2).
 */
export function normalLink(u: string): string | null {
  try {
    const h = new URL(u).href;
    return h !== u ? h : null;
  } catch {
    return null;
  }
}

/** The values the person is about to sign (or has signed), as a list. */
function EntryFields(props: { t: Dict; v: { control?: string; url: string; hash: string; title?: string; owner: { role: string; name: string }; date: string; note?: string } }) {
  const { t, v } = props;
  return (
    <dl className="ev-fields">
      {v.control && (
        <>
          <dt>{t.evControl}</dt>
          <dd>{v.control}</dd>
        </>
      )}
      {v.title && (
        <>
          <dt>{t.evTitle}</dt>
          <dd>{v.title}</dd>
        </>
      )}
      <dt>{t.evUrl}</dt>
      <dd className="af-url">
        {v.url}
        {normalLink(v.url) && <div className="qnote q-warn">{t.evLinkNormal(normalLink(v.url)!)}</div>}
      </dd>
      <dt>SHA-256</dt>
      <dd className="af-hash">
        <code>{v.hash}</code>
      </dd>
      <dt>{t.afOwner}</dt>
      <dd>
        {v.owner.role}
        {v.owner.name ? ` · ${v.owner.name}` : ""}
      </dd>
      <dt>{t.afDocDate}</dt>
      <dd>{v.date}</dd>
      {v.note && (
        <>
          <dt>{t.evNote}</dt>
          <dd>{v.note}</dd>
        </>
      )}
    </dl>
  );
}

/** Record a document for one control: fill in → check (what will be signed) → sign. */
export function EvidenceAdd(props: { t: Dict; control: string; controlTitle: string; onDone: (msg: string) => void; onCancel: () => void }) {
  const { t } = props;
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState("");
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"file" | "paste">(globalThis.crypto?.subtle ? "file" : "paste");
  const [hash, setHash] = useState("");
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [hashing, setHashing] = useState(false);
  const [preview, setPreview] = useState<OrgEvidenceInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pick = async (f: File | undefined) => {
    setErr(null);
    setHash("");
    setFileNote(null);
    if (!f) return;
    setHashing(true);
    try {
      const h = await sha256OfFile(f);
      setHash(h);
      setFileNote(t.evHashDone(f.name));
    } catch (e) {
      const m = errText(e);
      setErr(m === "no_crypto" ? t.evNoCrypto : m === "too_large" ? t.evTooLarge : m);
      if (m === "no_crypto") setMode("paste");
    } finally {
      setHashing(false);
    }
  };
  const check = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.orgEvidencePreview({ control: props.control, url, hash, title, role, name, date, note });
      setPreview(r.input);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const sign = async () => {
    if (!preview) return;
    setBusy(true);
    setErr(null);
    try {
      // Exactly the values shown (normalising them again changes nothing).
      const r = await api.orgEvidenceAdd(preview);
      props.onDone(t.evAdded(r.entry.id));
    } catch (e) {
      setErr(errText(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  if (preview) {
    return (
      <div className="ev-box" role="region" aria-label={t.evCheckTitle}>
        <h5>{t.evCheckTitle}</h5>
        <p className="small">{t.evCheckIntro}</p>
        <EntryFields t={t} v={{ control: `${preview.control} ${props.controlTitle}`, url: preview.url, hash: preview.hash, title: preview.title, owner: { role: preview.role, name: preview.name }, date: preview.date, note: preview.note }} />
        <p className="small muted">{t.evSignNote}</p>
        {err && <p className="error">{err}</p>}
        <div className="af-row">
          <button className="btn primary" disabled={busy} onClick={sign}>
            {t.evSign}
          </button>
          <button className="btn" disabled={busy} onClick={() => setPreview(null)}>
            {t.evBack}
          </button>
        </div>
      </div>
    );
  }
  const ready = url.trim() && hash.trim() && role.trim() && name.trim() && date && !hashing;
  return (
    <form
      className="ev-box ev-form"
      aria-label={t.evAddTitle}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void check();
      }}
    >
      <h5>{t.evAddTitle}</h5>
      <label className="field">
        <span>{t.evUrl} *</span>
        <input type="url" inputMode="url" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} required />
      </label>
      <fieldset className="ev-hash">
        <legend>{t.evHashLegend} *</legend>
        <div className="seg" role="radiogroup">
          <button type="button" role="radio" aria-checked={mode === "file"} className={mode === "file" ? "on" : ""} onClick={() => setMode("file")}>
            {t.evHashFile}
          </button>
          <button type="button" role="radio" aria-checked={mode === "paste"} className={mode === "paste" ? "on" : ""} onClick={() => setMode("paste")}>
            {t.evHashPaste}
          </button>
        </div>
        {mode === "file" ? (
          <>
            <input type="file" aria-label={t.evHashFile} onChange={(e) => void pick(e.target.files?.[0])} />
            <p className="small muted">{hashing ? t.evHashing : fileNote ?? t.evHashFileHint}</p>
            {hash && (
              <p className="small af-hash">
                <code>{hash}</code>
              </p>
            )}
          </>
        ) : (
          <input value={hash} placeholder="sha256:…" aria-label={t.evHashPaste} onChange={(e) => setHash(e.target.value)} />
        )}
      </fieldset>
      <label className="field">
        <span>{t.evTitle}</span>
        <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="ev-two">
        <label className="field">
          <span>{t.evRole} *</span>
          <input value={role} maxLength={120} placeholder={t.evRolePh} onChange={(e) => setRole(e.target.value)} required />
        </label>
        <label className="field">
          <span>{t.evName} *</span>
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required />
        </label>
      </div>
      <label className="field">
        <span>{t.afDocDate} *</span>
        <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} required />
      </label>
      <label className="field">
        <span>{t.evNote}</span>
        <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      <p className="small muted">{t.evPrivacy}</p>
      {err && <p className="error">{err}</p>}
      <div className="af-row">
        <button className="btn primary" type="submit" disabled={!ready || busy}>
          {t.evCheck}
        </button>
        <button className="btn" type="button" onClick={props.onCancel}>
          {t.cancel}
        </button>
      </div>
    </form>
  );
}

/** What the person can do with one entry, given its state. */
export function evidenceActionsFor(st: OrgEvidenceState | undefined): { remove: boolean; discard: boolean; confirm: boolean } {
  if (!st || st.entry.discarded || st.entry.status !== "active") return { remove: false, discard: false, confirm: false };
  if (st.trust === "tampered") return { remove: false, discard: true, confirm: false };
  if (st.trust === "verified") return { remove: true, discard: false, confirm: st.catalogueChanged && st.normal };
  // Not in its normal form (e.g. a look-alike link): signing would change it, so it can only be discarded (R1).
  if (!st.normal) return { remove: false, discard: true, confirm: false };
  // A teammate's entry (a key this machine does not trust) or an unsigned one: look at it, then confirm or discard.
  return { remove: false, discard: true, confirm: true };
}

/** The buttons for one entry and the step that shows what would happen before anything is signed. */
export function EvidenceActions(props: { t: Dict; st: OrgEvidenceState; onDone: (msg: string) => void }) {
  const { t, st } = props;
  const can = evidenceActionsFor(st);
  const [step, setStep] = useState<null | { kind: "remove"; plan: RemovePlanView; discard: boolean } | { kind: "confirm" }>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const plan = async (discard: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      setStep({ kind: "remove", plan: await api.orgEvidenceRemovePlan(st.entry.id, discard), discard });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    setErr(null);
    try {
      const msg = await f();
      setStep(null);
      props.onDone(msg);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!can.remove && !can.discard && !can.confirm) return null;
  if (step?.kind === "remove") {
    const p = step.plan;
    const label = p.outcome === "remove" ? t.evRemoveGo : p.outcome === "drop_copies" ? t.evDropGo : t.evDiscardGo;
    return (
      <div className="ev-box" role="region" aria-label={t.evRemoveTitle}>
        <p className="small">{t.evOutcome[p.outcome]?.(p.dropped) ?? p.outcome}</p>
        {p.outcome !== "restore_first" && p.outcome !== "already_removed" && (
          <EntryFields t={t} v={{ control: p.entry.control, url: p.entry.url, hash: p.entry.hash, title: p.entry.title, owner: p.entry.owner, date: p.entry.date, note: p.entry.note }} />
        )}
        {err && <p className="error">{err}</p>}
        <div className="af-row">
          {p.outcome === "restore_first" ? (
            <button className="btn bad" disabled={busy} onClick={() => void plan(true)}>
              {t.evDiscardAnyway}
            </button>
          ) : p.outcome !== "already_removed" ? (
            <button
              className="btn bad"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api.orgEvidenceRemove(st.entry.id, step.discard, { outcome: p.outcome, digest: p.digest });
                  return r.discarded ? t.evDiscarded(st.entry.id) : t.evRemoved(st.entry.id);
                })
              }
            >
              {label}
            </button>
          ) : null}
          <button className="btn" disabled={busy} onClick={() => setStep(null)}>
            {t.cancel}
          </button>
        </div>
      </div>
    );
  }
  if (step?.kind === "confirm") {
    return (
      <div className="ev-box" role="region" aria-label={t.evConfirmTitle}>
        <p className="small">{st.trust === "verified" ? t.evConfirmCatalogue : t.evConfirmOther}</p>
        <EntryFields t={t} v={{ control: st.entry.control, url: st.entry.url, hash: st.entry.hash, title: st.entry.title, owner: st.entry.owner, date: st.entry.date, note: st.entry.note }} />
        {err && <p className="error">{err}</p>}
        <div className="af-row">
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                // The digest of exactly the entry shown: a changed file is refused ("look at it again").
                await api.orgEvidenceConfirm(st.entry.id, st.digest);
                return t.evConfirmed(st.entry.id);
              })
            }
          >
            {t.evConfirmGo}
          </button>
          <button className="btn" disabled={busy} onClick={() => setStep(null)}>
            {t.cancel}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="ev-actions">
      {!st.normal && <p className="small qnote q-warn">{t.evNotNormal}</p>}
      {can.confirm && (
        <button className="btn" disabled={busy} onClick={() => setStep({ kind: "confirm" })}>
          {t.evConfirm}
        </button>
      )}
      {can.remove && (
        <button className="btn" disabled={busy} onClick={() => void plan(false)}>
          {t.evRemove}
        </button>
      )}
      {can.discard && (
        <button className="btn" disabled={busy} onClick={() => void plan(false)}>
          {t.evDiscard}
        </button>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

/** Take over the documents of another of the person's projects: choose → plan (what exactly) → take over. */
export function EvidenceCopy(props: { t: Dict; onDone: (msg: string) => void }) {
  const { t } = props;
  const [projects, setProjects] = useState<{ name: string; root: string }[] | null>(null);
  const [from, setFrom] = useState("");
  const [plan, setPlan] = useState<CopyPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api
      .projects()
      .then((p) => setProjects(p.projects.filter((x) => x.exists && !x.current).map((x) => ({ name: x.name, root: x.root }))))
      .catch((e) => setErr(errText(e)));
  }, []);
  const show = async () => {
    setBusy(true);
    setErr(null);
    setPlan(null);
    try {
      setPlan(await api.orgEvidenceCopyPlan(from));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const take = async () => {
    if (!plan) return;
    setBusy(true);
    setErr(null);
    try {
      // Every signed value shown and the project name that gets recorded (review C4c-2 K1).
      const r = await api.orgEvidenceCopy(from, { name: plan.from.name, entries: plan.take.map((x) => ({ id: x.id, digest: x.digest })) });
      setPlan(null);
      props.onDone(t.evCopied(r.copied.length, r.from));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ev-box" role="region" aria-label={t.evCopyTitle}>
      <h5>{t.evCopyTitle}</h5>
      <p className="small muted">{t.evCopyIntro}</p>
      {projects && projects.length === 0 && <p className="small muted">{t.evCopyNone}</p>}
      {projects && projects.length > 0 && (
        <div className="af-row">
          <label className="field ev-inline">
            <span>{t.evCopyFrom}</span>
            <select
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPlan(null);
              }}
            >
              <option value="">–</option>
              {projects.map((p) => (
                <option key={p.root} value={p.root}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" disabled={!from || busy} onClick={() => void show()}>
            {t.evCopyShow}
          </button>
        </div>
      )}
      {plan && (
        <>
          {plan.sameIdElsewhere > 0 && <p className="qnote q-warn">{t.evCopySameId(plan.sameIdElsewhere)}</p>}
          <p className="small">{t.evCopyOrigin(plan.from.name)}</p>
          {plan.take.length === 0 ? (
            <p className="small">{t.evCopyNothing}</p>
          ) : (
            plan.take.map((x) => <EntryFields key={x.id} t={t} v={{ control: x.control, url: x.url, hash: x.hash, title: x.title, owner: x.owner, date: x.date, note: x.note }} />)
          )}
          {plan.skipped.length > 0 && (
            <p className="small muted">
              {t.evCopySkipped}: {plan.skipped.map((x) => `${x.id} (${t.evSkipReason[x.reason] ?? x.reason})`).join(", ")}
            </p>
          )}
          {plan.take.length > 0 && (
            <>
              <p className="small muted">{t.evCopySign}</p>
              <div className="af-row">
                <button className="btn primary" disabled={busy} onClick={() => void take()}>
                  {t.evCopyGo(plan.take.length)}
                </button>
              </div>
            </>
          )}
        </>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
