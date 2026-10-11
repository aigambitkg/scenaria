/**
 * The person's settings for models and agents (dashboard → Settings).
 *
 * Model choices live in the global config (~/.config/scenaria/config.json), outside every project:
 * one default model plus an optional model per function. API keys are NEVER stored: they come from
 * environment variables (sent only to official or trusted endpoints) or are entered for one session
 * in the browser.
 */
import { DEFAULT_PROXY, type Scenaria } from "./engine.js";
import { readGlobalConfig, writeGlobalConfig, type LlmChoice, type LlmSettings } from "./global.js";
import { envKeyAllowed, type LlmRequest } from "./analysis.js";

export type LlmRole = "chat" | "analysis" | "archivist" | "craftsman" | "oracle";
export const LLM_ROLES: LlmRole[] = ["chat", "analysis", "archivist", "craftsman", "oracle"];

export const KEY_ENVS: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  azure: ["AZURE_OPENAI_API_KEY"],
};

export function upstreams(s: Scenaria): Record<string, string> {
  return { ...DEFAULT_PROXY.upstreams, ...(s.config().proxy?.upstreams ?? {}) } as Record<string, string>;
}

/** Which model does a function use? Role → default → the project's analysis setting. */
export function effectiveLlm(s: Scenaria, role: LlmRole, override?: Partial<LlmRequest>, opts: { globalOnly?: boolean } = {}): LlmRequest | null {
  const g = readGlobalConfig().llm ?? {};
  // globalOnly: only what the person chose in Settings (never the project file an agent can edit).
  const pick: LlmChoice | undefined = g.roles?.[role] ?? g.default ?? (!opts.globalOnly && s.config().analysis ? { ...s.config().analysis! } : undefined);
  if (override?.provider && override?.model) return { provider: override.provider, model: override.model, baseUrl: override.baseUrl, apiKey: override.apiKey };
  if (!pick) return null;
  // A session key goes only to the provider it was entered for.
  const key = override?.apiKey && (!override.keyFor || override.keyFor === pick.provider) ? override.apiKey : undefined;
  return { provider: pick.provider, model: pick.model, baseUrl: pick.baseUrl, apiKey: key };
}

function clean(c: any): LlmChoice | undefined {
  if (!c || typeof c !== "object" || !c.provider || !c.model) return undefined;
  const provider = String(c.provider).trim().toLowerCase().slice(0, 40);
  if (!/^[a-z0-9_-]+$/.test(provider)) throw new Error("provider must be a simple name (openai, anthropic, ollama, …)");
  const baseUrl = c.baseUrl ? String(c.baseUrl).trim().slice(0, 300) : undefined;
  if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error("base URL must start with http:// or https://");
  return { provider, model: String(c.model).trim().slice(0, 160), ...(baseUrl ? { baseUrl } : {}) };
}

export interface SettingsView {
  llm: LlmSettings;
  effective: Record<LlmRole, LlmChoice | null>;
  trustedEndpoints: string[];
  chat: { confirmDestructive: boolean; maxSteps: number };
  /** Automatic multiverse for open decisions: opt-in, with a daily limit. */
  forecast: { auto: boolean; dailyLimit: number };
  ui: { lang: "de" | "en" };
  /** Which providers have a key in the environment (names only, never values). */
  envKeys: Record<string, string[]>;
  upstreams: Record<string, string>;
}

export function readSettings(s: Scenaria): SettingsView {
  const g = readGlobalConfig();
  const effective = Object.fromEntries(
    LLM_ROLES.map((r) => {
      const e = effectiveLlm(s, r);
      return [r, e ? { provider: e.provider, model: e.model, baseUrl: e.baseUrl } : null];
    }),
  ) as Record<LlmRole, LlmChoice | null>;
  const envKeys: Record<string, string[]> = {};
  for (const [p, names] of Object.entries(KEY_ENVS)) {
    const found = names.filter((n) => Boolean(process.env[n]));
    if (found.length) envKeys[p] = found;
  }
  return {
    llm: g.llm ?? {},
    effective,
    trustedEndpoints: g.trustedEndpoints ?? [],
    chat: { confirmDestructive: g.chat?.confirmDestructive !== false, maxSteps: Math.min(30, Math.max(1, g.chat?.maxSteps ?? 10)) },
    forecast: { auto: g.forecast?.auto === true, dailyLimit: Math.min(200, Math.max(1, g.forecast?.dailyLimit ?? 20)) },
    ui: { lang: g.ui?.lang === "en" ? "en" : "de" },
    envKeys,
    upstreams: upstreams(s),
  };
}

/** A person's change (dashboard with approval session, or CLI). */
export function writeSettings(patch: { llm?: { default?: unknown; roles?: Record<string, unknown> }; trustedEndpoints?: unknown; chat?: { confirmDestructive?: unknown; maxSteps?: unknown }; forecast?: { auto?: unknown; dailyLimit?: unknown }; ui?: { lang?: unknown } }) {
  const g = readGlobalConfig();
  if (patch.llm) {
    const roles: LlmSettings["roles"] = {};
    for (const r of LLM_ROLES) {
      const c = clean(patch.llm.roles?.[r]);
      if (c) roles[r] = c;
    }
    g.llm = { default: clean(patch.llm.default), roles };
  }
  if (Array.isArray(patch.trustedEndpoints)) {
    g.trustedEndpoints = [...new Set(patch.trustedEndpoints.map((u) => String(u).trim().replace(/\/+$/, "")).filter((u) => /^https?:\/\/[^\s]+$/.test(u)))].slice(0, 20);
  }
  if (patch.chat) {
    g.chat = {
      confirmDestructive: patch.chat.confirmDestructive !== false,
      maxSteps: Math.min(30, Math.max(1, Number(patch.chat.maxSteps) || 10)),
    };
  }
  if (patch.forecast) g.forecast = { auto: patch.forecast.auto === true, dailyLimit: Math.min(200, Math.max(1, Number(patch.forecast.dailyLimit) || 20)) };
  if (patch.ui) g.ui = { lang: patch.ui.lang === "en" ? "en" : "de" };
  writeGlobalConfig(g);
  return g;
}

/** Ask a provider which models it offers (OpenAI-compatible /models or Anthropic /v1/models). */
export async function listModels(s: Scenaria, req: { provider: string; baseUrl?: string; apiKey?: string }): Promise<string[]> {
  const provider = req.provider.trim().toLowerCase();
  const ups = upstreams(s);
  const base = (req.baseUrl?.trim() || ups[provider] || (provider === "anthropic" ? "https://api.anthropic.com" : "")).replace(/\/+$/, "");
  if (!base) throw new Error(`Unknown provider "${provider}" — set a base URL`);
  const envName = (KEY_ENVS[provider] ?? []).find((n) => process.env[n]);
  const key = req.apiKey?.trim() || (envName && envKeyAllowed(provider, base) ? process.env[envName] : undefined);
  const anthropic = provider === "anthropic" || /anthropic\.com/.test(base);
  const url = anthropic ? `${base}${/\/v1$/.test(base) ? "" : "/v1"}/models?limit=100` : `${base}/models`;
  const headers: Record<string, string> = anthropic ? { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" } : key ? { authorization: `Bearer ${key}` } : {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const raw = await res.text();
    if (!res.ok) throw new Error(`${provider} answered HTTP ${res.status}: ${raw.slice(0, 200)}`);
    const json = JSON.parse(raw);
    const ids: string[] = (json.data ?? json.models ?? []).map((m: any) => String(m?.id ?? m?.name ?? "")).filter(Boolean);
    return [...new Set(ids)].sort().slice(0, 300);
  } catch (err: any) {
    if (ctrl.signal.aborted) throw new Error(`${provider} did not answer within 15 s`);
    if (err?.cause?.code === "ECONNREFUSED") throw new Error(`${provider} not reachable at ${base} (is it running?)`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
