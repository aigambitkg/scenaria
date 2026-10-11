/**
 * The person's Scenaria projects on this machine (global config, outside every project): every project
 * that was opened with the dashboard, the MCP server or `scenaria init` is remembered, so the
 * dashboard can switch between them and the analyst can look across all of them.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { readGlobalConfig, writeGlobalConfig } from "./global.js";

export interface KnownProject {
  root: string;
  name: string;
  lastSeen: string;
}

function real(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Known projects that still exist (a project folder with .scenaria/config.json). */
export function listProjects(): KnownProject[] {
  const all = readGlobalConfig().projects ?? [];
  return all
    .filter((p) => p && typeof p.root === "string" && existsSync(join(p.root, ".scenaria", "config.json")))
    .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""));
}

/** Remember a project (best effort; never throws). */
export function registerProject(root: string, name?: string) {
  try {
    const r = real(root);
    if (!existsSync(join(r, ".scenaria", "config.json"))) return;
    const g = readGlobalConfig();
    const list = (g.projects ?? []).filter((p) => real(p.root) !== r);
    const now = new Date().toISOString();
    const prev = (g.projects ?? []).find((p) => real(p.root) === r);
    // Write at most once per hour per project (the MCP server opens projects often).
    if (prev && Date.now() - Date.parse(prev.lastSeen) < 3_600_000 && prev.name === (name ?? prev.name)) return;
    g.projects = [{ root: r, name: name ?? prev?.name ?? basename(r), lastSeen: now }, ...list].slice(0, 100);
    writeGlobalConfig(g);
  } catch {
    /* best effort */
  }
}

/** Forget a project (does not touch its files). */
export function forgetProject(root: string) {
  const g = readGlobalConfig();
  const r = real(root);
  g.projects = (g.projects ?? []).filter((p) => real(p.root) !== r);
  writeGlobalConfig(g);
}
