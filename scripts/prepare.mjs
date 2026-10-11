// Builds automatically after `npm install` in a clone (or a git install), if dev tools are present.
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
try {
  require.resolve("typescript/package.json");
  require.resolve("vite/package.json");
} catch {
  process.exit(0); // installed without dev dependencies — the published package ships dist/
}
execSync("npm run build", { stdio: "inherit" });
