/**
 * serial.js — Web Serial manager untuk ESP32 + ADS1015
 * Format output: HALL4|adc1|dev1|led1|adc2|dev2|led2|adc3|dev3|led3|adc4|dev4|led4  @115200
 * S1=A0, S2=A1, S3=A2, S4=A3
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
let _reconnecting = false;
let _watchdog     = null;

const WATCHDOG_MS  = 6000;   // 6s tiada data → reconnect
const BAUD         = 115200;
const BUF_SIZE     = 65536;  // buffer besar cegah overflow

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
  console.warn('[serial] watchdog — tiada data, reconnect...');
  emitRaw('[WATCHDOG] Tiada data — cuba sambung semula...', 'rx');
  await _forceReconnect();
}

// ── Tutup reader & port dengan selamat ─────────────────────────
async function _closeAll() {
  stopWatchdog();
  _running = false;
  try { await _reader?.cancel(); }   catch {}
  try { _reader?.releaseLock(); }    catch {}
  _reader = null;
  await delay(100);
  try { await _port?.close(); }      catch {}
}

// ── Force reconnect (tutup dulu, buka semula) ──────────────────
async function _forceReconnect() {
  if (_reconnecting) return;    // cegah panggilan berganda
  connected.set(false);
  await _closeAll();
  await delay(600);
  await _autoReconnect();
}

// ── Web Serial USB events ──────────────────────────────────────
if (typeof navigator !== 'undefined' && navigator.serial) {
  navigator.serial.addEventListener('disconnect', (e) => {
    if (e.target !== _port) return;
    console.log('[serial] USB disconnect event');
    stopWatchdog();
    _running = false;   // hentikan readLoop — ia akan kesan physicalLoss sendiri
    _port    = null;
    connected.set(false);
    try { _reader?.cancel(); } catch {}
    try { _reader?.releaseLock(); } catch {}
    _reader = null;
    emitRaw('[USB] Peranti dicabut — cabut & pasang semula USB...', 'rx');
  });

  navigator.serial.addEventListener('connect', async () => {
    if (_wantMonitor && !_running && !_reconnecting) {
      emitRaw('[USB] Peranti dikesan — reconnecting...', 'rx');
      await delay(800);
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
        plotBuf[i].adc.push(adc);  plotBuf[i].adc.shift();
        plotBuf[i].dev.push(dev);  plotBuf[i].dev.shift();
        plotBuf[i].led.push(led);  plotBuf[i].led.shift();
      }
      return arr;
    });
    packetCount.update(n => n + 1);
    chartTick.update(n => n + 1);
    resetWatchdog();   // data diterima — reset timer
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

// ── Kesan error USB hilang fizikal ─────────────────────────────
function isPhysicalLoss(err) {
  const msg = err?.message ?? '';
  return msg.includes('device has been lost') ||
         msg.includes('The device') ||
         err?.name === 'NetworkError';
}

// ── Read loop ──────────────────────────────────────────────────
async function readLoop() {
  const dec = new TextDecoder();
  _lineBuf = '';
  let physicalLoss = false;
  console.log('[serial] readLoop mula');

  while (_running) {
    try {
      const { value, done } = await _reader.read();
      if (done) { console.log('[serial] reader done'); break; }
      _lineBuf += dec.decode(value, { stream: true });
      const lines = _lineBuf.split('\n');
      _lineBuf = lines.pop() ?? '';
      for (const l of lines) parseLine(l);
    } catch (err) {
      console.warn('[serial] read error:', err.message);
      physicalLoss = isPhysicalLoss(err);
      break;
    }
  }

  console.log('[serial] readLoop berhenti');
  stopWatchdog();

  if (physicalLoss) {
    // USB hilang fizikal — bersih sahaja, JANGAN reconnect sekarang
    // Tunggu navigator.serial 'connect' event untuk reconnect
    _running = false;
    _port    = null;
    connected.set(false);
    try { _reader?.releaseLock(); } catch {}
    _reader = null;
    emitRaw('[USB] Peranti hilang — cabut & pasang semula USB...', 'rx');
    return;
  }

  // Putus tidak sengaja (bukan USB hilang) — boleh cuba reconnect
  if (_running && _wantMonitor && !_reconnecting) {
    _running = false;
    connected.set(false);
    emitRaw('[SISTEM] Sambungan hilang — cuba pulihkan...', 'rx');
    await _forceReconnect();
  }
}

// ── Auto reconnect ─────────────────────────────────────────────
async function _autoReconnect() {
  if (_reconnecting) return;
  _reconnecting = true;
  portState.set('idle');

  for (let attempt = 1; attempt <= 12; attempt++) {
    if (!_wantMonitor) break;
    try {
      const ports = await navigator.serial.getPorts();
      if (!ports.length) {
        emitRaw(`[USB] Tiada port tersedia... (${attempt}/12)`, 'rx');
        await delay(1000);
        continue;
      }
      _port = ports[0];

      // Pastikan port tertutup — jangan assume state
      try { await _port.close(); } catch {}
      await delay(300);

      await _port.open({ baudRate: BAUD, bufferSize: BUF_SIZE });
      _reader  = _port.readable.getReader();
      _running = true;
      connected.set(true);
      portState.set('monitor');
      emitRaw(`[USB] Sambungan dipulihkan ✓ (percubaan ${attempt})`, 'rx');
      console.log('[serial] reconnect berjaya (attempt', attempt, ')');
      _reconnecting = false;
      resetWatchdog();
      readLoop();
      return;
    } catch (e) {
      console.warn(`[serial] reconnect ${attempt} gagal:`, e.message);
      await delay(Math.min(1000 * attempt, 5000));   // backoff
    }
  }

  _reconnecting = false;
  _wantMonitor  = false;
  _port = null;
  emitRaw('[SISTEM] Reconnect gagal — klik ⚡ Sambung semula', 'rx');
  portState.set('idle');
}

// ── API awam ───────────────────────────────────────────────────

export async function connect() {
  if (!navigator.serial) {
    alert('Web Serial API tidak disokong. Sila guna Chrome atau Edge.');
    return false;
  }

  // Bersihkan sambungan lama dulu
  if (_running || _port) {
    await _closeAll();
    _port = null;
    await delay(200);
  }

  try {
    _port = await navigator.serial.requestPort();
    await _port.open({ baudRate: BAUD, bufferSize: BUF_SIZE });

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
    _port = null;
    throw e;
  }
}

export async function disconnect() {
  _wantMonitor = false;
  await _closeAll();
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
  await _closeAll();
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
    await _port.open({ baudRate: BAUD, bufferSize: BUF_SIZE });
    _reader      = _port.readable.getReader();
    _running     = true;
    _wantMonitor = true;
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
