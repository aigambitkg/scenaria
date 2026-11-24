/**
 * Starting other programs by name — safely on Windows.
 *
 * On Windows a program started by its bare name ("git") is looked for in the CURRENT FOLDER first, and only then on
 * the PATH. Scenaria's current folder is usually the project, which agents can write to: a file called `git.exe`
 * there would be started with the person's rights (security rule 13). So on Windows Scenaria finds the program
 * itself, on the PATH only, and starts it by its full path. On macOS and Linux a bare name is looked for on the
 * PATH only, so nothing changes there.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface FindOptions {
  platform?: NodeJS.Platform;
  /** The PATH to search (default: this process's). */
  pathVar?: string;
  /** Endings to try on Windows, in this order. `.cmd`/`.bat` files only start through the shell. */
  exts?: readonly string[];
  exists?: (file: string) => boolean;
}

/**
 * The full path of `name` on the PATH, or null. Only folders named by a full path count: an empty or relative
 * PATH entry means "the current folder", which is exactly the place that must not decide.
 */
export function findOnPath(name: string, o: FindOptions = {}): string | null {
  const platform = o.platform ?? process.platform;
  const win = platform === "win32";
  const exists = o.exists ?? existsSync;
  const pathVar = o.pathVar ?? process.env.PATH ?? process.env.Path ?? "";
  const exts = win ? (o.exts ?? [".exe", ".com"]) : [""];
  const abs = (d: string) => (win ? /^[A-Za-z]:[\\/]|^\\\\/.test(d) : isAbsolute(d));
  const sep = win ? "\\" : "/";
  for (const raw of pathVar.split(win ? ";" : ":")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !abs(dir)) continue;
    for (const ext of exts) {
      const file = `${dir.replace(/[\\/]+$/, "")}${sep}${name}${ext}`;
      if (exists(file)) return file;
    }
  }
  return null;
}

const found = new Map<string, string>();

/**
 * What to hand to spawn for `name`: on Windows its full path from the PATH (or a path that cannot exist, so the
 * call fails with "not found" instead of falling back to the current folder); elsewhere the name itself.
 */
export function program(name: string): string {
  if (process.platform !== "win32") return name;
  const hit = found.get(name);
  if (hit) return hit;
  const p = findOnPath(name);
  if (p) {
    found.set(name, p);
    return p;
  }
  return join(process.env.SystemRoot || "C:\\Windows", "System32", "scenaria-not-found", `${name}.exe`);
}

/** Is `name` installed (on the PATH)? On Windows also as a `.cmd` or `.bat`, as npm installs command-line tools. */
export function onPath(name: string): boolean {
  if (process.platform === "win32") return findOnPath(name, { exts: [".exe", ".com", ".cmd", ".bat"] }) !== null;
  return findOnPath(name) !== null;
}

/** A program of Windows itself, by its full path (never looked up by name). */
export function windowsProgram(file: string): string {
  return join(process.env.SystemRoot || "C:\\Windows", file);
}
