/*
 * CSI enablement and periodic ping of the home access point follow the
 * approach of espressif/esp-csi examples/get-started/csi_recv_router
 * (Apache-2.0, Copyright 2026 Espressif Systems (Shanghai) CO LTD).
 * The motion score (amplitude variance over a sliding window) and the
 * presence hysteresis are original to this project.
 */
#include "csi_motion.h"

#include <WiFi.h>
#include <math.h>
#include <string.h>
#include <sys/time.h>

#include "esp_wifi.h"
#include "esp_netif.h"
#include "lwip/inet.h"
#include "ping/ping_sock.h"

static const int kWindow = 32;
static const int kMaxPairs = 64;

static portMUX_TYPE sMux = portMUX_INITIALIZER_UNLOCKED;
static float sWindow[kWindow];
static int sCount = 0;
static int sIndex = 0;
static float sLastRssi = -90;
static bool sHasFrame = false;
static bool sPresence = false;
static float sBaseline = 0.4f;
static float sMotion = 0;
static uint8_t sApBssid[6] = {0};
static bool sHaveBssid = false;
static esp_ping_handle_t sPing = nullptr;
static uint32_t sPresentSince = 0;
static uint32_t sAbsentSince = 0;

static int64_t nowMs() {
  timeval tv;
  gettimeofday(&tv, nullptr);
  if (tv.tv_sec > 1600000000L) {
    return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
  }
  return (int64_t)millis();
}

static void wifiCsiRxCb(void *ctx, wifi_csi_info_t *info) {
  if (!info || !info->buf || info->len < 4) return;
  if (sHaveBssid && memcmp(info->mac, sApBssid, 6) != 0) return;

  const int start = info->first_word_invalid ? 4 : 0;
  const int8_t *buf = info->buf;
  const int len = info->len;
  int pairs = 0;
  float sum = 0;
  float sumSq = 0;
  for (int i = start; i + 1 < len && pairs < kMaxPairs; i += 2) {
    // Skip a few edge subcarriers that are often noisy on 20 MHz LLTF.
    if (pairs < 4) {
      pairs += 1;
      continue;
    }
    const float I = (float)buf[i];
    const float Q = (float)buf[i + 1];
    const float amp = sqrtf(I * I + Q * Q);
    sum += amp;
    sumSq += amp * amp;
    pairs += 1;
  }
  const int used = pairs > 4 ? pairs - 4 : pairs;
  if (used < 4) return;
  const float mean = sum / (float)used;

  portENTER_CRITICAL(&sMux);
  sWindow[sIndex] = mean;
  sIndex = (sIndex + 1) % kWindow;
  if (sCount < kWindow) sCount += 1;
  sLastRssi = (float)info->rx_ctrl.rssi;
  sHasFrame = true;
  portEXIT_CRITICAL(&sMux);
  (void)sumSq;
  (void)ctx;
}

static float windowVariance() {
  if (sCount < 4) return 0;
  float sum = 0;
  for (int i = 0; i < sCount; i++) sum += sWindow[i];
  const float mean = sum / (float)sCount;
  float acc = 0;
  for (int i = 0; i < sCount; i++) {
    const float d = sWindow[i] - mean;
    acc += d * d;
  }
  return acc / (float)sCount;
}

void csiMotionBegin() {
  sCount = 0;
  sIndex = 0;
  sHasFrame = false;
  sPresence = false;
  sMotion = 0;
  sBaseline = 0.4f;

  wifi_ap_record_t ap = {};
  if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
    memcpy(sApBssid, ap.bssid, 6);
    sHaveBssid = true;
  } else {
    sHaveBssid = false;
  }

  // Classic ESP32 (non-HE) CSI config, same fields as esp-csi csi_recv_router.
  wifi_csi_config_t csi_config = {};
  csi_config.lltf_en = true;
  csi_config.htltf_en = false;
  csi_config.stbc_htltf2_en = false;
  csi_config.ltf_merge_en = true;
  csi_config.channel_filter_en = true;
  csi_config.manu_scale = true;
  csi_config.shift = 1;
  csi_config.dump_ack_en = false;

  esp_err_t err = esp_wifi_set_csi_config(&csi_config);
  if (err != ESP_OK) {
    Serial.printf("CSI config: %s\n", esp_err_to_name(err));
    return;
  }
  err = esp_wifi_set_csi_rx_cb(wifiCsiRxCb, sHaveBssid ? sApBssid : nullptr);
  if (err != ESP_OK) {
    Serial.printf("CSI callback: %s\n", esp_err_to_name(err));
    return;
  }
  err = esp_wifi_set_csi(true);
  if (err != ESP_OK) {
    Serial.printf("CSI enable: %s\n", esp_err_to_name(err));
    return;
  }
  Serial.println("CSI enabled");
}

void csiMotionStartTraffic() {
  if (sPing) {
    esp_ping_stop(sPing);
    esp_ping_delete_session(sPing);
    sPing = nullptr;
  }

  esp_ping_config_t ping_config = ESP_PING_DEFAULT_CONFIG();
  ping_config.count = 0;  // infinite
  ping_config.interval_ms = 50;  // 20 Hz of replies to harvest CSI
  ping_config.task_stack_size = 3072;
  ping_config.data_size = 1;

  const IPAddress gw = WiFi.gatewayIP();
  if (gw == IPAddress((uint32_t)0)) {
    Serial.println("No gateway yet, CSI traffic not started");
    return;
  }
  ping_config.target_addr.u_addr.ip4.addr = (uint32_t)gw;
  ping_config.target_addr.type = ESP_IPADDR_TYPE_V4;

  esp_ping_callbacks_t cbs = {};
  if (esp_ping_new_session(&ping_config, &cbs, &sPing) == ESP_OK) {
    esp_ping_start(sPing);
    Serial.printf("CSI ping started toward gateway\n");
  } else {
    Serial.println("CSI ping failed to start");
  }
}

void csiMotionEnd() {
  esp_wifi_set_csi(false);
  esp_wifi_set_csi_rx_cb(nullptr, nullptr);
  if (sPing) {
    esp_ping_stop(sPing);
    esp_ping_delete_session(sPing);
    sPing = nullptr;
  }
}

RadarReading csiMotionRead() {
  float var = 0;
  float rssi = sLastRssi;
  portENTER_CRITICAL(&sMux);
  var = windowVariance();
  rssi = sLastRssi;
  portEXIT_CRITICAL(&sMux);

  if (var < sBaseline * 1.4f) {
    sBaseline = 0.98f * sBaseline + 0.02f * (var > 0.05f ? var : 0.05f);
  } else {
    sBaseline = 0.999f * sBaseline + 0.001f * var;
  }
  if (sBaseline < 0.05f) sBaseline = 0.05f;

  float score = (var - sBaseline) / (sBaseline * 6.0f);
  if (score < 0) score = 0;
  if (score > 1) score = 1;
  sMotion = 0.7f * sMotion + 0.3f * (score * 100.0f);

  const uint32_t now = millis();
  if (!sPresence) {
    if (sMotion >= 22.0f) {
      if (!sPresentSince) sPresentSince = now;
      if (now - sPresentSince >= 350) {
        sPresence = true;
        sAbsentSince = 0;
      }
    } else {
      sPresentSince = 0;
    }
  } else {
    if (sMotion <= 10.0f) {
      if (!sAbsentSince) sAbsentSince = now;
      if (now - sAbsentSince >= 1600) {
        sPresence = false;
        sPresentSince = 0;
      }
    } else {
      sAbsentSince = 0;
    }
  }

  RadarReading r;
  r.t = nowMs();
  r.rssi = rssi;
  r.motion = sMotion;
  r.presence = sPresence;
  return r;
}

bool csiMotionHasFrame() {
  portENTER_CRITICAL(&sMux);
  const bool v = sHasFrame;
  portEXIT_CRITICAL(&sMux);
  return v;
}
