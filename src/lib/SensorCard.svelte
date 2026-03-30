<!--
  SensorCard.svelte — Paparan data satu sensor Hall
-->
<script>
  export let sensor    = { adc: 0, volt: 0, dev: 0, led: 0, baseline: 0, thresh: [] };
  export let idx       = 0;
  export let color     = '#22d3ee';
  export let connected = false;
  export let onCmd     = async (_cmd) => {};

  const LED_COLORS = ['#f59e0b', '#f97316', '#ef4444', '#8b5cf6'];

  // Perintah per sensor: [auto, baseline]
  const CMDS = [['a','c'], ['b','d'], ['e','g'], ['f','h']];

  let calMsg = '';
  let calTimer = null;

  function showMsg(msg) {
    calMsg = msg;
    clearTimeout(calTimer);
    calTimer = setTimeout(() => calMsg = '', 6000);
  }

  async function doAuto() {
    await onCmd(CMDS[idx][0]);
    showMsg('Jauhkan magnet 2s, kemudian dekatkan 3s...');
  }

  async function doBaseline() {
    await onCmd(CMDS[idx][1]);
    showMsg('Jauhkan magnet 2s...');
  }
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

  <!-- Butang Kalibrasi -->
  <div class="flex gap-2 pt-1 border-t border-slate-800">
    <button
      class="flex-1 py-1.5 rounded text-xs font-bold transition-colors
        {connected ? 'bg-violet-950 border border-violet-900 text-violet-400 hover:bg-violet-900' : 'bg-slate-900 border border-slate-800 text-slate-700 cursor-not-allowed'}"
      disabled={!connected}
      on:click={doAuto}
      title="AUTO kalibrasi — [{CMDS[idx][0].toUpperCase()}]"
    >⚡ AUTO Cal</button>
    <button
      class="flex-1 py-1.5 rounded text-xs font-bold transition-colors
        {connected ? 'bg-blue-950 border border-blue-900 text-blue-400 hover:bg-blue-900' : 'bg-slate-900 border border-slate-800 text-slate-700 cursor-not-allowed'}"
      disabled={!connected}
      on:click={doBaseline}
      title="Set baseline — [{CMDS[idx][1].toUpperCase()}]"
    >⟳ Baseline</button>
  </div>

  <!-- Status kalibrasi -->
  {#if calMsg}
    <div class="text-xs text-yellow-400 bg-yellow-950 border border-yellow-900 rounded px-2 py-1 leading-snug">
      {calMsg}
    </div>
  {/if}
</div>
