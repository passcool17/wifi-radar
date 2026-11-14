/*
 * Wi-Fi Radar — ESP32-WROOM-32
 * Serves the radar PWA over HTTP and streams
 * {t,rssi,motion,presence,pir,confirmed,mute} on /ws.
 * Wi-Fi credentials are entered on a captive portal, stored in NVS, and
 * never written to the serial log.
 *
 * CSI setup follows espressif/esp-csi (Apache-2.0). Not tested on real
 * hardware; compiled only on the build machine.
 */
#include <WiFi.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <time.h>

#include "csi_motion.h"
#include "http_ws.h"
#include "peripherals.h"

static const char *kApSsid = "WiFi-Radar-Setup";
static const char *kMdns = "wifi-radar";
static const uint8_t kBootPin = 0;  // BOOT button on the classic DevKit
static const uint32_t kLongPressMs = 3000;
static const uint32_t kStaTimeoutMs = 20000;
static const uint32_t kSampleMs = 100;  // ~10 Hz

static Preferences prefs;
static DNSServer dns;
static bool setupMode = false;
static bool staReady = false;
static bool resetRequested = false;
static uint32_t bootPressedAt = 0;
static uint32_t lastSample = 0;
static float lastMotion = 0;
static bool lastPresence = false;

void wifiRadarRequestReset() { resetRequested = true; }
void wifiRadarSetMute(bool mute) { peripheralsSetMute(mute); }

static void clearCredentials() {
  prefs.begin("wfradar", false);
  prefs.remove("ssid");
  prefs.remove("pass");
  prefs.end();
  Serial.println("Wi-Fi credentials cleared");
}

void wifiRadarSaveCredentials(const String &ssid, const String &pass) {
  if (ssid.length() == 0 || ssid.length() > 32) {
    Serial.println("SSID rejected");
    return;
  }
  if (pass.length() > 63) {
    Serial.println("Password rejected");
    return;
  }
  prefs.begin("wfradar", false);
  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  prefs.end();
  Serial.println("Wi-Fi credentials saved. Rebooting.");
  delay(400);
  ESP.restart();
}

static bool loadCredentials(String &ssid, String &pass) {
  prefs.begin("wfradar", true);
  ssid = prefs.getString("ssid", "");
  pass = prefs.getString("pass", "");
  prefs.end();
  return ssid.length() > 0;
}

static void startSetupAp() {
  setupMode = true;
  staReady = false;
  WiFi.persistent(false);
  WiFi.mode(WIFI_AP);
  csiMotionEnd();
  WiFi.softAP(kApSsid);
  delay(100);
  const IPAddress ip = WiFi.softAPIP();
  dns.start(53, "*", ip);
  httpWsSetSetupMode(true);
  httpWsBegin();
  Serial.print("Setup AP started: ");
  Serial.print(kApSsid);
  Serial.print("  http://");
  Serial.println(ip);
}

static void startStation(const String &ssid, const String &pass) {
  setupMode = false;
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(ssid.c_str(), pass.c_str());
  Serial.println("Connecting to the saved Wi-Fi network…");
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < kStaTimeoutMs) {
    delay(200);
  }
  // Wipe the local copy of the password as soon as begin() has been called.
  // (The Preferences copy remains in NVS.)
}

static void onStaConnected() {
  staReady = true;
  httpWsSetSetupMode(false);
  httpWsBegin();
  Serial.print("Wi-Fi connected, IP ");
  Serial.println(WiFi.localIP());

  if (MDNS.begin(kMdns)) {
    MDNS.addService("http", "tcp", 80);
    Serial.println("mDNS: http://wifi-radar.local");
  } else {
    Serial.println("mDNS failed to start");
  }

  configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");
  csiMotionBegin();
  csiMotionStartTraffic();
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("Wi-Fi Radar 1.1.0");
  pinMode(kBootPin, INPUT_PULLUP);
  // Display / PIR / buzzer: no network calls. Safe if the hardware is absent.
  peripheralsBegin();

  if (!LittleFS.begin(false, "/littlefs", 10, "spiffs")) {
    Serial.println("LittleFS mount failed (web files missing?)");
  }

  // httpWsBegin() is called only after WiFi.mode(): the lwIP/tcpip stack
  // must exist before NetworkServer::begin() opens a socket.

  String ssid, pass;
  const bool have = loadCredentials(ssid, pass);
  if (!have) {
    pass = "";
    startSetupAp();
    return;
  }
  startStation(ssid, pass);
  pass = "";
  ssid = "";
  if (WiFi.status() == WL_CONNECTED) {
    onStaConnected();
  } else {
    Serial.println("Saved network unreachable, starting setup AP");
    WiFi.disconnect(true, false);
    startSetupAp();
  }
}

static void checkBootButton() {
  const bool pressed = digitalRead(kBootPin) == LOW;
  if (pressed) {
    if (!bootPressedAt) bootPressedAt = millis();
    if (!resetRequested && millis() - bootPressedAt >= kLongPressMs) {
      Serial.println("BOOT held: clearing Wi-Fi and rebooting into setup");
      resetRequested = true;
    }
  } else {
    bootPressedAt = 0;
  }
}

void loop() {
  checkBootButton();
  if (resetRequested) {
    clearCredentials();
    delay(200);
    ESP.restart();
  }

  if (setupMode) {
    dns.processNextRequest();
  }
  httpWsLoop();

  bool fresh = false;
  RadarReading r{};
  if (staReady && millis() - lastSample >= kSampleMs) {
    lastSample = millis();
    r = csiMotionRead();
    lastMotion = r.motion;
    lastPresence = r.presence;
    fresh = true;
  }
  peripheralsLoop(lastMotion, lastPresence, setupMode);
  if (fresh) {
    const bool pir = peripheralsPir();
    const bool confirmed = peripheralsConfirmed(lastPresence);
    const bool mute = peripheralsMuted();
    char json[240];
    snprintf(json, sizeof(json),
             "{\"t\":%lld,\"rssi\":%.1f,\"motion\":%.1f,\"presence\":%s,\"pir\":%s,\"confirmed\":%s,\"mute\":%s}",
             (long long)r.t, r.rssi, r.motion,
             lastPresence ? "true" : "false",
             pir ? "true" : "false",
             confirmed ? "true" : "false",
             mute ? "true" : "false");
    httpWsBroadcast(json);
  }
}
