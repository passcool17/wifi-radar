import { createGraph } from './graph.js';
import { createRadar } from './radar.js';
import {
  SETTINGS_KEY,
  createMotionDetector,
  isEspHost,
  isMixedContent,
  loadSettings,
  websocketUrl,
} from './samples.js';
import { createSourceManager } from './source.js';

const timeFmt = new Intl.DateTimeFormat('fr-CA', {
  timeZone: 'America/Toronto',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatTime(ms) {
  return timeFmt.format(new Date(ms));
}

function readStoredSettings() {
  try {
    return loadSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'));
  } catch {
    return loadSettings(null);
  }
}

function writeStoredSettings(settings) {
  const stored = {
    source: settings.source,
    ip: settings.ip,
    port: settings.port,
    path: settings.path || '/ws',
    mute: Boolean(settings.mute),
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
}

function sceneFromQuery() {
  const q = new URLSearchParams(location.search);
  return q.get('scene');
}

const els = {
  srcSim: document.getElementById('src-sim'),
  srcEsp: document.getElementById('src-esp'),
  srcStatus: document.getElementById('src-status'),
  presenceDot: document.getElementById('presence-dot'),
  presenceText: document.getElementById('presence-text'),
  presenceBlock: document.getElementById('presence-block'),
  rssi: document.getElementById('rssi'),
  motionValue: document.getElementById('motion-value'),
  gauge: document.getElementById('gauge'),
  gaugeFill: document.getElementById('gauge-fill'),
  log: document.getElementById('log'),
  btnPause: document.getElementById('btn-pause'),
  btnSettings: document.getElementById('btn-settings'),
  settings: document.getElementById('settings'),
  setIp: document.getElementById('set-ip'),
  setPort: document.getElementById('set-port'),
  wsPreview: document.getElementById('ws-preview'),
  btnConnect: document.getElementById('btn-connect'),
  connStatus: document.getElementById('conn-status'),
  mixedNote: document.getElementById('mixed-note'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  flashLink: document.getElementById('flash-link'),
  resetWifi: document.getElementById('reset-wifi'),
  pirLine: document.getElementById('pir-line'),
  confirmedBadge: document.getElementById('confirmed-badge'),
  setMute: document.getElementById('set-mute'),
  cablageLink: document.getElementById('cablage-link'),
};

let settings = readStoredSettings();
const detector = createMotionDetector();
const radar = createRadar(document.getElementById('radar'));
const graph = createGraph(document.getElementById('graph'));
const logEntries = [];
const MAX_LOG = 40;

function statusLabel(status) {
  switch (status.state) {
    case 'simulated':
      return 'Simulation en cours';
    case 'connecting':
      return 'Connexion…';
    case 'connected':
      return 'Connecté';
    case 'reconnecting':
      return status.detail || 'Reconnexion…';
    case 'blocked':
      return 'Bloqué (HTTPS)';
    case 'disconnected':
    default:
      return status.detail || 'Déconnecté';
  }
}

function setLiveStatus(status) {
  els.srcStatus.textContent = statusLabel(status);
  els.srcStatus.dataset.state = status.state;
  if (els.connStatus) {
    els.connStatus.textContent = statusLabel(status);
    els.connStatus.dataset.state = status.state;
  }
}

function renderToggle() {
  const sim = settings.source !== 'esp32';
  els.srcSim.setAttribute('aria-checked', sim ? 'true' : 'false');
  els.srcEsp.setAttribute('aria-checked', sim ? 'false' : 'true');
  els.srcSim.classList.toggle('is-on', sim);
  els.srcEsp.classList.toggle('is-on', !sim);
}

function currentWsUrl() {
  return websocketUrl(settings);
}

function refreshSettingsForm() {
  els.setIp.value = settings.ip;
  els.setPort.value = settings.port;
  const url = currentWsUrl();
  els.wsPreview.textContent = url || 'ws://…/ws';
  const mixed = isMixedContent(url);
  els.mixedNote.hidden = !mixed;
  if (els.setMute) els.setMute.checked = Boolean(settings.mute);
  if (isEspHost()) {
    els.flashLink.hidden = true;
    els.resetWifi.hidden = false;
    if (els.cablageLink) els.cablageLink.hidden = false;
  } else {
    els.flashLink.hidden = false;
    els.resetWifi.hidden = true;
    if (els.cablageLink) els.cablageLink.hidden = true;
  }
}

function pushLog(kind, time) {
  const label = kind === 'start' ? 'Mouvement : début' : 'Mouvement : fin';
  logEntries.unshift({ kind, time, label });
  if (logEntries.length > MAX_LOG) logEntries.pop();
  const li = document.createElement('li');
  li.className = kind === 'start' ? 'is-start' : 'is-stop';
  const t = document.createElement('time');
  t.dateTime = new Date(time).toISOString();
  t.textContent = formatTime(time);
  const span = document.createElement('span');
  span.textContent = label;
  li.append(t, span);
  els.log.prepend(li);
  while (els.log.children.length > MAX_LOG) els.log.lastChild?.remove();
}

function applySample(sample) {
  radar.setSample(sample);
  graph.push(sample);

  const yes = Boolean(sample.presence);
  els.presenceText.textContent = yes ? 'oui' : 'non';
  els.presenceBlock.classList.toggle('is-yes', yes);
  els.presenceBlock.classList.toggle('is-no', !yes);
  els.presenceDot.setAttribute('aria-hidden', 'true');

  const motion = Math.round(sample.motion);
  els.motionValue.textContent = String(motion);
  els.gaugeFill.style.transform = `scaleX(${Math.max(0, Math.min(100, sample.motion)) / 100})`;
  els.gauge.setAttribute('aria-valuenow', String(motion));

  const rssi = Number.isFinite(sample.rssi) ? Math.round(sample.rssi) : '—';
  els.rssi.textContent = `Signal ${rssi} dBm`;

  if (sample.pir === true) els.pirLine.textContent = 'PIR oui';
  else if (sample.pir === false) els.pirLine.textContent = 'PIR non';
  else els.pirLine.textContent = 'PIR —';

  const confirmed = sample.confirmed === true;
  els.confirmedBadge.hidden = !confirmed;

  if (typeof sample.mute === 'boolean' && sample.mute !== settings.mute) {
    settings.mute = sample.mute;
    writeStoredSettings(settings);
    if (els.setMute) els.setMute.checked = sample.mute;
  }

  const ev = detector.observe(sample);
  if (ev) pushLog(ev, sample.t);
}

const sources = createSourceManager({
  onSample: applySample,
  onStatus: setLiveStatus,
  scene: sceneFromQuery(),
});

function startSource() {
  detector.reset();
  graph.reset();
  els.log.replaceChildren();
  logEntries.length = 0;
  sources.start(settings.source, {
    url: currentWsUrl(),
    hello: { cmd: 'mute', v: Boolean(settings.mute) },
  });
}

function setSource(kind) {
  settings.source = kind === 'esp32' ? 'esp32' : 'sim';
  writeStoredSettings(settings);
  renderToggle();
  startSource();
}

els.srcSim.addEventListener('click', () => setSource('sim'));
els.srcEsp.addEventListener('click', () => setSource('esp32'));

els.btnPause.addEventListener('click', () => {
  const next = !radar.isPaused();
  radar.setPaused(next);
  els.btnPause.textContent = next ? 'Relancer le balayage' : 'Pause le balayage';
  els.btnPause.setAttribute('aria-pressed', next ? 'true' : 'false');
});

els.btnSettings.addEventListener('click', () => {
  refreshSettingsForm();
  els.settings.showModal();
  els.setIp.focus();
});

els.btnCloseSettings.addEventListener('click', () => {
  els.settings.close();
});

els.settings.addEventListener('close', () => {
  commitNetworkFields();
  els.btnSettings.focus();
});

function commitNetworkFields() {
  settings.ip = els.setIp.value.trim();
  settings.port = els.setPort.value.trim() || '80';
  writeStoredSettings(settings);
  refreshSettingsForm();
}

els.setIp.addEventListener('change', commitNetworkFields);
els.setPort.addEventListener('change', commitNetworkFields);
els.setIp.addEventListener('input', () => {
  settings.ip = els.setIp.value.trim();
  els.wsPreview.textContent = currentWsUrl() || 'ws://…/ws';
  els.mixedNote.hidden = !isMixedContent(currentWsUrl());
});
els.setPort.addEventListener('input', () => {
  settings.port = els.setPort.value.trim() || '80';
  els.wsPreview.textContent = currentWsUrl() || 'ws://…/ws';
});

els.btnConnect.addEventListener('click', () => {
  commitNetworkFields();
  setSource('esp32');
});

els.resetWifi.addEventListener('click', async () => {
  if (!isEspHost()) return;
  const ok = confirm('Reconfigurer le Wi-Fi ? L’ESP32 redémarrera en mode configuration.');
  if (!ok) return;
  try {
    await fetch('/api/reset-wifi', { method: 'POST' });
  } catch {
    /* the board may reboot before answering */
  }
});

if (els.setMute) {
  els.setMute.addEventListener('change', () => {
    settings.mute = els.setMute.checked;
    writeStoredSettings(settings);
    sources.send({ cmd: 'mute', v: settings.mute });
  });
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}

renderToggle();
refreshSettingsForm();
startSource();
