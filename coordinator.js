#!/usr/bin/env node
/**
 * SiRelay Coordinator — central job broker for the personal residential fetch network.
 *
 * Projects POST fetch jobs; agents (residential machines, any OS) poll for jobs,
 * fetch from their residential IPs, and POST results back.
 *
 * API (Bearer authentication required unless noted):
 *   POST /v1/fetch                Submit a fetch job (master key required)
 *   GET  /v1/agent/poll?node=NAME Agent long-poll for next job (agent key or master key)
 *   POST /v1/agent/result         Agent submits completed fetch result
 *   GET  /v1/nodes                List registered/online nodes and telemetry
 *   GET  /v1/stats                Aggregated job statistics and node metrics
 *   GET  /v1/health               Public health check (no auth required)
 *   GET  / or /dashboard          Single-file dark theme dashboard
 *
 * Zero external dependencies — Node.js 18+ standard library only.
 */
import http from "node:http";
import https from "node:https";
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, renameSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";

export const VERSION = "0.3.0";

// ==========================================
// Configuration
// ==========================================
export const CONFIG = {
  PORT: Number(process.env.PORT || 8123),
  HOST: process.env.HOST || "0.0.0.0",
  KEY: process.env.SIRELAY_KEY || "change-me",
  NODES_FILE: process.env.SIRELAY_NODES_FILE || "/root/.sirelay-nodes.json",
  ALLOWLIST: (process.env.SIRELAY_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  ALLOW_PRIVATE_IPS: process.env.SIRELAY_ALLOW_PRIVATE_IPS === "true",
  RATE_LIMIT_RPM: Number(process.env.SIRELAY_RATE_LIMIT || 120), // 0 disables rate limiting
  MAX_BODY: 8 * 1024 * 1024, // 8MB for results
  MAX_FETCH_BODY: 64 * 1024, // 64KB for /v1/fetch parameters
  DEFAULT_CLIENT_TIMEOUT_MS: 25_000,
  MAX_CLIENT_TIMEOUT_MS: 60_000,
  AGENT_LEASE_TIMEOUT_MS: 18_000, // re-queue lease if agent dies mid-fetch
  NODE_TIMEOUT_MS: 45_000, // node considered online if seen within 45s
  NODE_PRUNE_MS: 24 * 60 * 60 * 1000, // prune nodes unseen for 24h
  MAX_JOB_ATTEMPTS: 2,
  LOG_LEVEL: (process.env.SIRELAY_LOG_LEVEL || "INFO").toUpperCase(),
  LOG_FILE: process.env.SIRELAY_LOG_FILE || "sirelay.log",
  STATS_FILE: process.env.SIRELAY_STATS_FILE || "sirelay-jobs.jsonl",
  MAX_LOG_SIZE: 10 * 1024 * 1024, // 10MB
  MAX_STATS_ENTRIES: 10_000,
  SSL_CERT: process.env.SSL_CERT || "",
  SSL_KEY: process.env.SSL_KEY || "",
};

// ==========================================
// Structured Logger with File Rotation
// ==========================================
const LOG_LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const currentLogLevel = LOG_LEVELS[CONFIG.LOG_LEVEL] ?? LOG_LEVELS.INFO;

function rotateLogIfNeeded(filePath) {
  try {
    if (!existsSync(filePath)) return;
    const stats = statSync(filePath);
    if (stats.size < CONFIG.MAX_LOG_SIZE) return;

    for (let i = 2; i >= 1; i--) {
      const oldFile = `${filePath}.${i}`;
      const nextFile = `${filePath}.${i + 1}`;
      if (existsSync(oldFile)) {
        try { renameSync(oldFile, nextFile); } catch {}
      }
    }
    renameSync(filePath, `${filePath}.1`);
  } catch {}
}

export const logger = {
  log(level, msg, meta = {}) {
    const numericLevel = LOG_LEVELS[level] ?? LOG_LEVELS.INFO;
    if (numericLevel < currentLogLevel) return;

    const iso = new Date().toISOString();
    const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
    const line = `[${iso}] [${level.padEnd(5)}] ${msg}${metaStr}\n`;

    if (level === "ERROR") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }

    if (CONFIG.LOG_FILE && CONFIG.LOG_FILE !== "none") {
      try {
        rotateLogIfNeeded(CONFIG.LOG_FILE);
        appendFileSync(CONFIG.LOG_FILE, line);
      } catch {}
    }
  },
  debug(msg, meta) { this.log("DEBUG", msg, meta); },
  info(msg, meta) { this.log("INFO", msg, meta); },
  warn(msg, meta) { this.log("WARN", msg, meta); },
  error(msg, meta) { this.log("ERROR", msg, meta); },
};

// ==========================================
// Multi-Key Management & Timing-Safe Auth
// ==========================================
export function loadNodeKeys(filePath = CONFIG.NODES_FILE) {
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8");
      return JSON.parse(content);
    }
  } catch (err) {
    logger.warn(`Failed to parse node keys from ${filePath}: ${err.message}`);
  }
  return {};
}

export let nodeKeys = loadNodeKeys();

export function setNodeKeys(keys) {
  nodeKeys = keys;
}

/** Timing-safe string comparison using SHA-256 digests */
export function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Validates request authorization.
 * Returns { role: 'master' | 'agent', node?: string } or null.
 */
export function verifyAuth(req, expectedNode = null) {
  let token = "";
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (match) {
    token = match[1].trim();
  } else {
    // Check URL query token for dashboard convenience
    try {
      const u = new URL(req.url, "http://localhost");
      if (u.searchParams.has("key")) {
        token = u.searchParams.get("key") || "";
      }
    } catch {}
  }

  if (!token) return null;

  // Master key check (has client role: can fetch, read stats/nodes/dashboard)
  if (safeCompare(token, CONFIG.KEY)) {
    return { role: "master", node: expectedNode || null };
  }

  // Node key check (has agent role: can poll and report results)
  if (expectedNode) {
    const registeredKey = nodeKeys[expectedNode];
    if (registeredKey && safeCompare(token, registeredKey)) {
      return { role: "agent", node: expectedNode };
    }
    return null;
  }

  for (const [name, registeredKey] of Object.entries(nodeKeys)) {
    if (typeof registeredKey === "string" && safeCompare(token, registeredKey)) {
      return { role: "agent", node: name };
    }
  }

  return null;
}

// ==========================================
// Security: SSRF & Hostname Validation
// ==========================================
const PRIVATE_IP_REGEXES = [
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // IPv4 loopback (127.0.0.0/8)
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // RFC 1918 Class A (10.0.0.0/8)
  /^192\.168\.\d{1,3}\.\d{1,3}$/, // RFC 1918 Class C (192.168.0.0/16)
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/, // RFC 1918 Class B (172.16.0.0/12)
  /^169\.254\.\d{1,3}\.\d{1,3}$/, // Link-local / Cloud metadata (169.254.0.0/16)
  /^0\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // Current network (0.0.0.0/8)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/, // CGNAT (100.64.0.0/10)
  /^::1$/, // IPv6 loopback
  /^f[cd][0-9a-f]{2}:/i, // IPv6 Unique Local (fc00::/7)
  /^fe80:/i, // IPv6 Link-Local (fe80::/10)
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "instance-data",
  "169.254.169.254",
]);

export function isBlockedHost(hostname) {
  if (CONFIG.ALLOW_PRIVATE_IPS) return false;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  for (const rx of PRIVATE_IP_REGEXES) {
    if (rx.test(h)) return true;
  }
  return false;
}

export function hostAllowed(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (isBlockedHost(u.hostname)) return false;

    if (!CONFIG.ALLOWLIST.length) return true;
    const h = u.hostname.toLowerCase();
    return CONFIG.ALLOWLIST.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
}

// ==========================================
// Rate Limiter
// ==========================================
const rateLimitBuckets = new Map();

function checkRateLimit(key) {
  if (!CONFIG.RATE_LIMIT_RPM || CONFIG.RATE_LIMIT_RPM <= 0) return { allowed: true };
  const now = Date.now();
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60_000 };
    rateLimitBuckets.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > CONFIG.RATE_LIMIT_RPM) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { allowed: false, retryAfter };
  }
  return { allowed: true };
}

// Clean up expired rate limit buckets periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateLimitBuckets) {
    if (now >= b.resetAt) rateLimitBuckets.delete(k);
  }
}, 60_000).unref();

// ==========================================
// State & Statistics
// ==========================================
/** @type {Map<string, { id: string, url: string, opts: any, created: number, timeoutMs: number, attempts: number, assignedNode: string|null, assignedAt: number|null, leaseTimer: any, timeoutTimer: any, clientRes: http.ServerResponse, resolve: Function, cancelled: boolean }>} */
export const jobs = new Map();

/** @type {Array<{ node: string, res: http.ServerResponse, req: http.IncomingMessage, finish: Function, fire: (job: any) => void }>} */
export const agentWaiters = [];

/**
 * @type {Map<string, {
 *   lastSeen: number,
 *   jobsDone: number,
 *   jobsFailed: number,
 *   totalLatencyMs: number,
 *   lastJobTs: number,
 *   version?: string,
 *   os?: string,
 *   uptimeSec?: number
 * }>}
 */
export const nodes = new Map();

/** Circular bounded in-memory list of recent job results for stats/dashboard */
export const recentJobs = [];
const MAX_RECENT_JOBS = 200;

export const globalStats = {
  totalSubmitted: 0,
  totalCompleted: 0,
  totalFailed: 0,
  startedAt: Date.now(),
};

let nextJobId = 1;

// Load previous stats from persistent JSONL file if present
export function recoverStatsFromFile(filePath = CONFIG.STATS_FILE) {
  try {
    if (!existsSync(filePath)) return;
    const content = readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n");
    for (const line of lines) {
      if (!line) continue;
      try {
        const item = JSON.parse(line);
        globalStats.totalSubmitted++;
        if (item.ok) {
          globalStats.totalCompleted++;
        } else {
          globalStats.totalFailed++;
        }

        if (item.node) {
          let node = nodes.get(item.node);
          if (!node) {
            node = {
              lastSeen: item.timestamp || 0,
              jobsDone: 0,
              jobsFailed: 0,
              totalLatencyMs: 0,
              lastJobTs: item.timestamp || 0,
            };
            nodes.set(item.node, node);
          }
          if (item.ok) {
            node.jobsDone++;
          } else {
            node.jobsFailed++;
          }
          if (item.durationMs) node.totalLatencyMs += item.durationMs;
        }

        recentJobs.unshift(item);
        if (recentJobs.length > MAX_RECENT_JOBS) recentJobs.pop();
      } catch {}
    }
    logger.info(`Recovered ${lines.length} job history entries from ${filePath}`);
  } catch (err) {
    logger.warn(`Could not recover stats from ${filePath}: ${err.message}`);
  }
}

recoverStatsFromFile();

export function persistJobResult(jobRecord, filePath = CONFIG.STATS_FILE) {
  try {
    const line = JSON.stringify(jobRecord) + "\n";
    appendFileSync(filePath, line);
  } catch (err) {
    logger.error(`Failed to persist job record to ${filePath}: ${err.message}`);
  }
}

// ==========================================
// Job Broker Helpers
// ==========================================
export function getOnlineNodeNames() {
  const now = Date.now();
  const online = [];
  for (const [name, meta] of nodes) {
    if (now - meta.lastSeen < CONFIG.NODE_TIMEOUT_MS) {
      online.push(name);
    }
  }
  return online;
}

/** Pick the least-recently-used online node */
export function pickLeastRecentlyUsedNode() {
  const online = getOnlineNodeNames();
  if (!online.length) return null;
  online.sort((a, b) => {
    const lastA = nodes.get(a)?.lastJobTs || 0;
    const lastB = nodes.get(b)?.lastJobTs || 0;
    return lastA - lastB;
  });
  return online[0];
}

/** Dispatches a job to the best waiting agent, or leaves it queued */
export function dispatchJob(job) {
  if (job.cancelled || !jobs.has(job.id)) return;

  // Filter valid live waiters
  while (agentWaiters.length > 0) {
    const targetNode = pickLeastRecentlyUsedNode();
    let idx = agentWaiters.findIndex((w) => w.node === targetNode);
    if (idx < 0) idx = 0; // Fallback to oldest waiter

    const waiter = agentWaiters.splice(idx, 1)[0];
    if (waiter.res.writableEnded || waiter.res.destroyed) {
      continue; // Skip dead connection
    }

    // Assign job to this node
    job.assignedNode = waiter.node;
    job.assignedAt = Date.now();
    job.attempts++;

    const nodeRecord = nodes.get(waiter.node);
    if (nodeRecord) nodeRecord.lastJobTs = Date.now();

    // Set an assignment lease timeout in case agent dies mid-fetch
    if (job.leaseTimer) clearTimeout(job.leaseTimer);
    job.leaseTimer = setTimeout(() => {
      handleJobLeaseTimeout(job.id);
    }, CONFIG.AGENT_LEASE_TIMEOUT_MS);

    logger.info(`Dispatched job ${job.id} to node "${waiter.node}" (attempt ${job.attempts})`);
    waiter.fire(job);
    return;
  }
}

function handleJobLeaseTimeout(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.cancelled) return;

  logger.warn(`Job ${jobId} lease expired on node "${job.assignedNode}"`);

  // Record node failure for timing out
  if (job.assignedNode) {
    const n = nodes.get(job.assignedNode);
    if (n) n.jobsFailed = (n.jobsFailed || 0) + 1;
  }

  // Can we retry?
  if (job.attempts < CONFIG.MAX_JOB_ATTEMPTS) {
    job.assignedNode = null;
    job.assignedAt = null;
    dispatchJob(job);
  } else {
    // Max attempts reached
    cleanFinishJob(jobId, {
      ok: false,
      error: `job timed out after ${job.attempts} attempts`,
      node: job.assignedNode,
    });
  }
}

export function cleanFinishJob(jobId, result) {
  const job = jobs.get(jobId);
  if (!job) return;

  if (job.leaseTimer) clearTimeout(job.leaseTimer);
  if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
  jobs.delete(jobId);

  const durationMs = Date.now() - job.created;
  const nodeName = result.node || job.assignedNode || null;

  if (nodeName) {
    let nodeMeta = nodes.get(nodeName);
    if (!nodeMeta) {
      nodeMeta = {
        lastSeen: Date.now(),
        jobsDone: 0,
        jobsFailed: 0,
        totalLatencyMs: 0,
        lastJobTs: Date.now(),
      };
      nodes.set(nodeName, nodeMeta);
    }
    if (result.ok) {
      nodeMeta.jobsDone++;
      globalStats.totalCompleted++;
    } else {
      nodeMeta.jobsFailed++;
      globalStats.totalFailed++;
    }
    nodeMeta.totalLatencyMs += durationMs;
  } else {
    if (result.ok) {
      globalStats.totalCompleted++;
    } else {
      globalStats.totalFailed++;
    }
  }

  // Persist record
  const logRecord = {
    timestamp: Date.now(),
    id: jobId,
    url: job.url,
    node: nodeName,
    ok: !!result.ok,
    status: result.status ?? 0,
    durationMs,
  };
  persistJobResult(logRecord);

  recentJobs.unshift(logRecord);
  if (recentJobs.length > MAX_RECENT_JOBS) recentJobs.pop();

  job.resolve?.(result);
}

// Background maintenance: clean stale jobs and prune ancient nodes
setInterval(() => {
  const now = Date.now();
  // Prune nodes not seen in 24 hours
  for (const [name, meta] of nodes) {
    if (now - meta.lastSeen > CONFIG.NODE_PRUNE_MS) {
      nodes.delete(name);
      logger.info(`Pruned stale node "${name}" (unseen for >24h)`);
    }
  }
}, 60_000).unref();

// Periodic nodeKeys reload (every 30 seconds)
setInterval(() => {
  nodeKeys = loadNodeKeys();
}, 30_000).unref();

// ==========================================
// HTTP Request Helpers
// ==========================================
function readBody(req, maxLimit = CONFIG.MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxLimit) {
        const err = new Error("payload_too_large");
        err.code = "PAYLOAD_TOO_LARGE";
        req.destroy(err);
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => reject(err));
  });
}

function sendJson(res, statusCode, data) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ==========================================
// Dashboard HTML
// ==========================================
function renderDashboard() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SiRelay — Fleet & Job Monitor</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --accent: #58a6ff;
      --success: #238636;
      --success-text: #3fb950;
      --danger: #da3633;
      --danger-text: #f85149;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      line-height: 1.5;
      padding: 24px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .logo {
      font-size: 1.5rem;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .logo span { color: var(--accent); }
    .badge-ver {
      font-size: 0.75rem;
      background: #21262d;
      border: 1px solid var(--border);
      padding: 2px 8px;
      border-radius: 12px;
      color: var(--text-muted);
    }
    .status-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .live-dot {
      width: 10px;
      height: 10px;
      background: var(--success-text);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--success-text);
      display: inline-block;
    }
    .grid-metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .card-title {
      font-size: 0.8rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .card-value {
      font-size: 1.8rem;
      font-weight: 700;
      color: #fff;
    }
    .section-title {
      font-size: 1.1rem;
      font-weight: 600;
      color: #fff;
      margin-bottom: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.875rem;
    }
    th, td {
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
    }
    th {
      background: #1c2128;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.75rem;
    }
    tr:last-child td { border-bottom: none; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-online { background: rgba(63, 185, 80, 0.15); color: var(--success-text); border: 1px solid rgba(63, 185, 80, 0.3); }
    .badge-offline { background: rgba(139, 148, 158, 0.15); color: var(--text-muted); border: 1px solid var(--border); }
    .status-200 { color: var(--success-text); font-weight: 600; }
    .status-err { color: var(--danger-text); font-weight: 600; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .table-container {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    .empty { padding: 24px; text-align: center; color: var(--text-muted); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">
        <span>⚡ SiRelay</span> Dashboard
        <span class="badge-ver">v${VERSION}</span>
      </div>
      <div class="status-bar">
        <span class="live-dot"></span>
        <span id="refresh-status">Live (3s polling)</span>
      </div>
    </header>

    <div class="grid-metrics">
      <div class="card">
        <div class="card-title">Fleet Online</div>
        <div class="card-value" id="metric-online">-</div>
      </div>
      <div class="card">
        <div class="card-title">In-Flight Jobs</div>
        <div class="card-value" id="metric-active">-</div>
      </div>
      <div class="card">
        <div class="card-title">Completed Jobs</div>
        <div class="card-value" id="metric-completed">-</div>
      </div>
      <div class="card">
        <div class="card-title">Success Rate</div>
        <div class="card-value" id="metric-rate">-</div>
      </div>
    </div>

    <div class="section-title">Fleet Nodes</div>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Node Name</th>
            <th>Status</th>
            <th>Version</th>
            <th>OS / Platform</th>
            <th>Last Seen</th>
            <th>Completed</th>
            <th>Success Rate</th>
            <th>Avg Latency</th>
          </tr>
        </thead>
        <tbody id="nodes-table-body">
          <tr><td colspan="8" class="empty">Loading fleet nodes...</td></tr>
        </tbody>
      </table>
    </div>

    <div class="section-title">Recent Job Activity</div>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Job ID</th>
            <th>Node</th>
            <th>Target URL</th>
            <th>Status</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody id="jobs-table-body">
          <tr><td colspan="6" class="empty">No recent jobs logged.</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    const token = new URLSearchParams(window.location.search).get("key") || "";
    const headers = token ? { Authorization: "Bearer " + token } : {};

    async function updateDashboard() {
      try {
        const res = await fetch("/v1/stats", { headers });
        if (!res.ok) {
          if (res.status === 403) {
            document.getElementById("refresh-status").textContent = "Unauthorized: Provide ?key=MASTER_KEY";
          }
          return;
        }
        const data = await res.json();

        // Metrics
        const onlineCount = (data.perNode || []).filter(n => n.online).length;
        const totalNodes = (data.perNode || []).length;
        document.getElementById("metric-online").textContent = onlineCount + " / " + totalNodes;
        document.getElementById("metric-active").textContent = data.activeJobs;
        document.getElementById("metric-completed").textContent = data.completedJobs;

        const totalFinished = data.completedJobs + data.failedJobs;
        const successRate = totalFinished > 0
          ? ((data.completedJobs / totalFinished) * 100).toFixed(1) + "%"
          : "100%";
        document.getElementById("metric-rate").textContent = successRate;

        // Nodes Table
        const nodesTbody = document.getElementById("nodes-table-body");
        if (!data.perNode || data.perNode.length === 0) {
          nodesTbody.innerHTML = '<tr><td colspan="8" class="empty">No nodes connected yet.</td></tr>';
        } else {
          nodesTbody.innerHTML = data.perNode.map(n => {
            const statusBadge = n.online
              ? '<span class="badge badge-online">ONLINE</span>'
              : '<span class="badge badge-offline">OFFLINE</span>';
            const rate = (n.jobsDone + (n.jobsFailed || 0)) > 0
              ? ((n.jobsDone / (n.jobsDone + (n.jobsFailed || 0))) * 100).toFixed(0) + "%"
              : "-";
            const avgLat = n.avgLatencyMs ? n.avgLatencyMs + " ms" : "-";
            return \`<tr>
              <td class="mono"><strong>\${n.name}</strong></td>
              <td>\${statusBadge}</td>
              <td class="mono">\${n.version || "n/a"}</td>
              <td>\${n.os || "unknown"}</td>
              <td>\${n.lastSeenAgoSec}s ago</td>
              <td>\${n.jobsDone}</td>
              <td>\${rate}</td>
              <td>\${avgLat}</td>
            </tr>\`;
          }).join("");
        }

        // Recent Jobs Table
        const jobsTbody = document.getElementById("jobs-table-body");
        if (!data.recentJobs || data.recentJobs.length === 0) {
          jobsTbody.innerHTML = '<tr><td colspan="6" class="empty">No jobs executed yet.</td></tr>';
        } else {
          jobsTbody.innerHTML = data.recentJobs.slice(0, 50).map(j => {
            const timeStr = new Date(j.timestamp).toLocaleTimeString();
            const statusClass = j.ok ? "status-200" : "status-err";
            const statusText = j.status ? j.status : (j.ok ? "OK" : "ERR");
            const urlShort = j.url.length > 60 ? j.url.slice(0, 60) + "…" : j.url;
            return \`<tr>
              <td class="mono" style="color:var(--text-muted)">\${timeStr}</td>
              <td class="mono">#\${j.id}</td>
              <td class="mono">\${j.node || "—"}</td>
              <td class="mono" title="\${j.url}">\${urlShort}</td>
              <td class="\${statusClass}">\${statusText}</td>
              <td>\${j.durationMs}ms</td>
            </tr>\`;
          }).join("");
        }
      } catch (err) {
        document.getElementById("refresh-status").textContent = "Connection error";
      }
    }

    updateDashboard();
    setInterval(updateDashboard, 3000);
  </script>
</body>
</html>`;
}

// ==========================================
// Request Handler
// ==========================================
export async function handleRequest(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");

    // Public health check
    if (u.pathname === "/v1/health") {
      const now = Date.now();
      const onlineCount = getOnlineNodeNames().length;
      return sendJson(res, 200, {
        ok: true,
        version: VERSION,
        nodes: nodes.size,
        onlineNodes: onlineCount,
        jobs: jobs.size,
        uptimeSec: Math.floor((now - globalStats.startedAt) / 1000),
      });
    }

    // Dashboard UI
    if (u.pathname === "/" || u.pathname === "/dashboard") {
      const authResult = verifyAuth(req);
      // Require master key or query token
      if (!authResult || authResult.role !== "master") {
        res.writeHead(401, {
          "Content-Type": "text/html",
          "WWW-Authenticate": 'Bearer realm="SiRelay Master"',
        });
        res.end(`<!DOCTYPE html><html><body style="background:#0d1117;color:#c9d1d9;font-family:sans-serif;padding:40px;text-align:center;">
          <h2>SiRelay Authentication Required</h2>
          <p>Provide <code>?key=YOUR_MASTER_KEY</code> in URL or Authorization header.</p>
        </body></html>`);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderDashboard());
      return;
    }

    // Authentication for API endpoints
    const targetNode = u.searchParams.get("node") || null;
    const authResult = verifyAuth(req, targetNode);

    if (!authResult) {
      return sendJson(res, 403, { ok: false, error: "forbidden" });
    }

    // Rate Limiting (per token / key)
    const authKey = req.headers.authorization || authResult.node || "anon";
    const rateCheck = checkRateLimit(authKey);
    if (!rateCheck.allowed) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": String(rateCheck.retryAfter),
      });
      res.end(JSON.stringify({ ok: false, error: "rate limit exceeded" }));
      return;
    }

    // ===== Client API: Submit fetch job =====
    if (u.pathname === "/v1/fetch" && req.method === "POST") {
      // Security: Only master key / client role can initiate fetch jobs
      if (authResult.role !== "master") {
        return sendJson(res, 403, { ok: false, error: "only master key can initiate fetch jobs" });
      }

      let rawBody = "";
      try {
        rawBody = await readBody(req, CONFIG.MAX_FETCH_BODY);
      } catch (err) {
        if (err.code === "PAYLOAD_TOO_LARGE") {
          return sendJson(res, 413, { ok: false, error: "payload too large (max 64KB)" });
        }
        return sendJson(res, 400, { ok: false, error: "bad request body" });
      }

      let body = {};
      try {
        body = JSON.parse(rawBody || "{}");
      } catch {
        return sendJson(res, 400, { ok: false, error: "malformed JSON" });
      }

      const url = body.url;
      if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        return sendJson(res, 400, { ok: false, error: "bad or unsupported url (must start with http:// or https://)" });
      }

      if (!hostAllowed(url)) {
        return sendJson(res, 403, { ok: false, error: "host disallowed or targeting private network" });
      }

      // Fail fast when no agents are online
      const onlineNodes = getOnlineNodeNames();
      if (!onlineNodes.length) {
        return sendJson(res, 503, { ok: false, error: "no agents online" });
      }

      // Clean request headers: remove hop-by-hop & control chars
      const sanitizedHeaders = {};
      if (body.headers && typeof body.headers === "object") {
        const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
        for (const [k, v] of Object.entries(body.headers)) {
          const lk = k.toLowerCase().trim();
          if (typeof v === "string" && !HOP_BY_HOP.has(lk) && !lk.includes("\n") && !lk.includes("\r")) {
            sanitizedHeaders[k] = v.replace(/[\r\n]+/g, " ");
          }
        }
      }

      const clientTimeoutMs = Math.min(
        Math.max(Number(body.timeoutMs || CONFIG.DEFAULT_CLIENT_TIMEOUT_MS), 2_000),
        CONFIG.MAX_CLIENT_TIMEOUT_MS
      );

      const id = String(nextJobId++);
      globalStats.totalSubmitted++;

      // Create Promise awaiting job resolution
      await new Promise((resolve) => {
        const job = {
          id,
          url,
          opts: {
            method: (body.method || "GET").toUpperCase(),
            headers: sanitizedHeaders,
          },
          created: Date.now(),
          timeoutMs: clientTimeoutMs,
          attempts: 0,
          assignedNode: null,
          assignedAt: null,
          leaseTimer: null,
          timeoutTimer: null,
          clientRes: res,
          resolve: (result) => {
            resolve();
            if (!res.writableEnded && !res.destroyed) {
              const code = result.ok ? 200 : (result.status && result.status >= 400 ? result.status : 502);
              sendJson(res, code, result);
            }
          },
          cancelled: false,
        };

        jobs.set(id, job);

        // Cancel job if client disconnects early
        req.on("close", () => {
          if (jobs.has(id)) {
            logger.debug(`Client aborted fetch job ${id}`);
            job.cancelled = true;
            if (job.leaseTimer) clearTimeout(job.leaseTimer);
            if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
            jobs.delete(id);
            resolve();
          }
        });

        // Client wait timeout
        job.timeoutTimer = setTimeout(() => {
          if (jobs.has(id)) {
            logger.warn(`Job ${id} timed out waiting for agent result (${clientTimeoutMs}ms)`);
            cleanFinishJob(id, { ok: false, error: `fetch timed out after ${clientTimeoutMs}ms` });
          }
        }, clientTimeoutMs);

        // Attempt dispatch immediately
        dispatchJob(job);
      });
      return;
    }

    // ===== Agent API: Poll for next job =====
    if (u.pathname === "/v1/agent/poll" && req.method === "GET") {
      const node = u.searchParams.get("node") || authResult.node || "unnamed";

      // Prevent node identity spoofing: if agent token belongs to specific node, enforce it
      if (authResult.role === "agent" && authResult.node && authResult.node !== node) {
        return sendJson(res, 403, { ok: false, error: "node identity mismatch with provided credentials" });
      }

      // Collect heartbeat metadata
      let nodeRecord = nodes.get(node);
      if (!nodeRecord) {
        nodeRecord = {
          lastSeen: Date.now(),
          jobsDone: 0,
          jobsFailed: 0,
          totalLatencyMs: 0,
          lastJobTs: 0,
        };
        nodes.set(node, nodeRecord);
      }
      nodeRecord.lastSeen = Date.now();
      if (u.searchParams.has("version")) nodeRecord.version = u.searchParams.get("version");
      if (u.searchParams.has("os")) nodeRecord.os = u.searchParams.get("os");
      if (u.searchParams.has("uptime")) nodeRecord.uptimeSec = Number(u.searchParams.get("uptime") || 0);

      // Check if there is an unassigned job waiting in queue
      const pendingJob = [...jobs.values()].find((j) => !j.assignedNode && !j.cancelled);
      if (pendingJob) {
        pendingJob.assignedNode = node;
        pendingJob.assignedAt = Date.now();
        pendingJob.attempts++;
        nodeRecord.lastJobTs = Date.now();

        if (pendingJob.leaseTimer) clearTimeout(pendingJob.leaseTimer);
        pendingJob.leaseTimer = setTimeout(() => {
          handleJobLeaseTimeout(pendingJob.id);
        }, CONFIG.AGENT_LEASE_TIMEOUT_MS);

        return sendJson(res, 200, {
          job: {
            id: pendingJob.id,
            url: pendingJob.url,
            opts: pendingJob.opts,
          },
        });
      }

      // Long-poll: hold request up to 20s
      await new Promise((resolve) => {
        let finished = false;
        let timer = null;

        const finish = () => {
          if (finished) return;
          finished = true;
          if (timer) clearTimeout(timer);
          const i = agentWaiters.indexOf(waiter);
          if (i >= 0) agentWaiters.splice(i, 1);
          resolve();
        };

        const waiter = {
          node,
          res,
          req,
          finish,
          fire: (job) => {
            finish();
            if (!res.writableEnded && !res.destroyed) {
              sendJson(res, 200, {
                job: {
                  id: job.id,
                  url: job.url,
                  opts: job.opts,
                },
              });
            } else {
              // Agent vanished before write completed: reset assignment and re-dispatch
              job.assignedNode = null;
              job.assignedAt = null;
              dispatchJob(job);
            }
          },
        };

        timer = setTimeout(() => {
          finish();
          if (!res.writableEnded && !res.destroyed) {
            res.writeHead(204);
            res.end();
          }
        }, 20_000);

        req.on("close", finish);
        agentWaiters.push(waiter);
      });
      return;
    }

    // ===== Agent API: Submit result =====
    if (u.pathname === "/v1/agent/result" && req.method === "POST") {
      let rawBody = "";
      try {
        rawBody = await readBody(req, CONFIG.MAX_BODY);
      } catch (err) {
        if (err.code === "PAYLOAD_TOO_LARGE") {
          return sendJson(res, 413, { ok: false, error: "payload too large (max 8MB)" });
        }
        return sendJson(res, 400, { ok: false, error: "bad request body" });
      }

      let body = {};
      try {
        body = JSON.parse(rawBody || "{}");
      } catch {
        return sendJson(res, 400, { ok: false, error: "malformed JSON" });
      }

      const jobId = String(body.jobId);
      const job = jobs.get(jobId);
      if (!job) {
        // Idempotent/graceful 404: job was already completed or timed out
        return sendJson(res, 404, { ok: false, error: "job gone or timed out" });
      }

      // Update node telemetry
      const reportingNode = job.assignedNode || authResult.node || null;
      cleanFinishJob(jobId, {
        ok: !!body.ok,
        status: Number(body.status) || 0,
        headers: body.headers || {},
        bodyB64: (body.bodyB64 || "").slice(0, CONFIG.MAX_BODY * 1.4),
        node: reportingNode,
        durationMs: body.ms || body.durationMs || (Date.now() - job.created),
      });

      return sendJson(res, 200, { ok: true });
    }

    // ===== Fleet Nodes endpoint =====
    if (u.pathname === "/v1/nodes" && req.method === "GET") {
      const now = Date.now();
      const list = [...nodes.entries()].map(([name, meta]) => {
        const isOnline = now - meta.lastSeen < CONFIG.NODE_TIMEOUT_MS;
        const total = meta.jobsDone + (meta.jobsFailed || 0);
        const successRate = total > 0 ? Number(((meta.jobsDone / total) * 100).toFixed(1)) : 100;
        const avgLatencyMs = meta.jobsDone > 0 ? Math.round(meta.totalLatencyMs / meta.jobsDone) : 0;
        return {
          name,
          online: isOnline,
          lastSeenAgoSec: Math.round((now - meta.lastSeen) / 1000),
          jobsDone: meta.jobsDone,
          jobsFailed: meta.jobsFailed || 0,
          successRate,
          avgLatencyMs,
          version: meta.version || null,
          os: meta.os || null,
          uptimeSec: meta.uptimeSec || null,
        };
      });
      return sendJson(res, 200, { nodes: list });
    }

    // ===== Statistics endpoint =====
    if (u.pathname === "/v1/stats" && req.method === "GET") {
      const now = Date.now();
      const nodeStatsList = [...nodes.entries()].map(([name, meta]) => {
        const isOnline = now - meta.lastSeen < CONFIG.NODE_TIMEOUT_MS;
        const total = meta.jobsDone + (meta.jobsFailed || 0);
        const successRate = total > 0 ? Number(((meta.jobsDone / total) * 100).toFixed(1)) : 100;
        const avgLatencyMs = meta.jobsDone > 0 ? Math.round(meta.totalLatencyMs / meta.jobsDone) : 0;
        return {
          name,
          online: isOnline,
          lastSeenAgoSec: Math.round((now - meta.lastSeen) / 1000),
          jobsDone: meta.jobsDone,
          jobsFailed: meta.jobsFailed || 0,
          successRate,
          avgLatencyMs,
          version: meta.version || null,
          os: meta.os || null,
          uptimeSec: meta.uptimeSec || null,
        };
      });

      return sendJson(res, 200, {
        version: VERSION,
        uptimeSec: Math.floor((now - globalStats.startedAt) / 1000),
        totalJobs: globalStats.totalSubmitted,
        activeJobs: jobs.size,
        completedJobs: globalStats.totalCompleted,
        failedJobs: globalStats.totalFailed,
        perNode: nodeStatsList,
        recentJobs: recentJobs.slice(0, 50),
      });
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (fatalErr) {
    logger.error(`Internal server error: ${fatalErr.stack || fatalErr.message}`);
    sendJson(res, 500, { ok: false, error: "internal server error" });
  }
}

// ==========================================
// Server Initialization & Graceful Shutdown
// ==========================================
export function createServer() {
  let srv;
  if (CONFIG.SSL_CERT && CONFIG.SSL_KEY && existsSync(CONFIG.SSL_CERT) && existsSync(CONFIG.SSL_KEY)) {
    try {
      const httpsOpts = {
        cert: readFileSync(CONFIG.SSL_CERT),
        key: readFileSync(CONFIG.SSL_KEY),
      };
      srv = https.createServer(httpsOpts, handleRequest);
      logger.info("Configured HTTPS server with TLS certificates");
    } catch (err) {
      logger.error(`Failed to load TLS cert/key: ${err.message}. Falling back to HTTP.`);
      srv = http.createServer(handleRequest);
    }
  } else {
    srv = http.createServer(handleRequest);
  }
  return srv;
}

export const server = createServer();

let isShuttingDown = false;
export function gracefulShutdown(signal = "SIGTERM") {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`Received ${signal}, initiating graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    logger.info("HTTP server closed to new connections");
  });

  // Drain active agent waiters
  while (agentWaiters.length > 0) {
    const waiter = agentWaiters.pop();
    if (!waiter.res.writableEnded && !waiter.res.destroyed) {
      waiter.res.writeHead(204);
      waiter.res.end();
    }
  }

  // Reject remaining client fetch requests
  for (const [id, job] of jobs) {
    if (job.clientRes && !job.clientRes.writableEnded && !job.clientRes.destroyed) {
      sendJson(job.clientRes, 503, { ok: false, error: "coordinator shutting down" });
    }
    if (job.leaseTimer) clearTimeout(job.leaseTimer);
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
  }
  jobs.clear();

  // Force exit after grace period if needed
  const forceExitTimer = setTimeout(() => {
    logger.warn("Shutdown grace period exceeded; force exiting");
    process.exit(0);
  }, 5000);
  forceExitTimer.unref();

  logger.info("Graceful shutdown completed");
  process.exit(0);
}

if (process.env.NODE_ENV !== "test") {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    logger.info(`SiRelay coordinator v${VERSION} listening on ${CONFIG.HOST}:${CONFIG.PORT}`);
  });
}
