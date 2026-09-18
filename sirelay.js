#!/usr/bin/env node
/**
 * SiRelay Agent — runs on any Windows / Linux / macOS machine.
 *
 *   1. Put sirelay.config.json next to this file:
 *      { "server": "http://YOUR_SERVER:8123", "key": "SECRET", "name": "edos-laptop" }
 *   2. Run:  node sirelay.js
 *
 * The agent long-polls the coordinator for fetch jobs, executes them from
 * THIS machine's IP (residential => bypasses datacenter blocks), and posts
 * results back. On startup it self-updates from GitHub Releases.
 *
 * Zero dependencies — Node 18+ only (global fetch).
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const VERSION = "0.1.0";
const REPO = "sitechfromgeorgia/sirelay"; // public repo: release asset "sirelay.js"
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
function loadConfig() {
  const p = path.join(__dirname, "sirelay.config.json");
  if (!existsSync(p)) {
    console.error(`[sirelay] create ${p} with {"server","key","name"?} — see README`);
    process.exit(1);
  }
  const c = JSON.parse(readFileSync(p, "utf8"));
  if (!c.server || !c.key) {
    console.error("[sirelay] config needs server + key");
    process.exit(1);
  }
  c.name = c.name || os.hostname();
  return c;
}

// ---------- self-update from GitHub Releases ----------
async function selfUpdate() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "sirelay-agent", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return; // no releases yet / offline — fine
    const rel = await r.json();
    const latest = (rel.tag_name || "").replace(/^v/, "");
    if (!latest || latest === VERSION) return;
    const asset = (rel.assets || []).find((a) => a.name === "sirelay.js");
    if (!asset) return;
    console.log(`[sirelay] update ${VERSION} -> ${latest}, downloading…`);
    const code = await (await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(20000) })).text();
    if (!code.includes("SiRelay Agent") || code.length < 2000) throw new Error("bad download");
    const self = path.join(__dirname, "sirelay.js");
    writeFileSync(self + ".new", code);
    renameSync(self + ".new", self);
    console.log("[sirelay] updated, restarting…");
    spawn(process.execPath, [self], { detached: true, stdio: "inherit" }).unref();
    process.exit(0);
  } catch (e) {
    console.log("[sirelay] update check failed (continuing):", e.message);
  }
}

// ---------- fetch job execution ----------
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function runJob(job) {
  const started = Date.now();
  try {
    const resp = await fetch(job.url, {
      method: job.opts?.method || "GET",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8",
        "Accept-Language": "ka-GE,ka;q=0.9,en;q=0.8",
        ...(job.opts?.headers || {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    const headers = {};
    resp.headers.forEach((v, k) => (headers[k] = v));
    return {
      ok: resp.ok,
      status: resp.status,
      headers,
      bodyB64: buf.subarray(0, 8 * 1024 * 1024).toString("base64"),
      ms: Date.now() - started,
    };
  } catch (e) {
    return { ok: false, status: 0, headers: {}, bodyB64: "", error: e.message, ms: Date.now() - started };
  }
}

// ---------- main loop ----------
async function main() {
  const cfg = loadConfig();
  console.log(`[sirelay] v${VERSION} node="${cfg.name}" server=${cfg.server}`);
  await selfUpdate();

  const auth = { Authorization: `Bearer ${cfg.key}` };
  let failures = 0;

  for (;;) {
    try {
      const r = await fetch(
        `${cfg.server}/v1/agent/poll?node=${encodeURIComponent(cfg.name)}`,
        { headers: auth, signal: AbortSignal.timeout(25_000) }
      );
      failures = 0;
      if (r.status === 204) continue; // no work
      if (!r.ok) {
        console.error("[sirelay] poll", r.status);
        await new Promise((s) => setTimeout(s, 5000));
        continue;
      }
      const { job } = await r.json();
      if (!job) continue;
      process.stdout.write(`[sirelay] fetch ${job.url.slice(0, 90)} … `);
      const result = await runJob(job);
      console.log(`${result.status} in ${result.ms}ms`);
      await fetch(`${cfg.server}/v1/agent/result`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, ...result }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      failures++;
      const wait = Math.min(30_000, 1000 * 2 ** failures);
      console.error(`[sirelay] ${e.message}; retry in ${wait / 1000}s`);
      await new Promise((s) => setTimeout(s, wait));
    }
  }
}

main();
