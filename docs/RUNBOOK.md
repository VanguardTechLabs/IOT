# Delivery runbook

Work through this in order. Steps 1–2 are contractual and time-critical; 3–6 must
happen before anything touches Edwin's server; 7–9 are the delivery itself.

---

## 1. Extend the Workana deadline  ⏰ do this first

The accepted bid records **3 days from 2026-08-01 19:59**, which expires
**2026-08-04 ~19:59**. In chat you said *"aproximadamente una semana"* — that is not
what the platform enforces.

1. Open the contract on Workana → request a delivery-date change to **2026-08-12**.
2. Send Edwin the message in step 2 so the request has written context.

Do not skip this because the code is finished. The remaining time depends on when
his server appears, which is outside your control — that is exactly what a formal
extension exists for.

---

## 2. Message Edwin

Both open questions are answered and he has approved the scope, so the only thing
still blocking delivery is the server. Copy-paste:

> Hola Edwin,
>
> Perfecto, con eso queda todo definido.
>
> - **Verificación de correo:** no se implementa. La cuenta queda activa de inmediato al registrarse.
> - **Zona horaria:** ya quedó implementada tal como la pediste, como una opción en la configuración de cada dispositivo. Los datos se guardan siempre en UTC y cada dispositivo tiene su propia zona horaria, que se usa para sus gráficos y para su descarga en CSV. Así puedes tener dispositivos en distintas ciudades dentro de la misma cuenta y cada uno muestra su hora local. El CSV incluye las dos columnas, hora UTC y hora local, para que sirva en cualquier caso.
> - **Alcance:** confirmado, sigo con eso.
>
> **Sobre el servidor,** mi recomendación por precio y por espacio en disco:
>
> **1. Contabo — la mejor relación precio/almacenamiento.** contabo.com → Cloud VPS. El plan más económico ya alcanza de sobra: 4 vCPU, 8 GB de RAM y 200 GB NVMe por alrededor de 6 a 9 USD al mes. Tienen un cargo único de instalación en algunos planes. Elige la ubicación **US East** o la más cercana a ti; para este proyecto la latencia no importa, porque los dispositivos envían cada 3 a 10 segundos.
>
> **2. Hetzner — mejor hardware, algo menos de disco.** hetzner.com/cloud → plan CX32: 4 vCPU, 8 GB de RAM, 80 GB SSD, alrededor de 7 EUR al mes. Es más rápido, pero 80 GB es más justo si más adelante quieres guardar más de 30 días de historial. Piden verificación de identidad al abrir la cuenta.
>
> **3. Vultr o DigitalOcean.** Panel más sencillo y tienen servidores en São Paulo, pero cuestan aproximadamente el doble o el triple por las mismas características. Solo los recomendaría si prefieres pagar más por comodidad.
>
> **Mi recomendación concreta: Contabo, plan de 8 GB de RAM con 200 GB NVMe, con Ubuntu 24.04.** Con 100 dispositivos enviando cada 10 segundos, el historial de 30 días ocupa unos 3 GB gracias a la compresión automática, así que ese disco te deja crecer mucho antes de necesitar otro servidor.
>
> **Cuando lo tengas, envíame:**
> 1. La **IP** del servidor y la **contraseña de root**.
> 2. El **dominio o subdominio** que vas a usar, con acceso al panel de DNS. Si lo tienes en Cloudflare, el subdominio para MQTT debe quedar en **"DNS only" (nube gris)**, porque Cloudflare no transporta tráfico MQTT y los dispositivos no podrían conectarse.
>
> Con eso instalo la plataforma, configuro el certificado SSL y te entrego todo funcionando junto con el código de ejemplo para el ESP32.
>
> Saludos

### About the deadline

If he has not yet responded to the extension request, add one line:

> Sobre el plazo: en Workana quedó registrado con 3 días, pero como conversamos la primera versión toma alrededor de una semana. Ya solicité la ampliación en la plataforma; el desarrollo está terminado y lo que resta depende de cuándo tengamos el servidor.

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

### 4.1 Configure

```powershell
cd g:\IoT
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
**Expected:** migration lines for `0001`…`0004`, then `database up to date`, then
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
curl http://localhost:8080/health
```

**Expected:** `dropped: 0` and `written` around 270,000. Any non-zero `dropped`
means Postgres could not keep up — tell me the number and the `ingest` logs.

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

## 5. Put it under version control

```powershell
cd g:\IoT
git init
git add .
git commit -m "Pulse IoT platform - first version"
```

`.gitignore` already excludes `node_modules`, `dist` and `.env`. Confirm `.env` is
**not** in `git status` before you push anywhere.

Create a private repo (GitHub/GitLab) and push. You will need it to `git clone` onto
Edwin's server, and it is how you hand over the source.

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

```bash
curl -s https://pulse.<domain>/health
docker compose logs ingest --tail=20
docker compose exec api node apps/simulator/dist/provision.js --devices 5
docker compose exec api node apps/simulator/dist/run.js --devices 5 --interval 10
```

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
