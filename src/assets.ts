/**
 * Asset access that works both from the npm package (files on disk) and from the
 * single-file binary (assets embedded at build time into globalThis).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare global {
  // eslint-disable-next-line no-var
  var __SCENARIA_EMBEDDED__: { ui: Record<string, string>; templates: Record<string, string> } | undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = join(here, "cli.js");
const TEMPLATES_DIR = join(here, "..", "templates");
export const UI_DIR = join(here, "ui");

/** True when running as the standalone binary (no Node, no node_modules). */
export function isStandalone(): boolean {
  return Boolean(globalThis.__SCENARIA_EMBEDDED__);
}

/** How other programs (agents, hooks) start Scenaria: [command, ...baseArgs]. */
export function selfInvocation(): string[] {
  return isStandalone() ? [process.execPath] : [process.execPath, CLI_PATH];
}

export function readTemplate(rel: string): string {
  const emb = globalThis.__SCENARIA_EMBEDDED__?.templates[rel];
  if (emb !== undefined) return emb;
  return readFileSync(join(TEMPLATES_DIR, rel), "utf8");
}

export function hasDiskUi(): boolean {
  return existsSync(join(UI_DIR, "index.html"));
}

/** Embedded dashboard file (path relative to the UI root, e.g. "index.html"). */
export function embeddedUi(rel: string): Buffer | null {
  const b64 = globalThis.__SCENARIA_EMBEDDED__?.ui[rel];
  return b64 === undefined ? null : Buffer.from(b64, "base64");
}
