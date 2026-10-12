/**
 * What went wrong with a model call — as a code the dashboard turns into a plain-language reason and
 * a fix. Shared by the server and the dashboard (no imports, no Node APIs).
 */
export type LlmErrorCode = "no_model" | "unreachable" | "timeout" | "model_missing" | "auth" | "busy" | "bad_json" | "cancelled" | "approval" | "http" | "other";

export function llmErrorCode(message: string): LlmErrorCode {
  const m = message.toLowerCase();
  if (/kein modell eingestellt|no model configured|no model set/.test(m)) return "no_model";
  if (/abgebrochen|cancelled by the person/.test(m)) return "cancelled";
  if (/approval_required|approval link|freigabe-link/.test(m)) return "approval";
  if (/läuft gerade|already running/.test(m)) return "busy";
  if (/not reachable|econnrefused|fetch failed|enotfound|eai_again|ehostunreach|socket hang up/.test(m)) return "unreachable";
  if (/did not answer within|timed out|timeout/.test(m)) return "timeout";
  if (/http 404/.test(m) && /model|not found|pull/.test(m)) return "model_missing";
  if (/http 401|http 403|api key|api_key|invalid.{0,20}key|unauthori[sz]ed|authentication/.test(m)) return "auth";
  if (/keine brauchbare antwort|no usable answer|not valid json|kein gültiges json|expected json/.test(m)) return "bad_json";
  if (/http \d{3}/.test(m)) return "http";
  return "other";
}

/** The model name in "model 'qwen3.5:9b' not found" (for the "ollama pull …" hint). */
export function missingModel(message: string): string | null {
  return message.match(/model ['"`]([^'"`]+)['"`]/i)?.[1] ?? null;
}

/** The provider at the start of our own messages ("ollama not reachable at …"). */
export function errorProvider(message: string): string | null {
  return message.match(/^(\w[\w-]*) (?:not reachable|did not answer|answered HTTP)/)?.[1] ?? null;
}
