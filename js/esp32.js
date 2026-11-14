import { isMixedContent, parseSample, stampSampleTime } from './samples.js';

/**
 * WebSocket data source for a local ESP32.
 * @param {{ url: string, onStatus?: (s: { state: string, detail?: string }) => void, location?: Location }} opts
 */
export function createEsp32Source(opts) {
  const onStatus = opts.onStatus ?? (() => {});
  const loc = opts.location ?? (typeof location !== 'undefined' ? location : null);
  let ws = null;
  let stopped = true;
  let delay = 1000;
  let retryTimer = null;
  let onSample = null;
  const url = opts.url;

  function setState(state, detail) {
    onStatus({ state, detail });
  }

  function clearRetry() {
    if (retryTimer != null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearRetry();
    const wait = delay;
    delay = Math.min(delay * 2, 15000);
    setState('reconnecting', `Reconnexion dans ${Math.round(wait / 1000)} s`);
    retryTimer = setTimeout(open, wait);
  }

  function open() {
    if (stopped) return;
    clearRetry();
    if (!url) {
      setState('disconnected', 'Adresse IP manquante');
      return;
    }
    if (isMixedContent(url, loc)) {
      setState('blocked', 'Connexion bloquée (contenu mixte HTTPS)');
      return;
    }
    try {
      setState('connecting', 'Connexion…');
      ws = new WebSocket(url);
    } catch {
      setState('disconnected', 'Impossible d’ouvrir le WebSocket');
      scheduleReconnect();
      return;
    }
    ws.addEventListener('open', () => {
      delay = 1000;
      setState('connected', 'Connecté');
      if (opts.hello) {
        try {
          ws.send(typeof opts.hello === 'string' ? opts.hello : JSON.stringify(opts.hello));
        } catch {
          /* ignore */
        }
      }
    });
    ws.addEventListener('message', (ev) => {
      const parsed = parseSample(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (!parsed.ok) return;
      onSample?.(stampSampleTime(parsed.sample));
    });
    ws.addEventListener('close', () => {
      ws = null;
      if (stopped) {
        setState('disconnected', 'Déconnecté');
        return;
      }
      scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // close will follow; avoid double reconnect
    });
  }

  function send(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  return {
    send,
    start(handler) {
      stopped = false;
      onSample = handler;
      delay = 1000;
      open();
    },
    stop() {
      stopped = true;
      onSample = null;
      clearRetry();
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
      setState('disconnected', 'Déconnecté');
    },
  };
}
