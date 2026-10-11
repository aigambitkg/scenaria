import { chmodSync, existsSync } from "node:fs";

for (const f of ["dist/cli.js"]) {
  if (existsSync(f)) chmodSync(f, 0o755);
}
