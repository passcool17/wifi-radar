/**
 * Live intensity graph of the last 60 seconds of motion.
 */
export function createGraph(canvas, windowMs = 60_000) {
  const ctx = canvas.getContext('2d', { alpha: true });
  /** @type {{ t: number, motion: number, presence: boolean }[]} */
  let points = [];
  let width = 0;
  let height = 0;
  let dpr = 1;
  let dirty = true;
  let raf = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    width = Math.max(1, Math.round(rect.width * dpr));
    height = Math.max(1, Math.round(rect.height * dpr));
    canvas.width = width;
    canvas.height = height;
    dirty = true;
    schedule();
  }

  function prune(now) {
    const from = now - windowMs;
    while (points.length && points[0].t < from) points.shift();
  }

  function draw() {
    raf = 0;
    if (!dirty) return;
    dirty = false;
    const now = points.length ? points[points.length - 1].t : Date.now();
    prune(now);
    const c = ctx;
    c.clearRect(0, 0, width, height);

    const padL = 28 * dpr;
    const padR = 8 * dpr;
    const padT = 8 * dpr;
    const padB = 16 * dpr;
    const x0 = padL;
    const y0 = padT;
    const w = width - padL - padR;
    const h = height - padT - padB;

    // Grid
    c.strokeStyle = 'rgba(94, 232, 160, 0.1)';
    c.lineWidth = Math.max(1, dpr * 0.6);
    c.font = `${Math.round(9 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    c.fillStyle = 'rgba(186, 232, 206, 0.4)';
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    for (const v of [0, 50, 100]) {
      const y = y0 + h - (v / 100) * h;
      c.beginPath();
      c.moveTo(x0, y);
      c.lineTo(x0 + w, y);
      c.stroke();
      c.fillText(String(v), x0 - 6 * dpr, y);
    }
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText('−60 s', x0, y0 + h + 3 * dpr);
    c.textAlign = 'right';
    c.fillText('maintenant', x0 + w, y0 + h + 3 * dpr);

    if (points.length < 2) return;

    const xAt = (t) => x0 + ((t - (now - windowMs)) / windowMs) * w;
    const yAt = (m) => y0 + h - (Math.max(0, Math.min(100, m)) / 100) * h;

    // Presence bands
    c.fillStyle = 'rgba(232, 177, 90, 0.08)';
    let i = 0;
    while (i < points.length) {
      if (!points[i].presence) {
        i += 1;
        continue;
      }
      const start = i;
      while (i < points.length && points[i].presence) i += 1;
      const xA = xAt(points[start].t);
      const xB = xAt(points[i - 1].t);
      c.fillRect(xA, y0, Math.max(1, xB - xA), h);
    }

    c.beginPath();
    c.moveTo(xAt(points[0].t), yAt(points[0].motion));
    for (let k = 1; k < points.length; k++) {
      c.lineTo(xAt(points[k].t), yAt(points[k].motion));
    }
    const last = points[points.length - 1];
    c.lineTo(xAt(last.t), y0 + h);
    c.lineTo(xAt(points[0].t), y0 + h);
    c.closePath();
    const fill = c.createLinearGradient(0, y0, 0, y0 + h);
    fill.addColorStop(0, 'rgba(94, 232, 160, 0.35)');
    fill.addColorStop(1, 'rgba(94, 232, 160, 0.02)');
    c.fillStyle = fill;
    c.fill();

    c.beginPath();
    c.moveTo(xAt(points[0].t), yAt(points[0].motion));
    for (let k = 1; k < points.length; k++) {
      c.lineTo(xAt(points[k].t), yAt(points[k].motion));
    }
    c.strokeStyle = 'rgba(150, 255, 200, 0.9)';
    c.lineWidth = Math.max(1.2, dpr);
    c.shadowColor = 'rgba(90, 255, 170, 0.35)';
    c.shadowBlur = 6 * dpr;
    c.stroke();
    c.shadowBlur = 0;
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(draw);
  }

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  resize();

  return {
    push(sample) {
      points.push({ t: sample.t, motion: sample.motion, presence: sample.presence });
      prune(sample.t);
      dirty = true;
      schedule();
    },
    reset() {
      points = [];
      dirty = true;
      schedule();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    },
  };
}
