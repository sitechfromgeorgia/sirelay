# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-19

### Added
- **Production Hardening & Reliability**:
  - Graceful shutdown handling (`SIGTERM`, `SIGINT`, `SIGHUP`) with request draining and agent socket cleanup.
  - Automatic re-queueing of fetch jobs if an assigned agent drops or disconnects mid-fetch.
  - Client request timeout (`timeoutMs`) support and client disconnect cancellation (`req.on("close")`).
  - Zero-dependency rotating structured file logger with configurable log levels (`SIRELAY_LOG_LEVEL`) and size-capped rotation (`SIRELAY_LOG_FILE`).
  - Persistent job history (`sirelay-jobs.jsonl`, capped) with metrics recovery on coordinator restart.
- **Security Enhancements**:
  - Constant-time authentication token comparison using `crypto.timingSafeEqual` with SHA-256 digests to prevent timing attacks.
  - Role-based authorization separation: master key for fetch clients, per-node keys restricted to polling/results.
  - Node identity verification preventing nodes from impersonating other registered nodes.
  - SSRF protection: automatic blocking of loopback, RFC 1918 private subnets, link-local, and cloud metadata addresses.
  - Request body size limits with clean HTTP 413 responses.
  - Token-bucket rate limiting per key (HTTP 429 with `Retry-After`).
- **Features & Observability**:
  - Single-file zero-dependency dark-mode HTML dashboard (`/` or `/dashboard`) with live fleet status and job stream.
  - `/v1/stats` endpoint exposing fleet health, success rate, and average latency.
  - Agent heartbeat metadata reporting: Node version, OS, architecture, and uptime sent via poll and displayed in `/v1/nodes`.
  - Coordinator restart detection and graceful handling in agent.
- **Installers & Tooling**:
  - Automated Node.js detection and `winget` installation helper for Windows installer.
  - Added Windows uninstall and pause/resume helper scripts.
  - Removed hardcoded server IP in `gen-installer.py`, adding configurable `--server` flag.
- **Testing & CI/CD**:
  - Comprehensive standard library test suite (`node:test`) covering coordinator, security, broker lifecycle, and agent.
  - GitHub Actions CI workflow for Node.js 18, 20, 22 on Linux and Windows.
  - Automated GitHub Release workflow building and attaching `sirelay.js` on semver tags.

## [0.2.0] - 2026-09-15

### Added
- Multi-key authentication supporting per-machine agent keys in `/root/.sirelay-nodes.json` with hot-reloading.
- Round-robin job assignment based on least-recently-used node.
- Fail-fast HTTP 503 response when no agents are online.
- Basic node statistics in `/v1/nodes`.
- Python-based one-click installer generator for Windows, Linux, and macOS (`gen-installer.py`).

### Fixed
- Prevented coordinator crash on agent long-poll socket disconnect (`ERR_HTTP_HEADERS_SENT`).

## [0.1.0] - 2026-09-01

### Added
- Initial release of SiRelay:
  - Zero-dependency Node.js coordinator (`coordinator.js`).
  - Cross-platform agent with residential IP fetching (`sirelay.js`).
  - GitHub Releases auto-update mechanism for agents.
  - HTTP endpoints: `/v1/fetch`, `/v1/agent/poll`, `/v1/agent/result`, `/v1/nodes`, `/v1/health`.
