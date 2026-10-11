import { spawnSync } from "node:child_process";
import type { ShadowRepo } from "./snapshot.js";
import type { ScenariaNode, VerificationCheck, VerificationStatus } from "./types.js";

const RANK: Record<VerificationStatus, number> = { unverified: 0, passed: 1, warning: 2, failed: 3 };

export function worst(statuses: VerificationStatus[]): VerificationStatus {
  return statuses.reduce<VerificationStatus>((acc, s) => (RANK[s] > RANK[acc] ? s : acc), "unverified");
}

/** Extract file-path-like claims (`src/app.ts`, ./README.md) from capsule bullets. */
export function extractPathClaims(lines: string[]): string[] {
  const found = new Set<string>();
  const re = /`([^`\s]+\.[A-Za-z0-9]{1,8})`|(?:^|\s)((?:\.\/)?[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8})(?=[\s,;:)]|$)/g;
  for (const line of lines) {
    for (const m of line.matchAll(re)) {
      const p = (m[1] ?? m[2] ?? "").replace(/^\.\//, "");
      if (!p || p.includes("://") || p.startsWith("/")) continue;
      found.add(p);
    }
  }
  return [...found];
}

export interface AutoVerifyOptions {
  root: string;
}

/** Run the configured verify command (only meaningful on a clean HEAD). */
export function commandCheck(verifyCommand: string, root: string, isHeadAndClean: boolean): VerificationCheck {
  if (!isHeadAndClean) {
    return {
      name: `command: ${verifyCommand}`,
      status: "warning",
      detail: "skipped — only runs when the node is HEAD and the working tree matches its snapshot",
    };
  }
  const r = spawnSync(verifyCommand, { cwd: root, shell: true, encoding: "utf8", timeout: 300_000 });
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-6).join(" | ").slice(-500);
  return {
    name: `command: ${verifyCommand}`,
    status: r.status === 0 ? "passed" : "failed",
    detail: r.status === 0 ? "exit 0" : `exit ${r.status ?? "timeout"} · ${tail}`,
  };
}

/** Deterministic checks a verifier (human or agent) can rely on. */
export function autoChecks(node: ScenariaNode, repo: ShadowRepo | null, o: AutoVerifyOptions): VerificationCheck[] {
  const checks: VerificationCheck[] = [];

  if (node.snapshot && repo) {
    const ok = repo.hasObject(node.snapshot.commit);
    checks.push({
      name: "snapshot restorable",
      status: ok ? "passed" : "failed",
      detail: ok ? `${node.snapshot.commit.slice(0, 10)} · ${node.snapshot.files} files` : "snapshot object missing",
    });

    const claims = extractPathClaims([...(node.outputs ?? []), ...(node.facts ?? [])]);
    if (claims.length && ok) {
      const missing = claims.filter((p) => !repo.fileExists(node.snapshot!.commit, p));
      checks.push({
        name: "claimed files exist",
        status: missing.length ? "failed" : "passed",
        detail: missing.length
          ? `missing in snapshot: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}`
          : `${claims.length} file claim(s) confirmed`,
      });
    }
  } else if (node.type !== "mission" && node.type !== "goal") {
    checks.push({ name: "snapshot restorable", status: "warning", detail: "node has no file snapshot" });
  }

  if (node.type === "decision") {
    const complete = Boolean(node.chosen) && Boolean(node.rationale);
    checks.push({
      name: "decision documented",
      status: complete ? "passed" : "warning",
      detail: complete ? "option + rationale recorded" : !node.chosen ? "no option chosen yet" : "rationale missing",
    });
    const ctx = Boolean(node.context || node.trigger);
    checks.push({
      name: "decision context",
      status: ctx && node.servesGoal ? "passed" : "warning",
      detail: !ctx ? "no context recorded (why did this decision come up?)" : !node.servesGoal ? "link to the main goal missing (servesGoal)" : "context + goal link recorded",
    });
    if (node.confidence !== undefined && node.confidence < 0.5) {
      checks.push({ name: "confidence", status: "warning", detail: `low confidence (${Math.round(node.confidence * 100)} %)` });
    }
  }

  if ((node.type === "checkpoint" || node.type === "autosave") && (node.changedFiles?.length ?? 0) > 0) {
    const documented = (node.outputs?.length ?? 0) > 0;
    checks.push({
      name: "changes documented",
      status: documented ? "passed" : "warning",
      detail: documented ? `${node.changedFiles!.length} changed file(s) with outputs` : "files changed but no outputs documented",
    });
  }

  const snapWarnings = node.snapshot?.warnings ?? [];
  if (snapWarnings.length) {
    checks.push({ name: "snapshot completeness", status: "warning", detail: snapWarnings.slice(0, 3).join("; ") });
  }

  if (node.irreversible?.length) {
    checks.push({
      name: "irreversible side effects",
      status: "warning",
      detail: `rewind cannot undo: ${node.irreversible.slice(0, 3).join("; ")}`,
    });
  }

  return checks;
}
