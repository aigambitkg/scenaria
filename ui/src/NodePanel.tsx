import { useEffect, useState } from "react";
import { api, type ConversationMessage, type Fidelity, type ScenariaNode } from "./api";
import { FidelityChart } from "./Fidelity";
import type { Dict } from "./i18n";
import type { Placed } from "./layout";
import { NodeId, qualityFlag } from "./Map";

function List({ title, items, tone }: { title: string; items?: string[]; tone?: string }) {
  if (!items?.length) return null;
  return (
    <section className={`p-sec ${tone ?? ""}`}>
      <h3>{title}</h3>
      <ul>
        {items.map((i, k) => (
          <li key={k}>{renderInline(i)}</li>
        ))}
      </ul>
    </section>
  );
}

/** Render `code` spans from capsule bullets. */
function renderInline(s: string) {
  const parts = s.split(/(`[^`]+`)/g);
  return parts.map((p, i) => (p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : <span key={i}>{p}</span>));
}

export function MessageList({ msgs, t, limit = 6 }: { msgs: ConversationMessage[]; t: Dict; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? msgs : msgs.slice(-limit);
  return (
    <ol className="msgs">
      {!all && msgs.length > limit && (
        <li className="more">
          <button className="btn link" onClick={() => setAll(true)}>
            {t.showMore} (+{msgs.length - limit})
          </button>
        </li>
      )}
      {shown.map((m) => (
        <li key={m.id} className={`msg r-${m.role}`}>
          <div className="msg-head">
            <span className="msg-role">{t.roles[m.role] ?? m.role}</span>
            <span className="muted">
              {m.id}
              {m.model ? ` · ${m.model}` : ""}
            </span>
          </div>
          {m.text && <p className="msg-text">{m.text.length > 700 ? m.text.slice(0, 700) + "…" : m.text}</p>}
          {m.toolCalls?.map((tc, i) => (
            <code key={i} className="msg-tool">
              {tc.name}
            </code>
          ))}
        </li>
      ))}
    </ol>
  );
}

function countInside(goalId: string, all: ScenariaNode[]) {
  const kids = new Map<string, ScenariaNode[]>();
  for (const x of all) if (x.parentId) kids.set(x.parentId, [...(kids.get(x.parentId) ?? []), x]);
  const out: ScenariaNode[] = [];
  const stack = [...(kids.get(goalId) ?? [])];
  while (stack.length) {
    const x = stack.pop()!;
    if (x.type === "goal") continue;
    out.push(x);
    stack.push(...(kids.get(x.id) ?? []));
  }
  return { steps: out.length, decisions: out.filter((x) => x.type === "decision").length, failed: out.filter((x) => x.verification?.status === "failed").length };
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

export function NodePanel(props: {
  placed: Placed | null;
  allNodes: ScenariaNode[];
  headId: string | null;
  t: Dict;
  onRewind: (n: ScenariaNode) => void;
  onFork: (decision: ScenariaNode, optionId: string, label: string) => void;
  onDiff: (from: string, to: string) => void;
  onVerify: (id: string, body: { status?: string; notes?: string; auto?: boolean }) => Promise<void>;
  toast: (msg: string) => void;
  graphVersion?: number;
  folded: Set<string>;
  onToggleFold: (id: string) => void;
  onEditGoal: () => void;
  onUpdate: (id: string, patch: Record<string, string>) => Promise<void>;
  fidelity: Fidelity | null;
  onSelect: (id: string) => void;
  onChoose?: (id: string, option: string, rationale: string) => Promise<void>;
}) {
  const { placed, allNodes, t } = props;
  const [choosing, setChoosing] = useState<{ id: string; why: string } | null>(null);
  const [ctx, setCtx] = useState<{ tokens: number; markdown: string; historyTokens?: number } | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msgs, setMsgs] = useState<{ leading: ConversationMessage[]; after: ConversationMessage[] } | null>(null);
  const node = placed?.kind === "node" ? placed.node! : null;

  useEffect(() => {
    setMsgs(null);
    if (node) api.nodeMessages(node.id).then(setMsgs).catch(() => setMsgs(null));
  }, [node?.id, props.graphVersion]);

  useEffect(() => {
    setCtx(null);
    setNotes("");
    if (node) api.context(node.id).then(setCtx).catch(() => setCtx(null));
  }, [node?.id, node?.verification?.at, node?.lessons?.length]);

  if (!placed) {
    return (
      <aside className="panel panel-empty">
        <p>{t.select}</p>
      </aside>
    );
  }

  if (placed.kind === "ghost") {
    const g = placed.ghost!;
    const opt = g.decision.options?.find((o) => o.id === g.optionId);
    return (
      <aside className="panel">
        <header className="p-head">
          <span className="p-kind">{g.chosen ? t.ghostChosen : t.types.ghost}</span>
          <h2 className="p-title">{g.label}</h2>
          <p className="p-meta">
            <NodeId id={g.decision.id} />
            <span>{g.decision.question}</span>
          </p>
        </header>
        {opt?.description && (
          <section className="p-sec">
            <p>{opt.description}</p>
          </section>
        )}
        <section className="p-sec">
          <p className="muted">{g.chosen ? t.ghostChosenHint : t.ghostHint}</p>
        </section>
        <div className="p-actions">
          <button className="btn primary" onClick={() => props.onFork(g.decision, g.optionId, g.label)}>
            {t.exploreOption}
          </button>
        </div>
      </aside>
    );
  }

  const n = node!;
  const v = n.verification?.status ?? "unverified";
  const kids = allNodes.filter((k) => k.parentId === n.id);
  const exploredOptions = new Set(kids.map((k) => k.viaOption));
  const transcriptTokens =
    typeof n.meta?.transcriptTokens === "number" ? (n.meta.transcriptTokens as number) : ctx?.historyTokens && ctx.historyTokens > ctx.tokens ? ctx.historyTokens : null;
  const q = qualityFlag(n, t);
  const inside = n.type === "goal" ? countInside(n.id, allNodes) : null;
  const fidPath = (() => {
    if (!props.fidelity) return [];
    const byId = new Map(allNodes.map((x) => [x.id, x]));
    const ids: string[] = [];
    let cur: ScenariaNode | undefined = n;
    while (cur && !ids.includes(cur.id)) {
      ids.unshift(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return ids.map((id) => props.fidelity!.points[id]).filter(Boolean);
  })();

  const verify = async (body: { status?: string; notes?: string; auto?: boolean }) => {
    setBusy(true);
    try {
      await props.onVerify(n.id, body);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="panel">
      <header className="p-head">
        <div className="p-head-row">
          <NodeId id={n.id} big />
          <div>
            <span className="p-kind">{t.types[n.type]}</span>
            <span className={`chip v-${v}`}>{t.verification[v]}</span>
          </div>
        </div>
        <h2 className="p-title">{n.type === "decision" ? n.question ?? n.title : n.title}</h2>
        <p className="p-meta">
          <span>{fmtTime(n.createdAt)}</span>
          {n.agent && (
            <span>
              {t.agent} {n.agent}
            </span>
          )}
          {n.model && <span title={t.model}>{n.model}</span>}
          {n.user && <span title={t.userLabel}>{n.user}</span>}
          <span>{n.snapshot ? `${n.snapshot.files} ${n.snapshot.files === 1 ? t.file : t.files}` : t.noSnapshot}</span>
        </p>
      </header>

      <div className="p-body">
        {props.fidelity?.ledgerBrokenAt || props.fidelity?.ledgerMissing ? <p className="qnote q-bad">⛔ {props.fidelity.ledgerMissing ? t.ledgerMissing : t.ledgerBroken}</p> : null}
        {fidPath.length > 1 && <FidelityChart path={fidPath} selectedId={n.id} t={t} onSelect={props.onSelect} />}
        {n.type === "mission" && (
          <section className={`p-sec goal ${n.goal ? "" : "missing"}`}>
            <h3>{t.goal}</h3>
            <p>{n.goal ?? t.goalMissingLong}</p>
            <button className="btn link" onClick={props.onEditGoal}>
              {n.goal ? t.editGoal : t.setGoal}
            </button>
          </section>
        )}
        {n.type === "goal" && (
          <section className="p-sec goal task">
            <h3>
              {t.taskGoal} <span className={`chip st-${n.status ?? "active"}`}>{t.taskStatus[n.status ?? "active"]}</span>
            </h3>
            {n.goal && n.goal !== n.title && <p>{n.goal}</p>}
            {inside && (
              <p className="muted">
                {inside.steps} {t.steps} · {inside.decisions} {t.decisionsShort}
                {inside.failed ? ` · ${inside.failed} ✘` : ""}
              </p>
            )}
            {n.summary && (
              <p className="rationale">
                <strong>{t.summary}:</strong> {n.summary}
              </p>
            )}
            <div className="row">
              <button className="btn" onClick={() => props.onToggleFold(n.id)}>
                {props.folded.has(n.id) ? t.expand : t.collapse}
              </button>
              {n.status !== "done" && (
                <button className="btn" onClick={() => props.onUpdate(n.id, { status: "done" })}>
                  {t.markDone}
                </button>
              )}
            </div>
          </section>
        )}
        {n.brief && n.brief !== n.goal && (
          <section className="p-sec">
            <h3>{t.brief}</h3>
            <p className="pre">{n.brief}</p>
          </section>
        )}

        {n.type === "decision" && (
          <section className="p-sec">
            <h3>{t.options}</h3>
            <ol className="opts">
              {(n.options ?? []).map((o) => {
                const isChosen = o.id === n.chosen;
                const explored = exploredOptions.has(o.id);
                return (
                  <li key={o.id} className={isChosen ? "chosen" : ""}>
                    <div className="opt-main">
                      <span className="opt-mark" aria-hidden>
                        {isChosen ? "●" : explored ? "⑂" : "○"}
                      </span>
                      <span className="opt-label">{o.label}</span>
                      {isChosen && <span className="tag">{t.chosen}</span>}
                      {!isChosen && explored && <span className="tag">{t.explored}</span>}
                    </div>
                    {o.description && <p className="opt-desc">{o.description}</p>}
                    {!n.chosen && props.onChoose && (
                      choosing?.id === o.id ? (
                        <form
                          className="choose-form"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            if (!choosing.why.trim()) return;
                            await props.onChoose!(n.id, o.id, choosing.why.trim());
                            setChoosing(null);
                          }}
                        >
                          <input autoFocus value={choosing.why} placeholder={t.chooseRationale} onChange={(e) => setChoosing({ id: o.id, why: e.target.value })} />
                          <button className="btn primary" type="submit" disabled={!choosing.why.trim()}>
                            {t.chooseConfirm}
                          </button>
                        </form>
                      ) : (
                        <button className="btn link" onClick={() => setChoosing({ id: o.id, why: "" })}>
                          {t.chooseOption}
                        </button>
                      )
                    )}
                    {n.chosen && !isChosen && !explored && (
                      <button className="btn link" onClick={() => props.onFork(n, o.id, o.label)}>
                        {t.exploreOption}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
            {q && <p className={`qnote ${q.cls}`}>{q.text}</p>}
            {n.rationale && (
              <p className="rationale">
                <strong>{t.rationale}:</strong> {n.rationale}
              </p>
            )}
            {(n.context || n.trigger) && (
              <p className="rationale">
                <strong>{n.context ? t.contextLabel : t.trigger}:</strong> {n.context ?? n.trigger}
              </p>
            )}
            {n.context && n.trigger && (
              <p className="rationale muted">
                <strong>{t.trigger}:</strong> {n.trigger}
              </p>
            )}
            {n.servesGoal && (
              <p className="rationale">
                <strong>{t.servesGoal}:</strong> {n.servesGoal}
              </p>
            )}
            {(n.respectsCanon?.length || n.breaksCanon?.length) && (
              <p className="rationale">
                {n.breaksCanon?.length ? <span className="chip v-failed">⚑ {t.breaksCanon} {n.breaksCanon.join(", ")}</span> : null}{" "}
                {n.respectsCanon?.length ? <span className="chip v-passed">✓ {t.respectsCanon} {n.respectsCanon.join(", ")}</span> : null}
              </p>
            )}
            {n.expectedOutcome && (
              <p className="rationale">
                <strong>{t.expectedOutcome}:</strong> {n.expectedOutcome}
              </p>
            )}
            {n.confidence !== undefined && (
              <div className="conf">
                <span>{t.confidence}</span>
                <div className="conf-bar">
                  <div style={{ width: `${Math.round(n.confidence * 100)}%` }} />
                </div>
                <span>{Math.round(n.confidence * 100)} %</span>
              </div>
            )}
          </section>
        )}

        <List title={t.assumptions} items={n.assumptions} />
        <List title={t.facts} items={n.facts} />
        <List title={t.outputs} items={n.outputs} />
        <List title={t.openQuestions} items={n.openQuestions} />
        <List title={t.lessons} items={n.lessons} tone="lesson" />
        <List title={t.irreversible} items={n.irreversible} tone="danger" />

        {n.changedFiles?.length ? (
          <section className="p-sec">
            <h3>
              {t.changedFiles} <span className="count">{n.changedFiles.length}</span>
            </h3>
            <ul className="files">
              {n.changedFiles.slice(0, 40).map((f) => (
                <li key={f} className={f.startsWith("+") ? "add" : f.startsWith("-") ? "del" : "mod"}>
                  <code>{f}</code>
                </li>
              ))}
              {n.changedFiles.length > 40 && <li className="muted">… +{n.changedFiles.length - 40}</li>}
            </ul>
          </section>
        ) : null}

        <section className="p-sec version">
          <h3>{t.versionSec}</h3>
          <dl className="kv">
            {n.scenarioId && (
              <>
                <dt>{t.scenario}</dt>
                <dd>
                  <strong>
                    {n.scenarioId}/v{n.version}
                  </strong>
                  {n.forkedFrom ? <span className="muted"> ← {n.forkedFrom}</span> : null}
                </dd>
              </>
            )}
            {n.uid && (
              <>
                <dt>{t.uidLabel}</dt>
                <dd>
                  <code>{n.uid}</code>
                </dd>
              </>
            )}
            {n.snapshot && (
              <>
                <dt>Snapshot</dt>
                <dd>
                  <code>{n.snapshot.commit.slice(0, 12)}</code>
                </dd>
              </>
            )}
          </dl>
          {n.snapshot && (
            <div className="row">
              <button
                className="btn"
                onClick={async () => {
                  const r = await api.folder(n.id, true);
                  if (r.folder) props.toast(r.folder);
                }}
              >
                {t.openFolder}
              </button>
              <button
                className="btn"
                onClick={async () => {
                  const r = await api.folder(n.id, false);
                  if (!r.folder) return;
                  try {
                    await navigator.clipboard.writeText(r.folder);
                    props.toast(t.pathCopied);
                  } catch {
                    props.toast(r.folder);
                  }
                }}
              >
                {t.copyPath}
              </button>
            </div>
          )}
        </section>

        <section className="p-sec convo">
          <h3>
            {t.conversation}
            {msgs ? <span className="count">{msgs.leading.length + msgs.after.length}</span> : null}
          </h3>
          {msgs && msgs.leading.length === 0 && msgs.after.length === 0 && <p className="muted">{t.noMessages}</p>}
          {msgs && msgs.leading.length > 0 && (
            <>
              <h4>{t.leadingHere}</h4>
              <MessageList msgs={msgs.leading} t={t} limit={4} />
            </>
          )}
          {msgs && msgs.after.length > 0 && (
            <>
              <h4>{t.afterHere}</h4>
              <MessageList msgs={msgs.after} t={t} limit={4} />
            </>
          )}
        </section>

        {n.verification?.checks?.length ? (
          <section className="p-sec">
            <h3>{t.checks}</h3>
            <ul className="checks">
              {n.verification.checks.map((c, i) => (
                <li key={i} className={`v-${c.status}`}>
                  <span className={`vdot v-${c.status}`} />
                  <span>
                    <strong>{c.name}</strong>
                    {c.detail ? <span className="muted"> — {c.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
            {n.verification.notes && <p className="rationale">{renderInline(n.verification.notes)}</p>}
          </section>
        ) : null}

        {ctx && (
          <section className="p-sec capsule">
            <h3>{t.capsule}</h3>
            <p>
              ≈ <strong>{fmtTokens(ctx.tokens)}</strong> {t.tokens}
              {transcriptTokens ? (
                <span className="muted">
                  {" "}
                  · {t.transcript} ≈ {fmtTokens(transcriptTokens)} {t.tokens} (−{Math.max(0, Math.round((1 - ctx.tokens / transcriptTokens) * 100))} %)
                </span>
              ) : null}
            </p>
          </section>
        )}

        <section className="p-sec verdict">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t.notesPlaceholder} rows={2} />
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => verify({ auto: true })}>
              {t.runChecks}
            </button>
            <button className="btn ok" disabled={busy} onClick={() => verify({ status: "passed", notes })}>
              {t.looksRight}
            </button>
            <button className="btn bad" disabled={busy} onClick={() => verify({ status: "failed", notes })}>
              {t.problem}
            </button>
          </div>
        </section>
      </div>

      <div className="p-actions">
        <button className="btn primary" onClick={() => props.onRewind(n)} disabled={n.id === props.headId && !n.snapshot}>
          {t.rewind}
        </button>
        <button
          className="btn"
          onClick={async () => {
            const c = ctx ?? (await api.context(n.id));
            try {
              await navigator.clipboard.writeText(c.markdown);
              props.toast(t.copied);
            } catch {
              props.toast(c.markdown.slice(0, 120) + "…");
            }
          }}
        >
          {t.copyContext}
        </button>
        {n.parentId && (
          <button className="btn" onClick={() => props.onDiff(n.parentId!, n.id)}>
            {t.compare}
          </button>
        )}
      </div>
    </aside>
  );
}
