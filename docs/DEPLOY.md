# Deploying Pulse

Target: a single VPS with Docker. Verified sizing for the contracted workload
(100 devices × 9 variables) is **8 GB RAM / 4 vCPU / 200 GB NVMe**.

---

## 1. Server

```bash
# Ubuntu 22.04 / 24.04
curl -fsSL https://get.docker.com | sh
usermod -aG docker $USER   # log out and back in

git clone <repo> /opt/pulse && cd /opt/pulse
cp .env.example .env
```

Set these four in `.env` before anything else. They ship **empty** in
`.env.example` and Compose declares them `${VAR:?}`, so the stack refuses to start
until you fill them in — a deployment cannot end up on a default secret.

`tr '+/' '-_'` is not cosmetic: these values are passed to Postgres and to the
broker verbatim, and stripping the two URL-reserved characters keeps them safe to
paste anywhere, including a `DATABASE_URL` if you ever run the services on the host.

```bash
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr '+/' '-_')
MQTT_BACKEND_PASSWORD=$(openssl rand -base64 24 | tr '+/' '-_')
JWT_SECRET=$(openssl rand -base64 48 | tr '+/' '-_')
EMQX_DASHBOARD_PASSWORD=<at least 8 characters>
```

```bash
docker compose up -d --build
```

Open `http://<server-ip>:8080`. **The first account to register becomes the
administrator** — register yours before handing the URL to anyone else.

---

## 2. DNS

Two records, both pointing at the server:

| Record | Example | Cloudflare proxy |
|---|---|---|
| Panel | `pulse.example.com` | 🟠 proxied is fine |
| MQTT | `mqtt.example.com` | ⚪ **DNS only — grey cloud** |

> **The single most common way to break this deployment:** leaving the MQTT record
> orange-clouded. Cloudflare's proxy carries HTTP(S) only — it does not carry MQTT
> on 1883 or 8883, and it will not forward the ACME challenge for that hostname
> either. Every device fails to connect and the cause is invisible from the panel.
> Click the cloud until it is grey.

Cloudflare is still worth using for the panel: free DNS, DDoS protection, and it
costs nothing. It just cannot be in the path of the broker.

---

## 3. TLS

Edit `.env`:

```bash
PUBLIC_URL=https://pulse.example.com
SITE_ADDRESS=pulse.example.com          # Caddy provisions + renews automatically
MQTT_SITE_ADDRESS=mqtt.example.com      # so Caddy gets a certificate for MQTT too
MQTT_DOMAIN=mqtt.example.com            # for the certsync sidecar
MQTT_TLS_ENABLED=true                   # opens mqtts on 8883
ACME_EMAIL=you@example.com
COOKIE_SECURE=true                      # required once the panel is on https
PUBLIC_MQTT_HOST=mqtt.example.com
PUBLIC_MQTT_PORT=8883
CADDY_HTTP_PORT=80                      # see below — required for HTTP-01 and for
CADDY_HTTPS_PORT=443                    # the firewall rules in section 4
```

> Until `CADDY_HTTP_PORT=80` is set, Compose publishes the panel on **:8080**, and
> Let's Encrypt's HTTP-01 challenge — which always connects to port 80 — cannot
> reach Caddy. Set it before running the commands below, or no certificate is ever
> issued and the `ufw` rules in section 4 guard a port nothing is listening on.

```bash
docker compose up -d
docker compose logs -f certsync         # wait for "installed a new certificate"
docker compose restart emqx             # EMQX reads the certificate at boot
```

Ports 80 and 443 must be open for the certificate to be issued — Caddy uses an
HTTP-01 challenge.

### Renewal

Caddy renews on its own roughly every 60 days and `certsync` copies the new
certificate within 12 hours. EMQX reads its certificate **at boot only**, so add
one weekly restart:

```bash
(crontab -l 2>/dev/null; echo "0 4 * * 0 cd /opt/pulse && docker compose restart emqx") | crontab -
```

A restart is a few seconds and devices reconnect automatically. This is the
deliberate trade: the alternative is giving a sidecar access to the Docker socket,
which is root-equivalent on the host and not worth it at this scale.

---

## 4. Firewall

```bash
ufw allow 22,80,443/tcp
ufw allow 8883/tcp                 # mqtts
ufw allow 1883/tcp                 # plain MQTT — omit once every device speaks TLS
ufw enable
```

Do **not** expose 18083 (EMQX dashboard) or 5432 (Postgres) publicly. Reach them
over an SSH tunnel:

```bash
ssh -L 18083:localhost:18083 -L 5432:localhost:5432 user@server
```

To stop Compose publishing Postgres at all, remove its `ports:` block —
nothing outside the Compose network needs it.

---

## 5. Verify

```bash
curl -s https://pulse.example.com/health | jq
docker compose logs --tail=50 ingest      # "subscribed" on the three topic filters
docker compose exec api node apps/simulator/dist/provision.js --devices 5
docker compose exec api node apps/simulator/dist/run.js --devices 5 --interval 10
```

Watch the dashboard: five devices go online and their tiles start updating. Then
delete them from the admin panel before handing the system over.

---

## 6. Backups

Only Postgres holds anything irreplaceable.

```bash
# /etc/cron.daily/pulse-backup
docker compose -f /opt/pulse/docker-compose.yml exec -T postgres \
  pg_dump -U pulse -Fc pulse > /var/backups/pulse-$(date +\%F).dump
find /var/backups -name 'pulse-*.dump' -mtime +14 -delete
```

A full dump of 30 days of telemetry for 100 devices is a few GB. If that grows
uncomfortable, dump with `--exclude-table-data=telemetry` — the configuration is
what is hard to recreate; a gap in historical sensor readings is not.

---

## 7. Upgrades

```bash
cd /opt/pulse && git pull
docker compose up -d --build
```

Migrations run automatically on API start and are idempotent. Roll back by
checking out the previous commit and rebuilding — no migration in this release
drops a column, so an older image runs against a newer schema.

---

## Using nginx instead of Caddy

```bash
docker compose -f docker-compose.yml -f docker-compose.nginx.yml up -d --build
```

Sections 1, 2 and 4 above apply unchanged. **Section 3 (TLS) does not** — nginx
has no ACME client, so replace it with certbot:

```bash
docker compose stop web
docker run --rm -p 80:80 -v /etc/letsencrypt:/etc/letsencrypt   certbot/certbot certonly --standalone -d panel.example.com
```

Then mount `/etc/letsencrypt` into the web service, uncomment and complete the
`listen 443 ssl` block in [`infra/nginx/nginx.conf`](../infra/nginx/nginx.conf),
set `PUBLIC_URL=https://…` and `COOKIE_SECURE=true` in `.env`, and add a renewal
cron. The `certsync` sidecar has nothing to do in this configuration, so the
broker certificate for `mqtts` on 8883 must be placed in the `emqxcerts` volume
by hand as `mqtt.crt` / `mqtt.key`, owned by uid 1000.

This is roughly an hour of setup that Caddy does in one line, which is why Caddy
is the default. Choose nginx only if something else in your estate requires it.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Devices cannot connect over TLS | MQTT record is orange-clouded in Cloudflare, or `docker compose restart emqx` was never run after the first certificate |
| `certsync` logs "no certificate yet" | Ports 80/443 blocked, or `MQTT_SITE_ADDRESS` not set so Caddy never requested that certificate |
| Login works, then every request 401s | `COOKIE_SECURE=true` while the panel is served over plain HTTP |
| Broker rejects a device with `not_authorized` | Device disabled in the admin panel, or its token was rotated and the firmware still has the old one |
| Charts empty beyond a few hours | Continuous aggregates never materialised — check `docker compose logs postgres` for background worker errors |
| Live badge stuck on **Offline**, console shows `Invalid frame header` | A proxy in front is not upgrading WebSockets, or is compressing them. With nginx, check the `map $http_upgrade` block and the `Upgrade`/`Connection` headers in every proxied location |
| `docker compose logs ingest` shows `dropped` climbing | Postgres cannot keep up; check disk I/O and confirm the compression policy is running. **Use the ingest logs, not `/health`** — `/health` reports the API's own writer, which only sees the HTTP and WebSocket paths, never MQTT |
