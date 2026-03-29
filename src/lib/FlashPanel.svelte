<!--
  FlashPanel.svelte — Flash firmware ESP32 via esptool-js
-->
<script>
  import { ESPLoader, Transport } from 'esptool-js';
  import { prepareForFlash, resumeMonitor, forgetPort } from './serial.js';

  let phase    = 'idle';   // idle | connecting | connected | flashing | done | error
  let errMsg   = '';
  let chipName = '';
  let isStub   = false;

  // File rows
  let fileRows = [{ addr: '0x1000', file: null, name: '' }];
  function addRow()       { fileRows = [...fileRows, { addr: '0x10000', file: null, name: '' }]; }
  function removeRow(i)   { fileRows = fileRows.filter((_, j) => j !== i); }
  function pickFile(e, i) {
    const f = e.target.files[0]; if (!f) return;
    fileRows[i] = { ...fileRows[i], file: f, name: f.name };
    fileRows = [...fileRows];
  }
  function onDrop(e, i) {
    e.preventDefault();
    const f = e.dataTransfer?.files[0];
    if (!f?.name.endsWith('.bin')) return;
    fileRows[i] = { ...fileRows[i], file: f, name: f.name };
    fileRows = [...fileRows];
  }

  function presetPIO() {
    fileRows = [
      { addr: '0x1000',  file: null, name: '' },
      { addr: '0x8000',  file: null, name: '' },
      { addr: '0x10000', file: null, name: '' }
    ];
  }
  function presetMerged() { fileRows = [{ addr: '0x0', file: null, name: '' }]; }

  let autoLoading = false;
  async function autoLoad() {
    autoLoading = true;
    const bins = [
      { addr: '0x1000',  path: '/firmware/bootloader.bin',  name: 'bootloader.bin'  },
      { addr: '0x8000',  path: '/firmware/partitions.bin',  name: 'partitions.bin'  },
      { addr: '0x10000', path: '/firmware/firmware.bin',    name: 'firmware.bin'    },
    ];
    try {
      const rows = [];
      for (const b of bins) {
        const res = await fetch(b.path);
        if (!res.ok) throw new Error(`Gagal muat ${b.name} (${res.status})`);
        const blob = await res.blob();
        rows.push({ addr: b.addr, file: new File([blob], b.name, { type: 'application/octet-stream' }), name: b.name });
      }
      fileRows = rows;
      log('✓ 3 fail firmware dimuatkan dari server', 'ok');
    } catch (e) { alert('Auto-load gagal: ' + e.message); }
    finally { autoLoading = false; }
  }

  // Flash options
  let flashMode = 'dio';
  let flashFreq = '40m';
  let flashSize = 'keep';
  let flashBaud = 921600;
  let eraseAll  = false;
  let compress  = true;
  let afterMode = 'hard_reset';

  // Progress
  let progress = 0, progressLbl = '';

  // Log
  let logEl, logLines = [];
  function log(text, type = 'info') {
    logLines = [...logLines, { text, type, ts: new Date().toISOString().slice(11, 23) }];
    setTimeout(() => { if (logEl) logEl.scrollTop = logEl.scrollHeight; }, 10);
  }
  function logType(t) {
    if (/error|fail|gagal/i.test(t)) return 'error';
    if (/warn/i.test(t))             return 'warn';
    if (/done|selesai|✓/i.test(t))  return 'ok';
    if (/chip|stub|flash|baud/i.test(t)) return 'chip';
    return 'info';
  }

  const terminal = {
    clean    : () => { logLines = []; },
    writeLine: (t) => log(t, logType(t)),
    write    : (t) => {
      if (logLines.length > 0) {
        const last = logLines[logLines.length - 1];
        if (last.partial) {
          logLines[logLines.length - 1] = { ...last, text: last.text + t };
          logLines = [...logLines]; return;
        }
      }
      logLines = [...logLines, { text: t, type: 'info', ts: '', partial: true }];
    }
  };

  let esploader = null, transport = null;

  async function connectChip() {
    phase = 'connecting'; errMsg = ''; logLines = [];
    log('Menyambung ke chip ESP32...');
    log('Tekan BOOT pada ESP32, kemudian tekan RESET sebentar, lepaskan RESET, lepaskan BOOT.', 'warn');
    try {
      const rawPort = await prepareForFlash();
      transport  = new Transport(rawPort, false);
      esploader  = new ESPLoader({ transport, baudrate: flashBaud, terminal, debugLogging: false });
      chipName   = await esploader.main();
      log(`✓ Chip: ${chipName}`, 'ok');
      log('Memuat stub flasher...', 'info');
      await esploader.runStub();
      isStub = true;
      log('✓ Stub aktif', 'ok');
      if (flashBaud !== 115200) {
        log(`Menukar baud ke ${flashBaud}...`);
        await esploader.changeBaud();
        log(`✓ Baud: ${flashBaud}`, 'ok');
      }
      phase = 'connected';
    } catch (e) {
      errMsg = e.message ?? String(e);
      log('✗ ' + errMsg, 'error');
      phase = 'error';
      await cleanup(false);
    }
  }

  async function doFlash() {
    const valid = fileRows.filter(r => r.file);
    if (!valid.length) { log('✗ Tiada fail dipilih!', 'error'); return; }
    phase = 'flashing'; progress = 0;
    try {
      const fileArray = [];
      for (const row of valid) {
        const data = new Uint8Array(await row.file.arrayBuffer());
        const addr = parseInt(row.addr, 16);
        if (isNaN(addr)) throw new Error(`Alamat tidak sah: ${row.addr}`);
        fileArray.push({ data, address: addr });
        log(`  + ${row.name} @ ${row.addr} (${(data.length/1024).toFixed(1)} KB)`);
      }
      log(`Mula flash ${fileArray.length} fail...`);
      let lastIdx = -1;
      await esploader.writeFlash({
        fileArray, flashMode, flashFreq, flashSize,
        eraseAll, compress,
        reportProgress(fi, written, total) {
          if (fi !== lastIdx) { lastIdx = fi; progressLbl = valid[fi]?.name ?? ''; }
          progress = Math.round((written / total) * 100);
        }
      });
      progress = 100;
      log('✓ Flash selesai!', 'ok');
      phase = 'done';
    } catch (e) {
      errMsg = e.message ?? String(e);
      log('✗ Flash gagal: ' + errMsg, 'error');
      phase = 'error';
    }
  }

  async function resetAndMonitor() {
    log(`Mereset chip (${afterMode})...`);
    try { await esploader.after(afterMode); } catch (e) { log('Reset: ' + e.message, 'warn'); }
    await cleanup(true);
  }

  async function eraseChip() {
    if (!confirm('Padam KESELURUHAN flash? Semua data akan hilang!')) return;
    phase = 'flashing'; log('Memadam flash...', 'warn');
    try { await esploader.eraseFlash(); log('✓ Dipadam', 'ok'); } catch (e) { log('✗ ' + e.message, 'error'); }
    phase = 'connected';
  }

  async function cleanup(reconnect) {
    try { await transport?.disconnect(); } catch {}
    transport = null; esploader = null; isStub = false;
    if (reconnect) { await resumeMonitor(); phase = 'idle'; }
    else { forgetPort(); }
  }

  async function disconnectChip() {
    log('Memutuskan...'); await cleanup(false); phase = 'idle'; chipName = '';
  }

  const onDragover = e => e.preventDefault();

  const logColor = { ok: 'text-green-400', error: 'text-red-400', warn: 'text-yellow-400', chip: 'text-cyan-400', info: 'text-slate-500' };
</script>

<div class="flex gap-3 h-full overflow-hidden">

  <!-- Kiri: Konfigurasi -->
  <div class="w-72 shrink-0 flex flex-col gap-3 overflow-y-auto pr-1">

    <!-- Chip Info -->
    <div class="card p-3 flex items-center gap-3 {chipName ? '' : 'opacity-50'}">
      <div class="text-2xl">{chipName ? '🟢' : '🔌'}</div>
      <div>
        {#if chipName}
          <div class="text-sm font-bold text-cyan-400">{chipName}</div>
          {#if isStub}<div class="text-xs text-green-400">✓ Stub aktif</div>{/if}
        {:else}
          <div class="text-xs text-slate-600">Belum disambung ke chip</div>
        {/if}
      </div>
    </div>

    <!-- Fail Firmware -->
    <div>
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs font-bold tracking-wider text-slate-600">FAIL FIRMWARE</span>
        <div class="flex gap-1">
          <button class="text-xs px-2 py-0.5 bg-slate-900 border border-slate-800 rounded text-slate-600 hover:text-slate-400" on:click={presetMerged}>Merged</button>
          <button class="text-xs px-2 py-0.5 bg-slate-900 border border-slate-800 rounded text-slate-600 hover:text-slate-400" on:click={presetPIO}>PIO (3)</button>
          <button class="text-xs px-2 py-0.5 bg-green-950 border border-green-900 rounded text-green-400 hover:text-green-300 disabled:opacity-40"
            on:click={autoLoad} disabled={autoLoading}>
            {autoLoading ? '⏳' : '⬇'} Auto
          </button>
        </div>
      </div>

      {#each fileRows as row, i}
        <div class="flex gap-1.5 mb-1.5 items-center"
          on:drop={e => onDrop(e, i)} on:dragover={onDragover}
          role="region" aria-label="file row {i}">
          <div class="flex items-center bg-slate-900 border border-slate-800 rounded px-2 py-1 shrink-0">
            <span class="text-xs text-slate-700">0x</span>
            <input class="w-16 bg-transparent text-xs font-mono text-cyan-400 outline-none" bind:value={row.addr} spellcheck="false" />
          </div>
          <label class="flex-1 flex items-center gap-1.5 px-2 py-1.5 bg-slate-900 border {row.file ? 'border-green-900 bg-green-950/20' : 'border-dashed border-slate-800'} rounded cursor-pointer overflow-hidden hover:border-slate-700 transition-colors">
            <input type="file" accept=".bin" on:change={e => pickFile(e, i)} hidden />
            <span class="text-xs {row.file ? 'text-green-400' : 'text-slate-700'}">{row.file ? '✓' : '+'}</span>
            <span class="text-xs truncate {row.file ? 'text-green-400' : 'text-slate-700'}">{row.name || 'Pilih / drop .bin'}</span>
          </label>
          {#if fileRows.length > 1}
            <button class="text-slate-700 hover:text-red-400 text-xs px-1" on:click={() => removeRow(i)}>✕</button>
          {/if}
        </div>
      {/each}
      <button class="w-full text-xs py-1 border border-dashed border-slate-800 rounded text-slate-700 hover:text-slate-500 hover:border-slate-700 transition-colors" on:click={addRow}>+ Tambah partition</button>
    </div>

    <!-- Pilihan Flash -->
    <div>
      <div class="text-xs font-bold tracking-wider text-slate-600 mb-2">PILIHAN FLASH</div>
      <div class="grid grid-cols-2 gap-2 mb-2">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-slate-600">Mode</span>
          <select class="bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-xs text-slate-400 outline-none" bind:value={flashMode}>
            <option>dio</option><option>dout</option><option>qio</option><option>qout</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-slate-600">Frekuensi</span>
          <select class="bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-xs text-slate-400 outline-none" bind:value={flashFreq}>
            <option>40m</option><option>80m</option><option>26m</option><option>20m</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-slate-600">Saiz Flash</span>
          <select class="bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-xs text-slate-400 outline-none" bind:value={flashSize}>
            <option>keep</option><option>1MB</option><option>2MB</option><option>4MB</option><option>8MB</option>
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs text-slate-600">Baud Flash</span>
          <select class="bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-xs text-slate-400 outline-none" bind:value={flashBaud}>
            <option value={115200}>115200</option>
            <option value={460800}>460800</option>
            <option value={921600}>921600 ⚡</option>
          </select>
        </label>
      </div>
      <div class="flex gap-4 mb-2">
        <label class="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer"><input type="checkbox" bind:checked={eraseAll} class="accent-cyan-500" /> Padam semua</label>
        <label class="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer"><input type="checkbox" bind:checked={compress} class="accent-cyan-500" /> Mampat</label>
      </div>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-slate-600">Selepas flash</span>
        <select class="bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-xs text-slate-400 outline-none" bind:value={afterMode}>
          <option value="hard_reset">Hard Reset → Monitor</option>
          <option value="soft_reset">Soft Reset</option>
          <option value="no_reset">Tiada Reset</option>
        </select>
      </label>
    </div>

    <!-- Butang Tindakan -->
    <div class="flex gap-2 flex-wrap">
      {#if phase === 'idle' || phase === 'error'}
        <button class="flex-1 py-2 rounded-lg text-xs font-bold bg-cyan-950 text-cyan-400 border border-cyan-900 hover:opacity-80" on:click={connectChip}>🔗 Sambung Chip</button>
      {:else if phase === 'connecting' || phase === 'flashing'}
        <button class="flex-1 py-2 rounded-lg text-xs font-bold bg-slate-900 text-slate-600 border border-slate-800 cursor-wait" disabled>
          {phase === 'connecting' ? '⏳ Menyambung...' : '⚡ Flashing...'}
        </button>
      {:else if phase === 'connected'}
        <button class="flex-1 py-2 rounded-lg text-xs font-bold bg-yellow-950 text-yellow-400 border border-yellow-900 hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed"
          on:click={doFlash} disabled={!fileRows.some(r => r.file)}>⚡ Flash</button>
        <button class="py-2 px-3 rounded-lg text-xs font-bold bg-red-950 text-red-400 border border-red-900 hover:opacity-80" on:click={eraseChip}>🗑</button>
        <button class="py-2 px-3 rounded-lg text-xs font-bold bg-slate-900 text-slate-500 border border-slate-800 hover:opacity-80" on:click={disconnectChip}>✕</button>
      {:else if phase === 'done'}
        <button class="flex-1 py-2 rounded-lg text-xs font-bold bg-green-950 text-green-400 border border-green-900 hover:opacity-80" on:click={resetAndMonitor}>▶ Reset + Monitor</button>
        <button class="py-2 px-3 rounded-lg text-xs font-bold bg-yellow-950 text-yellow-400 border border-yellow-900 hover:opacity-80" on:click={doFlash}>↺</button>
        <button class="py-2 px-3 rounded-lg text-xs font-bold bg-slate-900 text-slate-500 border border-slate-800 hover:opacity-80" on:click={disconnectChip}>✕</button>
      {/if}
    </div>

    <!-- Progress bar -->
    {#if phase === 'flashing'}
      <div class="relative h-5 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
        <div class="h-full rounded-full transition-all duration-200" style="width:{progress}%; background:linear-gradient(90deg,#0e7490,#22d3ee)"></div>
        <span class="absolute inset-0 flex items-center justify-center text-xs font-bold text-white">{progress}% — {progressLbl}</span>
      </div>
    {/if}
  </div>

  <!-- Kanan: Log -->
  <div class="flex-1 flex flex-col bg-slate-950 border border-slate-900 rounded-xl overflow-hidden">
    <div class="flex items-center justify-between px-3 py-2 bg-slate-900 border-b border-slate-800 shrink-0">
      <span class="text-xs font-bold tracking-wider text-slate-600">LOG ESPTOOL-JS</span>
      <button class="text-xs px-2 py-0.5 bg-slate-950 border border-slate-800 rounded text-slate-600 hover:text-red-400" on:click={() => logLines = []}>Kosong</button>
    </div>
    <div class="flex-1 overflow-y-auto p-2 font-mono text-xs" bind:this={logEl}>
      {#if !logLines.length}
        <div class="text-slate-800 text-center mt-4">Output esptool-js akan muncul di sini...</div>
      {:else}
        {#each logLines as ln}
          <div class="flex gap-2 py-0.5 border-b border-slate-900 leading-relaxed">
            {#if ln.ts}<span class="text-slate-800 shrink-0">{ln.ts}</span>{/if}
            <span class="{logColor[ln.type] ?? 'text-slate-500'} break-all">{ln.text}</span>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>
