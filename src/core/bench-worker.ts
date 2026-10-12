/** Runs the test bench off the main thread, so the server keeps answering (agents included). */
import { parentPort, workerData } from "node:worker_threads";
import { benchmark } from "./predict.js";

benchmark(workerData?.cal)
  .then((r) => parentPort?.postMessage({ ok: true, r }))
  .catch((e) => parentPort?.postMessage({ ok: false, error: String(e?.message ?? e) }));
