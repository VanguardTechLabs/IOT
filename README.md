# Pulse — IoT Platform for ESP32 fleets

Real-time telemetry, per-device variables, historical charts, CSV export and downlink
commands over **MQTT, HTTP and WebSockets**. Built to hold 100+ devices on one modest
VPS and to scale out without a redesign.

```
ESP32 ──MQTT/HTTP/WS──▶ EMQX ──▶ Ingest worker ──┬──▶ TimescaleDB   (history, rollups)
                                                 ├──▶ Redis         (last value, presence)
                                                 └──▶ Socket.IO ──▶ React dashboard
```

---

## Quick start

```bash
cp .env.example .env
#  edit .env: POSTGRES_PASSWORD, MQTT_BACKEND_PASSWORD, JWT_SECRET, EMQX_DASHBOARD_PASSWORD
#  they ship empty and the stack refuses to start until they are set

docker compose up -d --build
```

| Service | URL | Notes |
|---|---|---|
| Dashboard | http://localhost:8080 | register the first account here |
| API | http://localhost:8080/api/v1 | same origin as the dashboard |
| MQTT | `localhost:1883` | device username = device key |
| MQTT over WS | `localhost:8083/mqtt` | for browser-based devices |
| EMQX dashboard | http://localhost:18083 | `admin` / `EMQX_DASHBOARD_PASSWORD` |

**The first account to register becomes the administrator** — an admin panel at
`/admin` covers users, plans, roles and every device on the platform. Register
yours before sharing the URL.

Migrations run automatically on API start. To seed a demo account with the nine
reference variables:

```bash
docker compose exec api node packages/core/dist/db/seed.js
```

### Tests

```bash
pnpm test     # 24 assertions over the wire contract, credentials, ingest loop and query routing
```

These cover the rules the firmware, the simulator, EMQX and the CSV export all
depend on — value casting, type inference, device-clock sanitising, the salted
SHA-256 construction EMQX validates, the time-zone validator that guards the COPY
statement, and chart resolution routing. No database required.

### Local development

```bash
pnpm install
pnpm infra:up          # postgres + redis + emqx only
pnpm build:core
pnpm dev               # api :4000, ingest worker, web :5173
```

`pnpm dev` runs api and ingest **on the host**, not in Compose, so nothing loads
`.env` for them and the hostnames in it (`postgres`, `redis`, `emqx`) only resolve
inside the Docker network. Export the host-facing equivalents first:

```bash
export DATABASE_URL=postgres://pulse:<POSTGRES_PASSWORD>@localhost:5432/pulse
export REDIS_URL=redis://localhost:6379
export MQTT_URL=mqtt://localhost:1883
export MQTT_BACKEND_PASSWORD=<same value as .env>
export JWT_SECRET=<same value as .env>
```

---

## The wire contract

**One message per cycle, carrying every variable.** This is the single most important
decision in the design: nine separate publishes multiply broker load by nine for
identical data. At 100 devices × 9 variables every 3 s that is 33 msg/s instead of 300.

```jsonc
// topic: d/<deviceKey>/up
{
  "ts": 1730000000,            // optional, seconds or ms; server stamps if absent/implausible
  "v": {
    "temp":  "23.5",           // every value is a string
    "relay": "1",
    "mode":  "auto"
  }
}
```

A flat body (`{"temp":"23.5"}`) is accepted too. The platform casts each value using
the **type declared for that variable** in the panel — `int`, `float`, `bool` or
`string`. Unknown keys create a variable automatically with an inferred type unless
the device has auto-create disabled.

Commands travel back the same way, also as strings:

```jsonc
// topic: d/<deviceKey>/dn
{ "relay": "1" }
```

Presence uses a retained MQTT last will on `d/<deviceKey>/status`
(`"online"` / `"offline"`), backed by a server-side sweeper for devices that lose
power mid-cycle or speak HTTP.

### Three transports, one credential

| Transport | Endpoint | Best for |
|---|---|---|
| MQTT | `d/<key>/up`, user = device key, pass = token | the default for ESP32 |
| HTTP | `POST /api/v1/ingest` + `X-Device-Key` / `X-Device-Token` | rare reports, restrictive firewalls |
| WebSocket | `GET /api/v1/ingest/ws?key=…&token=…` | fast intervals plus downlink on one socket |

All three validate the same salted SHA-256 material, so a device can switch protocol
without new credentials. EMQX reads it directly from Postgres through the `emqx_authn`
and `emqx_acl` views, and each device is restricted to its own topic tree.

---

## How it scales

| Concern | Approach |
|---|---|
| Write volume | Telemetry is buffered and flushed as multi-row statements every 200 ms / 500 rows — ~5 statements/s instead of 300 |
| Storage | TimescaleDB hypertable, compressed after 2 days (`segmentby = variable_id`), 10–20× reduction |
| Retention | 30-day drop policy; per-plan retention enforced at query time |
| Chart reads | Continuous aggregates at 1 m and 1 h; the API routes ≤6 h → raw, ≤7 d → 1 m, else 1 h |
| Dashboard load | `variable_state` holds the current value per variable, so first paint never touches the hypertable |
| Time zones | Stored in UTC always; each device carries its own IANA zone, used to label its charts and CSV export |
| Live updates | Ingest publishes to Redis; every API instance fans out to its own sockets |
| Abuse | Per-device burst limit in Redis, per-IP rate limit on the API, plan limits on devices and variables |

**Sizing.** 100 devices × 9 variables at the 10 s default ≈ 7.8 M rows/day, ~5–15 GB
compressed over 30 days. A 4 vCPU / 8 GB / 160 GB NVMe VPS covers it comfortably. At a
3 s interval the same fleet produces ~26 M rows/day, which is why 10 s is the default
and 3 s is opt-in per device.

---

## Load testing with 100 virtual devices

```bash
docker compose exec api node apps/simulator/dist/provision.js --devices 100 --interval 10
docker compose exec api node apps/simulator/dist/run.js --devices 100 --interval 10
```

`provision.js` attaches its devices to an **existing** account — pass
`--email you@example.com`; it will not create one, precisely so a load test cannot
leave a working login behind on a production server. It writes to the database
directly and deliberately bypasses the plan ceiling — a load test that has to respect a 2-device limit cannot prove the platform
holds 100. It writes `simulated-devices.json`, which `run.js` then drives over MQTT
with jittered start times so the broker sees a steady rate rather than a herd.

The simulator logs its own publish rate every 10 s, and the ingest worker logs
`buffered / written / dropped` every 60 s — `docker compose logs ingest` is the
number that matters for a load test.

`GET /health` reports the same three counters for **the API process only**, which
covers the HTTP and WebSocket ingest paths. MQTT telemetry is written by the ingest
worker in a separate container, so it never appears there.

---

## Firmware

[`firmware/esp32/pulse_esp32.ino`](firmware/esp32/pulse_esp32.ino) is a complete
reference sketch: WiFi + MQTT reconnect, retained last will, one batched publish per
cycle, downlink command handling and a remotely adjustable interval. Set `DEVICE_KEY`
and `DEVICE_TOKEN` from the device page and flash.

Builds from the Arduino IDE, or with PlatformIO from the same file — `src_dir = .`
means there is one source of truth, not two copies that drift:

```bash
cd firmware/esp32
pio run -e esp32dev     -t upload -t monitor   # plain MQTT on 1883
pio run -e esp32dev-tls -t upload -t monitor   # mqtts on 8883
```

> `mqtt.setBufferSize(768)` matters — PubSubClient's 256-byte default silently
> truncates a nine-variable payload.

---

## Repository layout

```
packages/core        schema, migrations, crypto, ingest engine, plan limits
apps/api             REST + Socket.IO + HTTP/WS device ingest
apps/ingest          MQTT consumer, presence, offline sweeper
apps/web             React 19 + Vite + Tailwind v4 dashboard
apps/simulator       fleet provisioning and load generation
firmware/esp32       reference Arduino sketch
infra/               EMQX, Caddy and nginx configuration
```

Migrations are plain SQL in `packages/core/migrations`, applied in order and recorded
in `_migrations`. Files marked `-- pulse:no-transaction` run statement-by-statement
because TimescaleDB refuses continuous aggregates inside a transaction block.

---

## API surface

All routes are under `/api/v1`. There are three ways to authenticate:

| Caller | Credential | Scope |
|---|---|---|
| Browser | short-lived bearer token + rotating httpOnly refresh cookie | full |
| Integration | `X-API-Key: pk_…` | **read-only** — writes are rejected with 403 |
| Device | `X-Device-Key` + `X-Device-Token`, or MQTT username/password | its own topics only |

An API key that leaks cannot alter a fleet, which is why it is confined to `GET`.

```
POST   /auth/register · /auth/login · /auth/refresh · /auth/logout · /auth/password
GET    /auth/me

GET    /devices                      POST   /devices
GET    /devices/:id                  PATCH  /devices/:id          DELETE /devices/:id
POST   /devices/:id/rotate-token
GET    /devices/:id/connection       ← ready-to-paste connection details
GET    /devices/:id/state            ← every current value, one round trip
GET    /devices/:id/series           GET    /variables/:id/series
GET    /devices/:id/export.csv       ← streamed with COPY, any range
GET    /devices/:id/commands         POST   /devices/:id/commands

GET    /devices/:id/variables        POST   /devices/:id/variables
PATCH  /variables/:id                DELETE /variables/:id
POST   /devices/:id/variables/reorder

GET    /plans · /account/usage · /account/api-keys (GET/POST/DELETE)
GET    /admin/overview · /admin/users · /admin/devices
PATCH  /admin/users/:id · /admin/devices/:id       DELETE /admin/users/:id

GET    /admin/overview               ← platform counts + storage footprint
GET    /admin/users                  PATCH  /admin/users/:id      DELETE /admin/users/:id
GET    /admin/devices                PATCH  /admin/devices/:id    ← enable / disable

POST   /ingest                       GET    /ingest/ws            ← device-facing
```

---

## What is deliberately not here yet

**Email.** Registration activates an account immediately — agreed with the client, so
there is no verification mail and no SMTP dependency anywhere in the stack. Should
that change, it needs a mail provider plus one nullable `verified_at` column.

**Alerting.** The `alert_rules` table, operators and notification channels are in the
schema and enforced by constraints; the evaluator is the next stage. Nothing about
adding it requires a migration to existing tables.

**Billing.** The `plans` table carries prices and all three tiers, and every limit is
enforced end to end today. Moving a user to a paid tier is a single field update — no
schema change, no code change.

---

## Serving with nginx instead of Caddy

Caddy is the default because it provisions and renews TLS unattended. If your
deployment standardises on nginx, the same stack runs behind it:

```bash
docker compose -f docker-compose.yml -f docker-compose.nginx.yml up -d --build
```

Only the `web` service changes; Postgres, Redis, EMQX, api and ingest are
untouched, and `.env` behaves identically.

What you take on by switching:

| | Caddy (default) | nginx |
|---|---|---|
| HTTPS | automatic, renews itself | certbot + a renewal cron |
| Broker certificate for `mqtts` | `certsync` copies Caddy's | manual |
| WebSocket upgrades | implicit | four explicit directives |
| Compression | zstd + gzip | gzip |

That third row is the one that bites. nginx will not upgrade a WebSocket unless
told to, and a missing `Upgrade`/`Connection` pair does not error — it quietly
serves a normal response, the dashboard's live badge sticks on **Offline**, and
device uplinks on `/api/v1/ingest/ws` fail the same way with nothing in the panel
to explain it. [`infra/nginx/nginx.conf`](infra/nginx/nginx.conf) has it wired
correctly; if you adapt that file, keep the `map $http_upgrade` block and the
per-location headers together.

---

## Production notes

See **[docs/DEPLOY.md](docs/DEPLOY.md)** for the full walkthrough. In short: set
`SITE_ADDRESS`, `MQTT_SITE_ADDRESS`, `MQTT_DOMAIN` and `MQTT_TLS_ENABLED` in `.env`
and Caddy provisions certificates for both the panel and the broker; a `certsync`
sidecar hands the broker certificate to EMQX.

> **If the domain is on Cloudflare, the MQTT record must be DNS-only (grey cloud).**
> Cloudflare's proxy does not carry MQTT on 1883 or 8883, and a proxied record breaks
> every device with no visible cause in the panel.

- `synchronous_commit=off` is set on Postgres. For telemetry that trade is right: a
  crash can lose the last few hundred milliseconds of samples in exchange for a large
  throughput gain. Turn it back on if that is not acceptable for your data.
- Scale reads by adding API replicas behind Caddy; they share state through Redis. The
  ingest worker is single-writer by design — shard it by topic prefix before adding a
  second one.
