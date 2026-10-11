import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * ULID: 26 chars, lexicographically sortable by creation time, globally unique.
 * Used as the stable id for nodes, messages and sessions (exports, merges, audits),
 * next to the short human ids (n7, m42, s2).
 */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return time + rand;
}

/** Human label for a version: scenario + step, e.g. "s2/v5". */
export function versionLabel(scenarioId?: string, version?: number): string | undefined {
  if (!scenarioId || version === undefined) return undefined;
  return `${scenarioId}/v${version}`;
}

export function slugify(s: string, max = 40): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "node"
  );
}
