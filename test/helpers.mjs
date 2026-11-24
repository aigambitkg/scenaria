import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

// Tests never touch the developer's real ~/.config/scenaria (approver key, anchors, registries).
if (!process.env.SCENARIA_HOME) process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));

// … nor the developer's real home folder (agent configs such as ~/.claude, ~/.cursor; Downloads).
// Node reads the home folder from HOME on macOS and Linux and from USERPROFILE on Windows: both are set,
// so a test that forgets one of them writes into a throwaway folder and never into a real home.
export const REAL_HOME = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
if (!process.env.SCENARIA_TEST_HOME) {
  process.env.SCENARIA_TEST_HOME = mkdtempSync(join(tmpdir(), "scenaria-userhome-"));
  process.env.HOME = process.env.SCENARIA_TEST_HOME;
  process.env.USERPROFILE = process.env.SCENARIA_TEST_HOME;
  // Windows keeps app settings (Claude Desktop, VS Code) under APPDATA, not under the home folder itself.
  if (process.platform === "win32") {
    process.env.APPDATA = join(process.env.SCENARIA_TEST_HOME, "AppData", "Roaming");
    process.env.LOCALAPPDATA = join(process.env.SCENARIA_TEST_HOME, "AppData", "Local");
  }
}

export function tempProject(prefix = "scenaria-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    write(p, c) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    },
    read(p) {
      return readFileSync(join(dir, p), "utf8");
    },
    exists(p) {
      return existsSync(join(dir, p));
    },
  };
}

/** An absolute file as an import target: a Windows path ("D:\…") is no valid module address, a file URL is. */
export function importUrl(file) {
  return pathToFileURL(file).href;
}

/** Environment entries that point "home" at `dir` on every system (Windows reads USERPROFILE, not HOME). */
export function homeEnv(dir) {
  return { HOME: dir, USERPROFILE: dir };
}

/** Point this process's home at `dir` (both variables); returns the function that puts the old values back. */
export function setHome(dir) {
  const old = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, homeEnv(dir));
  return () => {
    for (const k of ["HOME", "USERPROFILE"]) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  };
}

/** A path as a POSIX shell (also git's own sh on Windows) reads it inside double quotes. */
export function shPath(file) {
  return file.replace(/\\/g, "/");
}
