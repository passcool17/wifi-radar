import { createEsp32Source } from './esp32.js';
import { createSimulator, sceneOffset } from './simulator.js';

/**
 * Switches between the simulated source and the ESP32 WebSocket source.
 * Both emit the same sample shape.
 * @param {{ onSample: (s: object) => void, onStatus: (s: object) => void, scene?: string | null }} opts
 */
export function createSourceManager(opts) {
  let active = null;
  let kind = 'sim';

  function stop() {
    if (active) {
      active.stop();
      active = null;
    }
  }

  function start(nextKind, settings) {
    stop();
    kind = nextKind === 'esp32' ? 'esp32' : 'sim';
    if (kind === 'sim') {
      const sim = createSimulator({
        interval: 100,
        originOffset: sceneOffset(opts.scene ?? null),
      });
      active = sim;
      opts.onStatus({ state: 'simulated', detail: 'Simulation en cours' });
      sim.start(opts.onSample);
      return;
    }
    const source = createEsp32Source({
      url: settings.url,
      onStatus: opts.onStatus,
    });
    active = source;
    source.start(opts.onSample);
  }

  return { start, stop, kind: () => kind };
}
