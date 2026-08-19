# Delivery runbook

Steps 1–2 record where the contract actually stands and what is still owed by the
client. Steps 3–6 must happen before anything touches Edwin's server; 7–9 are the
delivery itself.

*Last reviewed: 2026-08-19.*

---

## 1. Contract status  ✅ nothing outstanding

| Item | State |
|---|---|
| Bid accepted | 2026-08-01 19:59 — USD 60.00, held in escrow |
| Original deadline | 2026-08-04 (the platform recorded 3 days; never realistic) |
| Extension 1 | requested → **approved** → 2026-08-16 12:20 |
| Extension 2 | requested → **approved** → **2026-08-24 15:39** ← current |
| Scope | confirmed in writing by Edwin |
| Open questions | none — email verification dropped, time zone is per device |

The deadline has already been extended twice and both were approved. **Do not ask
for a third unless the server genuinely slips past 2026-08-24** — at that point send
a status update instead, because two extensions is the limit of what still reads as
professional on a USD 60 contract.

---

## 2. What is still blocking delivery

The code is finished: it builds, typechecks and passes its test suite. Exactly one
thing stands between here and handover — **a server to put it on.**

### Already settled

- Scope confirmed by Edwin in writing.
- Both open questions answered: no email verification, time zone chosen per device.
- Server recommendation sent (Contabo, 8 GB RAM / 200 GB NVMe, Ubuntu 24.04).
- Edwin has opened a Contabo account and asked which region to choose — answered:
  the one closest to him.

### Still owed by Edwin

1. **The VPS IP and root password**, once the instance finishes provisioning.
2. **A domain or subdomain**, with access to its DNS panel. If it is on Cloudflare,
   the MQTT subdomain must be **DNS only (grey cloud)** — see step 7.

Until both arrive, steps 3–6 are the useful work: boot the whole stack locally and
find the problems here rather than on his machine.

> ### ⚠️ Credential hygiene
>
> Edwin has pasted account passwords directly into the Workana chat. **Never copy
> them into this repository, into `.env`, into a commit message or into an issue.**
> This repo has a GitHub remote — anything committed is published. Keep them in a
> password manager, use them only over SSH, and tell him to rotate every password he
> typed into chat once handover is complete.

---

## 3. Install Docker Desktop

```powershell
winget install Docker.DockerDesktop
```

Reboot, launch Docker Desktop, wait for the whale icon to stop animating, then:

```powershell
docker version
docker compose version
```

Both must print without error before continuing.

---

## 4. Boot the stack locally

**This is the most important step in the runbook.** Everything is compiled and
typechecked, but the containers have never run together. Find the problems here,
not on Edwin's server.

> ### ⚠️ Status: not yet performed
>
> As of 2026-08-19 this step has **not** been run — the development machine has no
> Docker and installing it needs elevation plus two reboots. The decision was to
> verify on the server instead, which means **the first time these containers ever
> run together will be on Edwin's VPS.**
>
> That is a real risk, not a formality. Build, typecheck and the 24 tests all pass,
> but they exercise pure logic — no test starts Postgres, EMQX or Caddy. If you get
> access to any machine with Docker before deploying, run this section there first;
> it costs ten minutes and it is the difference between debugging on your box and
> debugging on the client's.
>
> If you go straight to the server, work through **step 8's first-boot checklist**,
> which covers exactly what this step would have caught.

### 4.1 Configure

```powershell
cd c:\Users\Administrator\Documents\IOT
Copy-Item .env.example .env
```

Generate three secrets and paste them into `.env`:

```powershell
node -e "for (const k of ['POSTGRES_PASSWORD','MQTT_BACKEND_PASSWORD','JWT_SECRET']) console.log(k + '=' + require('crypto').randomBytes(32).toString('base64url'))"
```

Also set `EMQX_DASHBOARD_PASSWORD` to at least 8 characters. Leave the whole TLS
block at its defaults for local testing.

### 4.2 Start

```powershell
docker compose up -d --build
```

First build pulls several images and compiles two Node images — expect 3–8 minutes.

```powershell
docker compose ps
```

**Expected:** `postgres`, `redis`, `emqx` healthy; `api`, `ingest`, `web`,
`certsync` running.

### 4.3 Check each service

```powershell
docker compose logs api --tail=40
```
**Expected:** migration lines for `0001`…`0006`, then `database up to date`, then
`api listening`.
**If it fails:** read the migration error. A TimescaleDB failure on `0002`/`0003`
means the extension did not load — check `docker compose logs postgres`.

```powershell
docker compose logs ingest --tail=20
```
**Expected:** `broker connected` and `subscribed` listing `d/+/up`, `d/+/up/+`,
`d/+/status`.
**If you see repeated `broker error` / `not_authorized`:** the service account did
not reach `emqx_authn`. Confirm `MQTT_BACKEND_PASSWORD` is identical for `api` and
`ingest` (they share the `&node_env` anchor, so it should be), then
`docker compose restart emqx ingest`.

```powershell
curl http://localhost:8080/health
```
**Expected:** `{"status":"ok","uptime":…,"writer":{"buffered":0,"written":0,"dropped":0}}`

### 4.4 First login

Open **http://localhost:8080** → **Create account**.

- The first account becomes admin. An **Admin** item appears in the top nav.
- Check `/admin` → Overview loads with counts and storage figures.

### 4.5 End-to-end with one device

1. **Devices → New device.** Name it, keep the 10 s interval.
2. Copy the **device key** and **token** from the dialog (the token is shown once).
3. Publish a reading — replace the two placeholders:

```powershell
curl -X POST http://localhost:8080/api/v1/ingest `
  -H "X-Device-Key: dev_xxxxxxxx" `
  -H "X-Device-Token: tok_xxxxxxxx" `
  -H "Content-Type: application/json" `
  -d '{\"v\":{\"temp\":\"23.5\",\"hum\":\"61\",\"relay\":\"1\"}}'
```

**Expected:** `{"accepted":3,"rejected":[],"intervalS":10}`
**And in the browser, without reloading:** three variable tiles appear, values flash
in, the device goes **Online**.

If the tiles do not appear live, the Socket.IO path is broken — check the browser
console and `docker compose logs api`.

4. Open the tile menu (pencil) on `relay` → tick **Writable** → Save. A toggle
   appears on the tile. Press it and confirm `POST .../commands` returns 200.

### 4.6 Load test — 100 devices

This is the claim you made to Edwin. Prove it.

```powershell
docker compose exec api node apps/simulator/dist/provision.js --devices 100 --interval 10
docker compose exec api node apps/simulator/dist/run.js --devices 100 --interval 10
```

**Expected:** a throughput line every 10 s reading roughly `published: 100,
rate: 10.0 msg/s, failed: 0`.

Let it run **30 minutes**, then:

```powershell
docker compose logs ingest --tail=5
```

**Expected:** `dropped: 0` and `written` around **162,000** (100 devices x 9
variables x 180 cycles). Any non-zero `dropped` means Postgres could not keep up —
tell me the number and the `ingest` logs.

> Do **not** use `/health` here. It reports the API process's writer, which only
> ever sees HTTP and WebSocket uplinks — the simulator speaks MQTT, so `/health`
> would show `written: 0` no matter how well the run went.

Then in the browser: open one simulated device, switch the chart to **1h** and
**24h**, and confirm both render. Click **Export CSV** and open the file.

Stop with `Ctrl+C`, then clean up:

```powershell
docker compose down -v      # -v wipes the volumes, including the 100 test devices
```

### 4.7 If anything above fails

Send me the exact command, the output, and `docker compose logs <service> --tail=60`.
Do not work around it — a bug found here is 10 minutes; the same bug found on
Edwin's server is an evening.

---

## 5. Version control  ✅ already done

Initialised, committed and pushed:

```
origin   https://github.com/VanguardTechLabs/IOT.git
branch   main
```

`.gitignore` excludes `node_modules`, `dist`, `.env` and `*.tsbuildinfo`. Before every
push, confirm `.env` is **not** listed in `git status` — it carries the JWT secret and
both database passwords.

Step 7 clones this repo onto Edwin's server, and repository access is part of the
handover in step 9.

---

## 6. Flash a real ESP32  *(if you have a board)*

You told Edwin the example firmware is ready to load. Verify that literally.

1. Open `firmware/esp32/pulse_esp32.ino`.
2. Fill in `WIFI_SSID`, `WIFI_PASSWORD`, `DEVICE_KEY`, `DEVICE_TOKEN`, `MQTT_HOST`
   (your PC's LAN IP, not `localhost` — the ESP32 resolves it on the network).
3. Arduino IDE: install **PubSubClient** and **ArduinoJson v7**, select
   *ESP32 Dev Module*, upload.
   PlatformIO: `cd firmware/esp32 && pio run -e esp32dev -t upload -t monitor`
4. **Expected on the serial monitor:** `[wifi] connected`, `[mqtt] connecting —
   connected`, then an `[up] {...}` line every 10 s.
5. **Expected in the panel:** the device goes Online and ten variables appear
   automatically (auto-create infers each type).
6. Toggle `relay` from the panel → `[cmd] relay = 1` appears on the serial monitor.

No board? Say so in the delivery message rather than implying it was tested.

---

## 7. Deploy to Edwin's server

Only once steps 4–6 pass and you have the IP, root password and domain.

Follow **[DEPLOY.md](DEPLOY.md)** end to end. The short version:

```bash
ssh root@<ip>
curl -fsSL https://get.docker.com | sh
git clone <your-private-repo> /opt/pulse && cd /opt/pulse
cp .env.example .env
# set the three secrets + EMQX_DASHBOARD_PASSWORD + the TLS block
docker compose up -d --build
```

**The two things that will bite you:**

- **Cloudflare grey cloud.** The MQTT subdomain record must be DNS-only. If it is
  proxied, Caddy cannot get its certificate and no device can connect — and nothing
  in the panel will tell you why.
- **`docker compose restart emqx`** after `certsync` reports the first certificate.
  EMQX reads its certificate at boot only. Then install the weekly renewal cron from
  DEPLOY.md.

Firewall: `ufw allow 22,80,443,1883,8883/tcp`. Do **not** open 18083 or 5432.

---

## 8. Verify on his server

### 8.1 First-boot checklist

Because step 4 was never run locally, this is the first time the stack has started
anywhere. Check these in order — each one is a specific failure that was fixed but
never observed running, so this is where they get confirmed.

```bash
docker compose ps                      # every service up; none restarting
```

| # | Check | Expected | If it fails |
|---|---|---|---|
| 1 | `docker compose logs api --tail=40` | migrations `0001`…`0006`, then `api listening` | a `dist/server.js` MODULE_NOT_FOUND means a stale build context — `docker compose build --no-cache api` |
| 2 | `docker compose exec api node -e "require('pg')"` + API logs | no `Set DATABASE_URL, or PGHOST/...` error | the discrete `PG*` variables did not reach the container |
| 3 | `docker compose logs postgres | grep -i "continuous aggregate"` | no errors; migration 0006 applied | TimescaleDB extension did not load |
| 4 | `ss -lntp | grep -E "5432|18083"` on the host | both bound to **127.0.0.1 only** | the loopback bind did not take effect — do not proceed until it has |
| 5 | `docker compose logs certsync` then `docker compose exec emqx ls -l /opt/emqx/etc/certs` | `mqtt.key` owned by uid 1000 | EMQX cannot read the key and 8883 will not open |
| 6 | `docker compose logs emqx | grep -i ssl` after `docker compose restart emqx` | the 8883 listener starts | see 5 |
| 7 | Panel → change a device's interval | the device receives `{"interval":"..."}` on `d/<key>/dn` | check the retained publish in the api logs |
| 8 | Panel → a 24 h and a 30 d chart | both plot the **whole** range, right up to now | rollup re-bucketing or real-time aggregation |

### 8.2 Load check

```bash
docker compose logs ingest --tail=20
docker compose exec api node apps/simulator/dist/provision.js --devices 5
docker compose exec api node apps/simulator/dist/run.js --devices 5 --interval 10
```

Read `written`/`dropped` from `docker compose logs ingest`, **not** from `/health` —
`/health` only covers the API's own HTTP and WebSocket ingest, never MQTT.

Watch the live panel, then **delete the five test devices from the admin panel**
before handover. Do not leave test data in his production system.

---

## 9. Handover

Register your admin account first, then create Edwin's and promote him to **admin**
from `/admin → Users → Role`.

Deliver:

| Item | Where it comes from |
|---|---|
| Panel URL + his admin credentials | you create them |
| Source repository access | step 5 |
| `README.md` | architecture, wire contract, API surface |
| `docs/DEPLOY.md` | how to redeploy, back up, upgrade |
| `firmware/esp32/` | the sketch, both build systems |
| EMQX dashboard credentials | `EMQX_DASHBOARD_PASSWORD` |
| The `.env` file | **send separately, never in the repo** |

State plainly in the delivery message what is **phase 2**, so there is no ambiguity
later: alerts and notifications, payment plans and billing, mobile app. The schema
and plan limits are already in place for all three — that was the point of building
them now.
