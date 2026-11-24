// Batch C4c-1: the audit file in the dashboard — the auditor mode on site (read only) and the audit package from
// the dashboard (Kev's decisions 2026-10-16/17).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { verifyAuditExport } from "../dist/core/auditexport.js";
import { checkExportPath } from "../dist/core/auditpackage.js";
import { createApp, browserLog } from "../dist/server.js";
import { tempProject, useHome } from "./helpers.mjs";

function project() {
  const p = tempProject("auditview-");
  p.write("a.txt", "1");
  const s = Scenaria.init(p.dir);
  s.startMission({ projectGoal: "A small API", title: "Build", goal: "Endpoints" });
  s.decide({ question: "Framework?", options: ["Express", "Fastify"], chosen: "Fastify", rationale: "fast", context: "new", servesGoal: "API", agent: "codex" });
  return { p, s };
}

async function serve(s, opts = {}) {
  const app = createApp(s, { approvalCode: "code", approvalSecret: "sess", openApproval: async () => ({ opened: true }), auditViewEveryMs: 0, ...opts });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, h = {}) => fetch(base + path, { headers: { "x-scenaria": "1", ...h }, redirect: "manual" });
  const post = (path, body, h = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", ...h }, body: JSON.stringify(body ?? {}), redirect: "manual" });
  return { server, base, get, post };
}

const cookieOf = (r, name) => {
  for (const c of r.headers.getSetCookie()) {
    const m = c.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return { value: m[1], raw: c };
  }
  return undefined;
};

test("C4c auditor mode: only the person starts it; the browser reads the audit file but loses every person action", async () => {
  const { s } = project();
  const { server, get, post } = await serve(s);
  const agent = { "x-scenaria-agent": "codex" };
  const person = { cookie: "scenaria_approval=sess" };
  try {
    // An agent can neither start the mode nor read the audit file (default: only the person).
    assert.equal((await post("/api/audit-file/auditor-mode", {}, agent)).status, 403);
    assert.equal((await get("/api/audit-file", agent)).status, 403);
    // The person starts it: a read cookie, the approval cookie cleared.
    const r = await post("/api/audit-file/auditor-mode", {}, person);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, hours: 8 });
    const view = cookieOf(r, "scenaria_auditview");
    assert.match(view.value, /^[0-9a-f]{48}\.[0-9a-z]+\.[0-9a-f]{32}$/, "random, valid until, signed");
    assert.match(view.raw, /HttpOnly/);
    assert.match(view.raw, /SameSite=Strict/);
    assert.match(view.raw, /Max-Age=28800/);
    assert.equal(cookieOf(r, "scenaria_approval").value, "", "the approval cookie is cleared");
    const auditor = { cookie: `scenaria_auditview=${view.value}` };
    // Reads the audit file and the organisation's evidence.
    assert.equal((await get("/api/audit-file", auditor)).status, 200);
    assert.equal((await get("/api/audit-file/evidence", auditor)).status, 200);
    const ap = await (await get("/api/approval", auditor)).json();
    assert.deepEqual([ap.granted, ap.auditView], [false, true]);
    // Changes nothing: every person action is refused.
    // Every write is refused, also the ones agents may do (save now, goal, go back, tools) and the lock
    // (no accidental approval by the auditor).
    const writes = [
      ["/api/audit-file/export", {}], ["/api/audit-file/package", {}], ["/api/audit-file/access", { mode: "open" }], ["/api/audit-file/evidence", {}],
      ["/api/audit-file/auditor-mode", {}], ["/api/canon/decide", {}], ["/api/integrity/reseal", {}], ["/api/checkpoint", { title: "x" }], ["/api/goal", { goal: "other" }],
      ["/api/rewind", { id: "n1" }], ["/api/v1/tools/scenaria_checkpoint", { title: "x", outputs: ["y"] }], ["/api/approval/open", {}],
    ];
    const nodes = s.store.listNodes().length;
    for (const [path, body] of writes) {
      const w = await post(path, body, { ...auditor, "x-scenaria-view": "dashboard" });
      assert.equal(w.status, 403, path);
      assert.equal((await w.json()).code, "auditor_mode", path);
    }
    assert.equal(s.store.listNodes().length, nodes, "nothing was written");
    // A made-up or unknown read cookie reads nothing.
    assert.equal((await get("/api/audit-file", { cookie: `scenaria_auditview=${"0".repeat(48)}` })).status, 403);
    // Ending it: the read cookie no longer works.
    const end = await post("/api/audit-file/auditor-mode/end", {}, auditor);
    assert.equal(end.status, 200);
    assert.equal(cookieOf(end, "scenaria_auditview").value, "");
    assert.equal((await get("/api/audit-file", auditor)).status, 403);
    // The browser dropped the cookie (Max-Age=0): unlocking works again.
    assert.equal((await post("/api/approval/open", {}, { "x-scenaria-view": "dashboard" })).status, 200, "unlocking works again after the end");
  } finally {
    server.close();
  }
});

test("C4c auditor mode: ending is logged only for a real auditor browser; the approval link ends the mode", async () => {
  const { s } = project();
  const { server, get, post } = await serve(s);
  const ended = () => s.store.readEvents().filter((e) => /auditor mode ended/.test(e.data?.message ?? "")).length;
  try {
    // Anyone may call the end route, but without a real auditor cookie it writes nothing to the log.
    for (let i = 0; i < 3; i++) assert.equal((await post("/api/audit-file/auditor-mode/end", {}, { "x-scenaria-agent": "codex" })).status, 200);
    assert.equal(ended(), 0);
    const started = s.store.readEvents().filter((e) => /auditor mode started/.test(e.data?.message ?? "")).length;
    const r = await post("/api/audit-file/auditor-mode", {}, { cookie: "scenaria_approval=sess" });
    assert.equal(s.store.readEvents().filter((e) => /auditor mode started/.test(e.data?.message ?? "")).length, started + 1);
    const v = cookieOf(r, "scenaria_auditview").value;
    // A link redeemed in this browser ends the auditor mode there — without approval (review C4c-1 K1).
    const back = await get("/?approve=code", { cookie: `scenaria_auditview=${v}` });
    assert.equal(back.status, 302);
    assert.equal(cookieOf(back, "scenaria_approval"), undefined);
    assert.equal(cookieOf(back, "scenaria_auditview").value, "");
    assert.equal(ended(), 1, "logged once");
    assert.equal((await get("/api/audit-file", { cookie: `scenaria_auditview=${v}` })).status, 403, "the old read cookie is dead");
  } finally {
    server.close();
  }
});

test("C4c auditor mode and dashboard package are refused in team mode", async () => {
  const { s } = project();
  const { server, post } = await serve(s, { token: "team-token", approverToken: "appr" });
  try {
    for (const path of ["/api/audit-file/auditor-mode", "/api/audit-file/package"]) {
      const r = await post(path, {}, { authorization: "Bearer team-token", cookie: "scenaria_approval=sess" });
      assert.ok([400, 403].includes(r.status), `${path}: ${r.status}`);
      if (r.status === 400) assert.equal((await r.json()).code, "team_mode");
    }
  } finally {
    server.close();
  }
});

test("C4c dashboard package: person-only, written to Downloads (else home), a valid package, no machine path in the answer", async () => {
  const { s } = project();
  const home = mkdtempSync(join(tmpdir(), "auditview-home-"));
  let restoreHome = useHome(home);
  const oldNo = process.env.SCENARIA_NO_BROWSER;
  process.env.SCENARIA_NO_BROWSER = "1";
  const { server, post } = await serve(s);
  try {
    assert.equal((await post("/api/audit-file/package", {}, { "x-scenaria-agent": "codex" })).status, 403);
    assert.equal(readdirSync(home).length, 0, "an agent wrote nothing");
    // No Downloads folder: the home folder.
    let r = await post("/api/audit-file/package", { lang: "en" }, { cookie: "scenaria_approval=sess" });
    assert.equal(r.status, 200);
    let j = await r.json();
    assert.equal(j.where, "home");
    assert.match(j.folder, /^audit-package-/);
    assert.ok(!JSON.stringify(j).includes(home), "no machine path in the answer");
    assert.ok(existsSync(join(home, j.folder, "audit-file.json")));
    // The server opens the real folder path (on macOS /var/… is really /private/var/…): compare real paths (docs/DEVELOPMENT.md §3).
    assert.ok(browserLog.some((x) => x === join(realpathSync.native(home), j.folder, "audit-file.html")), "the print page is opened by absolute path");
    // With a Downloads folder: there.
    mkdirSync(join(home, "Downloads"));
    r = await post("/api/audit-file/package", { names: "roles-only", open: false }, { cookie: "scenaria_approval=sess" });
    j = await r.json();
    assert.equal(j.where, "downloads");
    assert.equal(j.names, "roles-only");
    const folder = join(home, "Downloads", j.folder);
    const v = verifyAuditExport(readFileSync(join(folder, "audit-file.json"), "utf8"));
    assert.equal(v.valid, true, v.problem);
    const c = checkExportPath(folder, "0.9.11");
    assert.equal(c.valid, true, c.problem);
    assert.equal(c.package, true);
    assert.equal(c.copiesSignature, undefined, "the copies are signed");
    assert.deepEqual(c.copies.map((x) => x.state), ["same", "same", "same"]);
    // A bad period is refused before anything is written.
    const before = readdirSync(join(home, "Downloads")).length;
    r = await post("/api/audit-file/package", { from: "yesterday" }, { cookie: "scenaria_approval=sess" });
    assert.equal(r.status, 400);
    assert.equal(readdirSync(join(home, "Downloads")).length, before);
  } finally {
    server.close();
    restoreHome();
    if (oldNo === undefined) delete process.env.SCENARIA_NO_BROWSER;
    else process.env.SCENARIA_NO_BROWSER = oldNo;
  }
});

// ---------------------------------------------------------------- review C4c-1 (K1–K10), a test per finding

test("C4c-1 K1: while a browser is in auditor mode nobody opens an approval link, and a link opened there gives no approval", async () => {
  const { s } = project();
  const { server, get, post } = await serve(s);
  try {
    const r = await post("/api/audit-file/auditor-mode", {}, { cookie: "scenaria_approval=sess" });
    const v = cookieOf(r, "scenaria_auditview").value;
    // An agent (no cookie) asks Scenaria to open a link: refused while the auditor mode is active.
    const open = await post("/api/approval/open", {}, { "x-scenaria-agent": "codex" });
    assert.equal(open.status, 409);
    assert.equal((await open.json()).code, "auditor_mode_active");
    // A link that still reaches the auditor's browser (e.g. the printed start link): no approval, the mode ends.
    const back = await get("/?approve=code", { cookie: `scenaria_auditview=${v}` });
    assert.equal(back.status, 302);
    assert.equal(back.headers.get("location"), "/?approval=auditor");
    assert.equal(cookieOf(back, "scenaria_approval"), undefined, "no approval cookie");
    assert.equal(cookieOf(back, "scenaria_auditview").value, "");
    assert.equal((await get("/api/audit-file", { cookie: `scenaria_auditview=${v}` })).status, 403, "the read cookie is dead");
    // The link is used up; after the mode ended, the lock works again.
    assert.equal((await get("/?approve=code", {})).headers.get("location"), "/?approval=invalid");
    assert.equal((await post("/api/approval/open", {}, { "x-scenaria-view": "dashboard" })).status, 200);
  } finally {
    server.close();
  }
});

test("C4c-1 K2/K6/R1: a cookie Scenaria issued writes nothing after a restart (also through the LLM proxy); a planted one is ignored", async () => {
  const { s } = project();
  // The auditor mode is started, then Scenaria restarts (a new app: the in-process list is empty).
  const first = await serve(s);
  const v = cookieOf(await first.post("/api/audit-file/auditor-mode", {}, { cookie: "scenaria_approval=sess" }), "scenaria_auditview").value;
  first.server.close();
  const { server, get, post } = await serve(s);
  try {
    const stale = { cookie: `scenaria_auditview=${v}` };
    const nodes = s.store.listNodes().length;
    for (const [path, body] of [["/api/checkpoint", { title: "x" }], ["/api/goal", { goal: "other" }], ["/api/v1/tools/scenaria_checkpoint", { title: "x", outputs: ["y"] }], ["/proxy/openai/v1/chat/completions", { model: "x", messages: [] }]]) {
      const w = await post(path, body, stale);
      assert.equal(w.status, 403, path);
      assert.equal((await w.json()).code, "auditor_mode", path);
    }
    assert.equal((await post("/api/checkpoint", { title: "x" }, { cookie: `a=1;scenaria_auditview=${v}` })).status, 403, "another spelling");
    assert.equal(s.store.listNodes().length, nodes, "nothing was written");
    const ap = await (await get("/api/approval", stale)).json();
    assert.equal(ap.auditView, "stale");
    assert.equal((await get("/api/audit-file", stale)).status, 403, "a stale cookie reads nothing");
    // R1: a cookie Scenaria did not issue (planted by another page on 127.0.0.1, any path) is ignored entirely:
    // the person's approved browser keeps working, nothing reads more.
    for (const planted of ["1", "ab".repeat(24), `${"ab".repeat(24)}.zz.${"0".repeat(32)}`, v.replace(/.$/, (c) => (c === "0" ? "1" : "0"))]) {
      const h = { cookie: `scenaria_approval=sess; scenaria_auditview=${planted}` };
      assert.equal((await get("/api/approval", h).then((r) => r.json())).auditView, false, planted);
      assert.equal((await post("/api/checkpoint", { title: "planted" }, h)).status, 200, planted);
      assert.equal((await get("/api/audit-file", { cookie: `scenaria_auditview=${planted}` })).status, 403, planted);
    }
  } finally {
    server.close();
  }
});

test("C4c-1 K2: the auditor mode survives a project switch (one list for every app of the server)", async () => {
  const a = project();
  const b = project();
  const { registerProject } = await import("../dist/core/projects.js");
  const { startServer } = await import("../dist/server.js");
  registerProject(b.s.root, "b");
  const srv = await startServer(a.s, { port: 4793, quiet: true, showApprovalLink: true });
  try {
    const r0 = await fetch(srv.approvalUrl, { redirect: "manual" });
    const person = { "x-scenaria": "1", "x-scenaria-view": "dashboard", "content-type": "application/json", cookie: cookieOf(r0, "scenaria_approval").raw.split(";")[0] };
    const start = await fetch(`${srv.url}/api/audit-file/auditor-mode`, { method: "POST", headers: person, body: "{}" });
    const v = cookieOf(start, "scenaria_auditview").value;
    // The person switches the project in their own (other) browser.
    assert.equal((await fetch(`${srv.url}/api/projects/switch`, { method: "POST", headers: person, body: JSON.stringify({ root: b.s.root }) })).status, 200);
    const auditor = { cookie: `scenaria_auditview=${v}` };
    const ap = await (await fetch(`${srv.url}/api/approval`, { headers: { ...auditor, "x-scenaria-view": "dashboard" } })).json();
    assert.equal(ap.auditView, true, "still in auditor mode after the switch");
    assert.equal((await fetch(`${srv.url}/api/audit-file`, { headers: { ...auditor, "x-scenaria-view": "dashboard" } })).status, 200);
    for (const view of [{}, { "x-scenaria-view": "dashboard" }]) {
      const w = await fetch(`${srv.url}/api/checkpoint`, { method: "POST", headers: { "x-scenaria": "1", "content-type": "application/json", ...auditor, ...view }, body: JSON.stringify({ title: "x" }) });
      assert.equal(w.status, 403, JSON.stringify(view));
    }
  } finally {
    srv.close();
  }
});

test("C4c-1 K3/K4: the package folder is checked before signing; never a path in an answer", async () => {
  const { p, s } = project();
  let restoreHome = () => {};
  const setHome = (h) => {
    restoreHome();
    restoreHome = useHome(h);
  };
  const oldNo = process.env.SCENARIA_NO_BROWSER;
  process.env.SCENARIA_NO_BROWSER = "1";
  const { server, post } = await serve(s);
  const exports = () => s.store.readEvents().filter((e) => /audit file exported/.test(e.data?.message ?? "")).length;
  const person = { cookie: "scenaria_approval=sess" };
  try {
    // A relative home: refused (it would write into the server's working folder).
    setHome(".");
    let r = await post("/api/audit-file/package", {}, person);
    assert.equal(r.status, 400);
    const refused = await r.json();
    assert.equal(refused.code, "no_home", JSON.stringify(refused));
    // Downloads is a link into the project: refused, nothing signed.
    const home = mkdtempSync(join(tmpdir(), "auditview-home-"));
    setHome(home);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(p.dir, join(home, "Downloads"));
    r = await post("/api/audit-file/package", {}, person);
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.code, "inside_project");
    assert.ok(!j.error.includes(home) && !j.error.includes(p.dir), "no machine path");
    assert.equal(exports(), 0, "nothing signed or logged");
    assert.ok(!readdirSync(p.dir).some((x) => x.startsWith("audit-package-")), "nothing written into the project");
    // Downloads is a file: the home folder is used instead.
    const home2 = mkdtempSync(join(tmpdir(), "auditview-home-"));
    setHome(home2);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(home2, "Downloads"), "x");
    r = await post("/api/audit-file/package", { open: false }, person);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).where, "home");
  } finally {
    server.close();
    restoreHome();
    if (oldNo === undefined) delete process.env.SCENARIA_NO_BROWSER;
    else process.env.SCENARIA_NO_BROWSER = oldNo;
  }
});

test("C4c-1 K8: the list of auditor-mode browsers is capped (the oldest ends)", async () => {
  const { s } = project();
  const { server, get, post } = await serve(s);
  try {
    const cookies = [];
    for (let i = 0; i < 7; i++) cookies.push(cookieOf(await post("/api/audit-file/auditor-mode", {}, { cookie: "scenaria_approval=sess" }), "scenaria_auditview").value);
    const reads = await Promise.all(cookies.map(async (v) => (await get("/api/audit-file", { cookie: `scenaria_auditview=${v}` })).status));
    assert.deepEqual(reads, [403, 403, 200, 200, 200, 200, 200]);
  } finally {
    server.close();
  }
});

test("C4c-1 K7: in auditor mode the dashboard hides what would change something", () => {
  const src = (f) => readFileSync(new URL(`../ui/src/${f}`, import.meta.url), "utf8");
  for (const f of ["NodePanel.tsx", "SimpleView.tsx"]) assert.match(src(f), /useContext\(ReadOnlyContext\)/, f);
  assert.match(src("Approval.tsx"), /if \(readOnly\) return/, "the lock note offers no lock in auditor mode");
  assert.match(src("App.tsx"), /<ReadOnlyContext\.Provider value=\{auditView !== false\}>/);
  // "partly" never looks like "verified" (K10).
  assert.match(src("AuditFile.tsx"), /partly: "st-partly"/);
});

test("C4c-1 R2/R3/R6: the dashboard's lock stays usable; team mode ignores the cookie; starts are spaced", async () => {
  const { s } = project();
  const { server, post } = await serve(s, { auditViewEveryMs: 10_000 });
  try {
    assert.equal((await post("/api/audit-file/auditor-mode", {}, { cookie: "scenaria_approval=sess" })).status, 200);
    // R6: a second start right after is refused.
    assert.equal((await post("/api/audit-file/auditor-mode", {}, { cookie: "scenaria_approval=sess" })).status, 429);
    // S1: while the auditor's browser checked in recently, nobody opens a link — the dashboard mark is only a claim.
    assert.equal((await post("/api/approval/open", {}, { "x-scenaria-view": "dashboard" })).status, 409);
    assert.equal((await post("/api/approval/open", {}, { "x-scenaria-agent": "codex" })).status, 409, "an agent's request is refused");
  } finally {
    server.close();
  }
  // R3: team mode has no auditor mode; a stray cookie changes nothing there.
  const team = await serve(s, { token: "team-token", approverToken: "appr" });
  try {
    const first = await serve(s);
    const v = cookieOf(await first.post("/api/audit-file/auditor-mode", {}, { cookie: "scenaria_approval=sess" }), "scenaria_auditview").value;
    first.server.close();
    const r = await team.post("/api/checkpoint", { title: "team" }, { authorization: "Bearer team-token", cookie: `scenaria_auditview=${v}` });
    assert.equal(r.status, 200);
  } finally {
    team.server.close();
  }
});

test("C4c-1 R2/S1: an auditor browser that stopped checking in no longer blocks the lock (10 minutes)", async () => {
  const { s } = project();
  const auditViews = new Map();
  const { server, post } = await serve(s, { auditViews });
  try {
    assert.equal((await post("/api/audit-file/auditor-mode", {}, { cookie: "scenaria_approval=sess" })).status, 200);
    assert.equal((await post("/api/approval/open", {}, { "x-scenaria-view": "dashboard" })).status, 409);
    // The auditor's window was closed (the cookie lost): 11 minutes without a check-in.
    for (const e of auditViews.values()) e.seen = Date.now() - 11 * 60_000;
    assert.equal((await post("/api/approval/open", {}, { "x-scenaria-view": "dashboard" })).status, 200, "the person can unlock again");
  } finally {
    server.close();
  }
});
