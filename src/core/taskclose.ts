/**
 * E5 (re-check of N1): the person's closing of a task with approved completion criteria, kept OUTSIDE the project and
 * signed (like the lift of a stop). Only such a record ends the open task: a status written into the project — by an
 * agent's call, a checkpoint's taskDone or a file edited by hand — never does, so it cannot switch the stop rule off.
 * The newest record per task counts ("done"/"abandoned" closes, "active" reopens). Never throws.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic, type Store } from "./store.js";
import { globalConfigPath } from "./global.js";
import { projectIdentity, publicKeyId, signRecord, verifyRecord } from "./canon.js";

export type CloseStatus = "done" | "abandoned" | "active";
export interface TaskClose {
  task: string;
  status: CloseStatus;
  at: string;
  by: string;
  via: string;
  keyId?: string;
}

const file = () => join(dirname(globalConfigPath()), "task-closes.json");
function folderOf(store: Store): string {
  try {
    return realpathSync(store.root);
  } catch {
    return store.root;
  }
}
const keyOf = (store: Store, create: boolean) => {
  const pid = projectIdentity(store, create);
  return pid ? `${pid}:${folderOf(store)}` : "";
};
const parts = (folder: string, c: TaskClose) => ["task-close/v1", folder, c.task, c.status, c.at, c.by, c.via];
function readAll(): Record<string, any> {
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8"));
    return raw?.projects && typeof raw.projects === "object" && !Array.isArray(raw.projects) ? raw.projects : {};
  } catch {
    return {};
  }
}

/** Record the PERSON's close or reopening (callers make sure a person acts: the dashboard's approval session). */
export function recordTaskClose(store: Store, input: { task: string; status: CloseStatus; by?: string; via?: string }): TaskClose {
  const c: TaskClose = { task: input.task, status: input.status, at: new Date().toISOString(), by: String(input.by ?? "person").slice(0, 80) || "person", via: String(input.via ?? "dashboard").slice(0, 40) };
  const key = keyOf(store, true);
  if (!key) return c;
  const signed = signRecord(store, parts(folderOf(store), c));
  const all = readAll();
  const list: any[] = Array.isArray(all[key]?.closes) ? all[key].closes : [];
  list.push({ ...c, keyId: publicKeyId(signed.pub), pub: signed.pub, sig: signed.sig });
  all[key] = { closes: list.slice(-500) };
  writeJsonAtomic(file(), { version: 1, projects: all });
  return { ...c, keyId: publicKeyId(signed.pub) };
}

/** The person's newest valid record for a task, or null. A record that does not verify does not count. */
export function taskCloseOf(store: Store, task: string): TaskClose | null {
  try {
    const key = keyOf(store, false);
    const list: any[] = key && Array.isArray(readAll()[key]?.closes) ? readAll()[key].closes : [];
    const folder = folderOf(store);
    const ok = list
      .filter((c) => c && c.task === task && ["done", "abandoned", "active"].includes(c.status) && typeof c.at === "string" && typeof c.by === "string" && typeof c.via === "string")
      .filter((c) => verifyRecord(store, parts(folder, c), c.pub, c.sig))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const x = ok[ok.length - 1];
    return x ? { task: x.task, status: x.status, at: x.at, by: x.by, via: x.via, keyId: publicKeyId(x.pub) } : null;
  } catch {
    return null;
  }
}

/** Did the person close this task (the newest valid record says done or abandoned)? */
export function closedByPerson(store: Store, task: string): boolean {
  const c = taskCloseOf(store, task);
  return c !== null && c.status !== "active";
}
