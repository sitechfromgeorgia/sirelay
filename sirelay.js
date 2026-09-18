#!/usr/bin/env node
/**
 * SiRelay Agent — runs on any Windows / Linux / macOS machine.
 *
 *   1. Put sirelay.config.json next to this file:
 *      { "server": "http://YOUR_SERVER:8123", "key": "SECRET", "name": "residential-node" }
 *   2. Run:  node sirelay.js
 *
 * The agent long-polls the coordinator for fetch jobs, executes them from
 * THIS machine's IP (residential => bypasses datacenter blocks), and posts
 * results back. On startup it safely self-updates from GitHub Releases.
 *
 * Zero external dependencies — Node 18+ standard library only.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

export const VERSION = "0.4.0";
const REPO = process.env.SIRELAY_REPO || "sitechfromgeorgia/sirelay";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Configuration ----------
export function loadConfig() {
  const configPath = path.join(__dirname, "sirelay.config.json");
  let cfg = {};

  if (existsSync(configPath)) {
    try {
      cfg = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      console.error(`[sirelay] Invalid JSON in ${configPath}: ${err.message}`);
      process.exit(1);
    }
  }

  // Allow environment variable overrides
  cfg.server = process.env.SIRELAY_SERVER || cfg.server;
  cfg.key = process.env.SIRELAY_KEY || cfg.key;
  cfg.name = process.env.SIRELAY_NAME || cfg.name || os.hostname();

  if (!cfg.server || !cfg.key) {
    console.error(`[sirelay] Missing server or key. Create ${configPath} with {"server","key","name"} or set SIRELAY_SERVER and SIRELAY_KEY`);
    process.exit(1);
  }

  // Normalize server URL (remove trailing slash)
  cfg.server = cfg.server.replace(/\/+$/, "");
  return cfg;
}

// ---------- Safe Self-Update from GitHub Releases ----------
export async function selfUpdate() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        "User-Agent": `sirelay-agent/${VERSION}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return; // Release not found or offline/rate-limited

    const rel = await r.json();
    const latest = (rel.tag_name || "").replace(/^v/, "").trim();
    if (!latest || latest === VERSION) return;

    const asset = (rel.assets || []).find((a) => a.name === "sirelay.js");
    if (!asset || !asset.browser_download_url) return;

    console.log(`[sirelay] Update found: v${VERSION} -> v${latest}, downloading...`);
    const resp = await fetch(asset.browser_download_url, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
    const code = await resp.text();

    if (!code.includes("SiRelay Agent") || code.length < 2000) {
      throw new Error("Downloaded asset failed verification checks");
    }

    const self = path.join(__dirname, "sirelay.js");
    const tmp = `${self}.tmp.${Date.now()}`;
    writeFileSync(tmp, code, { mode: 0o755 });

    // Validate syntax before replacing
    const check = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
    if (check.status !== 0) {
      try { unlinkSync(tmp); } catch {}
      throw new Error(`Downloaded code failed syntax verification: ${check.stderr}`);
    }

    renameSync(tmp, self);
    console.log("[sirelay] Successfully updated agent script. Respawning...");

    spawn(process.execPath, [self], {
      detached: true,
      stdio: "inherit",
    }).unref();

    process.exit(0);
  } catch (err) {
    console.log(`[sirelay] Self-update check skipped (${err.message})`);
  }
}

// ---------- Fetch Job Execution ----------
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export async function runJob(job, signal = null) {
  const started = Date.now();
  try {
    const combinedSignal = signal
      ? AbortSignal.any([AbortSignal.timeout(30_000), signal])
      : AbortSignal.timeout(30_000);

    const resp = await fetch(job.url, {
      method: job.opts?.method || "GET",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8",
        "Accept-Language": "ka-GE,ka;q=0.9,en;q=0.8",
        ...(job.opts?.headers || {}),
      },
      redirect: "follow",
      signal: combinedSignal,
    });

    const buf = Buffer.from(await resp.arrayBuffer());
    const headers = {};
    resp.headers.forEach((v, k) => {
      headers[k] = v;
    });

    return {
      ok: resp.ok,
      status: resp.status,
      headers,
      bodyB64: buf.subarray(0, 8 * 1024 * 1024).toString("base64"),
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      headers: {},
      bodyB64: "",
      error: err.message,
      ms: Date.now() - started,
    };
  }
}

// ---------- Post Result with Retries ----------
async function submitResult(server, authHeader, jobId, result) {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${server}/v1/agent/result`, {
        method: "POST",
        headers: {
          ...authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jobId, ...result }),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status === 404) {
        console.warn(`[sirelay] Job #${jobId} was expired or coordinator restarted; discarded`);
        return true;
      }

      if (res.ok) {
        return true;
      }

      console.warn(`[sirelay] Result submission HTTP ${res.status}, attempt ${attempt + 1}/${maxRetries + 1}`);
    } catch (err) {
      console.warn(`[sirelay] Result submission network error: ${err.message}, attempt ${attempt + 1}/${maxRetries + 1}`);
    }

    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return false;
}

// ---------- Main Agent Polling Loop ----------
let isRunning = true;
let activeController = null;

async function handleShutdown(cfg = null) {
  if (!isRunning) return;
  isRunning = false;
  console.log("\n[sirelay] Shutting down agent cleanly...");
  if (activeController) {
    activeController.abort();
  }
  if (cfg && cfg.server && cfg.key) {
    try {
      await fetch(`${cfg.server}/v1/agent/bye?node=${encodeURIComponent(cfg.name)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.key}` },
        signal: AbortSignal.timeout(1500),
      });
    } catch {}
  }
  process.exit(0);
}

export async function main() {
  const cfg = loadConfig();
  const onSignal = () => handleShutdown(cfg);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  console.log(`[sirelay] v${VERSION} node="${cfg.name}" server=${cfg.server}`);
  await selfUpdate();

  const authHeader = { Authorization: `Bearer ${cfg.key}` };
  let failures = 0;

  while (isRunning) {
    activeController = new AbortController();
    try {
      // Build heartbeat query parameters
      const params = new URLSearchParams({
        node: cfg.name,
        version: VERSION,
        os: `${process.platform}-${process.arch}`,
        uptime: String(Math.floor(process.uptime())),
      });

      const pollUrl = `${cfg.server}/v1/agent/poll?${params.toString()}`;
      const r = await fetch(pollUrl, {
        headers: authHeader,
        signal: AbortSignal.any([AbortSignal.timeout(25_000), activeController.signal]),
      });

      failures = 0;

      if (r.status === 204) {
        // Long-poll timeout with no jobs; continue immediately
        continue;
      }

      if (!r.ok) {
        console.error(`[sirelay] Poll received HTTP ${r.status}`);
        await new Promise((s) => setTimeout(s, 5000));
        continue;
      }

      const data = await r.json();
      const job = data?.job;
      if (!job) continue;

      const urlPreview = job.url.length > 80 ? job.url.slice(0, 80) + "…" : job.url;
      process.stdout.write(`[sirelay] Executing job #${job.id}: ${urlPreview} … `);

      const result = await runJob(job, activeController.signal);
      console.log(`${result.status || "ERR"} in ${result.ms}ms`);

      await submitResult(cfg.server, authHeader, job.id, result);
    } catch (err) {
      if (!isRunning) break;

      failures++;
      // Exponential backoff with random jitter to avoid thundering herd
      const baseWait = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
      const jitter = 0.8 + Math.random() * 0.4;
      const wait = Math.round(baseWait * jitter);

      console.error(`[sirelay] Connection error (${err.message}); retrying in ${(wait / 1000).toFixed(1)}s`);
      await new Promise((s) => setTimeout(s, wait));
    } finally {
      activeController = null;
    }
  }
}

if (process.env.NODE_ENV !== "test") {
  main();
}
