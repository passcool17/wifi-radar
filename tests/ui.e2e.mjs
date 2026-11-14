import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const shots = path.resolve(root, '..', 'wifi-radar-shots');
fs.mkdirSync(shots, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      if (urlPath.endsWith('/')) urlPath += 'index.html';
      const file = path.join(root, urlPath.replace(/^\//, ''));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      const ext = path.extname(file);
      res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Chrome/Chromium introuvable');
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignore benign service-worker / favicon noise if any
      if (text.includes('Failed to load resource') && text.includes('favicon')) return;
      errors.push(text);
    }
  });
  return errors;
}

async function main() {
  const live = process.env.BASE_URL || '';
  let server = null;
  let base = live.replace(/\/+$/, '');
  if (!base) {
    const local = await startServer();
    server = local.server;
    base = local.base;
  }

  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  let failed = 0;
  const check = async (name, fn) => {
    try {
      await fn();
      console.log(`ok  - ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL - ${name}`);
      console.error(err);
    }
  };

  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2,
    serviceWorkers: 'allow',
    locale: 'fr-CA',
    timezoneId: 'America/Toronto',
  });
  const page = await context.newPage();
  const errors = collectErrors(page);

  const appUrl = `${base}/index.html?scene=presence`;

  await check('app loads without console errors', async () => {
    const res = await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 45000 });
    if (!res || !res.ok()) throw new Error(`HTTP ${res && res.status()}`);
    await page.waitForSelector('#radar');
    await page.waitForTimeout(600);
    if (errors.length) throw new Error(errors.join('\n'));
  });

  await check('presence is detected in the sitting scene', async () => {
    await page.waitForFunction(
      () => document.getElementById('presence-text')?.textContent.trim() === 'oui',
      { timeout: 15000 },
    );
    await page.screenshot({ path: path.join(shots, 'presence-412x915.png'), fullPage: true });
  });

  await check('radar sweep is animating', async () => {
    const changed = await page.evaluate(async () => {
      const canvas = document.getElementById('radar');
      const a = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise((r) => setTimeout(r, 220));
      const b = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let diff = 0;
      for (let i = 0; i < a.length; i += 16) {
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff += 1;
      }
      return diff;
    });
    if (changed < 8) throw new Error(`sweep does not appear to animate (diff=${changed})`);
  });

  await check('live screenshot 412x915', async () => {
    await page.screenshot({ path: path.join(shots, 'live-412x915.png'), fullPage: true });
    if (!fs.existsSync(path.join(shots, 'live-412x915.png'))) throw new Error('missing shot');
  });

  await check('settings persist after reload', async () => {
    await page.click('#btn-settings');
    await page.waitForSelector('#settings[open]');
    await page.fill('#set-ip', '192.168.1.42');
    await page.fill('#set-port', '80');
    await page.screenshot({ path: path.join(shots, 'settings.png'), fullPage: true });
    await page.click('#btn-close-settings');
    await page.click('#src-esp');
    await page.waitForTimeout(200);
    await page.reload({ waitUntil: 'networkidle' });
    // scene query may drop on reload of same path with query? we used index.html?scene=presence
    const source = await page.evaluate(() => localStorage.getItem('wifi-radar-settings'));
    const parsed = JSON.parse(source);
    if (parsed.source !== 'esp32') throw new Error(`source=${parsed.source}`);
    if (parsed.ip !== '192.168.1.42') throw new Error(`ip=${parsed.ip}`);
    await page.click('#btn-settings');
    await page.waitForSelector('#settings[open]');
    const ip = await page.inputValue('#set-ip');
    const port = await page.inputValue('#set-port');
    if (ip !== '192.168.1.42' || port !== '80') throw new Error(`form ${ip}:${port}`);
    await page.click('#btn-close-settings');
    // restore sim so later tests stay quiet
    await page.click('#src-sim');
  });

  await check('offline reload works after service worker install', async () => {
    // SW only registers on https. On a local http test, skip with a clear note.
    const secure = base.startsWith('https://');
    if (!secure) {
      console.log('skip - offline SW (page is not https)');
      return;
    }
    await page.goto(appUrl, { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
      if (!navigator.serviceWorker) throw new Error('no SW');
      const reg = await navigator.serviceWorker.ready;
      if (!reg) throw new Error('SW not ready');
    });
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#radar', { timeout: 15000 });
    const title = await page.title();
    if (!title.includes('Wi-Fi Radar')) throw new Error(title);
    await context.setOffline(false);
  });

  // Flasher page
  const flashErrors = [];
  const flashPage = await context.newPage();
  flashPage.on('pageerror', (err) => flashErrors.push(String(err)));
  flashPage.on('console', (msg) => {
    if (msg.type() === 'error') flashErrors.push(msg.text());
  });

  await check('flasher page loads at 412x915 without console errors', async () => {
    const res = await flashPage.goto(`${base}/flash/`, { waitUntil: 'networkidle', timeout: 45000 });
    if (!res || !res.ok()) throw new Error(`HTTP ${res && res.status()}`);
    await flashPage.waitForSelector('h1');
    const text = await flashPage.locator('h1').innerText();
    if (!text.includes('Installer')) throw new Error(text);
    await flashPage.waitForTimeout(400);
    if (flashErrors.length) throw new Error(flashErrors.join('\n'));
    await flashPage.screenshot({ path: path.join(shots, 'flash-412x915.png'), fullPage: true });
  });

  await check('flasher page loads at 1280x800 without console errors', async () => {
    await flashPage.setViewportSize({ width: 1280, height: 800 });
    flashErrors.length = 0;
    const res = await flashPage.goto(`${base}/flash/`, { waitUntil: 'networkidle', timeout: 45000 });
    if (!res || !res.ok()) throw new Error(`HTTP ${res && res.status()}`);
    await flashPage.waitForSelector('esp-web-install-button, h1');
    await flashPage.waitForTimeout(400);
    if (flashErrors.length) throw new Error(flashErrors.join('\n'));
    await flashPage.screenshot({ path: path.join(shots, 'flash-1280x800.png'), fullPage: true });
  });

  await browser.close();
  if (server) server.close();

  if (failed) {
    console.error(`${failed} UI test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('all UI tests passed');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
