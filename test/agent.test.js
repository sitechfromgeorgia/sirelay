import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sirelay-agent-test-"));

process.env.NODE_ENV = "test";
process.env.SIRELAY_SERVER = "http://localhost:8123";
process.env.SIRELAY_KEY = "agent-unit-test-key";
process.env.SIRELAY_NAME = "unit-test-node";

const { VERSION, loadConfig, runJob } = await import("../sirelay.js");

let mockTarget;
let mockTargetPort;

before(async () => {
  mockTarget = http.createServer((req, res) => {
    if (req.url === "/hello") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "X-Echo-Agent": req.headers["user-agent"] || "",
      });
      res.end("Hello from target web server!");
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise((resolve) => {
    mockTarget.listen(0, "127.0.0.1", () => {
      mockTargetPort = mockTarget.address().port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => mockTarget.close(resolve));
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

describe("SiRelay Agent Hardening & Execution", () => {
  test("Agent exports valid semver VERSION", () => {
    assert.equal(typeof VERSION, "string");
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  });

  test("loadConfig respects environment variables and normalization", () => {
    const cfg = loadConfig();
    assert.equal(cfg.server, "http://localhost:8123");
    assert.equal(cfg.key, "agent-unit-test-key");
    assert.equal(cfg.name, "unit-test-node");
  });

  test("runJob successfully executes request and encodes body to base64", async () => {
    const job = {
      id: "test-job-1",
      url: `http://127.0.0.1:${mockTargetPort}/hello`,
      opts: {
        method: "GET",
        headers: { "X-Test-Header": "agent-pass" },
      },
    };

    const result = await runJob(job);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.ok(result.bodyB64.length > 0);
    const decoded = Buffer.from(result.bodyB64, "base64").toString("utf8");
    assert.equal(decoded, "Hello from target web server!");
    assert.equal(typeof result.ms, "number");
  });

  test("runJob handles unreachable targets gracefully without throwing", async () => {
    const job = {
      id: "test-job-fail",
      url: "http://127.0.0.1:1/nonexistent",
      opts: { method: "GET" },
    };

    const result = await runJob(job);
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.ok(typeof result.error === "string");
    assert.equal(result.bodyB64, "");
  });
});
