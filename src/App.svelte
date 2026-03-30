<script>
  import SensorCard    from './lib/SensorCard.svelte';
  import Plotter       from './lib/Plotter.svelte';
  import SerialMonitor from './lib/SerialMonitor.svelte';
  import FlashPanel    from './lib/FlashPanel.svelte';
  import {
    portState, connected, sensors, packetCount, isLogging, logCount,
    connect, disconnect, sendCmd, startLog, stopLog, downloadCSV
  } from './lib/serial.js';

  // Debug: simpan error terakhir
  let lastError = '';
  const origConnect = connect;
  async function safeConnect() {
    lastError = '';
    try { await origConnect(); }
    catch(e) { lastError = e.message; }
  }

  const CLR = ['#22d3ee', '#4ade80', '#f59e0b', '#f472b6'];

  let tab = 'monitor';   // monitor | flash | plotter

  // Resize panel bawah
  let panelH = 380;
  let resizing = false, ry0 = 0, rh0 = 0;
  function rstart(e) { resizing = true; ry0 = e.clientY; rh0 = panelH; e.preventDefault(); }
  function rmove(e)  { if (resizing) panelH = Math.max(220, Math.min(700, rh0 + ry0 - e.clientY)); }
  function rend()    { resizing = false; }

  async function toggleConn() {
    lastError = '';
    if ($connected) { await disconnect(); }
    else {
      try { await connect(); }
      catch(e) { lastError = e.message; }
    }
  }
</script>

<svelte:window on:mousemove={rmove} on:mouseup={rend} />

<div class="min-h-screen bg-slate-950 text-slate-300 p-3 flex flex-col gap-3">

  <!-- ── HEADER ─────────────────────────────────────── -->
  <header class="card px-4 py-2.5 flex items-center justify-between flex-wrap gap-2">
    <div class="flex items-baseline gap-3">
      <span class="text-base font-bold text-cyan-400 tracking-tight">📡 ESP32 + ADS1015</span>
      <span class="text-xs text-slate-700">Hall Sensor Monitor</span>
    </div>

    <div class="flex items-center gap-3">
      {#if $portState === 'monitor'}
        <span class="text-xs font-bold text-green-400">● Monitor</span>
        <span class="text-xs text-slate-700">paket: {$packetCount}</span>
      {:else if $portState === 'flashing'}
        <span class="text-xs font-bold text-yellow-400">⚡ Flashing</span>
      {:else}
        <span class="text-xs text-slate-700">○ Idle</span>
      {/if}
    </div>

    <div class="flex items-center gap-2 flex-wrap">
      {#if $connected}
        {#if !$isLogging}
          <button class="btn-green" on:click={startLog}>⏺ Log</button>
        {:else}
          <button class="btn-disconnect" on:click={stopLog}>⏹ Stop</button>
        {/if}
        {#if $logCount > 0}
          <button class="btn-blue" on:click={downloadCSV}>⬇ CSV ({$logCount})</button>
        {/if}
        <button class="btn-gray" on:click={() => sendCmd('s')}>📋 Status</button>
        <button class="btn-gray" on:click={() => sendCmd('r')}>↺ Reset</button>
      {/if}
      <button
        class="{$connected ? 'btn-disconnect' : 'btn-connect'}"
        on:click={toggleConn}
        disabled={$portState === 'flashing'}
      >{$connected ? '⏏ Putus' : '⚡ Sambung'}</button>
    </div>
  </header>

  <!-- ── DEBUG BANNER ──────────────────────────────────── -->
  {#if lastError}
    <div class="bg-red-950 border border-red-800 rounded-xl px-4 py-2 text-xs text-red-300 flex items-center justify-between">
      <span>⚠ Error: <strong>{lastError}</strong></span>
      <button class="text-red-500 hover:text-red-300 ml-4" on:click={() => lastError=''}>✕</button>
    </div>
  {/if}

  <!-- ── SENSOR CARDS ────────────────────────────────── -->
  <section class="grid grid-cols-2 lg:grid-cols-4 gap-3 max-sm:grid-cols-1">
    {#each $sensors as s, i}
      <SensorCard sensor={s} idx={i} color={CLR[i]} />
    {/each}
  </section>

  <!-- ── PANEL BAWAH ─────────────────────────────────── -->
  <section class="card flex flex-col overflow-hidden" style="height:{panelH}px; min-height:220px; max-height:700px">

    <!-- Handle resize -->
    <div
      class="h-3 shrink-0 flex items-center justify-center cursor-ns-resize bg-slate-950 border-b border-slate-800 hover:bg-slate-900 transition-colors"
      on:mousedown={rstart}
      role="separator"
      aria-orientation="horizontal"
    >
      <div class="w-10 h-0.5 bg-slate-800 rounded"></div>
    </div>

    <!-- Tab bar -->
    <div class="flex items-center gap-1 px-3 bg-slate-950 border-b border-slate-800 shrink-0 flex-wrap">
      <button class="tab-item {tab==='monitor' ? 'active' : ''}" on:click={() => tab='monitor'}>
        ⬛ Serial Monitor
      </button>
      <button class="tab-item {tab==='flash' ? ($portState==='flashing' ? 'active-flash' : 'active') : ''}" on:click={() => tab='flash'}>
        ⚡ Flash Firmware
        {#if $portState === 'flashing'}<span class="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse"></span>{/if}
      </button>
      <button class="tab-item {tab==='plotter' ? 'active' : ''}" on:click={() => tab='plotter'}>
        📈 Plotter
      </button>
    </div>

    <!-- Kandungan -->
    <div class="flex-1 overflow-hidden relative">

      <!-- Serial Monitor — sentiasa mount, guna display:none bila tersembunyi -->
      <div class="absolute inset-0 p-2" style="display:{tab==='monitor' ? 'flex' : 'none'}; flex-direction:column">
        <SerialMonitor onSendCmd={sendCmd} />
      </div>

      <!-- Flash Panel — sentiasa mount (jangan interrupt flash) -->
      <div class="absolute inset-0 p-2" style="display:{tab==='flash' ? 'flex' : 'none'}; flex-direction:column">
        <FlashPanel />
      </div>

      <!-- Plotter — mount bila tab aktif supaya dapat dimensi yang tepat -->
      {#if tab === 'plotter'}
        <div class="absolute inset-0 flex flex-col">
          <Plotter />
        </div>
      {/if}

    </div>
  </section>

  <!-- ── FOOTER ──────────────────────────────────────── -->
  <footer class="flex justify-between items-center px-3 py-1.5 text-xs text-slate-700 bg-slate-950 border border-slate-900 rounded-xl">
    <span>
      {#if $portState === 'idle'}
        Klik ⚡ Sambung → pilih port ESP32 (115200) — Chrome / Edge sahaja
      {:else if $portState === 'monitor'}
        {$isLogging ? `● Merakam ${$logCount} rekod...` : '● Menerima data sensor'}
      {:else}
        ⚡ Sedang flash — jangan tutup halaman ini
      {/if}
    </span>
    <span class="text-slate-900">esptool-js · Espressif</span>
  </footer>

</div>
