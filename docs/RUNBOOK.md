# Delivery runbook

Steps 1–2 record where the contract actually stands and what is still owed by the
client. Steps 3–6 must happen before anything touches Edwin's server; 7–9 are the
delivery itself.

*Last reviewed: 2026-08-21 — the platform is deployed and verified in production.*

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

### Received  ✅

1. **VPS** — Contabo Cloud VPS 4, Ubuntu 24.04, `169.58.205.53`.
2. **Hostname** — no purchase was needed. Contabo's own
   `vmi3520387.contaboserver.net` resolves to the box and Let's Encrypt issued for
   it, so the panel is on HTTPS and the broker on `mqtts` today. A branded domain
   can replace it later with the same eight `.env` lines.

**The platform is live at https://vmi3520387.contaboserver.net.**

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

> ### Status: superseded — deployed straight to the VPS
>
> This step was never run locally: the development machine had no Docker, and
> installing it needed elevation plus two reboots. The stack was deployed directly
> to Edwin's server instead, and **is now verified running there** — 7 containers
> healthy, 7 migrations applied, HTTPS panel, `mqtts` on 8883.
>
> Two defects were found by that first real boot that no amount of review had
> caught: a Socket.IO/@fastify-websocket upgrade-listener race that broke every
> WebSocket, and a certsync timing bug that would have left broker TLS dead for
> twelve hours. Both are fixed. **Keep this section** — it remains the right way to
> bring the stack up on any new machine, and the checklist in step 8 is what
> confirms it.

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
**Expected:** migration lines for `0001`…`0007`, then `database up to date`, then
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

Every row below has been run against the live deployment and passed. Re-run them
after any redeploy, and in full on any new server — each one confirms a specific
defect that was fixed but is invisible until the stack actually runs.

Run everything from `/opt/pulse` — compose bind-mounts `./infra/emqx/emqx.conf` and
`./infra/certsync/sync.sh` relatively, and from any other directory those become empty
mounts and EMQX silently starts on its default config.

Add `-T` to every `docker compose exec` when driving these over a non-interactive
SSH command, or they fail with *the input device is not a TTY*.

```bash
cd /opt/pulse
docker compose ps                      # every service up; none restarting
```

| # | Check | Expected | If it fails |
|---|---|---|---|
| 1 | `docker compose logs api --tail=40` | `applying migration` ×7 then `api listening`. **Only on the very first boot** — later starts log just `database up to date` with `count:7`, which is equally good | a `dist/server.js` MODULE_NOT_FOUND means a stale build context — `docker compose build --no-cache api` |
| 2 | `docker compose exec -T api printenv PGHOST PGPORT PGUSER PGDATABASE` | `postgres` / `5432` / `pulse` / `pulse` | the discrete `PG*` variables did not reach the container; `docker compose logs api | grep "Set DATABASE_URL"` confirms it |
| 3 | `docker compose exec -T postgres psql -U pulse -d pulse -c "SELECT name FROM _migrations ORDER BY name;"` | all **seven** migration filenames, including `0007_aggregate_compression.sql` | migrations did not complete — read the api logs, not the postgres logs; the API runs them |
| 4 | `ss -lntp | grep -E "5432|18083"` on the host | both bound to **127.0.0.1 only** | the loopback bind did not take effect — do not proceed until it has |
| 5 | Panel → change a device's interval | the device receives `{"interval":"..."}` on `d/<key>/dn` | check the retained publish in the api logs |
| 6 | Panel → a 24 h and a 30 d chart | both plot the **whole** range, right up to now | rollup re-bucketing or real-time aggregation |

### TLS checks — all four verified on 2026-08-21

| # | Check | Expected |
|---|---|---|
| 7 | `docker compose exec -T emqx ls -l /opt/emqx/etc/certs` | `mqtt.crt` and `mqtt.key` owned by **emqx (uid 1000)**, not root — without this EMQX cannot read its own key and 8883 silently never opens |
| 8 | `docker compose logs certsync` | `installed a new certificate for <MQTT_DOMAIN>` |
| 9 | `openssl s_client -connect <MQTT_DOMAIN>:8883 -servername <MQTT_DOMAIN> </dev/null` | handshake completes, chain valid to a public root, `CN` matches the hostname |
| 10 | `crontab -l` | the weekly `docker compose restart emqx` — EMQX reads its certificate **only at boot**, so without it a renewed cert is never picked up and every device fails TLS about 60 days in |

> If `MQTT_DOMAIN` is empty (no domain yet), skip rows 7–10: certsync idles by
> design and logs
> `[certsync] MQTT_DOMAIN is not set — TLS for the broker is disabled, idling.`
> Chasing a listener that was never meant to start costs an evening.

> **First boot noise that is not a failure.** `emqx` only waits on `postgres`, so it
> can accept connections before the API has created the `emqx_authn`/`emqx_acl` views
> (migration 0004) and the `pulse-backend` service account. Expect a few
> `broker error` / `not_authorized` lines in the ingest log; mqtt.js retries every 2 s
> and it self-heals. Confirm with `docker compose logs ingest` showing `subscribed`
> on `d/+/up`, `d/+/up/+`, `d/+/status`.

### 8.2 Load check

> **Register your admin account in the panel BEFORE running anything below.** Both
> `provision.js` and the seed insert users with the default role `user`, and
> `/auth/register` only grants admin when the users table is *empty*. Run either one
> first and the deployment ends up with **no administrator at all**, recoverable only
> by hand-editing Postgres. Also: never run the seed on Edwin's server — it creates
> `demo@pulse.io` with the password printed in the README.

```bash
docker compose logs ingest --tail=20
docker compose exec api node apps/simulator/dist/provision.js --devices 5 --email you@example.com
docker compose exec api node apps/simulator/dist/run.js --devices 5 --interval 10
```

Read `written`/`dropped` from `docker compose logs ingest`, **not** from `/health` —
`/health` only covers the API's own HTTP and WebSocket ingest, never MQTT.

Watch the live panel, then **delete the five test devices from the admin panel**
before handover. Do not leave test data in his production system.

---

## 8.3 If a device credential leaks

Rotating the token does **not** disconnect the device that is already connected —
EMQX authenticates at CONNECT, and an established session keeps publishing on the
old credential until it happens to reconnect. To actually cut one off:

1. **Disable** the device in the panel. That drops its rows from `emqx_acl`, and
   EMQX's authorization cache expires within 60 s, so the live session stops being
   able to publish.
2. Wait a minute, then **Rotate token** and copy the new one.
3. **Re-enable** the device and flash the new token.

Disabling first is the part that matters — do it in the other order and the leaked
credential keeps working until the device reconnects on its own.

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
