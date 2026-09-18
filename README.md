# SiRelay — პირადი რეზიდენტული fetch-ქსელი

საკუთარი მოწყობილობების (Windows / Linux / macOS) ქსელი, რომელიც HTTP მოთხოვნებს
**საცხოვრებელი IP-ებიდან** ასრულებს — datacenter-ბლოკების (1tv.ge და მსგავსი) გვერდის ასარიდად.

```
[შენი ლეპტოპი] ──poll──> [კოორდინატორი (VPS)] <──POST /v1/fetch── [ნებისმიერი პროექტი]
       │  fetch ლოკალური IP-ით            │
       └────────── შედეგი ───────────────>│
```

## კომპონენტები

### 1. კოორდინატორი (`coordinator.js`) — VPS-ზე
```bash
SIRELAY_KEY=<secret> SIRELAY_ALLOWLIST=1tv.ge,example.com node coordinator.js
# PORT=8123 (default)
```

API (ყველა `Authorization: Bearer <key>`):
| endpoint | აღწერა |
|---|---|
| `POST /v1/fetch` | `{url}` → დაელოდება ≤25წმ → `{ok,status,headers,bodyB64,node}` |
| `GET /v1/nodes` | ონლაინ კომპების სია |
| `GET /v1/health` | ჯანმრთელობა (auth-ის გარეშე) |

### 2. აგენტი (`sirelay.js`) — ნებისმიერ კომპზე
გვერდით შექმენი `sirelay.config.json`:
```json
{ "server": "http://YOUR_SERVER:8123", "key": "<secret>", "name": "edos-laptop" }
```
გაშვება:
```bash
node sirelay.js        # Node 18+ (Windows-ზეც იგივე)
```

**Auto-update:** ყოველ ჩართვაზე ამოწმებს GitHub Releases-ს (`vX.Y.Z` თეგი +
`sirelay.js` asset) — ახალი ვერსია თუა, ჩამოტვირთვა + თვითრესტარტი.

### 3. Windows autostart (სურვილისამებრ)
`Win+R` → `shell:startup` → შექმენი `sirelay.bat`:
```bat
@echo off
cd /d C:\sirelay
node sirelay.js
```

## უსაფრთხოება
- გასაღების გარეშე არავინ არაფერს აკეთებს (403)
- `SIRELAY_ALLOWLIST` — რომელი დომენების წაკითხვა შეიძლება (ცარიელი = ყველა)
- კომპი NAT-ს უკნიდან **გამომავალი** კავშირით მუშაობს — პორტების გახსნა არ სჭირდება

## გამოყენება პროექტიდან (მაგ. tbilisi.today crawler)
```ts
const r = await fetch("http://COORDINATOR:8123/v1/fetch", {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://1tv.ge/news/…" }),
});
const { ok, status, bodyB64 } = await r.json();
const html = Buffer.from(bodyB64, "base64").toString("utf8");
```
