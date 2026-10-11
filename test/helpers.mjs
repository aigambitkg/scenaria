import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

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
