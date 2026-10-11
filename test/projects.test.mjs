// Batch 4 (v0.8): switch the dashboard between the person's Scenaria projects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenaria } from "../dist/core/index.js";
import { startServer } from "../dist/server.js";
import { registerProject, listProjects } from "../dist/core/projects.js";
import { autoBudget } from "../dist/core/forecast.js";
import { tempProject } from "./helpers.mjs";

process.env.SCENARIA_HOME = mkdtempSync(join(tmpdir(), "scenaria-home-"));

function project(name, goal) {
  const p = tempProject();
  const s = Scenaria.init(p.dir, { projectName: name });
  s.startMission({ projectGoal: goal, title: `${name} start` });
  return { p, s };
}

async function approve(srv) {
  const r = await fetch(srv.approvalUrl, { redirect: "manual" });
  const c = r.headers.get("set-cookie") ?? "";
  return c.split(";")[0];
}

function events(base) {
  // Minimal SSE reader: collects event names.
  const seen = [];
  const ctrl = new AbortController();
  (async () => {
    try {
      const r = await fetch(`${base}/api/events`, { signal: ctrl.signal });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const m of dec.decode(value).matchAll(/event: (\w+)/g)) seen.push(m[1]);
      }
    } catch {}
  })();
  return { seen, stop: () => ctrl.abort() };
}

test("the person switches the dashboard between projects; agents and other tabs are told", async () => {
  const a = project("Alpha", "Alpha goal");
  const b = project("Beta", "Beta goal: confidential roadmap");
  registerProject(b.s.root, "Beta");
  const srv = await startServer(a.s, { port: 4710, quiet: true, showApprovalLink: true });
  const base = srv.url;
  const post = (p, body, cookie) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-scenaria": "1", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  try {
    // without the approval session: no list, no switch
    const anon = await (await fetch(`${base}/api/projects`)).json();
    assert.equal(anon.person, false);
    assert.deepEqual(anon.projects, []);
    assert.equal(anon.current.root, undefined, "no folders for agents");
    assert.equal(anon.current.name, "Alpha");
    assert.equal((await post("/api/projects/switch", { root: b.s.root })).status, 403);

    const cookie = await approve(srv);
    assert.match(cookie, /^scenaria_approval=/);
    const page = await (await fetch(`${base}/api/projects`, { headers: { cookie } })).json();
    assert.equal(page.person, true);
    assert.equal(page.canSwitch, true);
    assert.deepEqual(page.projects.map((x) => x.name).sort(), ["Alpha", "Beta"]);
    assert.equal(page.projects.find((x) => x.current).name, "Alpha");

    // not a project → clear message
    const bad = await post("/api/projects/switch", { root: tmpdir() }, cookie);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "not_a_project");

    const sse = events(base);
    await new Promise((r) => setTimeout(r, 300));
    const sw = await post("/api/projects/switch", { root: b.s.root }, cookie);
    assert.equal(sw.status, 200);
    assert.equal((await sw.json()).name, "Beta");
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(sse.seen.includes("project"), `open dashboards are told: ${sse.seen}`);
    sse.stop();

    // everything now answers for Beta — with the same approval session
    const g = await (await fetch(`${base}/api/graph`)).json();
    assert.equal(g.config.projectName, "Beta");
    assert.equal(srv.project().root, b.s.root);
    assert.equal((await (await fetch(`${base}/api/projects`, { headers: { cookie } })).json()).person, true);
    // the single-use link stays used across the switch
    const again = await fetch(srv.approvalUrl, { redirect: "manual" });
    assert.match(again.headers.get("location") ?? "", /approval=invalid/);
    // and back
    assert.equal((await post("/api/projects/switch", { root: a.s.root }, cookie)).status, 200);
    assert.equal((await (await fetch(`${base}/api/graph`)).json()).config.projectName, "Alpha");

    // forget (files stay), never the open one
    assert.equal((await post("/api/projects/forget", { root: a.s.root }, cookie)).status, 400);
    assert.equal((await post("/api/projects/forget", { root: b.s.root }, cookie)).status, 200);
    assert.ok(!listProjects().some((x) => x.name === "Beta"));
    assert.ok(b.p.exists(".scenaria/config.json"));
  } finally {
    srv.close();
  }
});

test("team mode: no project list and no switching", async () => {
  const a = project("Gamma", "g");
  registerProject(a.s.root, "Gamma");
  const srv = await startServer(a.s, { port: 4730, quiet: true, token: "team-secret", approverToken: "appr" });
  try {
    const h = { authorization: "Bearer team-secret" };
    const page = await (await fetch(`${srv.url}/api/projects`, { headers: h })).json();
    assert.equal(page.canSwitch, false);
    assert.deepEqual(page.projects, []);
  } finally {
    srv.close();
  }
});

test("the daily limit of automatic forecasts is one budget across all projects", () => {
  const a = project("A", "a");
  const b = project("B", "b");
  const before = autoBudget(b.s).used();
  autoBudget(a.s).spend();
  assert.equal(autoBudget(b.s).used(), before + 1);
});
