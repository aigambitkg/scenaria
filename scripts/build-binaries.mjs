#!/usr/bin/env node
// Builds single-file executables (no Node, no npm install needed) with Bun.
//   node scripts/build-binaries.mjs                 → all targets
//   node scripts/build-binaries.mjs linux-x64       → selected targets
// Dashboard and templates are embedded; output goes to release/.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ALL = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const root = new URL("..", import.meta.url).pathname;

if (!existsSync(join(root, "dist/cli.js")) || !existsSync(join(root, "dist/ui/index.html"))) {
  throw new Error("Run `npm run build` first.");
}

function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const f = join(dir, e);
    return statSync(f).isDirectory() ? walk(f) : [f];
  });
}

const ui = Object.fromEntries(walk(join(root, "dist/ui")).map((f) => [relative(join(root, "dist/ui"), f).split("\\").join("/"), readFileSync(f).toString("base64")]));
const templates = Object.fromEntries(walk(join(root, "templates")).map((f) => [relative(join(root, "templates"), f).split("\\").join("/"), readFileSync(f, "utf8")]));

mkdirSync(join(root, "build"), { recursive: true });
writeFileSync(join(root, "build/embedded.mjs"), `globalThis.__SCENARIA_EMBEDDED__ = ${JSON.stringify({ ui, templates })};\n`);
writeFileSync(join(root, "build/entry.mjs"), `import "./embedded.mjs";\nimport "../dist/cli.js";\n`);
mkdirSync(join(root, "release"), { recursive: true });

for (const t of targets) {
  if (!ALL.includes(t)) throw new Error(`Unknown target ${t}. Use: ${ALL.join(", ")}`);
  const out = join(root, "release", `scenaria-${t}${t.startsWith("windows") ? ".exe" : ""}`);
  console.log(`→ ${t}`);
  const hasBun = (() => {
    try {
      execFileSync("bun", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const [cmd, pre] = hasBun ? ["bun", []] : ["npx", ["-y", "bun@1"]];
  execFileSync(cmd, [...pre, "build", join(root, "build/entry.mjs"), "--compile", "--minify", `--target=bun-${t}`, "--outfile", out], {
    stdio: "inherit",
    cwd: root,
  });
}
console.log("Done. Binaries in release/");
