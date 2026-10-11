/**
 * v0.7 — control surfaces: Settings (models, keys, agents), the built-in chat, the relay dialog
 * and the canon gate per line of work.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AgentStatus, type ChatMessage, type ChatToolCall, type GateMatrix, type LlmChoice, type LlmRole, type RelayReport, type SettingsPage } from "./api";
import { Modal } from "./Dialogs";
import { NodeId } from "./Map";
import type { Dict } from "./i18n";

export const PROVIDERS = ["ollama", "lmstudio", "openai", "anthropic", "gemini", "mistral", "openrouter", "groq", "custom"];
const MODEL_HINT: Record<string, string> = {
  ollama: "llama3.3",
  lmstudio: "local-model",
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-5-5",
  gemini: "gemini-2.5-flash",
  mistral: "mistral-large-latest",
  openrouter: "meta-llama/llama-3.3-70b-instruct",
  groq: "llama-3.3-70b-versatile",
  custom: "model name",
};
const LOCAL = new Set(["ollama", "lmstudio"]);
const ROLES: LlmRole[] = ["chat", "analysis", "archivist", "craftsman", "oracle"];

/** API keys entered in the browser: memory only, gone with the tab. */
export type SessionKeys = Record<string, string>;

const errText = (e: any) => String(e?.message ?? e);

/** Turn "n12", "k3" in text into clickable references. */
export function Linkified({ text, onNode }: { text: string; onNode: (id: string) => void }) {
  const parts = text.split(/\b(n\d+)\b/g);
  return (
    <>
      {parts.map((p, i) =>
        /^n\d+$/.test(p) ? (
          <button key={i} className="btn link inline" onClick={() => onNode(p)}>
            <NodeId id={p} />
          </button>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/** Elapsed time while the model works (local models can take a while). */
function Thinking({ label }: { label: string }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setSec(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="muted thinking">
      {label} {sec > 0 ? `${sec} s` : ""}
    </p>
  );
}

/** Inline markdown: **bold**, *italic*, `code`, node references. Rendered as React elements (no HTML). */
function Inline({ text, onNode }: { text: string; onNode: (id: string) => void }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\*\*[^*]+\*\*$/.test(p) ? (
          <strong key={i}>
            <Linkified text={p.slice(2, -2)} onNode={onNode} />
          </strong>
        ) : /^`[^`]+`$/.test(p) ? (
          <code key={i}>{p.slice(1, -1)}</code>
        ) : /^\*[^*\s][^*]*\*$/.test(p) ? (
          <em key={i}>
            <Linkified text={p.slice(1, -1)} onNode={onNode} />
          </em>
        ) : (
          <Linkified key={i} text={p} onNode={onNode} />
        ),
      )}
    </>
  );
}

/** Small, safe markdown for chat answers: headings, lists, code blocks, paragraphs. */
export function Markdown({ text, onNode }: { text: string; onNode: (id: string) => void }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={key++} className="md-code">{code.join("\n")}</pre>);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push(
        <p key={key++} className={`md-h md-h${Math.min(h[1].length, 3)}`}>
          <Inline text={h[2]} onNode={onNode} />
        </p>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      const children = items.map((it, k) => (
        <li key={k}>
          <Inline text={it} onNode={onNode} />
        </li>
      ));
      blocks.push(ordered ? <ol key={key++}>{children}</ol> : <ul key={key++}>{children}</ul>);
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      blocks.push(<hr key={key++} />);
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*([-*•]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(
      <p key={key++}>
        <Inline text={para.join("\n")} onNode={onNode} />
      </p>,
    );
  }
  return <div className="md">{blocks}</div>;
}

// ------------------------------------------------------------------ model picker

function ModelPicker(props: {
  t: Dict;
  value: LlmChoice | undefined;
  onChange: (v: LlmChoice | undefined) => void;
  keys: SessionKeys;
  onKey: (provider: string, key: string) => void;
  envKeys: Record<string, string[]>;
  teamMode: boolean;
  allowDefault?: boolean;
  toast: (m: string) => void;
}) {
  const { t, value } = props;
  const provider = value?.provider ?? "";
  const known = PROVIDERS.includes(provider) ? provider : provider ? "custom" : "";
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(Boolean(value?.baseUrl));
  const listId = useMemo(() => `models-${Math.random().toString(36).slice(2)}`, []);
  const set = (patch: Partial<LlmChoice>) => props.onChange({ provider: provider || "ollama", model: value?.model ?? "", ...value, ...patch });
  const call = () => ({ provider: provider === "custom" ? "custom" : provider, model: value?.model || MODEL_HINT[known || "custom"], baseUrl: value?.baseUrl || undefined, apiKey: props.keys[provider] || undefined });
  const env = props.envKeys[provider];
  return (
    <div className="picker">
      <div className="llm-form">
        <label>
          <span>{props.t.provider}</span>
          <select
            value={known}
            onChange={(e) => {
              const p = e.target.value;
              setModels([]);
              if (!p) props.onChange(undefined);
              else props.onChange({ provider: p === "custom" ? "custom" : p, model: "", ...(p === "custom" ? { baseUrl: value?.baseUrl ?? "" } : {}) });
              if (p === "custom") setAdvanced(true);
            }}
          >
            {props.allowDefault && <option value="">{props.t.useDefault}</option>}
            {!props.allowDefault && !known && <option value="">—</option>}
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p === "custom" ? props.t.customProvider : p}
              </option>
            ))}
          </select>
        </label>
        {known && (
          <label>
            <span>{props.t.modelLabel}</span>
            <input list={listId} value={value?.model ?? ""} placeholder={MODEL_HINT[known]} onChange={(e) => set({ model: e.target.value })} />
            <datalist id={listId}>
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
        )}
        {known && advanced && !props.teamMode && (
          <label className="wide">
            <span>{props.t.baseUrl}</span>
            <input value={value?.baseUrl ?? ""} placeholder="http://127.0.0.1:11434/v1" onChange={(e) => set({ baseUrl: e.target.value || undefined })} />
          </label>
        )}
        {known && !LOCAL.has(known) && (
          <label className="wide">
            <span>
              {props.t.keySession}
              {env ? <em className="keyok"> · ✓ {props.t.keyFromEnv}: {env.join(", ")}</em> : <em className="muted"> · {props.t.keyNone}</em>}
            </span>
            <input type="password" autoComplete="off" value={props.keys[provider] ?? ""} placeholder={env ? props.t.keyFromEnv : "sk-…"} onChange={(e) => props.onKey(provider, e.target.value)} />
          </label>
        )}
      </div>
      {known && (
        <div className="row">
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={async () => {
              setBusy("models");
              setErr(null);
              try {
                const r = await api.models({ provider: call().provider, baseUrl: call().baseUrl, apiKey: call().apiKey });
                setModels(r.models);
                props.toast(`${r.models.length} ${props.t.modelLabel}`);
              } catch (e) {
                setErr(errText(e));
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "models" ? props.t.running : props.t.loadModels}
          </button>
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={async () => {
              setBusy("test");
              setErr(null);
              try {
                const r = await api.testLlm(call());
                props.toast(`${props.t.testOk}: ${r.model} · ${r.ms} ms`);
              } catch (e) {
                setErr(errText(e));
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "test" ? props.t.running : props.t.testConnection}
          </button>
          {!props.teamMode && known !== "custom" && (
            <button className="btn link" onClick={() => setAdvanced(!advanced)}>
              {props.t.baseUrl}
            </button>
          )}
          {LOCAL.has(known) && <span className="muted small">{props.t.keyLocalNone}</span>}
        </div>
      )}
      {err && <p className="error small">{err}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ settings

function Copyable({ t, text, toast, block }: { t: Dict; text: string; toast: (m: string) => void; block?: boolean }) {
  return (
    <div className={`copyable ${block ? "block" : ""}`}>
      {block ? <pre>{text}</pre> : <code>{text}</code>}
      <button
        className="btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            toast(t.copiedShort);
          } catch {
            /* clipboard not available */
          }
        }}
      >
        {t.copy}
      </button>
    </div>
  );
}

export function SettingsDialog(props: { t: Dict; keys: SessionKeys; onKey: (provider: string, key: string) => void; toast: (m: string) => void; onClose: () => void; onSaved: () => void }) {
  const { t } = props;
  const [page, setPage] = useState<SettingsPage | null>(null);
  const [def, setDef] = useState<LlmChoice | undefined>();
  const [roles, setRoles] = useState<Partial<Record<LlmRole, LlmChoice>>>({});
  const [trusted, setTrusted] = useState("");
  const [chat, setChat] = useState({ confirmDestructive: true, maxSteps: 10 });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const p = await api.settings();
    setPage(p);
    setDef(p.llm.default ?? p.effective.chat ?? undefined);
    setRoles(p.llm.roles ?? {});
    setTrusted(p.trustedEndpoints.join("\n"));
    setChat(p.chat);
  };
  useEffect(() => {
    load().catch((e) => setErr(errText(e)));
  }, []);
  const locked = !page?.approval || Boolean(busy);

  const save = async () => {
    setBusy("save");
    setErr(null);
    try {
      const clean = (c?: LlmChoice) => (c && c.provider && c.model ? { provider: c.provider, model: c.model, ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}) } : undefined);
      const rolePatch: Partial<Record<LlmRole, LlmChoice>> = {};
      for (const r of ROLES) {
        const c = clean(roles[r]);
        if (c) rolePatch[r] = c;
      }
      await api.saveSettings({
        llm: { default: clean(def), roles: rolePatch },
        chat,
        ...(page?.teamMode ? {} : { trustedEndpoints: trusted.split("\n").map((x) => x.trim()).filter(Boolean) }),
      });
      await load();
      props.toast(t.settingsSaved);
      props.onSaved();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const connect = async (a: AgentStatus) => {
    setBusy(a.target);
    setErr(null);
    try {
      const r = await api.connectAgents([a.target]);
      setPage((p) => (p ? { ...p, agents: r.agents } : p));
      [...r.changes, ...r.notes].slice(0, 3).forEach((m) => props.toast(m));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal wide title={t.settingsTitle} onClose={props.onClose}>
      <div className="modal-body analysis settings">
        {page && !page.approval && <p className="qnote q-warn">🔒 {t.settingsLocked}</p>}
        {err && <p className="error">{err}</p>}
        {page && (
          <>
            <section className="a-sec">
              <h3>{t.modelSection}</h3>
              <p className="hint">{t.modelSectionHint}</p>
              <ModelPicker t={t} value={def} onChange={setDef} keys={props.keys} onKey={props.onKey} envKeys={page.envKeys} teamMode={page.teamMode} toast={props.toast} />
              <details className="roles">
                <summary>{t.rolesSection}</summary>
                {ROLES.map((r) => (
                  <div key={r} className="role-row">
                    <h4>{t.roleNames[r]}</h4>
                    <ModelPicker t={t} allowDefault value={roles[r]} onChange={(v) => setRoles({ ...roles, [r]: v })} keys={props.keys} onKey={props.onKey} envKeys={page.envKeys} teamMode={page.teamMode} toast={props.toast} />
                  </div>
                ))}
              </details>
            </section>

            <section className="a-sec">
              <h3>{t.chatBehaviour}</h3>
              <label className="check">
                <input type="checkbox" checked={chat.confirmDestructive} onChange={(e) => setChat({ ...chat, confirmDestructive: e.target.checked })} />
                <span>{t.confirmDestructive}</span>
              </label>
              <label className="check">
                <span>{t.maxSteps}</span>
                <input className="num" type="number" min={1} max={30} value={chat.maxSteps} onChange={(e) => setChat({ ...chat, maxSteps: Number(e.target.value) || 10 })} />
              </label>
            </section>

            <section className="a-sec">
              <h3>{t.agentsSection}</h3>
              <p className="hint">{t.agentsHint}</p>
              <table className="agents">
                <tbody>
                  {page.agents.map((a) => (
                    <tr key={a.target}>
                      <td>
                        <strong>{a.target === "generic" ? t.agentGeneric : a.label}</strong>
                        <div className="muted small">{a.where}</div>
                      </td>
                      <td>{a.detected && a.target !== "generic" ? <span className="chip">{t.agentInstalled}</span> : null}</td>
                      <td>{a.connected ? <span className="chip v-passed">✓ {t.agentConnected}</span> : <span className="muted small">{t.agentNotConnected}</span>}</td>
                      <td className="right">
                        {a.target !== "windsurf" && (
                          <button className="btn" disabled={locked} onClick={() => connect(a)}>
                            {busy === a.target ? t.running : t.connect}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4>{t.ownAgent}</h4>
              <p className="hint">{t.ownAgentHint}</p>
              <Copyable t={t} text={page.snippets.mcpJson} toast={props.toast} block />
              {page.snippets.http && <Copyable t={t} text={page.snippets.http.tools} toast={props.toast} />}
              {page.snippets.proxy && Object.values(page.snippets.proxy).map((u) => <Copyable key={u} t={t} text={u} toast={props.toast} />)}
            </section>

            {!page.teamMode && (
              <section className="a-sec">
                <h3>{t.trustedSection}</h3>
                <p className="hint">{t.trustedHint}</p>
                <textarea className="trusted" rows={3} value={trusted} placeholder="https://llm-proxy.example.com/v1" onChange={(e) => setTrusted(e.target.value)} />
              </section>
            )}

            <div className="row sticky-save">
              <button className="btn primary" disabled={locked} onClick={save}>
                {busy === "save" ? t.running : t.saveSettings}
              </button>
              <span className="muted small">Scenaria {page.version}</span>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ chat

const STORE_KEY = "scenaria.chat.v1";
function loadChat(): { sessionId: string; messages: ChatMessage[] } | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveChat(v: { sessionId: string; messages: ChatMessage[] }) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(v));
  } catch {
    /* storage may be unavailable */
  }
}
const newSession = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** What a pending call will do: the target fields in full, the rest shortened. */
function PendingArgs({ c }: { c: ChatToolCall }) {
  const a = (c.args ?? {}) as Record<string, unknown>;
  const key = ["id", "decisionId", "option", "restoreFiles"];
  const rest = Object.fromEntries(Object.entries(a).filter(([k]) => !key.includes(k)));
  const restText = JSON.stringify(rest);
  return (
    <span className="pending-args">
      {key
        .filter((k) => a[k] !== undefined)
        .map((k) => (
          <span key={k} className="chip">
            {k}: {String(a[k])}
          </span>
        ))}
      {restText !== "{}" && <span className="muted small">{restText.length > 160 ? `${restText.slice(0, 160)}…` : restText}</span>}
    </span>
  );
}

export function ChatPanel(props: { t: Dict; lang: "de" | "en"; keys: SessionKeys; toast: (m: string) => void; onNode: (id: string) => void; onChanged: () => void; onOpenSettings: () => void; onOpenRelay: () => void }) {
  const { t } = props;
  const saved = useMemo(loadChat, []);
  const [sessionId, setSessionId] = useState(saved?.sessionId ?? newSession());
  const [messages, setMessages] = useState<ChatMessage[]>(saved?.messages ?? []);
  const [pending, setPending] = useState<ChatToolCall[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [model, setModel] = useState<{ provider: string; model: string } | null | undefined>(undefined);
  const [approval, setApproval] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setModel(s.effective.chat);
        setApproval(s.approval);
      })
      .catch(() => setModel(null));
  }, []);
  useEffect(() => saveChat({ sessionId, messages }), [sessionId, messages]);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [messages, pending, busy]);

  const llm = () => (model && props.keys[model.provider] ? { apiKey: props.keys[model.provider] } : undefined);

  const run = async (msgs: ChatMessage[], decisions?: Record<string, "approve" | "deny">) => {
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      // Structured tool data stays in the browser; the server only needs the text.
      const lean = msgs.map(({ data, ...m }) => m);
      const r = await api.chat({ sessionId, messages: lean, decisions, llm: llm(), lang: props.lang });
      // Keep the dashboard data of earlier tool results (the server returns the text history).
      const before = new Map(msgs.filter((m) => m.role === "tool" && m.toolCallId).map((m) => [m.toolCallId!, m.data]));
      r.messages = r.messages.map((m) => (m.role === "tool" && m.data === undefined && before.has(m.toolCallId!) ? { ...m, data: before.get(m.toolCallId!) } : m));
      setMessages(r.messages);
      setPending(r.pending);
      if (r.stopped) setNotice(t.chatMaxSteps);
      props.onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    const msgs = [...messages, { role: "user" as const, content: text }];
    setMessages(msgs);
    setInput("");
    run(msgs);
  };

  const decideAll = (answer: "approve" | "deny") => run(messages, Object.fromEntries(pending.map((c) => [c.id, answer])));

  const toolCard = (m: ChatMessage, i: number) => {
    const data: any = m.data;
    const canonProposal = m.toolName === "scenaria_canon" && data && data.status === "proposed" && data.id;
    const relay = m.toolName === "scenaria_relay" && data && Array.isArray(data?.craftsman?.options) ? (data as RelayReport) : null;
    return (
      <Fragment key={i}>
        <details className={`tool ${m.ok === false ? "bad" : ""}`}>
          <summary>
            <span className="tool-name">{m.toolName?.replace(/^scenaria_/, "") ?? "tool"}</span> <span className="muted">· {m.ok === false ? t.chatToolErr : t.chatToolOk}</span>
          </summary>
          {relay ? <RelayView t={t} r={relay} onNode={props.onNode} /> : <pre>{m.content}</pre>}
        </details>
        {canonProposal && (
          <div className="canon-item chat-canon">
            <div className="canon-main">
              <span className="canon-id">{data.id}</span>
              <span className={`chip ${data.kind === "past" ? "k-past" : "k-future"}`}>{t.canonKinds[data.kind as "past" | "future"] ?? data.kind}</span>
              <span className="chip">{data.hard ? t.canonHard : t.canonSoft}</span>
            </div>
            <p>{String(data.text ?? "")}</p>
            {data.suggestedCheck && (
              <p className="small muted">
                {t.canonSuggestedCheck}: <code className="cmd">{String(data.suggestedCheck)}</code>
              </p>
            )}
            <button
              className="btn ok"
              disabled={!approval}
              onClick={async () => {
                try {
                  await api.decideCanon(data.id, "approve");
                  props.toast(`${data.id} ✓`);
                  props.onChanged();
                } catch (x) {
                  setErr(errText(x));
                }
              }}
            >
              {t.chatApproveCanon}
            </button>
          </div>
        )}
      </Fragment>
    );
  };

  return (
    <div className="chat">
      <div className="chat-head">
        <div>
          <strong>{t.chatTitle}</strong>
          <span className="muted small">{model ? ` · ${model.provider}/${model.model}` : model === null ? "" : " …"}</span>
        </div>
        <div className="row">
          <button className="btn" onClick={props.onOpenRelay} title={t.relayHint}>
            {t.relay}
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              setMessages([]);
              setPending([]);
              setSessionId(newSession());
              setErr(null);
            }}
          >
            {t.chatNew}
          </button>
        </div>
      </div>
      <div className="chat-log">
        {!approval && <p className="qnote q-warn">🔒 {t.settingsLocked}</p>}
        {approval && model === null && (
          <p className="qnote q-warn">
            {t.chatNoModel}{" "}
            <button className="btn link" onClick={props.onOpenSettings}>
              {t.settings}
            </button>
          </p>
        )}
        {!messages.length && <p className="hint">{t.chatHint}</p>}
        {messages.map((m, i) =>
          m.role === "tool" ? (
            toolCard(m, i)
          ) : m.role === "user" ? (
            <div key={i} className="bubble user">
              {m.content}
            </div>
          ) : m.content ? (
            <div key={i} className="bubble assistant">
              <Markdown text={m.content} onNode={props.onNode} />
            </div>
          ) : null,
        )}
        {pending.length > 0 && !busy && (
          <div className="pending">
            <strong>{t.chatPendingTitle}:</strong>
            <ul>
              {pending.map((c) => (
                <li key={c.id}>
                  {c.summary ? <span className="pending-summary">{c.summary}</span> : null}
                  <div>
                    <code>{c.name.replace(/^scenaria_/, "")}</code> <PendingArgs c={c} />
                  </div>
                </li>
              ))}
            </ul>
            <div className="row">
              <button className="btn primary" onClick={() => decideAll("approve")}>
                {t.chatAllow}
              </button>
              <button className="btn" onClick={() => decideAll("deny")}>
                {t.chatDeny}
              </button>
            </div>
          </div>
        )}
        {busy && <Thinking label={t.chatThinking} />}
        {notice && <p className="qnote q-info">{notice}</p>}
        {err && <p className="error">{err}</p>}
        <div ref={end} />
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          rows={3}
          value={input}
          placeholder={t.chatPlaceholder}
          disabled={!approval}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn primary" type="submit" disabled={busy || !input.trim() || !approval || pending.length > 0}>
          {t.chatSend}
        </button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ relay

export function RelayView({ t, r, onNode }: { t: Dict; r: RelayReport; onNode: (id: string) => void }) {
  return (
    <div className="relay-view">
      <div className="relay-cols">
        <div>
          <h4>{t.relayArchivist}</h4>
          <ul>
            {r.archivist.constraints.map((c, i) => (
              <li key={i}>
                {c.hard && <span className="chip">hard</span>} {c.text} {c.refs.length ? <span className="muted small">({c.refs.join(", ")})</span> : null}
              </li>
            ))}
            {!r.archivist.constraints.length && <li className="muted">—</li>}
          </ul>
        </div>
        <div className="wide">
          <h4>
            {t.relayCraftsman} → {t.relayOracle}
          </h4>
          <ul className="relay-options">
            {r.craftsman.options.map((o) => {
              const a = r.oracle.assessments.find((x) => x.option === o.label);
              const ok = r.surviving.includes(o.label);
              const rec = r.oracle.recommendation?.option === o.label;
              return (
                <li key={o.label} className={ok ? "ok" : "cut"}>
                  <div className="canon-main">
                    <strong>{o.label}</strong>
                    <span className={`chip ${ok ? "v-passed" : "v-failed"}`}>{ok ? t.relaySurvives : t.relayCut}</span>
                    {rec && <span className="chip mark">★ {t.relayRecommends}</span>}
                    {[...o.breaks, ...(a?.failsOn ?? [])].length > 0 && <span className="muted small">✘ {[...new Set([...o.breaks, ...(a?.failsOn ?? [])])].join(", ")}</span>}
                  </div>
                  <p className="small">{o.plan}</p>
                  {a?.risks.length ? <p className="small muted">⚠ {a.risks.join(" · ")}</p> : null}
                </li>
              );
            })}
          </ul>
          {r.oracle.recommendation && (
            <p className="small">
              <strong>{t.relayRecommends}:</strong> {r.oracle.recommendation.option} — {r.oracle.recommendation.why}
            </p>
          )}
        </div>
      </div>
      {r.warnings.map((w, i) => (
        <p key={i} className="qnote q-warn">
          {w}
        </p>
      ))}
      {r.decisionId && (
        <p className="small">
          {t.relayOpenDecision}:{" "}
          <button className="btn link" onClick={() => onNode(r.decisionId!)}>
            <NodeId id={r.decisionId} />
          </button>
        </p>
      )}
      <p className="muted small">{Object.entries(r.models).map(([k, v]) => `${t.roleNames[k as LlmRole] ?? k}: ${v}`).join(" · ")}</p>
    </div>
  );
}

export function RelayDialog(props: { t: Dict; lang: "de" | "en"; keys: SessionKeys; toast: (m: string) => void; onClose: () => void; onNode: (id: string) => void; onChanged: () => void }) {
  const { t } = props;
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState("");
  const [create, setCreate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [report, setReport] = useState<RelayReport | null>(null);
  const [history, setHistory] = useState<RelayReport[]>([]);
  const [approval, setApproval] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  useEffect(() => {
    api.relays().then(setHistory).catch(() => {});
    api
      .settings()
      .then((s) => {
        setApproval(s.approval);
        setProvider(s.effective.craftsman?.provider ?? null);
      })
      .catch(() => {});
  }, []);
  return (
    <Modal wide title={t.relayTitle} onClose={props.onClose}>
      <div className="modal-body analysis">
        <p className="hint">{t.relayHint}</p>
        {!approval && <p className="qnote q-warn">🔒 {t.settingsLocked}</p>}
        <form
          className="relay-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (question.trim().length < 5 || busy) return;
            setBusy(true);
            setErr(null);
            try {
              const r = await api.relay({ question, options: options.split("\n").map((x) => x.trim()).filter(Boolean), createDecision: create, lang: props.lang, llm: provider && props.keys[provider] ? { apiKey: props.keys[provider] } : undefined });
              setReport(r);
              setHistory((h) => [r, ...h]);
              props.onChanged();
            } catch (x) {
              setErr(errText(x));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            <span>{t.relayQuestion}</span>
            <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="z. B. Welche Datenbank für das Backend?" />
          </label>
          <label>
            <span>{t.relayOptions}</span>
            <textarea rows={3} value={options} onChange={(e) => setOptions(e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={create} onChange={(e) => setCreate(e.target.checked)} />
            <span>{t.relayCreate}</span>
          </label>
          <div className="row">
            <button className="btn primary" type="submit" disabled={busy || !approval || question.trim().length < 5}>
              {busy ? t.running : t.relayRun}
            </button>
          </div>
        </form>
        {err && <p className="error">{err}</p>}
        {report && (
          <section className="a-sec">
            <h3>{report.question}</h3>
            <RelayView t={t} r={report} onNode={props.onNode} />
          </section>
        )}
        {history.filter((h) => h.id !== report?.id).length > 0 && (
          <section className="a-sec">
            <h3>{t.relayHistory}</h3>
            <ul>
              {history
                .filter((h) => h.id !== report?.id)
                .slice(0, 12)
                .map((h) => (
                  <li key={h.id}>
                    <button className="btn link" onClick={() => setReport(h)}>
                      {h.id}
                    </button>{" "}
                    {h.question} <span className="muted small">· {new Date(h.createdAt).toLocaleString()}</span>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ gate (inside the canon dialog)

export function GateSection(props: { t: Dict; locked: boolean; toast: (m: string) => void; onNode: (id: string) => void; onChanged: () => void; reloadKey?: unknown }) {
  const { t } = props;
  const [m, setM] = useState<GateMatrix | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.gate().then(setM).catch((e) => setErr(errText(e)));
  }, [props.reloadKey]);
  if (!m) return err ? <p className="error">{err}</p> : null;
  const icon = (s: string) => (s === "passed" ? "✓" : s === "failed" ? "✘" : "·");
  return (
    <section className="a-sec">
      <h3>
        {t.gateTitle} <span className="count">{m.rows.length}</span>
        <button
          className="btn"
          disabled={props.locked || busy || !m.events.length}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await api.runGate();
              setM(r);
              props.toast(`${r.rows.filter((x) => x.verdict === "valid").length}/${r.rows.length} ✓`);
              props.onChanged();
            } catch (e) {
              setErr(errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t.running : t.gateRun}
        </button>
      </h3>
      <p className="hint">{t.gateHint}</p>
      {err && <p className="error">{err}</p>}
      {m.tampered.length > 0 && (
        <p className="qnote q-bad">
          ⛔ {t.gateTampered}: {m.tampered.join(", ")}
        </p>
      )}
      {!m.events.length ? (
        <p className="muted">{t.gateNoChecks}</p>
      ) : (
        <div className="gate-wrap">
          <table className="gate">
            <thead>
              <tr>
                <th>{t.gateLine}</th>
                {m.events.map((e) => (
                  <th key={e.id} title={`${e.text}\n${e.check ?? ""}`}>
                    {e.id}
                  </th>
                ))}
                <th>{t.gateVerdict}</th>
              </tr>
            </thead>
            <tbody>
              {m.rows.map((r) => (
                <tr key={r.head} className={r.current ? "current" : ""}>
                  <td>
                    <button className="btn link" onClick={() => props.onNode(r.head)}>
                      <NodeId id={r.head} />
                    </button>{" "}
                    <span className="small">{r.title}</span> <span className="muted small">{r.scenario}</span>
                  </td>
                  {r.cells.map((c) => (
                    <td key={c.event} className={`cell s-${c.status.replace(" ", "-")}`} title={c.detail ?? t.gateNotRun}>
                      {icon(c.status)}
                    </td>
                  ))}
                  <td title={r.reasons.join(" · ")}>
                    <span className={`chip v-${r.verdict === "valid" ? "passed" : r.verdict === "invalid" ? "failed" : "warning"}`}>{t.canonVerdicts[r.verdict]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="a-sec">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
