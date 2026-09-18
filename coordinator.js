#!/usr/bin/env node
/**
 * SiRelay Coordinator — central job broker for the personal fetch network.
 *
 * Projects POST fetch jobs; agents (Edo's machines, any OS) poll for jobs,
 * fetch from THEIR residential IPs, and POST results back.
 *
 * API (all require Authorization: Bearer <SIRELAY_KEY>):
 *   POST /v1/fetch      {url, method?, headers?, timeoutMs?} -> waits <=25s -> {ok, status, headers, bodyB64, node}
 *   GET  /v1/agent/poll?node=NAME         (long-poll 20s) -> job | 204
 *   POST /v1/agent/result {jobId, ok, status, headers, bodyB64}
 *   GET  /v1/nodes      -> online nodes
 *   GET  /v1/health     -> {ok:true}
 */
import http from "node:http";

const KEY = process.env.SIRELAY_KEY || "change-me";
const PORT = Number(process.env.PORT || 8123);
const MAX_BODY = 8 * 1024 * 1024; // 8MB per response
const JOB_TTL = 60_000;
const NODE_TIMEOUT = 45_000; // node is "online" if seen <45s ago

// Optional domain allowlist (comma-separated env). Empty = allow all.
const ALLOWLIST = (process.env.SIRELAY_ALLOWLIST || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

/** @type {Map<string, {url:string, opts:any, created:number, resolve:Function, waiters:Function[]}> */
const jobs = new Map();
/** @type {Array<(job:any)=>void>} */
const agentWaiters = [];
/** @type {Map<string, number>} node name -> last seen ts */
const nodes = new Map();

let nextId = 1;

function auth(req, res) {
  const h = req.headers.authorization || "";
  if (h !== `Bearer ${KEY}`) {
    res.writeHead(403).end("forbidden");
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function hostAllowed(url) {
  if (!ALLOWLIST.length) return true;
  try {
    const h = new URL(url).hostname;
    return ALLOWLIST.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
}

function expireJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.created > JOB_TTL) {
      jobs.delete(id);
      job.resolve?.({ ok: false, error: "timeout: no agent took the job" });
    }
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (u.pathname === "/v1/health") return json(200, { ok: true, nodes: nodes.size, jobs: jobs.size });
  if (!auth(req, res)) return;

  // ===== Client API: submit fetch job, wait for result =====
  if (u.pathname === "/v1/fetch" && req.method === "POST") {
    const body = JSON.parse(await readBody(req) || "{}");
    const url = body.url;
    if (!url || !/^https?:\/\//.test(url)) return json(400, { ok: false, error: "bad url" });
    if (!hostAllowed(url)) return json(403, { ok: false, error: "host not in allowlist" });

    const id = String(nextId++);
    const result = await new Promise((resolve) => {
      const job = { id, url, opts: { headers: body.headers || {}, method: body.method || "GET" }, created: Date.now(), resolve };
      jobs.set(id, job);
      // wake one waiting agent
      const w = agentWaiters.shift();
      if (w) w(job);
      // client-side wait max 25s
      setTimeout(() => {
        if (jobs.has(id)) {
          jobs.delete(id);
          resolve({ ok: false, error: "no agent available (25s timeout)" });
        }
      }, 25_000);
    });
    return json(result.ok ? 200 : 502, result);
  }

  // ===== Agent API: long-poll for a job =====
  if (u.pathname === "/v1/agent/poll" && req.method === "GET") {
    const node = u.searchParams.get("node") || "unnamed";
    nodes.set(node, Date.now());

    // existing queued job?
    const pending = [...jobs.values()].find((j) => !j.taken);
    if (pending) {
      pending.taken = node;
      return json(200, { job: { id: pending.id, url: pending.url, opts: pending.opts } });
    }
    // long-poll: hold the request up to 20s
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 20_000);
      agentWaiters.push((job) => {
        clearTimeout(timer);
        json(200, { job: { id: job.id, url: job.url, opts: job.opts } });
        job.taken = node;
        resolve();
      });
    });
    if (!res.writableEnded) res.writeHead(204).end();
    return;
  }

  // ===== Agent API: submit result =====
  if (u.pathname === "/v1/agent/result" && req.method === "POST") {
    const body = JSON.parse(await readBody(req) || "{}");
    const job = jobs.get(String(body.jobId));
    if (!job) return json(404, { ok: false, error: "job gone" });
    jobs.delete(String(body.jobId));
    job.resolve?.({
      ok: !!body.ok,
      status: body.status,
      headers: body.headers,
      bodyB64: (body.bodyB64 || "").slice(0, MAX_BODY * 1.4),
      node: job.taken || null,
    });
    return json(200, { ok: true });
  }

  // ===== Nodes list =====
  if (u.pathname === "/v1/nodes" && req.method === "GET") {
    const now = Date.now();
    const list = [...nodes.entries()].map(([name, ts]) => ({
      name, lastSeenAgoSec: Math.round((now - ts) / 1000), online: now - ts < NODE_TIMEOUT,
    }));
    return json(200, { nodes: list });
  }

  json(404, { ok: false, error: "not found" });
});

setInterval(expireJobs, 10_000);
server.listen(PORT, () => console.log(`SiRelay coordinator on :${PORT}`));
