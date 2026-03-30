<!--
  Plotter.svelte — Canvas 2D real-time plotter, 60fps
  3 panel: ADC, Deviasi, LED — 4 sensor serentak
-->
<script>
  import { onMount, tick } from 'svelte';
  import { plotBuf, chartTick, sensors, MAX_POINTS } from './serial.js';

  const CLR  = ['#22d3ee', '#4ade80', '#f59e0b', '#f472b6'];
  const TCLR = ['#fbbf24', '#f97316', '#ef4444', '#a855f7'];

  const NUM_SENSORS = 4;

  let wrap, canvas, ctx;
  let rafId, dirty = true, paused = false;
  let W = 0, H = 0;

  // state sensor (reactive) — array 4 sensor
  let sensArr = Array.from({ length: NUM_SENSORS }, () =>
    ({ adc: 0, dev: 0, led: 0, baseline: 0, thresh: [82, 329, 720, 1049] })
  );

  // Panel layout — dikira semula tiap resize
  // P[i] = { y, h, label, min, max }
  let panels = [];
  const HEADER = 32;   // px toolbar dalam canvas
  const PAD    = { l: 58, r: 12, t: 8, b: 22 };

  function layoutPanels(totalH) {
    const avail = totalH - HEADER - 16;
    // Agih: ADC 40%, Dev 35%, LED 25%
    const adcH  = Math.floor(avail * 0.40);
    const devH  = Math.floor(avail * 0.35);
    const ledH  = avail - adcH - devH;
    let y = HEADER + 8;
    panels = [
      { y, h: adcH,  label: 'ADC (LSB)',   key: 'adc', autoY: true  },
      { y: y + adcH + 4, h: devH, label: 'Deviasi',     key: 'dev', autoY: true  },
      { y: y + adcH + devH + 8, h: ledH, label: 'LED', key: 'led', autoY: false, yMin: -0.2, yMax: 4.5 },
    ];
  }

  // ── Drawing ─────────────────────────────────────────────────
  function drawPanel(p) {
    const { y, h, label, key, autoY, yMin, yMax } = p;
    const x0 = PAD.l, x1 = W - PAD.r;
    const y0 = y + PAD.t, y1 = y + h - PAD.b;
    const pw = x1 - x0, ph = y1 - y0;
    if (pw <= 0 || ph <= 0) return;

    const bufs = plotBuf.map(b => b[key]);

    // Hitung range Y
    let vMin, vMax;
    if (autoY) {
      vMin = Infinity; vMax = -Infinity;
      for (let si = 0; si < NUM_SENSORS; si++) {
        for (let i = 0; i < MAX_POINTS; i++) {
          if (bufs[si][i] < vMin) vMin = bufs[si][i];
          if (bufs[si][i] > vMax) vMax = bufs[si][i];
        }
      }
      if (vMin === vMax) { vMin -= 10; vMax += 10; }
      const margin = (vMax - vMin) * 0.08;
      vMin -= margin; vMax += margin;
    } else {
      vMin = yMin; vMax = yMax;
    }
    const yScale = ph / (vMax - vMin);
    const toY = v => y1 - (v - vMin) * yScale;

    // Background panel
    ctx.fillStyle = '#020817';
    ctx.fillRect(x0, y0, pw, ph);

    // Grid lines Y
    ctx.strokeStyle = '#ffffff08';
    ctx.lineWidth = 1;
    const gridCount = key === 'led' ? 5 : 4;
    for (let i = 0; i <= gridCount; i++) {
      const gv = vMin + (vMax - vMin) * (i / gridCount);
      const gy = Math.round(toY(gv));
      ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x1, gy); ctx.stroke();
      ctx.fillStyle = '#334155';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      const lbl = Math.abs(gv) >= 1000 ? (gv / 1000).toFixed(1) + 'k' : gv.toFixed(key === 'led' ? 1 : 0);
      ctx.fillText(lbl, x0 - 3, gy);
    }

    // Threshold lines (panel deviasi)
    if (key === 'dev') {
      const thresh = sensArr[0].thresh ?? [];
      for (let i = 0; i < thresh.length; i++) {
        const ty = toY(thresh[i]);
        if (ty >= y0 && ty <= y1) {
          ctx.strokeStyle = TCLR[i] + 'aa';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(x0, ty); ctx.lineTo(x1, ty); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = TCLR[i] + 'cc';
          ctx.font = '9px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
          ctx.fillText(`L${i + 1}`, x1 + 2, ty);
        }
      }
    }

    // Baseline line (panel ADC)
    if (key === 'adc') {
      for (let si = 0; si < NUM_SENSORS; si++) {
        const base = sensArr[si].baseline;
        if (!base) continue;
        const by = toY(base);
        if (by >= y0 && by <= y1) {
          ctx.strokeStyle = CLR[si] + '40';
          ctx.lineWidth = 1;
          ctx.setLineDash([6, 3]);
          ctx.beginPath(); ctx.moveTo(x0, by); ctx.lineTo(x1, by); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // Plot lines — kedua sensor
    const step = pw / (MAX_POINTS - 1);

    if (key === 'led') {
      // Bar chart untuk LED — 4 sensor
      const barW = Math.max(1, step * 0.22);
      const offsets = [-barW * 1.65, -barW * 0.55, barW * 0.55, barW * 1.65];
      for (let si = 0; si < NUM_SENSORS; si++) {
        ctx.fillStyle = CLR[si] + '90';
        for (let i = 0; i < MAX_POINTS; i++) {
          const bx = x0 + i * step + offsets[si];
          const bv = bufs[si][i];
          const by = toY(bv);
          const bh = y1 - by;
          if (bh > 0) ctx.fillRect(bx, by, barW, bh);
        }
      }
    } else {
      // Line chart — 4 sensor
      for (let si = 0; si < NUM_SENSORS; si++) {
        // Fill area
        ctx.beginPath();
        ctx.moveTo(x0, y1);
        for (let i = 0; i < MAX_POINTS; i++) {
          const px = x0 + i * step;
          const py = Math.max(y0, Math.min(y1, toY(bufs[si][i])));
          i === 0 ? ctx.lineTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.lineTo(x0 + (MAX_POINTS - 1) * step, y1);
        ctx.closePath();
        ctx.fillStyle = CLR[si] + '14';
        ctx.fill();

        // Line
        ctx.beginPath();
        ctx.strokeStyle = CLR[si];
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        for (let i = 0; i < MAX_POINTS; i++) {
          const px = x0 + i * step;
          const py = Math.max(y0, Math.min(y1, toY(bufs[si][i])));
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }

    // Border panel
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.rect(x0, y0, pw, ph); ctx.stroke();

    // Label panel
    ctx.fillStyle = '#475569';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(label, x0 + 2, y0 - 1);
  }

  function draw() {
    if (!ctx || W === 0 || H === 0) return;

    ctx.fillStyle = '#020817';
    ctx.fillRect(0, 0, W, H);

    // Header bar
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, HEADER);

    // Legend sensor di header — 4 sensor
    for (let i = 0; i < NUM_SENSORS; i++) {
      const s = sensArr[i];
      const lx = 10 + i * Math.floor((W - 20) / NUM_SENSORS);
      ctx.fillStyle = CLR[i];
      ctx.beginPath(); ctx.arc(lx + 5, HEADER / 2, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = CLR[i];
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(
        `S${i + 1} ${s.adc} D:${s.dev} L:${s.led}`,
        lx + 13, HEADER / 2
      );
    }

    // Divider
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, HEADER); ctx.lineTo(W, HEADER); ctx.stroke();

    // Draw panels
    for (const p of panels) drawPanel(p);

    // Pause overlay
    if (paused) {
      ctx.fillStyle = '#f59e0b22';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#f59e0bcc';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('⏸ PAUSED', W / 2, H / 2);
      ctx.textAlign = 'left';
    }
  }

  function loop() {
    if (dirty) { draw(); dirty = false; }
    rafId = requestAnimationFrame(loop);
  }

  // ── Resize ───────────────────────────────────────────────────
  function resize(w, h) {
    if (w <= 0 || h <= 0) return;
    W = w; H = h;
    canvas.width = w; canvas.height = h;
    layoutPanels(h);
    dirty = true;
  }

  onMount(async () => {
    await tick();  // tunggu DOM render

    ctx = canvas.getContext('2d', { alpha: false });

    // Subscribe sensor state
    const unsubS = sensors.subscribe(arr => {
      sensArr = arr.map(s => ({ ...s }));
      dirty = true;
    });

    // Subscribe chartTick
    const unsubT = chartTick.subscribe(() => {
      if (!paused) dirty = true;
    });

    // Initial size
    resize(wrap.clientWidth, wrap.clientHeight);

    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      resize(Math.floor(width), Math.floor(height));
    });
    ro.observe(wrap);

    rafId = requestAnimationFrame(loop);

    return () => {
      unsubS(); unsubT();
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  });

  function togglePause() {
    paused = !paused;
    if (!paused) dirty = true;
  }
</script>

<div class="flex flex-col h-full bg-slate-950 rounded-lg overflow-hidden">

  <!-- Toolbar (di luar canvas untuk interaktif) -->
  <div class="flex items-center gap-3 px-3 py-1.5 bg-slate-900 border-b border-slate-800 shrink-0">
    <span class="text-xs font-bold tracking-widest text-slate-600">PLOTTER</span>
    <div class="flex items-center gap-1.5 ml-1">
      {#each [0,1,2,3] as i}
        <div class="w-2.5 h-2.5 rounded-full" style="background:{CLR[i]}"></div>
        <span class="text-xs font-mono mr-2" style="color:{CLR[i]}">S{i+1}</span>
      {/each}
    </div>
    <span class="text-xs text-slate-700 flex-1">{MAX_POINTS} titik bergulir · 60fps</span>
    <button
      class="text-xs px-3 py-1 rounded border transition-colors
        {paused ? 'bg-yellow-950 border-yellow-800 text-yellow-400' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'}"
      on:click={togglePause}
    >{paused ? '▶ Resume' : '⏸ Pause'}</button>
  </div>

  <!-- Canvas — ambil semua ruang yang ada -->
  <div bind:this={wrap} class="flex-1 overflow-hidden">
    <canvas bind:this={canvas} style="display:block;width:100%;height:100%"></canvas>
  </div>

</div>
