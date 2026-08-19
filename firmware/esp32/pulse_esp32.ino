/*
 * ─────────────────────────────────────────────────────────────────────────────
 * Pulse IoT — reference ESP32 firmware
 *
 * Implements the platform contract exactly:
 *   • ONE MQTT message per cycle carrying every variable (not one per variable)
 *   • every value published as a string; the platform casts by declared type
 *   • retained last-will presence on d/<key>/status
 *   • commands received on d/<key>/dn as {"key":"value"} string pairs
 *
 * Libraries (Arduino Library Manager):
 *   PubSubClient by Nick O'Leary
 *   ArduinoJson  by Benoit Blanchon  (v7)
 *
 * Board: any ESP32 (tested against ESP32 Dev Module).
 * PlatformIO: `pio run -t upload` (see platformio.ini, env esp32dev-tls for TLS).
 * ─────────────────────────────────────────────────────────────────────────────
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// Build with -DPULSE_USE_TLS=1 (PlatformIO env esp32dev-tls) to use mqtts on 8883.
#ifndef PULSE_USE_TLS
#define PULSE_USE_TLS 0
#endif

#if PULSE_USE_TLS
#include <WiFiClientSecure.h>
#endif

// ── Configuration ───────────────────────────────────────────────────────────
const char *WIFI_SSID = "your-wifi";
const char *WIFI_PASSWORD = "your-wifi-password";

// Copy these from the device page in the Pulse dashboard.
const char *DEVICE_KEY = "dev_xxxxxxxxxxxxxxxxxx";   // MQTT username
const char *DEVICE_TOKEN = "tok_xxxxxxxxxxxxxxxxxx"; // MQTT password

const char *MQTT_HOST = "your-server-host";

#if PULSE_USE_TLS
const uint16_t MQTT_PORT = 8883;
// ISRG Root X1 — the Let's Encrypt root the server certificate chains to.
// Valid until 2035; replace it if you move to a different certificate authority.
static const char *ROOT_CA = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
)EOF";
#else
const uint16_t MQTT_PORT = 1883;
#endif

// Overwritten by the platform on connect; 10 s is the recommended default.
uint32_t publishIntervalMs = 10000;

// ── Derived topics ──────────────────────────────────────────────────────────
char topicUp[64];
char topicDown[64];
char topicStatus[64];

#if PULSE_USE_TLS
WiFiClientSecure net;
#else
WiFiClient net;
#endif
PubSubClient mqtt(net);

uint32_t lastPublish = 0;

// Actuator state driven by downlink commands.
bool relayState = false;
String mode = "auto";
const uint8_t RELAY_PIN = 2;
const uint8_t BUTTON_PIN = 0;

// ── Forward declarations ────────────────────────────────────────────────────
// onMessage() calls publishTelemetry(), which is defined further down. The
// Arduino preprocessor normally generates these automatically, but it does not
// always succeed and PlatformIO's .ino conversion behaves differently — so they
// are declared explicitly rather than left to chance.
void publishTelemetry();
void connectWiFi();
void connectMqtt();
void buildTopics();
void onMessage(char *topic, byte *payload, unsigned int length);

// ── Helpers ─────────────────────────────────────────────────────────────────
static bool asBool(const char *value) {
  return strcmp(value, "1") == 0 || strcasecmp(value, "true") == 0 ||
         strcasecmp(value, "on") == 0 || strcasecmp(value, "high") == 0;
}

void buildTopics() {
  snprintf(topicUp, sizeof(topicUp), "d/%s/up", DEVICE_KEY);
  snprintf(topicDown, sizeof(topicDown), "d/%s/dn", DEVICE_KEY);
  snprintf(topicStatus, sizeof(topicStatus), "d/%s/status", DEVICE_KEY);
}

void connectWiFi() {
  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.printf("\n[wifi] connected, ip=%s\n", WiFi.localIP().toString().c_str());
}

/* Downlink: {"relay":"1"} or {"mode":"manual"} — always strings. */
void onMessage(char *topic, byte *payload, unsigned int length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) {
    Serial.println("[mqtt] malformed command");
    return;
  }

  for (JsonPair kv : doc.as<JsonObject>()) {
    const char *key = kv.key().c_str();
    const char *value = kv.value().as<const char *>();
    if (!value) continue;

    Serial.printf("[cmd] %s = %s\n", key, value);

    if (strcmp(key, "relay") == 0) {
      relayState = asBool(value);
      digitalWrite(RELAY_PIN, relayState ? HIGH : LOW);
    } else if (strcmp(key, "mode") == 0) {
      mode = String(value);
    } else if (strcmp(key, "interval") == 0) {
      uint32_t requested = strtoul(value, nullptr, 10);
      if (requested >= 3) publishIntervalMs = requested * 1000UL; // 3 s platform floor
    }
  }

  // Echo actuator state back immediately so the dashboard confirms the write
  // instead of waiting for the next cycle.
  publishTelemetry();
}

void connectMqtt() {
  while (!mqtt.connected()) {
    Serial.print("[mqtt] connecting");
    // Last will: the broker publishes "offline" (retained) if this device drops.
    bool ok = mqtt.connect(DEVICE_KEY, DEVICE_KEY, DEVICE_TOKEN, topicStatus, 1, true, "offline");
    if (ok) {
      Serial.println(" — connected");
      mqtt.publish(topicStatus, "online", true);
      mqtt.subscribe(topicDown, 1);
    } else {
      Serial.printf(" — failed (rc=%d), retrying in 3s\n", mqtt.state());
      delay(3000);
    }
  }
}

/*
 * One message, every variable. Nine separate publishes would multiply broker
 * load by nine for exactly the same data.
 */
void publishTelemetry() {
  JsonDocument doc;
  doc["ts"] = (uint32_t)(millis() / 1000); // platform re-stamps when there is no RTC
  JsonObject v = doc["v"].to<JsonObject>();

  // ── Replace these with real sensor reads ─────────────────────────────────
  float temp = 22.0f + (float)random(-200, 200) / 100.0f;
  float hum = 55.0f + (float)random(-500, 500) / 100.0f;
  float pressure = 1013.0f + (float)random(-300, 300) / 100.0f;

  char buf[16];
  dtostrf(temp, 0, 2, buf);      v["temp"] = buf;
  dtostrf(hum, 0, 1, buf);       v["hum"] = buf;
  dtostrf(pressure, 0, 1, buf);  v["pressure"] = buf;

  v["lux"] = String(analogRead(34));
  v["voltage"] = String(3.3f, 3);
  v["current"] = String(0.42f, 3);
  v["rssi"] = String(WiFi.RSSI());
  v["button"] = digitalRead(BUTTON_PIN) == LOW ? "1" : "0";
  v["relay"] = relayState ? "1" : "0";
  v["mode"] = mode;

  char payload[512];
  size_t written = serializeJson(doc, payload, sizeof(payload));
  if (mqtt.publish(topicUp, (const uint8_t *)payload, written, false)) {
    Serial.printf("[up] %s\n", payload);
  } else {
    Serial.println("[up] publish failed");
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(RELAY_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  digitalWrite(RELAY_PIN, LOW);

  buildTopics();
  connectWiFi();

#if PULSE_USE_TLS
  // Pin the certificate authority. Never swap this for setInsecure() in the
  // field: it would accept any certificate and make the TLS purely decorative.
  net.setCACert(ROOT_CA);
  configTime(0, 0, "pool.ntp.org", "time.nist.gov"); // certificate validity needs a real clock
  Serial.print("[tls] waiting for time");
  while (time(nullptr) < 8 * 3600 * 2) {
    delay(300);
    Serial.print(".");
  }
  Serial.println(" — clock set");
#endif

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMessage);
  mqtt.setBufferSize(768); // the default 256 truncates a nine-variable payload
  mqtt.setKeepAlive(30);
  connectMqtt();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();

  uint32_t now = millis();
  if (now - lastPublish >= publishIntervalMs) {
    lastPublish = now;
    publishTelemetry();
  }
}
