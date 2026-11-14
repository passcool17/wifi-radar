/*
 * OLED (SSD1306 I2C), buzzer and PIR helpers.
 * Safe if the display or PIR is absent: I2C is probed with a short
 * timeout, and a missing device is ignored.
 */
#include "peripherals.h"

#include <Wire.h>
#include <Preferences.h>
#include <WiFi.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

static const int kSdaPin = 21;
static const int kSclPin = 22;
static const int kBuzzPin = 25;
static const int kPirPin = 27;
static const uint8_t kAddrA = 0x3C;
static const uint8_t kAddrB = 0x3D;
static const int kWidth = 128;
static const int kHeight = 64;
static const uint32_t kDispMs = 250;       // 4 Hz
static const uint32_t kBeepCooldown = 10000;
static const uint32_t kPirHoldMs = 5000;
static const uint32_t kBeepOnMs = 120;
static const uint32_t kBeepGapMs = 80;
static const int kToneHz = 2000;

static Preferences hwPrefs;
static Adafruit_SSD1306 display(kWidth, kHeight, &Wire, -1);
static bool displayOk = false;
static bool muted = false;
static bool prevPresence = false;
static bool pirHigh = false;
static bool sawPir = false;
static uint32_t lastPirHigh = 0;
static uint32_t lastDisp = 0;
static uint32_t lastBeepAt = 0;
static int beepStep = 0;  // 0 idle, 1 on, 2 gap, 3 on, then idle
static uint32_t beepStepAt = 0;
static bool toneAttached = false;

static void loadMute() {
  hwPrefs.begin("wfradarhw", true);
  muted = hwPrefs.getBool("mute", false);
  hwPrefs.end();
}

static void saveMute() {
  hwPrefs.begin("wfradarhw", false);
  hwPrefs.putBool("mute", muted);
  hwPrefs.end();
}

static bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

static void toneStart() {
  if (!toneAttached) {
    toneAttached = ledcAttach(kBuzzPin, kToneHz, 10);
  }
  if (toneAttached) {
    ledcWriteTone(kBuzzPin, kToneHz);
  } else {
    digitalWrite(kBuzzPin, HIGH);
  }
}

static void toneStop() {
  if (toneAttached) {
    ledcWriteTone(kBuzzPin, 0);
    ledcWrite(kBuzzPin, 0);
    ledcDetach(kBuzzPin);
    toneAttached = false;
  }
  pinMode(kBuzzPin, OUTPUT);
  digitalWrite(kBuzzPin, LOW);
}

static void startBeep() {
  beepStep = 1;
  beepStepAt = millis();
  lastBeepAt = millis();
  toneStart();
}

static void serviceBeep() {
  if (beepStep == 0) return;
  if (muted) {
    toneStop();
    beepStep = 0;
    return;
  }
  const uint32_t now = millis();
  if (beepStep == 1 && now - beepStepAt >= kBeepOnMs) {
    toneStop();
    beepStep = 2;
    beepStepAt = now;
  } else if (beepStep == 2 && now - beepStepAt >= kBeepGapMs) {
    toneStart();
    beepStep = 3;
    beepStepAt = now;
  } else if (beepStep == 3 && now - beepStepAt >= kBeepOnMs) {
    toneStop();
    beepStep = 0;
  }
}

static void drawBar(int y, int motion) {
  if (motion < 0) motion = 0;
  if (motion > 100) motion = 100;
  const int w = (motion * (kWidth - 2)) / 100;
  display.drawRect(0, y, kWidth, 8, SSD1306_WHITE);
  if (w > 0) display.fillRect(1, y + 1, w, 6, SSD1306_WHITE);
}

static void refreshDisplay(float motion, bool presence, bool setupMode) {
  if (!displayOk) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  if (setupMode) {
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println(F("Wi-Fi Radar"));
    display.setCursor(0, 14);
    display.println(F("Configuration"));
    display.setTextSize(1);
    display.setCursor(0, 32);
    display.println(F("WiFi-Radar-Setup"));
    display.setCursor(0, 48);
    display.println(F("192.168.4.1"));
    display.display();
    return;
  }

  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(F("Presence"));

  display.setTextSize(3);
  display.setCursor(0, 12);
  display.print(presence ? F("oui") : F("non"));

  display.setTextSize(1);
  display.setCursor(0, 40);
  display.print(F("Mouv. "));
  display.print((int)(motion + 0.5f));
  drawBar(50, (int)(motion + 0.5f));

  display.setTextSize(1);
  display.setCursor(0, 56);
  if (WiFi.status() == WL_CONNECTED) {
    display.print(WiFi.localIP());
  } else if (WiFi.getMode() == WIFI_AP || WiFi.getMode() == WIFI_AP_STA) {
    display.print(F("192.168.4.1"));
  } else {
    display.print(F("Connexion..."));
  }
  display.display();
}

void peripheralsBegin() {
  pinMode(kPirPin, INPUT_PULLDOWN);
  pinMode(kBuzzPin, OUTPUT);
  digitalWrite(kBuzzPin, LOW);
  loadMute();

  Wire.begin(kSdaPin, kSclPin);
  Wire.setTimeOut(50);

  uint8_t addr = 0;
  if (i2cPresent(kAddrA)) addr = kAddrA;
  else if (i2cPresent(kAddrB)) addr = kAddrB;

  if (addr == 0) {
    Serial.println("OLED not found, continuing without display");
    displayOk = false;
    return;
  }

  displayOk = display.begin(SSD1306_SWITCHCAPVCC, addr, false, false);
  if (!displayOk) {
    Serial.println("OLED init failed, continuing without display");
    return;
  }
  Serial.printf("OLED ready at 0x%02X\n", addr);
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 20);
  display.println(F("Wi-Fi Radar 1.1"));
  display.setCursor(0, 36);
  display.println(F("Demarrage..."));
  display.display();
}

void peripheralsSetMute(bool mute) {
  if (muted == mute) return;
  muted = mute;
  saveMute();
  if (muted) {
    toneStop();
    beepStep = 0;
  }
  Serial.printf("Buzzer mute: %s\n", muted ? "on" : "off");
}

bool peripheralsMuted() { return muted; }

bool peripheralsPir() { return pirHigh; }

bool peripheralsConfirmed(bool presence) {
  const bool recent = sawPir && (millis() - lastPirHigh <= kPirHoldMs);
  return presence && (pirHigh || recent);
}

void peripheralsLoop(float motion, bool presence, bool setupMode) {
  pirHigh = digitalRead(kPirPin) == HIGH;
  if (pirHigh) {
    sawPir = true;
    lastPirHigh = millis();
  }

  if (presence && !prevPresence) {
    const bool cooled = lastBeepAt == 0 || (millis() - lastBeepAt >= kBeepCooldown);
    if (!muted && cooled) startBeep();
  }
  prevPresence = presence;
  serviceBeep();

  if (millis() - lastDisp >= kDispMs) {
    lastDisp = millis();
    refreshDisplay(motion, presence, setupMode);
  }
}
