/**
 * The person's Scenaria projects on this machine — remembered in their own file
 * (~/.config/scenaria/projects.json, written atomically; never inside a project and never mixed into
 * the settings file, so registering a project can never overwrite a setting).
 * Every project opened with the dashboard, the MCP server or `scenaria init` is remembered, so the
 * dashboard can switch between them and the analyst can look across all of them.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { globalConfigPath, readGlobalConfig } from "./global.js";
import { writeJsonAtomic } from "./store.js";

export interface KnownProject {
  root: string;
  name: string;
  lastSeen: string;
  /** false: the folder (or its .scenaria) is gone — shown, not silently dropped. */
  exists?: boolean;
}

/** The folder's real path (macOS: /var → /private/var, symlinks resolved); the path itself if it is gone. */
export function realRoot(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function personalDir() {
  return dirname(globalConfigPath());
}
const file = () => join(personalDir(), "projects.json");

function read(): KnownProject[] {
  try {
    const x = JSON.parse(readFileSync(file(), "utf8"));
    if (Array.isArray(x?.projects)) return x.projects.filter((p: any) => p && typeof p.root === "string" && typeof p.name === "string").map((p: any) => ({ root: p.root, name: p.name, lastSeen: String(p.lastSeen ?? "") }));
  } catch {
    /* missing or broken: fall back to the old place */
  }
  // Migration: v0.8 betas kept the list inside the global config.
  const old = readGlobalConfig().projects;
  return Array.isArray(old) ? old.filter((p) => p && typeof p.root === "string").map((p) => ({ root: p.root, name: String(p.name ?? basename(p.root)), lastSeen: String(p.lastSeen ?? "") })) : [];
}

function write(list: KnownProject[]) {
  writeJsonAtomic(file(), { version: 1, projects: list.map(({ root, name, lastSeen }) => ({ root, name, lastSeen })) });
}

const isProject = (root: string) => existsSync(join(root, ".scenaria", "config.json"));

/** Known projects, most recent first. Missing ones only with includeMissing (marked exists:false). */
export function listProjects(opts: { includeMissing?: boolean } = {}): KnownProject[] {
  return read()
    .map((p) => ({ ...p, exists: isProject(p.root) }))
    .filter((p) => opts.includeMissing || p.exists)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** Remember a project (best effort; never throws). */
export function registerProject(root: string, name?: string) {
  try {
    const r = realRoot(root);
    if (!isProject(r)) return;
    const all = read();
    const prev = all.find((p) => realRoot(p.root) === r);
    // Write at most once per hour per project (the MCP server opens projects often).
    if (prev && Date.now() - Date.parse(prev.lastSeen) < 3_600_000 && prev.name === (name ?? prev.name) && prev.root === r) return;
    const rest = all.filter((p) => realRoot(p.root) !== r);
    write([{ root: r, name: name ?? prev?.name ?? basename(r), lastSeen: new Date().toISOString() }, ...rest].slice(0, 100));
  } catch {
    /* best effort */
  }
}

/** Forget a project (does not touch its files). */
export function forgetProject(root: string) {
  const r = realRoot(root);
  write(read().filter((p) => realRoot(p.root) !== r && p.root !== root));
}
