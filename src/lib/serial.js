/**
 * serial.js — Web Serial manager untuk ESP32 + ADS1015
 * Format output: HALL4|adc1|dev1|led1|adc2|dev2|led2|adc3|dev3|led3|adc4|dev4|led4  @115200
 * S1=A0, S2=A1, S3=A2 (SS49E_1), S4=A3 (SS49E_2)
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
const RX_THR1 = /\[THRESH1\]\s*(\d+)\|(\d+)\|(\d+)\|(\d+)/;
const RX_THR2 = /\[THRESH2\]\s*(\d+)\|(\d+)\|(\d+)\|(\d+)/;
const RX_THR3 = /\[THRESH3\]\s*(\d+)\|(\d+)\|(\d+)\|(\d+)/;
const RX_THR4 = /\[THRESH4\]\s*(\d+)\|(\d+)\|(\d+)\|(\d+)/;
const RX_BASE = /\[(?:AUTO|CAL|INIT)\s*S(\d)\].*?(\d+)\s*$/;

// ── State ──────────────────────────────────────────────────────
let _port      = null;
let _reader    = null;
let _running   = false;
let _lineBuf   = '';
let _csvRows   = [];
let _logging   = false;
let _logCount  = 0;
let _wantMonitor   = false;   // adakah user mahu monitor aktif?
let _reconnecting  = false;   // cegah race condition reconnect berganda

isLogging.subscribe(v => { _logging = v; });

// ── Web Serial disconnect/connect events ───────────────────────
if (typeof navigator !== 'undefined' && navigator.serial) {
  navigator.serial.addEventListener('disconnect', (e) => {
    if (e.target === _port) {
      console.log('[serial] USB disconnect event');
      _running  = false;
      connected.set(false);
      emitRaw('[USB] Peranti terputus — menunggu sambungan semula...', 'rx');
      try { _reader?.releaseLock(); } catch {}
      _reader = null;
      // Port tidak sah lagi selepas USB disconnect
      _port = null;
    }
  });

  navigator.serial.addEventListener('connect', async (e) => {
    if (_wantMonitor && !_running && !_reconnecting) {
      console.log('[serial] USB connect event — reconnecting...');
      emitRaw('[USB] Peranti disambung semula — reconnecting...', 'rx');
      await delay(600);
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
    const v = [1,2,3,4,5,6,7,8,9,10,11,12].map(i => +m[i]);
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
    if (_logging) {
      _csvRows.push([new Date().toISOString().slice(11, 23), ...v].join(','));
      logCount.set(++_logCount);
    }
    return;
  }

  m = RX_THR1.exec(line);
  if (m) { const t = [1,2,3,4].map(i=>+m[i]); sensors.update(a=>{a[0]={...a[0],thresh:t};return a;}); return; }
  m = RX_THR2.exec(line);
  if (m) { const t = [1,2,3,4].map(i=>+m[i]); sensors.update(a=>{a[1]={...a[1],thresh:t};return a;}); return; }
  m = RX_THR3.exec(line);
  if (m) { const t = [1,2,3,4].map(i=>+m[i]); sensors.update(a=>{a[2]={...a[2],thresh:t};return a;}); return; }
  m = RX_THR4.exec(line);
  if (m) { const t = [1,2,3,4].map(i=>+m[i]); sensors.update(a=>{a[3]={...a[3],thresh:t};return a;}); return; }
  m = RX_BASE.exec(line);
  if (m) {
    const idx = +m[1] - 1, base = +m[2];
    sensors.update(a => { a[idx] = { ...a[idx], baseline: base }; return a; });
  }
}

// ── Read loop ──────────────────────────────────────────────────
async function readLoop() {
  const dec = new TextDecoder();
  _lineBuf = '';
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
      if (_running) console.warn('[serial] read error:', err.message);
      break;
    }
  }

  // Putus secara tidak sengaja (bukan oleh disconnect())
  if (_running && _wantMonitor && !_reconnecting) {
    _running = false;
    connected.set(false);
    emitRaw('[SISTEM] Sambungan hilang — tunggu USB...', 'rx');
    try { _reader?.releaseLock(); } catch {}
    _reader = null;
    // Jika port masih ada (bukan USB disconnect), cuba tutup & buka semula
    if (_port) {
      try { await _port.close(); } catch {}
      await delay(800);
      await _autoReconnect();
    }
    // Jika port tiada, tunggu 'connect' event dari navigator.serial
  }

  console.log('[serial] readLoop berhenti');
}

// ── Auto reconnect (guna getPorts untuk port yang sama) ────────
async function _autoReconnect() {
  if (_reconnecting) return;   // cegah panggilan berganda
  _reconnecting = true;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      // Guna getPorts() — tidak perlukan user gesture
      const ports = await navigator.serial.getPorts();
      if (!ports.length) {
        emitRaw(`[USB] Tiada port — tunggu... (${attempt}/10)`, 'rx');
        await delay(1000);
        continue;
      }
      _port = ports[0];

      // Pastikan port tertutup dulu
      try { await _port.close(); } catch {}
      await delay(200);

      await _port.open({ baudRate: 115200 });
      _reader  = _port.readable.getReader();
      _running = true;
      connected.set(true);
      portState.set('monitor');
      emitRaw('[USB] Sambungan dipulihkan ✓', 'rx');
      console.log('[serial] reconnect berjaya (attempt', attempt, ')');
      _reconnecting = false;
      readLoop();
      return;
    } catch (e) {
      console.warn(`[serial] reconnect ${attempt} gagal:`, e.message);
      await delay(1000);
    }
  }
  _reconnecting = false;
  emitRaw('[SISTEM] Reconnect gagal — klik ⚡ Sambung semula', 'rx');
  portState.set('idle');
  _port = null;
  _wantMonitor = false;
}

// ── API awam ───────────────────────────────────────────────────

export async function connect() {
  if (!navigator.serial) {
    alert('Web Serial API tidak disokong. Sila guna Chrome atau Edge.');
    return false;
  }
  try {
    _port = await navigator.serial.requestPort();
    console.log('[serial] port dipilih, membuka...');

    // Tutup dulu kalau masih open dari sesi lama
    if (_port.readable) {
      try { await _port.close(); } catch {}
      await delay(300);
    }

    await _port.open({ baudRate: 115200 });
    console.log('[serial] port dibuka');

    _reader      = _port.readable.getReader();
    _running     = true;
    _wantMonitor = true;
    connected.set(true);
    portState.set('monitor');
    readLoop();
    return true;
  } catch (e) {
    if (e.name !== 'NotFoundError') {
      console.error('[serial] gagal sambung:', e);
    }
    _port = null;
    throw e;
  }
}

export async function disconnect() {
  _wantMonitor = false;
  _running     = false;
  try { await _reader?.cancel(); }  catch {}
  try { _reader?.releaseLock(); }   catch {}
  _reader = null;
  await delay(150);
  try { await _port?.close(); }     catch {}
  _port = null;
  connected.set(false);
  portState.set('idle');
  _lineBuf = '';
}

export async function sendCmd(cmd) {
  if (!_port?.writable) return;
  const w = _port.writable.getWriter();
  try {
    await w.write(new TextEncoder().encode(cmd));
    emitRaw(`>> ${cmd}`, 'tx');
  } finally { w.releaseLock(); }
}

// ── Flash API ──────────────────────────────────────────────────
export async function prepareForFlash() {
  if (!navigator.serial) throw new Error('Web Serial API tidak disokong.');
  _wantMonitor = false;
  if (_running) {
    _running = false;
    try { await _reader?.cancel(); }  catch {}
    try { _reader?.releaseLock(); }   catch {}
    _reader = null;
    await delay(200);
    try { await _port?.close(); }     catch {}
    connected.set(false);
  } else if (!_port) {
    _port = await navigator.serial.requestPort();
  } else {
    try { await _port?.close(); }     catch {}
  }
  await delay(400);
  portState.set('flashing');
  return _port;
}

export async function resumeMonitor() {
  portState.set('idle');
  if (!_port) return;
  try {
    await delay(300);
    await _port.open({ baudRate: 115200 });
    _reader      = _port.readable.getReader();
    _running     = true;
    _wantMonitor = true;
    connected.set(true);
    portState.set('monitor');
    readLoop();
  } catch (e) {
    console.error('[resumeMonitor]', e.message);
    _port = null;
    portState.set('idle');
  }
}

export function forgetPort() {
  _port = null;
  _wantMonitor = false;
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
