<!--
  UChart.svelte — Real-time chart menggunakan uPlot
-->
<script>
  import { onMount } from 'svelte';
  import uPlot from 'uplot';
  import { MAX_POINTS, plotBuf, chartTick } from './serial.js';

  export let sensorIdx  = 0;
  export let type       = 'adc';
  export let yLabel     = '';
  export let color      = '#22d3ee';
  export let thresholds = [];
  export let baseline   = 0;

  const TCLR = ['#f59e0b', '#f97316', '#ef4444', '#8b5cf6'];
  const xs   = Float64Array.from({ length: MAX_POINTS }, (_, i) => i);

  let container, plot, raf, unsub;

  function buildData() {
    const buf  = plotBuf[sensorIdx][type];
    const rows = [xs, new Float64Array(buf)];
    if (type === 'dev') for (const t of thresholds) rows.push(new Float64Array(MAX_POINTS).fill(t));
    if (type === 'adc') rows.push(new Float64Array(MAX_POINTS).fill(baseline));
    return rows;
  }

  function makeSeries() {
    const s = [{}, { label: yLabel, stroke: color, width: 2, fill: color + '18' }];
    if (type === 'dev') thresholds.forEach((t, i) => s.push({ label: `L${i+1}=${t}`, stroke: TCLR[i], width: 1, dash: [4,4], points: { show: false } }));
    if (type === 'adc') s.push({ label: 'Baseline', stroke: '#ffffff30', width: 1, dash: [6,3], points: { show: false } });
    return s;
  }

  function makeOpts(w) {
    return {
      width: w, height: 150,
      cursor: { show: false },
      legend: { show: type !== 'led' },
      axes: [
        { stroke: '#334155', grid: { stroke: '#ffffff06', width: 1 }, ticks: { stroke: '#ffffff06', width: 1 }, values: (_, vs) => vs.map(v => v ?? '') },
        { label: yLabel, labelSize: 13, labelGap: 4, stroke: '#475569', size: 48, grid: { stroke: '#ffffff06', width: 1 }, ticks: { stroke: '#ffffff06', width: 1 } }
      ],
      scales: { x: { time: false }, y: type === 'led' ? { range: [-0.2, 4.5] } : { auto: true } },
      series: makeSeries()
    };
  }

  function refresh() { if (plot) plot.setData(buildData(), false); }

  onMount(() => {
    const w = container.clientWidth || 400;
    plot = new uPlot(makeOpts(w), buildData(), container);

    unsub = chartTick.subscribe(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(refresh);
    });

    const ro = new ResizeObserver(([e]) => {
      const nw = Math.floor(e.contentRect.width);
      if (nw > 0) plot?.setSize({ width: nw, height: 150 });
    });
    ro.observe(container);

    return () => { unsub?.(); cancelAnimationFrame(raf); ro.disconnect(); plot?.destroy(); };
  });

  $: if (plot) refresh();
</script>

<div bind:this={container} class="uchart w-full overflow-hidden"></div>

<style>
  :global(.uchart .uplot) { background: transparent !important; }
  :global(.uchart .u-legend) { font-size: 10px; color: #475569; }
  :global(.uchart .u-series td) { padding: 1px 4px; }
</style>
