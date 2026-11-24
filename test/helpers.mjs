import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

// Tests never touch the developer's real ~/.config/scenaria (approver key, anchors, registries).
if (!process.env.SCENARIA_HOME) process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));

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

export const isWin = process.platform === "win32";

/** A file path as text for `import(...)` in generated code: on Windows an absolute path must be a file:// URL. */
export const importPath = (p) => JSON.stringify(pathToFileURL(p).href);

/**
 * What makes `home` the home folder of a child process. os.homedir() reads HOME on macOS and Linux and
 * USERPROFILE on Windows; Windows programs also need a few variables of the system to start at all.
 */
export function homeEnv(home) {
  if (!isWin) return { HOME: home };
  const keep = Object.fromEntries(["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "ProgramFiles", "ProgramData"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  return { ...keep, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") };
}

/** Make `home` the home folder of THIS process; returns the function that puts the old one back. */
export function useHome(home) {
  const keys = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = home;
  if (isWin) {
    process.env.USERPROFILE = home;
    process.env.APPDATA = join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  }
  return () => {
    for (const k of keys) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  };
}
