import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Configure test environment before importing coordinator
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sirelay-test-"));
const TEST_KEY = "test-master-secret-key-12345";
const TEST_NODES_FILE = path.join(TEST_DIR, "nodes.json");
const TEST_LOG_FILE = path.join(TEST_DIR, "test.log");
const TEST_STATS_FILE = path.join(TEST_DIR, "jobs.jsonl");

process.env.NODE_ENV = "test";
process.env.SIRELAY_KEY = TEST_KEY;
process.env.SIRELAY_NODES_FILE = TEST_NODES_FILE;
process.env.SIRELAY_LOG_FILE = TEST_LOG_FILE;
process.env.SIRELAY_STATS_FILE = TEST_STATS_FILE;
process.env.SIRELAY_RATE_LIMIT = "0"; // disable rate limit in main test flow

// Write initial test node keys
fs.writeFileSync(
  TEST_NODES_FILE,
  JSON.stringify({
    "agent-alpha": "key-alpha-1111",
    "agent-beta": "key-beta-2222",
  })
);

const {
  server,
  safeCompare,
  CONFIG,
  nodes,
  jobs,
  agentWaiters,
  setNodeKeys,
  loadNodeKeys,
} = await import("../coordinator.js");

// Mock target HTTP server to simulate external target sites (e.g. 1tv.ge)
let mockTargetServer;
let mockTargetPort;

// Coordinator server address
let coordinatorPort;
let baseUrl;

before(async () => {
  // Update node keys
  setNodeKeys(loadNodeKeys(TEST_NODES_FILE));

  // Spin up mock target server
  mockTargetServer = http.createServer((req, res) => {
    if (req.url === "/article") {
      res.writeHead(200, { "Content-Type": "text/html", "X-Custom": "SiRelay-Passed" });
      res.end("<html><body>Article Content from Residential Node</body></html>");
      return;
    }
    res.writeHead(404).end("Not Found");
  });

  await new Promise((resolve) => {
    mockTargetServer.listen(0, "127.0.0.1", () => {
      mockTargetPort = mockTargetServer.address().port;
      resolve();
    });
  });

  // Spin up coordinator server on ephemeral port
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      coordinatorPort = server.address().port;
      baseUrl = `http://127.0.0.1:${coordinatorPort}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => mockTargetServer.close(resolve));
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

describe("SiRelay Coordinator Hardening & Features", () => {
  test("GET /v1/health returns status without authentication", async () => {
    const res = await fetch(`${baseUrl}/v1/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, "0.3.0");
    assert.equal(typeof body.uptimeSec, "number");
  });

  test("Timing-safe comparison correctly compares strings", () => {
    assert.equal(safeCompare("secret-key", "secret-key"), true);
    assert.equal(safeCompare("secret-key", "wrong-key"), false);
    assert.equal(safeCompare("secret-key", "secret-key-extra"), false);
    assert.equal(safeCompare("", ""), true);
    assert.equal(safeCompare("a", "b"), false);
  });

  test("Authentication rejects missing or invalid tokens", async () => {
    // Missing auth
    const noAuth = await fetch(`${baseUrl}/v1/nodes`);
    assert.equal(noAuth.status, 403);

    // Invalid token
    const badAuth = await fetch(`${baseUrl}/v1/nodes`, {
      headers: { Authorization: "Bearer bad-token-xyz" },
    });
    assert.equal(badAuth.status, 403);
  });

  test("Role-based separation: Agent key cannot initiate fetch jobs", async () => {
    // Agent key attempts POST /v1/fetch -> must return 403
    const res = await fetch(`${baseUrl}/v1/fetch`, {
      method: "POST",
      headers: {
        Authorization: "Bearer key-alpha-1111",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /only master key/i);
  });

  test("Agent cannot poll with mismatched node identity", async () => {
    // Agent-alpha key polling as agent-beta
    const res = await fetch(`${baseUrl}/v1/agent/poll?node=agent-beta`, {
      headers: { Authorization: "Bearer key-alpha-1111" },
    });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /mismatch/i);
  });

  test("SSRF Protection: Blocks private IPs and loopback", async () => {
    const testCases = [
      "http://127.0.0.1/secret",
      "http://localhost/admin",
      "http://192.168.1.1/",
      "http://10.0.0.1/",
      "http://172.16.0.1/",
      "http://169.254.169.254/latest/meta-data/",
    ];

    for (const blockedUrl of testCases) {
      const res = await fetch(`${baseUrl}/v1/fetch`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: blockedUrl }),
      });
      assert.equal(res.status, 403, `Expected 403 for SSRF attempt: ${blockedUrl}`);
      const body = await res.json();
      assert.match(body.error, /disallowed or targeting private network/i);
    }
  });

  test("Fail-Fast 503 when no agents are online", async () => {
    // Ensure nodes map has no online agents
    nodes.clear();

    // Allow mock target URL for testing
    CONFIG.ALLOW_PRIVATE_IPS = true;
    try {
      const res = await fetch(`${baseUrl}/v1/fetch`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: `http://127.0.0.1:${mockTargetPort}/article` }),
      });
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.equal(data.ok, false);
      assert.match(data.error, /no agents online/i);
    } finally {
      CONFIG.ALLOW_PRIVATE_IPS = false;
    }
  });

  test("End-to-End Fetch Flow with Heartbeat Reporting", async () => {
    CONFIG.ALLOW_PRIVATE_IPS = true;
    try {
      // 1. Agent registers and sends heartbeat telemetry
      const pollPromise = fetch(
        `${baseUrl}/v1/agent/poll?node=agent-alpha&version=0.3.0&os=win32-x64&uptime=3600`,
        { headers: { Authorization: "Bearer key-alpha-1111" } }
      );

      // Give agent 50ms to register poller
      await new Promise((r) => setTimeout(r, 50));

      // Check /v1/nodes to verify heartbeat telemetry
      const nodesRes = await fetch(`${baseUrl}/v1/nodes`, {
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      });
      assert.equal(nodesRes.status, 200);
      const nodesData = await nodesRes.json();
      const alphaNode = nodesData.nodes.find((n) => n.name === "agent-alpha");
      assert.ok(alphaNode);
      assert.equal(alphaNode.online, true);
      assert.equal(alphaNode.version, "0.3.0");
      assert.equal(alphaNode.os, "win32-x64");
      assert.equal(alphaNode.uptimeSec, 3600);

      // 2. Client initiates fetch job
      const targetUrl = `http://127.0.0.1:${mockTargetPort}/article`;
      const clientFetchPromise = fetch(`${baseUrl}/v1/fetch`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: targetUrl,
          headers: { "X-Crawler-Request": "1" },
          timeoutMs: 5000,
        }),
      });

      // 3. Agent receives job
      const pollRes = await pollPromise;
      assert.equal(pollRes.status, 200);
      const pollData = await pollRes.json();
      assert.ok(pollData.job);
      assert.equal(pollData.job.url, targetUrl);
      assert.equal(pollData.job.opts.headers["x-crawler-request"], "1");

      // 4. Agent simulates local execution and posts result
      const mockResult = {
        jobId: pollData.job.id,
        ok: true,
        status: 200,
        headers: { "content-type": "text/html", "x-custom": "SiRelay-Passed" },
        bodyB64: Buffer.from("<html>Sample Response</html>").toString("base64"),
        durationMs: 42,
      };

      const resultPostRes = await fetch(`${baseUrl}/v1/agent/result`, {
        method: "POST",
        headers: {
          Authorization: "Bearer key-alpha-1111",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(mockResult),
      });
      assert.equal(resultPostRes.status, 200);

      // 5. Client receives completed response
      const clientRes = await clientFetchPromise;
      assert.equal(clientRes.status, 200);
      const clientData = await clientRes.json();
      assert.equal(clientData.ok, true);
      assert.equal(clientData.status, 200);
      assert.equal(clientData.node, "agent-alpha");
      const decodedBody = Buffer.from(clientData.bodyB64, "base64").toString("utf8");
      assert.equal(decodedBody, "<html>Sample Response</html>");

      // 6. Verify duplicate result post returns 404 (idempotent/graceful)
      const duplicateRes = await fetch(`${baseUrl}/v1/agent/result`, {
        method: "POST",
        headers: {
          Authorization: "Bearer key-alpha-1111",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(mockResult),
      });
      assert.equal(duplicateRes.status, 404);
    } finally {
      CONFIG.ALLOW_PRIVATE_IPS = false;
    }
  });

  test("Job Re-queuing: If assigned agent fails, coordinator dispatches to waiting node", async () => {
    CONFIG.ALLOW_PRIVATE_IPS = true;
    try {
      // Register agent-beta as online
      nodes.set("agent-beta", {
        lastSeen: Date.now(),
        jobsDone: 0,
        jobsFailed: 0,
        totalLatencyMs: 0,
        lastJobTs: 0,
      });

      // Submit fetch job with short timeout
      const targetUrl = `http://127.0.0.1:${mockTargetPort}/article`;
      const clientPromise = fetch(`${baseUrl}/v1/fetch`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TEST_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: targetUrl,
          timeoutMs: 3000,
        }),
      });

      // Give coordinator 50ms to queue job
      await new Promise((r) => setTimeout(r, 50));

      // Agent beta polls and receives job
      const pollRes = await fetch(`${baseUrl}/v1/agent/poll?node=agent-beta`, {
        headers: { Authorization: "Bearer key-beta-2222" },
      });
      assert.equal(pollRes.status, 200);
      const pollData = await pollRes.json();
      assert.ok(pollData.job);

      // Now agent beta crashes/dies and does NOT submit result.
      // Agent alpha polls for work
      const pollAlphaPromise = fetch(`${baseUrl}/v1/agent/poll?node=agent-alpha`, {
        headers: { Authorization: "Bearer key-alpha-1111" },
      });

      // Trigger lease timeout manually or wait for re-assignment
      const assignedJob = jobs.get(pollData.job.id);
      assert.ok(assignedJob);
      assert.equal(assignedJob.assignedNode, "agent-beta");

      // Complete job via agent-alpha to verify successful handoff
      assignedJob.assignedNode = null;
      assignedJob.assignedAt = null;
      const { dispatchJob } = await import("../coordinator.js");
      dispatchJob(assignedJob);

      const alphaPollRes = await pollAlphaPromise;
      assert.equal(alphaPollRes.status, 200);
      const alphaPollData = await alphaPollRes.json();
      assert.equal(alphaPollData.job.id, pollData.job.id);

      // Post result from alpha
      await fetch(`${baseUrl}/v1/agent/result`, {
        method: "POST",
        headers: {
          Authorization: "Bearer key-alpha-1111",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jobId: alphaPollData.job.id,
          ok: true,
          status: 200,
          bodyB64: Buffer.from("Handoff Success").toString("base64"),
        }),
      });

      const clientRes = await clientPromise;
      assert.equal(clientRes.status, 200);
      const clientData = await clientRes.json();
      assert.equal(clientData.ok, true);
      assert.equal(clientData.node, "agent-alpha");
    } finally {
      CONFIG.ALLOW_PRIVATE_IPS = false;
    }
  });

  test("Dashboard endpoint GET / returns HTML with key parameter", async () => {
    const res = await fetch(`${baseUrl}/?key=${TEST_KEY}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /SiRelay/);
    assert.match(html, /Dashboard/);
    assert.match(html, /Fleet Nodes/);
  });

  test("GET /v1/stats returns fleet metrics and recent jobs", async () => {
    const res = await fetch(`${baseUrl}/v1/stats`, {
      headers: { Authorization: `Bearer ${TEST_KEY}` },
    });
    assert.equal(res.status, 200);
    const stats = await res.json();
    assert.equal(typeof stats.uptimeSec, "number");
    assert.equal(typeof stats.totalJobs, "number");
    assert.ok(Array.isArray(stats.perNode));
    assert.ok(Array.isArray(stats.recentJobs));
  });

  test("Payload limits: Reject oversized payloads with HTTP 413", async () => {
    const hugePayload = JSON.stringify({
      url: "https://example.com",
      oversizedData: "x".repeat(70 * 1024), // >64KB
    });

    const res = await fetch(`${baseUrl}/v1/fetch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_KEY}`,
        "Content-Type": "application/json",
      },
      body: hugePayload,
    });
    assert.equal(res.status, 413);
  });

  test("Rate limiting returns HTTP 429 with Retry-After header", async () => {
    CONFIG.RATE_LIMIT_RPM = 2;
    try {
      // 1st request - ok
      const r1 = await fetch(`${baseUrl}/v1/nodes`, {
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      });
      assert.equal(r1.status, 200);

      // 2nd request - ok
      const r2 = await fetch(`${baseUrl}/v1/nodes`, {
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      });
      assert.equal(r2.status, 200);

      // 3rd request - rate limited
      const r3 = await fetch(`${baseUrl}/v1/nodes`, {
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      });
      assert.equal(r3.status, 429);
      assert.ok(r3.headers.has("retry-after"));
      const retryAfter = Number(r3.headers.get("retry-after"));
      assert.ok(retryAfter >= 1);
    } finally {
      CONFIG.RATE_LIMIT_RPM = 0;
    }
  });

  test("Allowlist enforcement: Blocks non-whitelisted domains", async () => {
    CONFIG.ALLOWLIST = ["example.ge", "1tv.ge"];
    const { hostAllowed } = await import("../coordinator.js");

    assert.equal(hostAllowed("https://1tv.ge/news/123"), true);
    assert.equal(hostAllowed("https://sub.example.ge/page"), true);
    assert.equal(hostAllowed("https://malicious.com/hack"), false);
    assert.equal(hostAllowed("http://127.0.0.1/admin"), false); // private IP blocked regardless

    CONFIG.ALLOWLIST = [];
  });

  test("Round-robin least-recently-used node selection", async () => {
    const { pickLeastRecentlyUsedNode } = await import("../coordinator.js");
    const now = Date.now();

    nodes.set("node-first", {
      lastSeen: now,
      jobsDone: 5,
      jobsFailed: 0,
      totalLatencyMs: 100,
      lastJobTs: now - 100_000, // Oldest job
    });

    nodes.set("node-second", {
      lastSeen: now,
      jobsDone: 2,
      jobsFailed: 0,
      totalLatencyMs: 50,
      lastJobTs: now - 10_000, // Newer job
    });

    const picked = pickLeastRecentlyUsedNode();
    assert.equal(picked, "node-first");
  });

  test("Persistent stats recovery from JSONL log file", async () => {
    const { recoverStatsFromFile, globalStats } = await import("../coordinator.js");
    const tempStatsFile = path.join(TEST_DIR, "recovery-test.jsonl");

    const sampleRecords = [
      { timestamp: Date.now() - 5000, id: "101", url: "https://site1.ge", node: "agent-recovered", ok: true, status: 200, durationMs: 120 },
      { timestamp: Date.now() - 3000, id: "102", url: "https://site2.ge", node: "agent-recovered", ok: false, status: 502, durationMs: 300 },
    ];

    fs.writeFileSync(tempStatsFile, sampleRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const prevCompleted = globalStats.totalCompleted;
    recoverStatsFromFile(tempStatsFile);

    assert.ok(globalStats.totalCompleted >= prevCompleted + 1);
    const recoveredNode = nodes.get("agent-recovered");
    assert.ok(recoveredNode);
    assert.equal(recoveredNode.jobsDone, 1);
    assert.equal(recoveredNode.jobsFailed, 1);
  });
});
