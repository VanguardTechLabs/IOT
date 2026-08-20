#!/bin/sh
# ─────────────────────────────────────────────────────────────
# Copies the Let's Encrypt certificate Caddy obtained for MQTT_DOMAIN into the
# volume EMQX reads, so one ACME client serves both the web panel and the broker.
#
# Caddy stores certificates at:
#   /caddy-data/caddy/certificates/<issuer>/<domain>/<domain>.{crt,key}
#
# EMQX reads the certificate at boot and does not watch the file, so a renewal
# only takes effect on the next restart. See docs/DEPLOY.md for the weekly cron
# that handles that — a renewal happens every ~60 days, a restart costs a few
# seconds, and devices reconnect automatically.
# ─────────────────────────────────────────────────────────────
set -eu

DOMAIN="${MQTT_DOMAIN:-}"
SRC_ROOT="/caddy-data/caddy/certificates"
DEST="/emqx-certs"
INTERVAL="${SYNC_INTERVAL:-43200}"

if [ -z "$DOMAIN" ]; then
  echo "[certsync] MQTT_DOMAIN is not set — TLS for the broker is disabled, idling."
  while true; do sleep 3600; done
fi

mkdir -p "$DEST"

# Until the first certificate exists, poll fast.
#
# On a fresh deployment certsync and Caddy start together, and Caddy needs ~10 s
# to complete the ACME order. The first pass therefore finds nothing — and with a
# single 12 hour interval the broker's TLS listener then stayed dead for half a
# day, with nothing in the panel to explain why devices could not connect over
# mqtts. Observed on the first real deployment.
#
# Once a certificate has been installed, renewals are the only thing left to
# watch for and the long interval is right.
INITIAL_INTERVAL="${SYNC_INITIAL_INTERVAL:-15}"
INITIAL_DEADLINE="${SYNC_INITIAL_DEADLINE:-900}"
installed=0
waited=0

while true; do
  CRT="$(find "$SRC_ROOT" -type f -name "${DOMAIN}.crt" 2>/dev/null | head -n 1 || true)"
  KEY="$(find "$SRC_ROOT" -type f -name "${DOMAIN}.key" 2>/dev/null | head -n 1 || true)"

  if [ -n "$CRT" ] && [ -n "$KEY" ]; then
    # Compare before writing so an unchanged certificate does not churn the file
    # and mislead anyone reading modification times.
    if ! cmp -s "$CRT" "$DEST/mqtt.crt" || ! cmp -s "$KEY" "$DEST/mqtt.key"; then
      cp "$CRT" "$DEST/mqtt.crt"
      cp "$KEY" "$DEST/mqtt.key"
      # This container runs as root; EMQX does not. Without the chown the key
      # lands root:root 0640 and the broker cannot open it, so the 8883 listener
      # silently never starts. 1000:1000 is the emqx user in emqx/emqx:5.8.4.
      chown 1000:1000 "$DEST/mqtt.crt" "$DEST/mqtt.key"
      chmod 644 "$DEST/mqtt.crt"
      chmod 640 "$DEST/mqtt.key"
      echo "[certsync] installed a new certificate for ${DOMAIN} — restart emqx to load it"
    fi
    installed=1
  else
    # Only worth saying once a minute while we are polling every 15 s.
    if [ "$installed" -eq 0 ] && [ $((waited % 60)) -eq 0 ]; then
      echo "[certsync] no certificate for ${DOMAIN} yet; is its DNS record set to DNS-only (grey cloud)?"
    fi
  fi

  # Fast polling only while waiting for the very first certificate, and only for
  # a bounded window. After that, a missing certificate is a configuration
  # problem rather than a startup race, and polling every 15 s helps nobody.
  if [ "$installed" -eq 0 ] && [ "$waited" -lt "$INITIAL_DEADLINE" ]; then
    waited=$((waited + INITIAL_INTERVAL))
    sleep "$INITIAL_INTERVAL"
  else
    sleep "$INTERVAL"
  fi
done
