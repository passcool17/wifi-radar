#include "http_ws.h"

#include <WiFi.h>
#include <LittleFS.h>
#include <SHA1Builder.h>
#include "mbedtls/base64.h"

static const int kMaxClients = 6;
static const size_t kLineMax = 512;

struct ClientSlot {
  WiFiClient client;
  bool used = false;
  bool websocket = false;
  bool headerDone = false;
  String method;
  String path;
  String key;
  String contentType;
  int contentLength = 0;
  String body;
  uint32_t lastSeen = 0;
};

static WiFiServer sServer(80);
static ClientSlot sClients[kMaxClients];
static bool sSetup = true;

// Minimal French setup page (captive portal). No credentials are echoed.
static const char SETUP_HTML[] PROGMEM = R"HTML(<!DOCTYPE html>
<html lang="fr-CA">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Configuration Wi-Fi Radar</title>
<style>
  body{margin:0;font-family:system-ui,sans-serif;background:#05070a;color:#e7f3ec;padding:1.25rem}
  h1{font-size:1.3rem;margin:0 0 .25rem}
  p{color:#9bb5a6}
  label{display:block;margin:.8rem 0 .3rem}
  input,select,button{font:inherit;width:100%;box-sizing:border-box;min-height:48px;border-radius:8px;border:1px solid rgba(120,200,160,.25);background:#0a1114;color:#e7f3ec;padding:.5rem .7rem}
  button{margin-top:1rem;background:#146b42;border:0;color:#f4fff8}
  .hint{font-size:.85rem}
</style>
</head>
<body>
  <h1>Wi-Fi Radar</h1>
  <p>Connectez l’ESP32 à votre réseau Wi-Fi. Le mot de passe reste sur l’appareil.</p>
  <form method="POST" action="/api/wifi" autocomplete="off">
    <label for="ssid">Nom du réseau (SSID)</label>
    <input id="ssid" name="ssid" required maxlength="32" spellcheck="false"/>
    <label for="pass">Mot de passe</label>
    <input id="pass" name="pass" type="password" maxlength="63"/>
    <button type="submit">Enregistrer et connecter</button>
  </form>
  <p class="hint">Après la connexion, ouvrez <strong>http://wifi-radar.local</strong> depuis votre téléphone, sur le même réseau.</p>
</body>
</html>
)HTML";

static const char SAVED_HTML[] PROGMEM = R"HTML(<!DOCTYPE html>
<html lang="fr-CA"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Wi-Fi enregistré</title>
<style>body{font-family:system-ui,sans-serif;background:#05070a;color:#e7f3ec;padding:1.5rem}</style>
</head><body><h1>Réseau enregistré</h1><p>L’ESP32 redémarre et tente de se connecter. Revenez sur cette page dans quelques secondes, ou ouvrez http://wifi-radar.local une fois le réseau joint.</p></body></html>
)HTML";

void httpWsSetSetupMode(bool setup) { sSetup = setup; }
bool httpWsIsSetupMode() { return sSetup; }

static const char *mimeFor(const String &path) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webmanifest") || path.endsWith(".json")) return "application/manifest+json";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

static bool isCaptiveProbe(const String &path) {
  return path == "/generate_204" || path == "/gen_204" || path == "/hotspot-detect.html" ||
         path == "/ncsi.txt" || path == "/connecttest.txt" || path == "/redirect" ||
         path == "/canonical.html" || path == "/success.txt" || path == "/library/test/success.html";
}

static String urlDecode(const String &in) {
  String out;
  out.reserve(in.length());
  for (size_t i = 0; i < in.length(); i++) {
    const char c = in[i];
    if (c == '+') {
      out += ' ';
    } else if (c == '%' && i + 2 < in.length()) {
      out += (char)strtol(in.substring(i + 1, i + 3).c_str(), nullptr, 16);
      i += 2;
    } else {
      out += c;
    }
  }
  return out;
}

static String formValue(const String &body, const char *key) {
  String prefix = String(key) + "=";
  int start = 0;
  while (start < (int)body.length()) {
    int amp = body.indexOf('&', start);
    if (amp < 0) amp = body.length();
    if (body.substring(start, start + prefix.length()) == prefix) {
      return urlDecode(body.substring(start + prefix.length(), amp));
    }
    start = amp + 1;
  }
  return "";
}

// Provided by the sketch. Password is never logged.
extern void wifiRadarSaveCredentials(const String &ssid, const String &pass);
extern void wifiRadarRequestReset();

static void sendRaw(WiFiClient &c, const char *status, const char *ctype, const uint8_t *data, size_t len, const char *extra = nullptr) {
  c.printf("HTTP/1.1 %s\r\n", status);
  c.printf("Content-Type: %s\r\n", ctype);
  c.printf("Content-Length: %u\r\n", (unsigned)len);
  c.println("Connection: close");
  c.println("Cache-Control: no-store");
  if (extra) c.print(extra);
  c.println();
  if (data && len) c.write(data, len);
}

static void sendProgmem(WiFiClient &c, const char *html) {
  const size_t len = strlen_P(html);
  c.println("HTTP/1.1 200 OK");
  c.println("Content-Type: text/html; charset=utf-8");
  c.printf("Content-Length: %u\r\n", (unsigned)len);
  c.println("Connection: close");
  c.println("Cache-Control: no-store");
  c.println();
  c.print(FPSTR(html));
}

static void sendRedirect(WiFiClient &c, const char *loc) {
  c.println("HTTP/1.1 302 Found");
  c.printf("Location: %s\r\n", loc);
  c.println("Content-Length: 0");
  c.println("Connection: close");
  c.println();
}

static bool serveFile(WiFiClient &c, String path) {
  if (path == "/") path = "/index.html";
  if (path.indexOf("..") >= 0) return false;
  String gz = path + ".gz";
  if (LittleFS.exists(gz)) {
    File f = LittleFS.open(gz, "r");
    if (!f) return false;
    c.println("HTTP/1.1 200 OK");
    c.printf("Content-Type: %s\r\n", mimeFor(path));
    c.printf("Content-Length: %u\r\n", (unsigned)f.size());
    c.println("Content-Encoding: gzip");
    c.println("Connection: close");
    c.println("Cache-Control: public, max-age=300");
    c.println();
    uint8_t buf[512];
    while (f.available()) {
      int n = f.read(buf, sizeof(buf));
      if (n <= 0) break;
      c.write(buf, n);
    }
    f.close();
    return true;
  }
  if (!LittleFS.exists(path)) return false;
  File f = LittleFS.open(path, "r");
  if (!f) return false;
  c.println("HTTP/1.1 200 OK");
  c.printf("Content-Type: %s\r\n", mimeFor(path));
  c.printf("Content-Length: %u\r\n", (unsigned)f.size());
  c.println("Connection: close");
  c.println("Cache-Control: public, max-age=300");
  c.println();
  uint8_t buf[512];
  while (f.available()) {
    int n = f.read(buf, sizeof(buf));
    if (n <= 0) break;
    c.write(buf, n);
  }
  f.close();
  return true;
}

static String wsAccept(const String &key) {
  SHA1Builder sha;
  sha.begin();
  sha.add(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
  sha.calculate();
  uint8_t hash[20];
  sha.getBytes(hash);
  unsigned char out[40];
  size_t outlen = 0;
  mbedtls_base64_encode(out, sizeof(out), &outlen, hash, 20);
  out[outlen] = 0;
  return String((char *)out);
}

static void completeWsHandshake(ClientSlot &s) {
  const String accept = wsAccept(s.key);
  WiFiClient &c = s.client;
  c.println("HTTP/1.1 101 Switching Protocols");
  c.println("Upgrade: websocket");
  c.println("Connection: Upgrade");
  c.printf("Sec-WebSocket-Accept: %s\r\n", accept.c_str());
  c.println();
  s.websocket = true;
  s.headerDone = true;
}

static void handleRequest(ClientSlot &s) {
  String path = s.path;
  const int q = path.indexOf('?');
  if (q >= 0) path = path.substring(0, q);

  if (s.method == "POST" && path == "/api/wifi") {
    const String ssid = formValue(s.body, "ssid");
    const String pass = formValue(s.body, "pass");
    sendProgmem(s.client, SAVED_HTML);
    s.client.stop();
    s.used = false;
    wifiRadarSaveCredentials(ssid, pass);
    return;
  }
  if (s.method == "POST" && path == "/api/reset-wifi") {
    const char *ok = "{\"ok\":true}";
    sendRaw(s.client, "200 OK", "application/json", (const uint8_t *)ok, strlen(ok));
    s.client.stop();
    s.used = false;
    wifiRadarRequestReset();
    return;
  }
  if (s.method == "GET" && (path == "/setup" || (sSetup && (path == "/" || isCaptiveProbe(path))))) {
    if (isCaptiveProbe(path) && path != "/") {
      sendRedirect(s.client, "http://192.168.4.1/setup");
    } else {
      sendProgmem(s.client, SETUP_HTML);
    }
    s.client.stop();
    s.used = false;
    return;
  }
  if (sSetup && path == "/") {
    sendProgmem(s.client, SETUP_HTML);
    s.client.stop();
    s.used = false;
    return;
  }
  if (s.method == "GET" && serveFile(s.client, path)) {
    s.client.stop();
    s.used = false;
    return;
  }
  const char *msg = "introuvable";
  sendRaw(s.client, "404 Not Found", "text/plain; charset=utf-8", (const uint8_t *)msg, strlen(msg));
  s.client.stop();
  s.used = false;
}

static void consumeWsFrame(ClientSlot &s) {
  // Drain and reply to ping/close so the socket stays healthy. App traffic is server-push only.
  WiFiClient &c = s.client;
  if (c.available() < 2) return;
  const uint8_t b0 = c.read();
  const uint8_t b1 = c.read();
  const uint8_t opcode = b0 & 0x0F;
  uint64_t len = b1 & 0x7F;
  if (len == 126) {
    if (c.available() < 2) return;
    len = ((uint16_t)c.read() << 8) | c.read();
  } else if (len == 127) {
    for (int i = 0; i < 8; i++) {
      if (c.available()) c.read();
    }
    // oversized, close
    s.client.stop();
    s.used = false;
    return;
  }
  uint8_t mask[4] = {0, 0, 0, 0};
  if (b1 & 0x80) {
    for (int i = 0; i < 4; i++) {
      while (!c.available() && c.connected()) delay(1);
      mask[i] = c.read();
    }
  }
  for (uint64_t i = 0; i < len; i++) {
    while (!c.available() && c.connected()) delay(1);
    c.read();  // discard payload (masked or not)
  }
  if (opcode == 0x8) {
    s.client.stop();
    s.used = false;
  } else if (opcode == 0x9) {
    // pong
    uint8_t pong[2] = {0x8A, 0x00};
    c.write(pong, 2);
  }
  (void)mask;
}

static void sendWsText(WiFiClient &c, const char *json) {
  const size_t len = strlen(json);
  uint8_t hdr[10];
  size_t n = 0;
  hdr[n++] = 0x81;
  if (len < 126) {
    hdr[n++] = (uint8_t)len;
  } else if (len < 65536) {
    hdr[n++] = 126;
    hdr[n++] = (len >> 8) & 0xFF;
    hdr[n++] = len & 0xFF;
  } else {
    return;
  }
  c.write(hdr, n);
  c.write((const uint8_t *)json, len);
}

void httpWsBegin() {
  static bool started = false;
  if (started) return;
  started = true;
  sServer.begin();
  sServer.setNoDelay(true);
}

static void acceptNew() {
  if (!sServer.hasClient()) return;
  WiFiClient incoming = sServer.accept();
  if (!incoming) return;
  incoming.setNoDelay(true);
  incoming.setTimeout(3);
  for (int i = 0; i < kMaxClients; i++) {
    if (!sClients[i].used) {
      sClients[i] = ClientSlot{};
      sClients[i].client = incoming;
      sClients[i].used = true;
      sClients[i].lastSeen = millis();
      return;
    }
  }
  incoming.println("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n");
  incoming.stop();
}

static void readHeaders(ClientSlot &s) {
  WiFiClient &c = s.client;
  while (c.connected() && c.available()) {
    String line = c.readStringUntil('\n');
    line.trim();
    if (s.method.isEmpty()) {
      const int sp = line.indexOf(' ');
      const int sp2 = line.indexOf(' ', sp + 1);
      if (sp > 0 && sp2 > sp) {
        s.method = line.substring(0, sp);
        s.path = line.substring(sp + 1, sp2);
      }
      continue;
    }
    if (line.length() == 0) {
      s.headerDone = true;
      if (s.contentLength <= 0) {
        if (s.path.startsWith("/ws") && s.key.length()) {
          completeWsHandshake(s);
        } else {
          handleRequest(s);
        }
      }
      return;
    }
    const int colon = line.indexOf(':');
    if (colon < 0) continue;
    String name = line.substring(0, colon);
    String value = line.substring(colon + 1);
    value.trim();
    name.toLowerCase();
    if (name == "sec-websocket-key") s.key = value;
    if (name == "content-length") s.contentLength = value.toInt();
    if (name == "content-type") s.contentType = value;
  }
}

void httpWsLoop() {
  acceptNew();
  for (int i = 0; i < kMaxClients; i++) {
    ClientSlot &s = sClients[i];
    if (!s.used) continue;
    if (!s.client.connected()) {
      s.client.stop();
      s.used = false;
      continue;
    }
    if (s.websocket) {
      if (s.client.available()) consumeWsFrame(s);
      continue;
    }
    if (!s.headerDone) {
      readHeaders(s);
    }
    if (s.headerDone && !s.websocket && s.contentLength > 0) {
      while (s.client.available() && (int)s.body.length() < s.contentLength) {
        s.body += (char)s.client.read();
      }
      if ((int)s.body.length() >= s.contentLength) {
        handleRequest(s);
      }
    }
  }
}

void httpWsBroadcast(const char *json) {
  for (int i = 0; i < kMaxClients; i++) {
    if (sClients[i].used && sClients[i].websocket && sClients[i].client.connected()) {
      sendWsText(sClients[i].client, json);
    }
  }
}

int httpWsClientCount() {
  int n = 0;
  for (int i = 0; i < kMaxClients; i++) {
    if (sClients[i].used && sClients[i].websocket) n++;
  }
  return n;
}
