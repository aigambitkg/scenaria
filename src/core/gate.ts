/**
 * Canon gate per line of work ("string"): run the approved check commands of the active canon
 * events against the snapshot of each line, not just against the current working tree.
 *
 *   - A line = a scenario's newest node (its head). Its snapshot is exported into a temporary
 *     directory outside the project (dependencies such as node_modules are linked, not copied).
 *   - Only a person starts a gate run (same rule as `canon check`), and only adopted commands run.
 *   - Results are signed with the approver key and bound to the project, the event's text and
 *     command, and a sequence number; a high-water anchor outside the project makes restored
 *     older results visible (same scheme as canon events).
 *   - `stringPayload` uses the newest result on a line: a line "survives" when every hard future
 *     event passed on it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scenaria } from "./engine.js";
import { activeCanon, projectAnchors, readCanon, runCheckCommand, signRecord, verifyRecord, type CanonEvent } from "./canon.js";
import { writeJsonAtomic } from "./store.js";
import { stringPayload } from "./workspace.js";

export interface GateResult {
  node: string;
  scenario?: string;
  event: string;
  check: string;
  text: string;
  status: "passed" | "failed";
  detail: string;
  at: string;
  by?: string;
  seq: number;
  pub?: string;
  sig?: string;
}

export interface GateLine {
  scenario: string;
  head: string;
  title: string;
  version?: number;
  current: boolean;
}

const payload = (r: GateResult) => ["gate/v1", r.seq, r.node, r.event, r.check, r.text, r.status, r.at];
const anchorKey = (node: string, event: string) => `gate:${node}:${event}`;

function file(s: Scenaria) {
  return s.store.path("gate.json");
}

function readRaw(s: Scenaria): GateResult[] {
  try {
    const raw = JSON.parse(readFileSync(file(s), "utf8"));
    return Array.isArray(raw?.results) ? raw.results.filter((r: any) => r && typeof r.node === "string" && typeof r.event === "string") : [];
  } catch {
    return [];
  }
}

/** The lines of work: every scenario's newest node with a snapshot. */
export function gateLines(s: Scenaria): GateLine[] {
  const nodes = s.store.listNodes();
  const head = s.store.readState().head;
  const onHeadLine = new Set(head ? s.path(head).map((n) => n.id) : []);
  const best = new Map<string, (typeof nodes)[number]>();
  for (const n of nodes) {
    if (!n.scenarioId || !n.snapshot) continue;
    const cur = best.get(n.scenarioId);
    if (!cur || (n.version ?? 0) > (cur.version ?? 0) || ((n.version ?? 0) === (cur.version ?? 0) && n.createdAt > cur.createdAt)) best.set(n.scenarioId, n);
  }
  return [...best.values()]
    .map((n) => ({ scenario: n.scenarioId!, head: n.id, title: n.title, version: n.version, current: onHeadLine.has(n.id) || n.id === head }))
    .sort((a, b) => Number(b.current) - Number(a.current) || parseInt(b.head.slice(1)) - parseInt(a.head.slice(1)));
}

/**
 * Verified gate results (newest per node and event). A result whose signature fails, whose key is not
 * trusted, which no longer matches the event (text/command changed, event not active) or which is
 * older than the anchor is dropped; `tampered` lists the ones that look restored or edited.
 */
export function gateResults(s: Scenaria): { results: GateResult[]; tampered: string[] } {
  const events = new Map(activeCanon(s.store).map((e) => [e.id, e]));
  const anchors = projectAnchors(s.store).read();
  const newest = new Map<string, GateResult>();
  const tampered: string[] = [];
  for (const r of readRaw(s)) {
    const key = anchorKey(r.node, r.event);
    const a = anchors[key];
    if (!verifyRecord(s.store, payload(r), r.pub, r.sig) || (a && (r.seq < a.rev || (r.seq === a.rev && r.sig !== a.sig)))) {
      tampered.push(`${r.node}/${r.event}`);
      continue;
    }
    const ev = events.get(r.event);
    if (!ev || ev.check !== r.check || ev.text !== r.text) continue; // outdated, not evidence any more
    const cur = newest.get(key);
    if (!cur || r.seq > cur.seq) newest.set(key, r);
  }
  return { results: [...newest.values()], tampered: [...new Set(tampered)] };
}

/** For one line (root → node): per event, the newest result from the deepest node on that line. */
export function gateEvidence(s: Scenaria, linePath: string[]): Map<string, GateResult> {
  const pos = new Map(linePath.map((id, i) => [id, i]));
  const out = new Map<string, GateResult>();
  for (const r of gateResults(s).results) {
    const i = pos.get(r.node);
    if (i === undefined) continue;
    const cur = out.get(r.event);
    if (!cur || i > pos.get(cur.node)! || (i === pos.get(cur.node)! && r.seq > cur.seq)) out.set(r.event, r);
  }
  return out;
}

/** Link dependency folders that snapshots leave out (node_modules, virtualenvs) into the export. */
function linkDependencies(root: string, dir: string, exclude: string[]) {
  const candidates = new Set(["node_modules", ".venv", "venv", "vendor", ...exclude.filter((x) => /^[\w.-]+\/$/.test(x)).map((x) => x.slice(0, -1))]);
  for (const name of candidates) {
    const src = join(root, name);
    const dst = join(dir, name);
    if (existsSync(src) && !existsSync(dst)) {
      try {
        symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir");
      } catch {
        /* checks may still work without */
      }
    }
  }
}

/**
 * Run the gate — only on a person's request. `lines`: head node ids (default: every line);
 * `ids`: canon events (default: every active event with an adopted command).
 */
export async function runGate(s: Scenaria, opts: { lines?: string[]; ids?: string[]; by?: string; timeoutMs?: number } = {}) {
  if (!s.repo) throw new Error("The gate needs file snapshots (git).");
  const events = activeCanon(s.store).filter((e) => e.check && (!opts.ids?.length || opts.ids.includes(e.id)));
  const all = gateLines(s);
  const lines = opts.lines?.length ? opts.lines.map((id) => all.find((l) => l.head === id) ?? { scenario: s.node(id).scenarioId ?? "?", head: id, title: s.node(id).title, current: false }) : all;
  const cfg = s.config();
  const fresh: GateResult[] = [];
  for (const line of lines.slice(0, 40)) {
    const node = s.node(line.head);
    if (!node.snapshot) continue;
    const dir = mkdtempSync(join(tmpdir(), "scenaria-gate-"));
    try {
      s.repo.exportTo(node.snapshot.commit, dir);
      linkDependencies(s.root, dir, cfg.exclude ?? []);
      for (const ev of events) {
        const r = await runCheckCommand(ev.check!, dir, opts.timeoutMs);
        fresh.push({ node: node.id, scenario: node.scenarioId, event: ev.id, check: ev.check!, text: ev.text, status: r.status, detail: r.detail, at: new Date().toISOString(), by: opts.by, seq: 0 });
      }
    } catch (err: any) {
      for (const ev of events) fresh.push({ node: node.id, scenario: node.scenarioId, event: ev.id, check: ev.check!, text: ev.text, status: "failed", detail: `could not prepare the snapshot: ${String(err?.message ?? err).slice(0, 200)}`, at: new Date().toISOString(), by: opts.by, seq: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!fresh.length) return { results: [], lines: lines.length, events: events.length };
  return s.store.withLock(() => {
    const anchors = projectAnchors(s.store);
    const marks = anchors.read();
    let seq = Math.max(0, ...Object.entries(marks).filter(([k]) => k.startsWith("gate:")).map(([, a]) => a.rev), ...readRaw(s).map((r) => r.seq || 0));
    const raise: Record<string, { rev: number; status: string; sig: string }> = {};
    for (const r of fresh) {
      r.seq = ++seq;
      const sg = signRecord(s.store, payload(r));
      r.pub = sg.pub;
      r.sig = sg.sig;
      raise[anchorKey(r.node, r.event)] = { rev: r.seq, status: r.status, sig: r.sig };
    }
    // Keep the newest result per node and event (plus nothing else: results are evidence, not a log).
    const keep = new Map<string, GateResult>();
    for (const r of [...readRaw(s), ...fresh]) {
      const k = anchorKey(r.node, r.event);
      const cur = keep.get(k);
      if (!cur || (r.seq ?? 0) > (cur.seq ?? 0)) keep.set(k, r);
    }
    writeJsonAtomic(file(s), { results: [...keep.values()] });
    anchors.raise(raise);
    s.store.appendEvent({ type: "canon", data: { message: `canon gate on ${lines.length} line(s): ${fresh.filter((r) => r.status === "passed").length} passed, ${fresh.filter((r) => r.status === "failed").length} failed`, by: opts.by } });
    return { results: fresh, lines: lines.length, events: events.length };
  });
}

/** Matrix for the dashboard: every line × every active event with a command. */
export function gateMatrix(s: Scenaria) {
  const lines = gateLines(s);
  const events = readCanon(s.store).filter((e) => e.status === "active" && e.check) as CanonEvent[];
  const { tampered } = gateResults(s);
  const rows = lines.map((l) => {
    const ev = gateEvidence(s, s.path(l.head).map((n) => n.id));
    const cells = events.map((e) => {
      const r = ev.get(e.id);
      return { event: e.id, status: r ? r.status : ("not run" as const), at: r?.at, detail: r?.detail, node: r?.node };
    });
    // The verdict is the line's string payload: broken canon, checks and gate results together.
    const pl = stringPayload(s, l.head);
    return { ...l, cells, verdict: pl.verdict, reasons: pl.reasons };
  });
  return { events: events.map((e) => ({ id: e.id, kind: e.kind, text: e.text, hard: e.hard, check: e.check })), rows, tampered };
}
