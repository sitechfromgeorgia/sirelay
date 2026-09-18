# SiRelay ⚡

**Personal Residential Fetch Network** | **პირადი რეზიდენტული fetch-ქსელი**

[![CI](https://github.com/sitechfromgeorgia/sirelay/actions/workflows/ci.yml/badge.svg)](https://github.com/sitechfromgeorgia/sirelay/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20(stdlib%20only)-blue.svg)](https://nodejs.org/api/)
[![License](https://img.shields.io/badge/license-MIT-purple.svg)](LICENSE)

[English](#english) • [ქართული](#ქართული)

---

<a name="english"></a>
## English

### What is SiRelay?
SiRelay routes outbound HTTP fetch requests through your personal residential machines (Windows laptops, Linux boxes, Macs) so that requests originate from legitimate residential IPs rather than datacenter VPS networks.

This seamlessly bypasses:
- Cloudflare "Under Attack" challenge pages and strict datacenter IP blocks.
- Regional content and news portals (e.g. Georgian national broadcaster `1tv.ge`) that drop datacenter IP ranges but allow domestic residential connections.

### Architecture

```
                                  ┌─────────────────────────────┐
                                  │      Client Applications    │
                                  │  (e.g., tbilisi.today bot)  │
                                  └──────────────┬──────────────┘
                                                 │ POST /v1/fetch (Master Key)
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              SiRelay Coordinator (VPS)                                  │
│  - Zero-dependency HTTP/HTTPS broker (Node.js 18+)                                      │
│  - Least-Recently-Used (LRU) round-robin scheduling & fail-fast 503                     │
│  - Timing-safe multi-key authentication (crypto.timingSafeEqual)                        │
│  - SSRF defense (RFC 1918 / loopback / cloud metadata filter)                           │
│  - Built-in rotating logger & persistent job history (sirelay-jobs.jsonl)               │
│  - Single-file dark theme monitoring dashboard (/ or /dashboard)                        │
└───────────────────▲─────────────────────────────────────────────▲───────────────────────┘
                    │                                             │
      Poll / Result │ (NAT-Safe, Outbound Only)     Poll / Result │
                    │                                             │
       ┌────────────┴───────────┐                    ┌────────────┴───────────┐
       │   Home Laptop (Win11)  │                    │   Office PC (Linux)    │
       │   Residential IP: ISP A │                    │   Residential IP: ISP B│
       └────────────┬───────────┘                    └────────────┬───────────┘
                    │ GET /news/123                               │ GET /article/456
                    ▼                                             ▼
       ┌────────────────────────┐                    ┌────────────────────────┐
       │  Target: 1tv.ge / etc  │                    │  Target: Protected Host│
       └────────────────────────┘                    └────────────────────────┘
```

### Key Components

1. **Coordinator (`coordinator.js`)**
   - Central broker running on your VPS.
   - Evaluates node health and dispatches fetch jobs to waiting agents using LRU round-robin.
   - Enforces role separation: clients submit fetch tasks with `SIRELAY_KEY`; agents poll and post results using their assigned machine keys.
   - Features SSRF defenses, payload limits (HTTP 413), rate limiting (HTTP 429), and automatic job re-queuing on agent disconnection.
   - Zero dependencies (Node.js standard library only).

2. **Agent (`sirelay.js`)**
   - Lightweight script running on distributed client machines.
   - Communicates strictly via **outbound-only** HTTPS/HTTP requests — requires no incoming open ports, UPnP, or firewall modifications.
   - Sends node telemetry with each poll (version, OS, platform, uptime).
   - Automatically checks GitHub Releases on startup, verifies syntax, and updates itself.

3. **Installer Generator (`gen-installer.py`)**
   - Python utility to generate customized, one-click installation scripts embedding unique machine keys.
   - **Windows**: Detects Node.js (offers `winget` installation), configures background execution via Task Scheduler (`onlogon`), and provides `toggle-pause.bat` and `uninstall.bat`.
   - **Linux**: Configures a `systemd --user` service with auto-restart.
   - **macOS**: Configures a `launchd` user daemon.

---

### Quickstart Guide

#### 1. Coordinator Setup (VPS)

Create `/root/.sirelay-nodes.json` (chmod 600) with per-node machine keys:
```json
{
  "home-laptop": "key-hex-for-laptop",
  "office-pc": "key-hex-for-office"
}
```

Run coordinator:
```bash
export SIRELAY_KEY="master-secret-for-crawlers"
export SIRELAY_ALLOWLIST="1tv.ge,rustavi2.ge,example.com" # optional: empty = allow all public hosts
node coordinator.js
```

Or run via `systemd` (`/etc/systemd/system/sirelay.service`):
```ini
[Unit]
Description=SiRelay Coordinator
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/sirelay
Environment=PORT=8123
Environment=SIRELAY_KEY=your_master_key_here
Environment=SIRELAY_ALLOWLIST=1tv.ge,example.com
ExecStart=/usr/bin/node coordinator.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

#### 2. Reverse Proxy Fronting (Recommended)

##### Option A: Caddy
```caddy
sirelay.yourdomain.com {
    reverse_proxy localhost:8123
}
```

##### Option B: Cloudflare Tunnel (`cloudflared`)
```yaml
tunnel: your-tunnel-id
credentials-file: /root/.cloudflared/credentials.json
ingress:
  - hostname: sirelay.yourdomain.com
    service: http://localhost:8123
  - service: http_status:404
```

#### 3. Generate Installers & Deploy Agents

Generate machine-specific installers (stored in `./installers/`, never committed):
```bash
python3 gen-installer.py home-laptop windows --server https://sirelay.yourdomain.com
python3 gen-installer.py office-pc linux --server https://sirelay.yourdomain.com
python3 gen-installer.py macbook mac --server https://sirelay.yourdomain.com
```

- **Windows**: Send `sirelay-home-laptop.bat` to the machine and double click. It will install, configure Task Scheduler, and launch in the background.
- **Linux**: Execute `bash sirelay-office-pc.sh`.
- **macOS**: Execute `bash sirelay-macbook.command`.

---

### API Reference

All requests must provide authorization unless specified.

| Endpoint | Method | Auth Role | Description |
|---|---|---|---|
| `/v1/fetch` | `POST` | Master Key | Dispatches an HTTP request to residential agents. Supports optional `node` (sticky routing) and `timeoutMs` (default 25s). |
| `/v1/agent/poll?node=NAME` | `GET` | Agent Key | Long-poll request (up to 20s) held by coordinator until a job arrives. Sends node telemetry. |
| `/v1/agent/result` | `POST` | Agent Key | Agent submits completed response status, headers, and base64 body. |
| `/v1/agent/bye?node=NAME` | `POST` | Agent Key | Immediate agent departure beacon (drain mode); marks node offline with zero delay. |
| `/v1/nodes` | `GET` | Master Key | Returns list of registered nodes, online status, telemetry, jobs done, and latencies. |
| `/v1/stats` | `GET` | Master Key | Returns detailed queue stats, aggregate success rates, and recent jobs. |
| `/v1/health` | `GET` | *Public* | Health status `{ ok: true, version, nodes, onlineNodes, uptimeSec }`. |
| `/` or `/dashboard` | `GET` | Master Key | Single-file responsive dark theme dashboard. Pass `?key=MASTER_KEY`. |

#### Submitting Fetch Jobs (`POST /v1/fetch`)

```typescript
const response = await fetch("https://sirelay.yourdomain.com/v1/fetch", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${SIRELAY_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    url: "https://1tv.ge/news/12345",
    method: "GET",
    headers: { "Accept-Language": "ka-GE,ka;q=0.9" },
    node: "home-laptop", // optional: sticky targeted routing to a specific machine
    timeoutMs: 20000,     // optional: custom request timeout (2s - 60s)
  }),
});

const result = await response.json();
if (result.ok) {
  const html = Buffer.from(result.bodyB64, "base64").toString("utf8");
  console.log(`Fetched via ${result.node} in ${result.durationMs}ms:`, html.slice(0, 100));
}
```

---

<a name="ქართული"></a>
## ქართული

### რა არის SiRelay?
SiRelay გაძლევთ საშუალებას შეასრულოთ HTTP მოთხოვნები საკუთარი მოწყობილობებიდან (Windows ლეპტოპები, Linux სერვერები, Mac კომპიუტერები). მოთხოვნები გამოდის **საცხოვრებელი (residential) IP მისამართებიდან** და არა მონაცემთა ცენტრის (VPS) IP-დან.

ეს უზრუნველყოფს:
- Cloudflare "Under Attack" რეჟიმისა და datacenter IP ბლოკების გვერდის ავლას.
- ქართული საინფორმაციო და სახელმწიფო საიტების (მაგ. `1tv.ge`) წვდომას, რომლებიც უცხოურ/ჰოსტინგ IP-ებს ბლოკავენ, თუმცა ადგილობრივი საცხოვრებელი ინტერნეტიდან ჩვეულებრივ იხსნებიან.

### მთავარი კომპონენტები

1. **კოორდინატორი (`coordinator.js`)**
   - ცენტრალური სერვერი VPS-ზე (Node.js 18+, დამოკიდებულებების გარეშე — 0 dependencies).
   - ანაწილებს დავალებებს round-robin (LRU) პრინციპით ყველაზე ნაკლებად დატვირთულ ონლაინ მოწყობილობაზე.
   - უსაფრთხოება: constant-time გასაღების შედარება (`crypto.timingSafeEqual`), SSRF დაცვა, 413/429 ლიმიტები.
   - ჩაშენებული მონიტორინგის dark-theme დაშბორდი (`/` ან `/dashboard`).

2. **აგენტი (`sirelay.js`)**
   - მუშაობს ნებისმიერ OS-ზე (Windows, Linux, macOS).
   - კავშირი არის **მხოლოდ გამავალი** (NAT-friendly) — პორტების გადამისამართება (Port Forwarding) საჭირო არ არის.
   - ჩართვისას ამოწმებს GitHub Releases-ს და ავტომატურად ანახლებს საკუთარ თავს.
   - აგზავნის მოწყობილობის ტელემეტრიას (ვერსია, OS, uptime) ყოველ poll-ზე.

3. **ინსტალერის გენერატორი (`gen-installer.py`)**
   - აგენერირებს 1-click ინსტალერებს თითოეული კომპიუტერისთვის უნიკალური გასაღებით.
   - **Windows**: ამოწმებს Node.js-ს (სთავაზობს `winget` ინსტალაციას), რთავს ფონურ Task Scheduler სერვისს, ქმნის `toggle-pause.bat`-ს და `uninstall.bat`-ს.
   - **Linux**: ამატებს `systemd --user` სერვისს.
   - **macOS**: ამატებს `launchd` დემონს.

### სწრაფი ინსტალაცია

#### კოორდინატორი (VPS)
```bash
export SIRELAY_KEY="შენი_საიდუმლო_მასტერ_გასაღები"
export SIRELAY_ALLOWLIST="1tv.ge,example.ge"
node coordinator.js
```

#### აგენტის ინსტალერის გენერაცია
```bash
# ინსტალერები იქმნება ./installers/ საქაღალდეში (პირადია, GitHub-ზე არ იტვირთება!)
python3 gen-installer.py edo-laptop windows --server https://sirelay.yourdomain.com
python3 gen-installer.py server-linux linux --server https://sirelay.yourdomain.com
```

---

## უსაფრთხოება & კონფიდენციალურობა (Security & Hardening)

1. **Public Repository Hygiene**:
   - კოდში არასოდეს ინახება რეალური სერვერის IP, დომენი ან გასაღები.
   - ინსტალერები გენერირდება ლოკალურად (`./installers/`) და იგნორირებულია `.gitignore`-ით.
2. **SSRF დაცვა (Server-Side Request Forgery)**:
   - კოორდინატორი ბლოკავს შიდა IP მისამართებს (127.0.0.1, 10.0.0.0/8, 192.168.0.0/16, 169.254.169.254 metadata და ა.შ.).
3. **Timing-Safe Auth**:
   - შედარება ხდება SHA-256 ჰეშების `crypto.timingSafeEqual` მეთოდით (timing შეტევების პრევენცია).
4. **როლების გამიჯვნა**:
   - `POST /v1/fetch`-ის გამოძახება შეუძლია მხოლოდ მასტერ გასაღებს (კლიენტს).
   - აგენტის გასაღებით დავალების გაშვება დაბლოკილია (403 Forbidden).

---

## ტესტირება & ხარისხის კონტროლი (Testing & CI)

პროექტი იყენებს Node.js-ის ჩაშენებულ ტესტ-რანერს (`node:test`):

```bash
# ტესტების გაშვება
npm test

# სინტაქსის შემოწმება
npm run lint
```

GitHub Actions ავტომატურად უშვებს ტესტებს Linux და Windows გარემოზე Node 18, 20 და 22 ვერსიებზე.

## ლიცენზია (License)
MIT © [sitechfromgeorgia](https://github.com/sitechfromgeorgia)
