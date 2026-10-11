import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

/** User-level settings written by `scenaria setup --global` (~/.config/scenaria/config.json). */
export interface GlobalConfig {
  /** Initialize Scenaria automatically the first time an agent works in a project. */
  autoInit: boolean;
  setupAt?: string;
  targets?: string[];
}

/**
 * Deliberately NOT ~/.scenaria/: a `.scenaria/config.json` marks a project root,
 * so the global settings must never live at that path.
 */
export function globalConfigPath() {
  const base = process.env.SCENARIA_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "scenaria");
  return join(base, "config.json");
}

export function readGlobalConfig(): GlobalConfig {
  try {
    return { autoInit: false, ...JSON.parse(readFileSync(globalConfigPath(), "utf8")) };
  } catch {
    // Legacy location of v0.3 pre-releases (~/.scenaria/config.json with autoInit, not a project).
    try {
      const legacy = JSON.parse(readFileSync(join(homedir(), ".scenaria", "config.json"), "utf8"));
      if (typeof legacy.autoInit === "boolean") return { autoInit: legacy.autoInit, setupAt: legacy.setupAt, targets: legacy.targets };
    } catch {}
    return { autoInit: false };
  }
}

export function writeGlobalConfig(c: GlobalConfig) {
  const f = globalConfigPath();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
}

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "composer.json",
  "Gemfile",
  "deno.json",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
];

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Home, filesystem roots and dot-folders directly in home (~/.codex, ~/.ssh, ~/.config …) are never projects. */
export function isForbiddenRoot(dir: string): boolean {
  if (!dir || dir.includes("${")) return true;
  const abs = real(dir);
  const home = real(homedir());
  if (abs === home || abs === parse(abs).root) return true;
  const rel = abs.startsWith(home + "/") || abs.startsWith(home + "\\") ? abs.slice(home.length + 1) : null;
  if (rel !== null && rel.startsWith(".")) return true;
  return false;
}

/**
 * Is `dir` a reasonable place to create .scenaria/ automatically?
 * Never the home folder, a filesystem root, or an unresolved template like ${workspaceFolder}.
 */
export function isPlausibleProject(dir: string): boolean {
  if (isForbiddenRoot(dir)) return false;
  const abs = real(dir);
  if (!existsSync(abs)) return false;
  return PROJECT_MARKERS.some((m) => existsSync(join(abs, m)));
}
