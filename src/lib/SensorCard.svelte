<!--
  SensorCard.svelte — Paparan data satu sensor Hall
-->
<script>
  export let sensor = { adc: 0, volt: 0, dev: 0, led: 0, baseline: 0, thresh: [] };
  export let idx    = 0;
  export let color  = '#22d3ee';

  const LED_COLORS = ['#f59e0b', '#f97316', '#ef4444', '#8b5cf6'];
</script>

<div class="card p-4 flex flex-col gap-3">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2">
      <div class="w-2.5 h-2.5 rounded-full transition-all" style="background:{color}; box-shadow:0 0 6px {color}80"></div>
      <span class="text-xs font-bold tracking-wider text-slate-400">SENSOR {idx + 1}</span>
    </div>
    <span class="text-xs font-mono text-slate-600">ADS1015 A{idx}</span>
  </div>

  <!-- Nilai utama -->
  <div class="grid grid-cols-3 gap-2">
    <div class="bg-slate-950 rounded-lg p-2 text-center">
      <div class="text-xl font-bold font-mono leading-none" style="color:{color}">{sensor.adc}</div>
      <div class="text-xs text-slate-600 mt-1">ADC (LSB)</div>
    </div>
    <div class="bg-slate-950 rounded-lg p-2 text-center">
      <div class="text-xl font-bold font-mono leading-none text-slate-300">{sensor.volt.toFixed(3)}</div>
      <div class="text-xs text-slate-600 mt-1">Volt (V)</div>
    </div>
    <div class="bg-slate-950 rounded-lg p-2 text-center">
      <div class="text-xl font-bold font-mono leading-none text-violet-400">{sensor.dev}</div>
      <div class="text-xs text-slate-600 mt-1">Deviasi</div>
    </div>
  </div>

  <!-- LED Bar -->
  <div class="flex items-center gap-2">
    <span class="text-xs text-slate-600 shrink-0 w-7">LED</span>
    <div class="flex gap-1.5 flex-1">
      {#each [0,1,2,3] as i}
        <div
          class="flex-1 h-4 rounded transition-all duration-150"
          style="background:{i < sensor.led ? LED_COLORS[i] : '#0f172a'}; box-shadow:{i < sensor.led ? `0 0 8px ${LED_COLORS[i]}60` : 'none'}"
        ></div>
      {/each}
    </div>
    <span class="text-xs font-mono text-slate-400 w-6 text-right">{sensor.led}/4</span>
  </div>

  <!-- Baseline & Threshold -->
  <div class="flex items-center justify-between text-xs">
    <span class="text-slate-600">Base: <span class="text-slate-500 font-mono">{sensor.baseline}</span></span>
    <div class="flex gap-2">
      {#each sensor.thresh as t, i}
        <span class="font-mono text-slate-700">L{i+1}=<span style="color:{LED_COLORS[i]}99">{t}</span></span>
      {/each}
    </div>
  </div>
</div>
