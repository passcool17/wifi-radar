/**
 * Two-layer radar scope: static rings + a sweeping beam with a persistence trail.
 * Pauses when the tab is hidden. Honours prefers-reduced-motion (slow crawl).
 */
export function createRadar(canvas) {
  const trail = document.createElement('canvas');
  const staticLayer = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: true });
  let trailCtx = trail.getContext('2d', { alpha: true });
  let staticCtx = staticLayer.getContext('2d', { alpha: true });

  let width = 0;
  let height = 0;
  let dpr = 1;
  let radius = 0;
  let cx = 0;
  let cy = 0;
  let angle = -Math.PI / 2;
  let lastTs = 0;
  let raf = 0;
  let running = true;
  let paused = false;
  let hidden = false;
  let reduced = false;
  let sample = { presence: false, motion: 0, bearing: null };

  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const onMq = () => {
    reduced = mq ? mq.matches : false;
  };
  onMq();
  mq?.addEventListener?.('change', onMq);

  const onVis = () => {
    hidden = document.hidden;
    if (!hidden && running) {
      lastTs = 0;
      loop();
    }
  };
  document.addEventListener('visibilitychange', onVis);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    width = Math.max(1, Math.round(rect.width * dpr));
    height = Math.max(1, Math.round(rect.height * dpr));
    for (const c of [canvas, trail, staticLayer]) {
      c.width = width;
      c.height = height;
    }
    cx = width / 2;
    cy = height / 2;
    radius = Math.min(cx, cy) * 0.86;
    drawStatic();
    // Clear trail on resize so it doesn't smear
    trailCtx.clearRect(0, 0, width, height);
  }

  function ringColor(alpha) {
    return `rgba(94, 232, 160, ${alpha})`;
  }

  function drawStatic() {
    const c = staticCtx;
    c.clearRect(0, 0, width, height);
    c.save();
    c.translate(cx, cy);

    const bg = c.createRadialGradient(0, 0, radius * 0.05, 0, 0, radius);
    bg.addColorStop(0, 'rgba(18, 48, 36, 0.45)');
    bg.addColorStop(0.55, 'rgba(6, 16, 14, 0.2)');
    bg.addColorStop(1, 'rgba(2, 6, 8, 0.0)');
    c.fillStyle = bg;
    c.beginPath();
    c.arc(0, 0, radius, 0, Math.PI * 2);
    c.fill();

    c.strokeStyle = 'rgba(94, 232, 160, 0.55)';
    c.lineWidth = Math.max(1.5, dpr);
    c.beginPath();
    c.arc(0, 0, radius, 0, Math.PI * 2);
    c.stroke();

    for (const f of [0.25, 0.5, 0.75]) {
      c.strokeStyle = ringColor(0.16);
      c.lineWidth = Math.max(1, dpr * 0.6);
      c.beginPath();
      c.arc(0, 0, radius * f, 0, Math.PI * 2);
      c.stroke();
    }

    c.strokeStyle = 'rgba(94, 232, 160, 0.18)';
    c.lineWidth = Math.max(1, dpr * 0.5);
    c.beginPath();
    c.moveTo(-radius, 0);
    c.lineTo(radius, 0);
    c.moveTo(0, -radius);
    c.lineTo(0, radius);
    c.stroke();

    c.fillStyle = 'rgba(186, 232, 206, 0.45)';
    c.font = `${Math.round(10 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const labels = [
      [0, -radius - 12 * dpr, '0'],
      [radius + 12 * dpr, 0, '90'],
      [0, radius + 12 * dpr, '180'],
      [-radius - 16 * dpr, 0, '270'],
    ];
    // Keep labels inside the canvas
    c.fillStyle = 'rgba(186, 232, 206, 0.4)';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const r0 = radius - 7 * dpr;
      const r1 = radius;
      c.strokeStyle = i % 3 === 0 ? 'rgba(94, 232, 160, 0.45)' : 'rgba(94, 232, 160, 0.2)';
      c.lineWidth = i % 3 === 0 ? 1.4 * dpr : dpr * 0.7;
      c.beginPath();
      c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      c.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      c.stroke();
    }
    c.restore();
    void labels;
  }

  function drawBeam(target, a, strong) {
    const c = target;
    c.save();
    c.translate(cx, cy);
    const span = reduced ? 0.22 : 0.42;
    const grd = c.createRadialGradient(0, 0, 0, 0, 0, radius);
    grd.addColorStop(0, `rgba(120, 255, 180, ${strong ? 0.18 : 0.08})`);
    grd.addColorStop(1, 'rgba(80, 220, 140, 0)');
    c.fillStyle = grd;
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, radius, a - span, a, false);
    c.closePath();
    c.fill();

    c.strokeStyle = `rgba(180, 255, 210, ${strong ? 0.9 : 0.55})`;
    c.lineWidth = Math.max(1.4, dpr * 1.1);
    c.shadowColor = 'rgba(90, 255, 170, 0.65)';
    c.shadowBlur = 8 * dpr;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
    c.stroke();
    c.restore();
  }

  function drawBlip(target) {
    if (!sample.presence) return;
    const c = target;
    const motion = Math.max(0, Math.min(100, sample.motion ?? 0));
    const dist = sample.bearing == null ? radius * (0.38 + motion * 0.002) : radius * (0.42 + (motion / 100) * 0.22);
    const a =
      sample.bearing == null ? angle - 0.35 : (sample.bearing * Math.PI) / 180 - Math.PI / 2;
    const x = cx + Math.cos(a) * dist;
    const y = cy + Math.sin(a) * dist;
    const r = (5 + motion * 0.05) * dpr;
    c.save();
    c.shadowColor = 'rgba(255, 210, 110, 0.8)';
    c.shadowBlur = 12 * dpr;
    const g = c.createRadialGradient(x, y, 0, x, y, r * 3);
    g.addColorStop(0, 'rgba(255, 236, 170, 0.95)');
    g.addColorStop(0.4, 'rgba(232, 177, 90, 0.6)');
    g.addColorStop(1, 'rgba(232, 177, 90, 0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r * 3, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#ffe9a8';
    c.beginPath();
    c.arc(x, y, r * 0.45, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  function frame(ts) {
    if (!running) return;
    if (hidden) {
      raf = 0;
      return;
    }
    raf = requestAnimationFrame(frame);
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;

    const period = reduced ? 28 : 3.2; // seconds per revolution
    if (!paused) {
      angle = (angle + (Math.PI * 2 * dt) / period) % (Math.PI * 2);
      // Fade trail
      trailCtx.globalCompositeOperation = 'source-over';
      trailCtx.fillStyle = reduced ? 'rgba(5, 7, 10, 0.18)' : 'rgba(5, 7, 10, 0.085)';
      trailCtx.fillRect(0, 0, width, height);
      trailCtx.save();
      trailCtx.beginPath();
      trailCtx.arc(cx, cy, radius - dpr, 0, Math.PI * 2);
      trailCtx.clip();
      drawBeam(trailCtx, angle, true);
      trailCtx.restore();
    }

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(staticLayer, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius - dpr, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalAlpha = 0.95;
    ctx.drawImage(trail, 0, 0);
    ctx.globalAlpha = 1;
    if (paused) drawBeam(ctx, angle, true);
    drawBlip(ctx);
    ctx.restore();
  }

  function loop() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  resize();
  loop();

  return {
    setSample(next) {
      sample = next || sample;
    },
    setPaused(value) {
      paused = Boolean(value);
    },
    isPaused() {
      return paused;
    },
    destroy() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      mq?.removeEventListener?.('change', onMq);
    },
  };
}
