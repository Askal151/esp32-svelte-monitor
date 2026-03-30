/**
 * serial.js — Web Serial manager untuk ESP32 + ADS1015
 * Format output: HALL4|adc1|dev1|led1|adc2|dev2|led2|adc3|dev3|led3|adc4|dev4|led4  @115200
 */
import { writable } from 'svelte/store';

export const MAX_POINTS  = 300;
export const MAX_HISTORY = 3000;

// ── Svelte stores ──────────────────────────────────────────────
export const portState   = writable('idle');
export const connected   = writable(false);
export const packetCount = writable(0);
export const isLogging   = writable(false);
export const logCount    = writable(0);

export const sensors = writable([
  { adc: 0, volt: 0, dev: 0, led: 0, baseline: 0, thresh: [82, 329, 720, 1049] },
  { adc: 0, volt: 0, dev: 0, led: 0, baseline: 0, thresh: [82, 329, 720, 1049] },
  { adc: 0, volt: 0, dev: 0, led: 0, baseline: 0, thresh: [82, 329, 720, 1049] },
  { adc: 0, volt: 0, dev: 0, led: 0, baseline: 0, thresh: [82, 329, 720, 1049] },
]);

export const chartTick = writable(0);

// ── Plot buffers ───────────────────────────────────────────────
export const plotBuf = [
  { adc: new Array(MAX_POINTS).fill(0), dev: new Array(MAX_POINTS).fill(0), led: new Array(MAX_POINTS).fill(0) },
  { adc: new Array(MAX_POINTS).fill(0), dev: new Array(MAX_POINTS).fill(0), led: new Array(MAX_POINTS).fill(0) },
  { adc: new Array(MAX_POINTS).fill(0), dev: new Array(MAX_POINTS).fill(0), led: new Array(MAX_POINTS).fill(0) },
  { adc: new Array(MAX_POINTS).fill(0), dev: new Array(MAX_POINTS).fill(0), led: new Array(MAX_POINTS).fill(0) },
];

// ── Sejarah baris serial ───────────────────────────────────────
export const rawHistory = [];

const _listeners = new Set();
export function onRawLine(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
function emitRaw(text, dir = 'rx') {
  const ts = new Date().toISOString().slice(11, 23);
  rawHistory.push({ text, dir, ts });
  if (rawHistory.length > MAX_HISTORY) rawHistory.shift();
  _listeners.forEach(fn => fn(text, dir, ts));
}

// ── Regex ──────────────────────────────────────────────────────
const RX_DATA = /HALL4\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)\|(-?\d+)/;
const RX_THR  = [1,2,3,4].map(i => new RegExp(`\\[THRESH${i}\\]\\s*(\\d+)\\|(\\d+)\\|(\\d+)\\|(\\d+)`));
const RX_BASE = /\[(?:AUTO|CAL|INIT)\s*S(\d)\].*?(\d+)\s*$/;

// ── State ──────────────────────────────────────────────────────
let _port         = null;
let _reader       = null;
let _running      = false;
let _lineBuf      = '';
let _csvRows      = [];
let _logging      = false;
let _logCount     = 0;
let _wantMonitor  = false;
let _reconnecting = false;   // sedang dalam proses reconnect
let _failStreak   = 0;       // berapa kali readLoop gagal berturut-turut tanpa data
let _watchdog     = null;

const WATCHDOG_MS = 6000;
const BAUD        = 115200;
const MAX_STREAK  = 3;       // gagal >= MAX_STREAK → minta reconnect manual

isLogging.subscribe(v => { _logging = v; });

// ── Watchdog ───────────────────────────────────────────────────
function resetWatchdog() {
  clearTimeout(_watchdog);
  if (_running && _wantMonitor) {
    _watchdog = setTimeout(onWatchdogFire, WATCHDOG_MS);
  }
}

function stopWatchdog() {
  clearTimeout(_watchdog);
  _watchdog = null;
}

async function onWatchdogFire() {
  if (!_running || !_wantMonitor || _reconnecting) return;
  console.warn('[serial] watchdog — tiada data');
  emitRaw('[WATCHDOG] Tiada data — cuba sambung semula...', 'rx');
  _running = false;
  connected.set(false);
  await _safeClose();
  await delay(600);
  await _autoReconnect();
}

// ── Tutup reader & port dengan selamat ─────────────────────────
async function _safeClose() {
  stopWatchdog();
  // Cancel reader dulu — ini unlock readable stream
  try { await _reader?.cancel(); }  catch {}
  try { _reader?.releaseLock(); }   catch {}
  _reader = null;
  await delay(200);   // beri masa Chrome release lock
  // Pastikan readable tidak ada lock lain sebelum close
  if (_port?.readable && !_port.readable.locked) {
    try {
      const r = _port.readable.getReader();
      await r.cancel().catch(() => {});
      r.releaseLock();
    } catch {}
    await delay(100);
  }
  try { await _port?.close(); }     catch {}
  await delay(150);
}

// ── Paksa unlock semua stream dan tutup port ───────────────────
async function _forceClosePort(port) {
  // Unlock readable — tangani sama ada locked atau tidak
  if (port.readable) {
    if (!port.readable.locked) {
      // Bukan locked tapi port nampak terbuka — ambil reader lalu cancel
      try {
        const r = port.readable.getReader();
        await r.cancel().catch(() => {});
        r.releaseLock();
      } catch {}
    }
    // Jika masih locked (reader lain pegang) — biarkan sahaja, close() akan handle
  }
  // Unlock writable
  if (port.writable?.locked) {
    try {
      // Kita tidak boleh paksa release writer orang lain — tapi cuba dapatkan writer baru akan gagal
      // Cuma log dan teruskan
      console.warn('[serial] writable masih locked semasa _forceClosePort');
    } catch {}
  }
  await delay(200);
  try { await port.close(); } catch (e) {
    console.warn('[serial] _forceClosePort → close() gagal (mungkin sudah tertutup):', e.message);
  }
  await delay(200);
}

// ── Buka port — cuba pelbagai konfigurasi, force-close jika perlu ──
async function _openPort(port) {
  // Konfigurasi yang dicuba secara berurutan
  // bufferSize kecil (4096) lebih selamat di Linux Chrome; tanpa bufferSize guna default Chrome
  const OPEN_CONFIGS = [
    { baudRate: BAUD, bufferSize: 4096 },
    { baudRate: BAUD },
  ];

  // Jika port.readable bukan null → port sudah terbuka (dari sesi sebelum)
  // Paksa tutup dulu sebelum buka semula
  if (port.readable !== null) {
    console.log('[serial] port nampak terbuka dari sesi lama — paksa tutup');
    await _forceClosePort(port);
  }

  let lastErr = null;
  for (const cfg of OPEN_CONFIGS) {
    try {
      await port.open(cfg);
      console.log('[serial] port berjaya dibuka:', JSON.stringify(cfg));
      return;   // berjaya
    } catch (e) {
      lastErr = e;
      console.warn(`[serial] open gagal (${JSON.stringify(cfg)}):`, e.message);
      // Jika gagal, cuba force close lagi sebelum konfigurasi seterusnya
      await _forceClosePort(port);
    }
  }

  // Semua konfigurasi gagal — forget port supaya Chrome reset state sepenuhnya
  if (typeof port.forget === 'function') {
    console.warn('[serial] port.forget() — Chrome akan reset state port');
    try { await port.forget(); } catch {}
  }

  const hint = lastErr?.message?.toLowerCase().includes('failed to open')
    ? ' Pastikan tiada program lain (PlatformIO monitor, minicom) sedang menggunakan port ini.'
    : '';
  throw new Error(
    `Gagal buka port: ${lastErr?.message ?? 'ralat tidak diketahui'}.${hint} Klik ⚡ Sambung dan pilih port sekali lagi.`
  );
}

// ── Web Serial USB events ──────────────────────────────────────
if (typeof navigator !== 'undefined' && navigator.serial) {

  navigator.serial.addEventListener('disconnect', (e) => {
    if (e.target !== _port) return;
    console.log('[serial] USB disconnect event');
    stopWatchdog();
    _running = false;
    _port    = null;
    try { _reader?.cancel(); }   catch {}
    try { _reader?.releaseLock(); } catch {}
    _reader = null;
    connected.set(false);
    emitRaw('[USB] Peranti dicabut.', 'rx');
  });

  navigator.serial.addEventListener('connect', async () => {
    // Hanya reconnect jika: user mahu monitor, tiada sesi aktif,
    // tiada reconnect dalam proses, DAN streak gagal belum melebihi had
    if (_wantMonitor && !_running && !_reconnecting && _failStreak < MAX_STREAK) {
      emitRaw('[USB] Peranti dikesan semula — reconnecting...', 'rx');
      await delay(1200);   // tunggu ESP32 selesai enumerate
      await _autoReconnect();
    }
  });
}

// ── Parse baris serial ─────────────────────────────────────────
function parseLine(raw) {
  const line = raw.trim();
  if (!line) return;
  emitRaw(line, 'rx');

  let m = RX_DATA.exec(line);
  if (m) {
    const v = Array.from({ length: 12 }, (_, i) => +m[i + 1]);
    sensors.update(arr => {
      for (let i = 0; i < 4; i++) {
        const adc = v[i*3], dev = v[i*3+1], led = v[i*3+2];
        arr[i] = { ...arr[i], adc, volt: +(adc * 0.002).toFixed(3), dev, led };
        plotBuf[i].adc.push(adc); plotBuf[i].adc.shift();
        plotBuf[i].dev.push(dev); plotBuf[i].dev.shift();
        plotBuf[i].led.push(led); plotBuf[i].led.shift();
      }
      return arr;
    });
    packetCount.update(n => n + 1);
    chartTick.update(n => n + 1);
    resetWatchdog();
    if (_logging) {
      _csvRows.push([new Date().toISOString().slice(11, 23), ...v].join(','));
      logCount.set(++_logCount);
    }
    return;
  }

  for (let i = 0; i < 4; i++) {
    m = RX_THR[i].exec(line);
    if (m) {
      const t = [1,2,3,4].map(j => +m[j]);
      sensors.update(a => { a[i] = { ...a[i], thresh: t }; return a; });
      return;
    }
  }

  m = RX_BASE.exec(line);
  if (m) {
    const idx = +m[1] - 1, base = +m[2];
    if (idx >= 0 && idx < 4)
      sensors.update(a => { a[idx] = { ...a[idx], baseline: base }; return a; });
  }
}

// ── Read loop ──────────────────────────────────────────────────
async function readLoop() {
  const dec = new TextDecoder();
  _lineBuf = '';
  let gotData  = false;   // pernah terima data dalam sesi ini?
  let lastErr  = null;
  console.log('[serial] readLoop mula');

  while (_running) {
    try {
      const { value, done } = await _reader.read();
      if (done) { console.log('[serial] reader done'); break; }
      if (!gotData) {
        gotData = true;
        _failStreak = 0;   // berjaya terima data → reset streak
      }
      _lineBuf += dec.decode(value, { stream: true });
      const lines = _lineBuf.split('\n');
      _lineBuf = lines.pop() ?? '';
      for (const l of lines) parseLine(l);
    } catch (err) {
      lastErr = err;
      console.warn('[serial] read error:', err.message);
      break;
    }
  }

  console.log('[serial] readLoop berhenti');
  stopWatchdog();
  try { _reader?.releaseLock(); } catch {}
  _reader = null;

  // _running = false bermakna disconnect() atau USB event yang hentikan loop
  // → jangan reconnect, keluar sahaja
  if (!_running) return;

  _running = false;
  connected.set(false);

  if (!_wantMonitor) return;

  if (!gotData) {
    // readLoop gagal tanpa dapat sebarang data (kemungkinan USB tidak stabil)
    _failStreak++;
    _port = null;
    if (_failStreak >= MAX_STREAK) {
      // Terlalu banyak kali gagal → berhenti, minta user reconnect manual
      _wantMonitor = false;
      portState.set('idle');
      emitRaw(`[USB] Gagal ${_failStreak}x berturut — klik ⚡ Sambung semula`, 'rx');
    } else {
      emitRaw(`[USB] Sambungan tidak stabil (${_failStreak}/${MAX_STREAK}) — menunggu USB...`, 'rx');
      // Tunggu 'connect' event — JANGAN reconnect terus
    }
    return;
  }

  // Ada data tapi kemudian putus → ini genuine disconnect, cuba reconnect
  emitRaw('[SISTEM] Sambungan hilang — cuba pulihkan...', 'rx');
  if (!_reconnecting) {
    try { await _port?.close(); } catch {}
    await delay(800);
    await _autoReconnect();
  }
}

// ── Auto reconnect ─────────────────────────────────────────────
async function _autoReconnect() {
  if (_reconnecting) return;
  _reconnecting = true;
  portState.set('idle');

  for (let attempt = 1; attempt <= 10; attempt++) {
    if (!_wantMonitor) break;
    try {
      const ports = await navigator.serial.getPorts();
      if (!ports.length) {
        emitRaw(`[USB] Tiada port... (${attempt}/10)`, 'rx');
        await delay(1000);
        continue;
      }
      _port = ports[0];
        await _openPort(_port);
      _reader = _port.readable.getReader();

      // Tetapkan _running = true DAN _reconnecting = false
      // SEBELUM readLoop dipanggil — tapi dengan urutan yang betul:
      // readLoop mesti tahu ia sudah "dalam reconnect" sehingga data pertama diterima
      connected.set(true);
      portState.set('monitor');
      emitRaw(`[USB] Sambungan dipulihkan ✓ (percubaan ${attempt})`, 'rx');
      console.log('[serial] reconnect berjaya (attempt', attempt, ')');

      _running      = true;
      _reconnecting = false;   // clear SELEPAS _running = true
      resetWatchdog();
      readLoop();              // fire-and-forget (intentional)
      return;
    } catch (e) {
      console.warn(`[serial] reconnect ${attempt} gagal:`, e.message);
      await delay(Math.min(1000 * attempt, 5000));
    }
  }

  _reconnecting = false;
  _wantMonitor  = false;
  _port = null;
  portState.set('idle');
  emitRaw('[SISTEM] Reconnect gagal — klik ⚡ Sambung semula', 'rx');
}

// ── API awam ───────────────────────────────────────────────────

export async function connect() {
  if (!navigator.serial) {
    alert('Web Serial API tidak disokong. Sila guna Chrome atau Edge.');
    return false;
  }

  // Reset state
  _failStreak   = 0;
  _reconnecting = false;

  // Bersihkan sesi lama
  if (_running || _port) {
    _running = false;
    await _safeClose();
    _port = null;
    await delay(200);
  }

  // Bersihkan sebarang port lama yang Chrome ingat — elak "port already open" dari sesi lama
  try {
    const stalePorts = await navigator.serial.getPorts();
    for (const p of stalePorts) {
      if (p.readable !== null) {
        console.log('[serial] tutup stale port dari getPorts()');
        await _forceClosePort(p).catch(() => {});
      }
    }
  } catch {}

  try {
    _port = await navigator.serial.requestPort();
    await _openPort(_port);

    _reader      = _port.readable.getReader();
    _running     = true;
    _wantMonitor = true;
    connected.set(true);
    portState.set('monitor');
    resetWatchdog();
    readLoop();
    return true;
  } catch (e) {
    if (e.name !== 'NotFoundError') console.error('[serial] gagal sambung:', e);
    // Paksa tutup port supaya percubaan seterusnya bermula bersih
    if (_port) {
      await _forceClosePort(_port).catch(() => {});
      _port = null;
    }
    throw e;
  }
}

export async function disconnect() {
  _wantMonitor = false;
  _running     = false;
  _failStreak  = 0;
  stopWatchdog();
  await _safeClose();
  _port = null;
  connected.set(false);
  portState.set('idle');
  _lineBuf = '';
}

export async function sendCmd(cmd) {
  if (!_port?.writable || _port.writable.locked) return;
  const w = _port.writable.getWriter();
  try {
    await w.write(new TextEncoder().encode(cmd));
    emitRaw(`>> ${cmd}`, 'tx');
  } catch (e) {
    console.warn('[serial] sendCmd gagal:', e.message);
  } finally {
    w.releaseLock();
  }
}

// ── Flash API ──────────────────────────────────────────────────
export async function prepareForFlash() {
  if (!navigator.serial) throw new Error('Web Serial API tidak disokong.');
  _wantMonitor = false;
  _running     = false;
  stopWatchdog();
  await _safeClose();
  if (!_port) {
    _port = await navigator.serial.requestPort();
  }
  await delay(400);
  portState.set('flashing');
  return _port;
}

export async function resumeMonitor() {
  portState.set('idle');
  if (!_port) return;
  try {
    await delay(400);
    await _openPort(_port);
    _reader      = _port.readable.getReader();
    _running     = true;
    _wantMonitor = true;
    _failStreak  = 0;
    connected.set(true);
    portState.set('monitor');
    resetWatchdog();
    readLoop();
  } catch (e) {
    console.error('[resumeMonitor]', e.message);
    _port = null;
    portState.set('idle');
  }
}

export function forgetPort() {
  _wantMonitor = false;
  _running     = false;
  _failStreak  = 0;
  stopWatchdog();
  _port = null;
  portState.set('idle');
  connected.set(false);
}

// ── CSV logging ────────────────────────────────────────────────
export function startLog() {
  _csvRows  = ['Masa,S1_ADC,S1_Dev,S1_LED,S2_ADC,S2_Dev,S2_LED,S3_ADC,S3_Dev,S3_LED,S4_ADC,S4_Dev,S4_LED'];
  _logCount = 0;
  logCount.set(0);
  isLogging.set(true);
}

export function stopLog() { isLogging.set(false); }

export function downloadCSV() {
  stopLog();
  const blob = new Blob([_csvRows.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `esp32_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`
  });
  a.click();
  URL.revokeObjectURL(url);
  _csvRows = [];
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Vite HMR cleanup — tutup port semasa hot-reload ────────────
if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    _wantMonitor = false;
    _running     = false;
    stopWatchdog();
    try { await _reader?.cancel(); }  catch {}
    try { _reader?.releaseLock(); }   catch {}
    _reader = null;
    await delay(150);
    try { await _port?.close(); }     catch {}
    _port = null;
    console.log('[serial] HMR dispose — port ditutup');
  });
}
