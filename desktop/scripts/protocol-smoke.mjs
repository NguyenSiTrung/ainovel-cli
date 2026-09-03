#!/usr/bin/env node
// Protocol-driven native smoke for the packaged Go engine sidecar.
//
// Speaks desktop-v1 NDJSON directly on the sidecar's stdin/stdout — the same
// private pipes the Tauri shell uses — and encodes the maximal flow that can
// run WITHOUT any LLM (no paid provider, no network):
//
//   session 1: engine.ready → ping → project.create → project.snapshot →
//              chapter.save (+ chapter.updated event) → chapter.list →
//              chapter.read → run.abort (idle no-op semantics) →
//              project.replay_events (original sequences) → logs.replay →
//              chapter.export (file content asserted) → engine.shutdown (exit 0)
//   session 2: fresh process → NEW session id + sequence reset →
//              project.open recovery → replay_events empty (per-session
//              memory) → chapter.read persisted → engine.shutdown (exit 0)
//
// What this deliberately does NOT script (engine would reject / needs a
// provider): run.start / run.steer on an active run, simulation.start —
// Host.Simulate binds models.ForRole("architect") and calls the configured
// provider (internal/host/host.go, Simulate), so it is NOT LLM-free and
// stays in the manual checklist (desktop/README.md).
//
// Usage: node protocol-smoke.mjs --engine <path-to-sidecar> [--workdir <dir>]
// Exit code 0 = every phase passed; any assertion failure exits non-zero.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import readline from "node:readline";

function arg(name, required = true) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) {
    if (required) {
      console.error(`protocol-smoke: missing --${name}`);
      process.exit(2);
    }
    return undefined;
  }
  return argv[i + 1];
}

const ENGINE = resolve(arg("engine"));
const WORKDIR = arg("workdir", false) ?? mkdtempSync(join(tmpdir(), "ainovel-protocol-smoke-"));
const REQUEST_TIMEOUT_MS = 30_000;

const MARKER = "The lighthouse keeper counted seventeen steps downward.";
const CHAPTER_CONTENT = `${MARKER}\n\nThe stair spiralled into salt and dark, and the lamp above turned regardless.`;

const failures = [];
function check(cond, label) {
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL: ${label}`);
  }
}

class EngineSession {
  constructor() {
    this.proc = spawn(ENGINE, ["--desktop-daemon"], { stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.events = [];
    this.session = null;
    this.maxSequence = 0;
    this.stderrLines = 0;
    this.exited = null;
    this.proc.stdout.setEncoding("utf8");
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
    this.proc.stderr.setEncoding("utf8");
    readline.createInterface({ input: this.proc.stderr }).on("line", () => this.stderrLines++);
    this.proc.on("exit", (code) => {
      this.exited = code;
      for (const [, { reject }] of this.pending) reject(new Error(`engine exited (code ${code})`));
      this.pending.clear();
    });
  }

  onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      failures.push(`engine wrote non-JSON stdout line: ${line.slice(0, 120)}`);
      return;
    }
    if (msg.kind === "response") {
      const entry = this.pending.get(msg.id);
      if (!entry) {
        failures.push(`response for unknown request id ${msg.id}`);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.payload ?? {});
      else entry.reject(Object.assign(new Error(msg.error?.message ?? "engine error"), { code: msg.error?.code }));
    } else if (msg.kind === "event") {
      this.events.push(msg);
      // project.replay_events re-emits envelopes with their ORIGINAL sequence
      // numbers (protocol: dedupe/续传 by sequence); track the high-water mark
      // of first observations for monotonicity and replay assertions.
      if (msg.sequence > this.maxSequence) this.maxSequence = msg.sequence;
      if (msg.event === "engine.error") {
        failures.push(`engine.error event: ${JSON.stringify(msg.payload).slice(0, 200)}`);
      }
      this.onEvent?.(msg);
    } else {
      failures.push(`unexpected stdout kind "${msg.kind}"`);
    }
  }

  request(method, payload = {}) {
    const id = `smoke-${this.pending.size + 1}-${method}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(JSON.stringify({ protocol: "desktop-v1", kind: "request", id, method, payload }) + "\n");
    });
  }

  async expectRequest(method, label, payload = {}) {
    try {
      const out = await this.request(method, payload);
      console.log(`  ok: ${label}`);
      return out;
    } catch (e) {
      failures.push(`${label} (${e.code ?? ""} ${e.message})`);
      console.error(`  FAIL: ${label}: ${e.message}`);
      return null;
    }
  }

  waitFor(predicate, label, timeoutMs = REQUEST_TIMEOUT_MS) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onEvent = undefined;
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      const prev = this.onEvent;
      this.onEvent = (msg) => {
        prev?.(msg);
        if (predicate(msg)) {
          clearTimeout(timer);
          this.onEvent = prev;
          resolve(msg);
        }
      };
    });
  }

  sequencesMonotonic() {
    // First observation of each sequence must be strictly increasing;
    // replays re-emit original sequences and are skipped as echoes.
    const seen = new Set();
    let last = 0;
    for (const ev of this.events) {
      if (seen.has(ev.sequence)) continue;
      seen.add(ev.sequence);
      if (ev.sequence <= last) return false;
      last = ev.sequence;
    }
    return true;
  }

  async shutdown() {
    await this.expectRequest("engine.shutdown", "engine.shutdown accepted", { reason: "protocol smoke" });
    const code = await new Promise((resolve) => {
      if (this.exited !== null) return resolve(this.exited);
      this.proc.on("exit", resolve);
      setTimeout(() => resolve("timeout"), REQUEST_TIMEOUT_MS);
    });
    check(code === 0, `engine exited cleanly after shutdown (code=${code})`);
  }
}

async function waitForReady(engine, label) {
  try {
    const ready = await engine.waitFor((ev) => ev.event === "engine.ready", "engine.ready", REQUEST_TIMEOUT_MS);
    console.log(`  ok: ${label} (session=${ready.session})`);
    check(typeof ready.session === "string" && ready.session.length > 0, `${label} carries a session id`);
    check(ready.sequence === 1, `${label} is the first event (sequence=1)`);
    engine.session = ready.session;
    return ready;
  } catch (e) {
    failures.push(`${label}: ${e.message}`);
    console.error(`  FAIL: ${label}: ${e.message}`);
    return null;
  }
}

async function main() {
  mkdirSync(WORKDIR, { recursive: true });
  const projectDir = join(WORKDIR, "project");
  const exportDir = join(WORKDIR, "export");
  mkdirSync(exportDir, { recursive: true });
  const exportPath = join(exportDir, "chapter-1.txt");
  console.log(`protocol-smoke: engine=${ENGINE}`);
  console.log(`protocol-smoke: workdir=${WORKDIR}`);

  // ── Session 1 ─────────────────────────────────────────────────────────
  console.log("session 1: create / save / export / replay");
  const s1 = new EngineSession();
  await waitForReady(s1, "engine.ready (session 1)");

  await s1.expectRequest("engine.ping", "engine.ping round-trip");
  const created = await s1.expectRequest("project.create", "project.create", {
    path: projectDir,
    name: "Protocol Smoke",
  });
  if (created) {
    check(created.created === true, "project.create reports created=true");
    check(typeof created.project_id === "string" && created.project_id.length > 0, "project.create returns project_id");
  }

  // Seed minimal book metadata (input data on disk, like a corpus file).
  // The exporter requires meta/book.json; on real projects it is written by
  // the generation/import flows, both of which are LLM-backed and therefore
  // excluded from CI. Every behavior asserted below still goes through the
  // protocol.
  mkdirSync(join(projectDir, "meta"), { recursive: true });
  writeFileSync(
    join(projectDir, "meta", "book.json"),
    JSON.stringify({ title: "Protocol Smoke", synopsis: "LLM-free packaging smoke" }),
  );

  const snapshot = await s1.expectRequest("project.snapshot", "project.snapshot");
  if (snapshot) check(typeof snapshot.total_chapters === "number", "project.snapshot exposes total_chapters");

  const savePromise = s1.waitFor((ev) => ev.event === "chapter.updated" && ev.payload?.chapter === 1, "chapter.updated(1)");
  const saved = await s1.expectRequest("chapter.save", "chapter.save(1)", { chapter: 1, content: CHAPTER_CONTENT });
  if (saved) check(saved.saved === true && saved.version >= 1, "chapter.save reports saved + version");
  try {
    await savePromise;
    console.log("  ok: chapter.updated(1) event observed");
  } catch (e) {
    failures.push(`chapter.updated(1): ${e.message}`);
    console.error(`  FAIL: chapter.updated(1): ${e.message}`);
  }

  const list = await s1.expectRequest("chapter.list", "chapter.list");
  if (list) check(list.completed >= 1 && list.chapters?.some((c) => c.chapter === 1), "chapter.list shows chapter 1 completed");

  const read = await s1.expectRequest("chapter.read", "chapter.read(1)", { chapter: 1 });
  if (read) check(String(read.content ?? "").includes(MARKER), "chapter.read returns the saved content");

  // run.abort on an idle project is a SUPPORTED no-op (stopped=false) — the
  // documented abort semantics without a generation run. run.steer on an
  // idle project would be rejected by the engine and is intentionally not
  // scripted (see header).
  const aborted = await s1.expectRequest("run.abort", "run.abort idle no-op", { reason: "protocol smoke" });
  if (aborted) check(aborted.stopped === false, "run.abort reports stopped=false when idle");

  const lastSeqBeforeReplay = s1.maxSequence;
  const replayDelta = await s1.expectRequest("project.replay_events", "project.replay_events(after_sequence=N)", {
    after_sequence: lastSeqBeforeReplay,
  });
  if (replayDelta) check(replayDelta.replayed === 0, "replay_events after the last sequence replays 0");

  const replayAll = await s1.expectRequest("project.replay_events", "project.replay_events(from 0)", { after_sequence: 0 });
  if (replayAll) check(replayAll.replayed > 0, "replay_events from 0 replays history");

  const logs = await s1.expectRequest("logs.replay", "logs.replay", { limit: 10 });
  if (logs) check(Array.isArray(logs.records), "logs.replay returns records array");

  const exported = await s1.expectRequest("chapter.export", "chapter.export(1) -> txt", {
    output_path: exportPath,
    chapters: [1],
    format: "txt",
  });
  if (exported) {
    check(typeof exported.path === "string" && exported.path.length > 0, "chapter.export returns path");
    check(exported.chapters === 1, `chapter.export wrote 1 chapter (count=${exported.chapters})`);
    check(Number(exported.bytes) > 0, "chapter.export reports bytes > 0");
    try {
      const text = readFileSync(exportPath, "utf8");
      check(text.includes(MARKER), "exported file contains the chapter content");
    } catch (e) {
      failures.push(`exported file readable: ${e.message}`);
      console.error(`  FAIL: exported file readable: ${e.message}`);
    }
  }

  check(s1.sequencesMonotonic(), "session 1 event sequences strictly monotonic");
  check(s1.stderrLines > 0, "engine logs on stderr (forwarded by the shell in production)");
  await s1.shutdown();

  // ── Session 2: restart → new session, sequence reset, recovery ────────
  console.log("session 2: restart / recover / inspect");
  const s2 = new EngineSession();
  const ready2 = await waitForReady(s2, "engine.ready (session 2)");
  if (ready2 && s1.session) check(s2.session !== s1.session, "restart produces a new engine session id");

  const reopened = await s2.expectRequest("project.open", "project.open after restart", { path: projectDir });
  if (reopened) {
    check(reopened.created === undefined, "project.open does not report created=true");
    if (created) check(reopened.project_id === created.project_id, "project.open recovers the same project_id");
  }

  const replayAfterRestart = await s2.expectRequest("project.replay_events", "replay_events after restart (memory reset)", {
    after_sequence: 0,
  });
  if (replayAfterRestart) {
    // Replay is per-session memory: session 2 may replay its OWN few events,
    // but its numbering must not carry over from session 1.
    check(
      replayAfterRestart.last_sequence < s1.maxSequence,
      `replay after restart reflects fresh sequences (last=${replayAfterRestart.last_sequence} < session-1 high-water ${s1.maxSequence})`,
    );
    check(replayAfterRestart.replayed <= s2.maxSequence, "replay after restart is bounded by session-2 events");
  }

  const reread = await s2.expectRequest("chapter.read", "chapter.read(1) after restart", { chapter: 1 });
  if (reread) check(String(reread.content ?? "").includes(MARKER), "chapter content persisted across restart");

  check(s2.sequencesMonotonic(), "session 2 event sequences strictly monotonic");
  await s2.shutdown();

  rmSync(WORKDIR, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`\nprotocol-smoke: FAILED (${failures.length} assertion(s))`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nprotocol-smoke: PASSED");
}

main().catch((e) => {
  console.error(`protocol-smoke: fatal: ${e.message}`);
  process.exit(1);
});
