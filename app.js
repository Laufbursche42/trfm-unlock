// TR Unlock - a Web Bluetooth port of the Laufbursche Edition BLE core.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Scope: scan, reconnect, lock/unlock, wheel diameter + cruise (persisted, restored on unlock).
// The protocol (CRC-8, 0x18 settings frame, 0x1f identity, 55 71 parse) is ported 1:1 from the
// native lb-edition (CommandBuilder.java / SettingsState.java / FrameParser.java). No firmware flash.
//
// Runs in a Web Bluetooth browser: Bluefy on iOS, Chrome on Android/desktop. Safari has no BLE.

'use strict';

const BUILD = 'v6';   // logged on load so a tester's log reveals which deployed build is running

// ─────────────────────────── BLE transport constants ───────────────────────────

// Only real scooters: the BLE name is the FIN - "TDE..." when locked, "T1..." when unlocked. The old
// broad 'T' matched any T-named device (TVs, phones), so the chooser and auto-reconnect could target
// non-scooters. These strict prefixes keep the picker (and getDevices) to actual scooters only.
const NAME_PREFIXES = ['TDE', 'T1'];

// Candidate GATT services the Teverun BLE module exposes. The ISSC (Microchip) Transparent-UART
// service is the usual one; the 0000FFxx family is the fallback. Web Bluetooth needs every service
// we touch listed here up front (optionalServices).
const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const ISSC_NOTIFY  = '49535343-1e4d-4bd9-ba61-23c647249616';
const ISSC_WRITE   = '49535343-aca3-481c-91ec-d85e28a60318';
// Web Bluetooth can only touch services declared up front (the one hard constraint). Cheap BLE-UART
// modules use 16-bit UUIDs in the vendor/member ranges 0xFCxx-0xFFxx (HM-10 0xFFE0, member 0xFExx,
// ISSC alternates, ...), so declare the WHOLE 0xFC00-0xFFFF range plus the known 128-bit UARTs (ISSC,
// Nordic). That covers almost every module WITHOUT knowing its exact UUID - and makes the real service
// appear in getPrimaryServices() and the log, so a new module is identified from a log line, not by hand.
const VENDOR_16BIT = [];
for (const base of ['fc', 'fd', 'fe', 'ff'])
  for (let i = 0; i < 256; i++)
    VENDOR_16BIT.push('0000' + base + i.toString(16).padStart(2, '0') + '-0000-1000-8000-00805f9b34fb');
const NORDIC_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';   // Nordic UART - a common non-ISSC/FF BLE-UART module
const OPTIONAL_SERVICES = [ISSC_SERVICE, NORDIC_SERVICE, ...VENDOR_16BIT];

const CONNECT_CODE_INTERVAL_MS = 6500;
const WRITE_GAP_MS = 200;         // match the native app's ~200 ms spacing (gentler on the BLE module)
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 20000;

// ─────────────────────────── CRC-8 (poly 0x07) - exact port ───────────────────────────

function crc8(data, len) {
  let crc = 0;
  for (let i = 0; i < len; i++) {
    crc ^= (data[i] & 0xFF);
    for (let n = 8; n > 0; n--) {
      crc = ((crc & 0x80) !== 0) ? (((crc << 1) ^ 0x07) & 0x1FF) : ((crc << 1) & 0x1FF);
    }
    crc &= 0xFF;
  }
  return crc & 0xFF;
}

// ─────────────────────────── bit helpers ───────────────────────────

function bytesToInt(bits) {           // LSB-first: index 0 = bit0
  let v = 0;
  for (let i = 0; i < bits.length; i++) if ((bits[i] & 1) !== 0) v |= (1 << i);
  return v & 0xFF;
}
function bytesToInt2(bits) {          // MSB-first: index 0 = most-significant bit
  let v = 0;
  const n = bits.length;
  for (let i = 0; i < n; i++) if ((bits[i] & 1) !== 0) v |= (1 << (n - 1 - i));
  return v & 0xFF;
}
function nibbles(high, low) {
  const b = new Array(8).fill(0);
  for (let k = 0; k < 4; k++) b[k] = (high >> (3 - k)) & 1;
  for (let k = 0; k < 4; k++) b[4 + k] = (low >> (3 - k)) & 1;
  return b;
}
function applyCruise(bits, cruise) {  // 2 (manual) -> bit2; 1 (auto) -> bit0 & bit1; else none
  if (cruise === 2) bits[2] = 1;
  else if (cruise === 1) { bits[0] = 1; bits[1] = 1; }
}
function voltCode(packVolt) {
  switch (packVolt) {
    case 36: return 30; case 48: return 39; case 52: return 42;
    case 60: return 48; case 72: return 60; case 84: return 69;
    default: return packVolt & 0xFF;
  }
}

// ─────────────────────────── frame assembly ───────────────────────────

function finalizeFrame(a19) {
  const out = new Uint8Array(20);
  for (let i = 0; i < 19; i++) out[i] = a19[i] & 0xFF;
  out[19] = crc8(a19, 19);
  return out;
}
function base(cmdId) {
  const a = new Array(19).fill(0xFF);
  a[0] = 170;            // 0xAA
  a[1] = cmdId & 0xFF;
  return a;
}
function sendConnectCode(e) {          // handshake / keep-alive: AA 01 10 <e> FF..FF CRC
  const a = base(1);
  a[2] = 0x10;
  a[3] = e & 0xFF;
  return finalizeFrame(a);
}
function setDeviceName(name) {         // cmd 0x1f: set VCU identity / BLE name (16 ASCII, space-padded)
  const a = base(0x1F);
  const s = (name == null ? '' : String(name));
  for (let i = 0; i < 16; i++) {
    const c = i < s.length ? s.charCodeAt(i) : 0x20;
    a[2 + i] = (c >= 0 && c <= 0x7F) ? (c & 0xFF) : 0x20;   // ASCII only, space-pad the rest
  }
  return finalizeFrame(a);
}

// ─────────────────────────── settings state (mirrors SettingsState.java) ───────────────────────────

const S = {
  gear: 1, wheel: 8.5, sysProTemp: 80, motorPolePairs: 15,
  assistSpeedLimit: 25, speedLimit: 25, fCurrent: 0, rCurrent: 0, packVolt: 60,
  enfEcon: false, isUnitMile: false, atMode: false, isSmart: false,
  cruise: 0, abs: false, startMode: false,
  fStartLevel: 0, rStartLevel: 0, eabsLevel: 0, sleepTime: 0, prTime: 0,
  rmStatus: 1, doubleMotor: 1,
  received71: false,
};

function updateFrom71(t) {
  S.gear = t[3] & 0xFF;
  const r = t[4] & 0xFF;                       // rControlStatus (LSB-first)
  const b1 = (r >> 1) & 1, b2 = (r >> 2) & 1;
  S.cruise = (b2 << 1) | b1;                   // (bit2<<1)|bit1
  S.abs = ((r >> 3) & 1) !== 0;
  S.startMode = ((r >> 6) & 1) !== 0;
  S.motorPolePairs = t[5] & 0xFF;
  S.wheel = (t[6] & 0xFF) * 0.1;
  S.sysProTemp = t[7] & 0xFF;
  S.fStartLevel = t[8] & 0x0F;
  S.eabsLevel = (t[9] >> 4) & 0x0F;
  S.rStartLevel = t[9] & 0x0F;
  S.assistSpeedLimit = t[10] & 0xFF;
  S.speedLimit = t[11] & 0xFF;
  S.fCurrent = t[12] & 0xFF;
  S.rCurrent = t[13] & 0xFF;
  S.packVolt = t[15] & 0xFF;
  const sys = t[17] & 0xFF;
  S.enfEcon = (sys & 0x01) !== 0;
  S.isUnitMile = (sys & 0x02) !== 0;
  S.atMode = (sys & 0x04) !== 0;
  S.isSmart = (sys & 0x10) !== 0;
  const sp = t[18] & 0xFF;
  S.sleepTime = sp & 0x07;
  S.prTime = (sp >> 3) & 0x1F;
  S.received71 = true;
}

// Full 0x18 settings frame. All shared config comes from S; per-gear bytes from the args. Mirrors
// CommandBuilder.buildSettingFrame - the whole state is serialised, so only call after received71.
function buildSettingFrame(n, gearByte, eabsLevel, fStartLevel, rStartLevel, perGearSpeed, fCurrent, rCurrent) {
  const a = new Array(19).fill(0xFF);
  a[0] = 170; a[1] = 24; a[2] = n & 0xFF; a[3] = gearByte & 0xFF;
  const s4 = new Array(8).fill(0);
  applyCruise(s4, S.cruise); s4[3] = S.abs ? 1 : 0; s4[6] = S.startMode ? 1 : 0; s4[7] = S.rmStatus & 1;
  a[4] = bytesToInt(s4);
  a[5] = S.motorPolePairs & 0xFF;
  a[6] = Math.round(S.wheel * 10.0) & 0xFF;
  a[7] = S.sysProTemp & 0xFF;
  a[8] = bytesToInt2(nibbles(eabsLevel, fStartLevel));
  a[9] = bytesToInt2(nibbles(eabsLevel, rStartLevel));
  a[10] = perGearSpeed & 0xFF;
  a[11] = S.speedLimit & 0xFF;
  a[12] = fCurrent & 0xFF;
  a[13] = rCurrent & 0xFF;
  a[14] = voltCode(S.packVolt);
  a[15] = S.packVolt & 0xFF;
  const d = new Array(8).fill(0);
  d[0] = S.enfEcon ? 1 : 0; d[1] = S.isUnitMile ? 1 : 0; d[2] = S.atMode ? 1 : 0; d[4] = S.isSmart ? 1 : 0;
  a[16] = bytesToInt(d);
  const s17 = new Array(8).fill(0);
  applyCruise(s17, S.cruise); s17[3] = S.abs ? 1 : 0; s17[6] = S.startMode ? 1 : 0; s17[7] = S.doubleMotor & 1;
  a[17] = bytesToInt(s17);
  a[18] = ((S.prTime & 0x1F) << 3) | (S.sleepTime & 0x07);
  return finalizeFrame(a);
}

// Generic full write, mode 2, r=1 - exactly the original app's sendSetting() default.
function sendSettingCode() {
  return buildSettingFrame(2, 1, S.eabsLevel, S.fStartLevel, S.rStartLevel,
                           S.assistSpeedLimit, S.fCurrent, S.rCurrent);
}

// Write the current settings into EVERY gear slot. The wheel diameter is global to the rider, but the
// VCU stores it per gear: a mode-2 (a[2]=2) frame is memcpy'd into config slot ARR[a[3]], so writing
// only one gear leaves the other slots with a stale wheel - and the live speed uses the ACTIVE gear's
// slot, so the same scooter reads a different speed per gear. Push the frame (which carries the wheel
// in a[6]) to every gear 0..5, current gear LAST so the runtime that the VCU re-applies after each
// write settles on the gear the rider is actually on.
function enqueueAllGears() {
  const cur = S.gear & 0xFF;
  const frame = (g) => buildSettingFrame(2, g, S.eabsLevel, S.fStartLevel, S.rStartLevel,
                                         S.assistSpeedLimit, S.fCurrent, S.rCurrent);
  for (let g = 0; g <= 5; g++) if (g !== cur) enqueue(frame(g));
  enqueue(frame(cur));
}

// ─────────────────────────── telemetry parse (subset of FrameParser.java) ───────────────────────────

const T = { speed: 0, soc: 0, gear: 0, speedRaw: 0, volt: 0, frameNum: '', fin: '' };

function u16(t, i) { return ((t[i] & 0xFF) << 8) | (t[i + 1] & 0xFF); }

// Frame reassembly: a BLE notification is not guaranteed to carry exactly one 20-byte frame (it can
// be fragmented or batched), so we buffer the bytes and pull out every 20-byte frame that starts
// with 0x55 and has a valid CRC. The old code assumed 20-byte-aligned notifications and, on a unit
// that fragments, parsed nothing at all - no telemetry, so the FIN only appeared on disconnect.
let rxBuf = new Uint8Array(0);
let diagNotify = 0;
let diagParsed = false;

function onNotify(value) {                       // value: DataView
  const len = value.byteLength;
  if (diagNotify < 3) {                          // log the first raw notifications for diagnosis
    diagNotify++;
    let h = '';
    for (let i = 0; i < Math.min(len, 12); i++) h += value.getUint8(i).toString(16).padStart(2, '0') + ' ';
    log('rx ' + len + 'B: ' + h.trim());
  }
  const merged = new Uint8Array(rxBuf.length + len);
  merged.set(rxBuf, 0);
  for (let i = 0; i < len; i++) merged[rxBuf.length + i] = value.getUint8(i);
  let pos = 0;
  while (pos + 20 <= merged.length) {
    if (merged[pos] !== 0x55) { pos++; continue; }            // resync to the 0x55 frame marker
    const t = new Array(20);
    for (let i = 0; i < 20; i++) t[i] = merged[pos + i];
    if (crc8(t, 19) !== (t[19] & 0xFF)) { pos++; continue; }  // not a valid frame - skip one byte
    dispatch(t);
    pos += 20;
  }
  rxBuf = merged.slice(pos);                     // keep the unconsumed tail for the next notification
  if (rxBuf.length > 200) rxBuf = rxBuf.slice(rxBuf.length - 40);
}

function dispatch(t) {
  if (!diagParsed) { diagParsed = true; log('telemetry ok - first frame 0x' + (t[1] & 0xFF).toString(16)); }
  if (!linkConfirmed) {          // first real frame proves the device is truly here -> now "connected"
    linkConfirmed = true;
    if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
    setStatus('connected');
    maybeRunDeepAction();
  }
  switch (t[1]) {
    case 0x71:
      updateFrom71(t);
      T.gear = t[3] & 0xFF;
      onSettingsFrame();
      maybeRunDeepAction();      // a shortcut's ?do=lock waits for this first 55 71
      break;
    case 0x72: {
      T.speedRaw = u16(t, 15);
      let v = 0;
      if (T.speedRaw > 0) v = 287.0 * S.wheel / T.speedRaw;
      if (T.speedRaw >= 3000 || v <= 0.5) v = 0;
      if (S.isUnitMile) v = v / 1.6093439;
      T.speed = v;
      break;
    }
    case 0x52: T.volt = u16(t, 2) * 0.1; T.soc = t[8] & 0xFF; break;
    case 0x42: T.frameNum = ascii(t, 2, 18); updateFin(); break;
    default: break;
  }
  renderLive();
}

function ascii(t, from, toInc) {
  let s = '';
  for (let i = from; i <= toInc && i < 20; i++) {
    const c = t[i] & 0xFF;
    if (c >= 0x20 && c <= 0x7E) s += String.fromCharCode(c);
  }
  return s.trim();
}
function updateFin() { T.fin = ((deviceName || '') + (T.frameNum || '')).trim(); }

// ─────────────────────────── BLE connection ───────────────────────────

let device = null, server = null, notifyChar = null, writeChar = null;
let notifyReady = false, connected = false, userDisconnect = false;
let deviceName = '';
let reconnectDelay = RECONNECT_BASE_MS;
let keepAliveTimer = null;
let linkConfirmed = false, linkTimer = null;   // "connected" is shown only once real telemetry arrives

async function pickAndConnect() {
  if (!navigator.bluetooth) { log('Web Bluetooth not available - use Bluefy (iOS) or Chrome.'); return; }
  try {
    userDisconnect = false;
    log('scanning...');
    device = await navigator.bluetooth.requestDevice({
      filters: NAME_PREFIXES.map(p => ({ namePrefix: p })),
      optionalServices: OPTIONAL_SERVICES,
    });
    deviceName = device.name || '';
    updateFin();
    device.addEventListener('gattserverdisconnected', onDisconnected);
    log('selected: ' + deviceName + ' [' + device.id + ']');
    finField.value = deviceName;
    await connectGatt();
  } catch (e) {
    log('scan/connect cancelled: ' + e);
  }
}

async function connectGatt() {
  setStatus('connecting');
  notifyReady = false; connected = false;
  rxBuf = new Uint8Array(0); diagNotify = 0; diagParsed = false;   // fresh frame buffer + diagnostics
  server = await device.gatt.connect();
  const svc = await pickService(server);
  if (!svc) { setStatus('no-service'); log('no matching GATT service'); return; }
  await pickCharacteristics(svc);
  if (!notifyChar || !writeChar) { setStatus('no-char'); log('notify/write characteristic missing'); return; }
  await notifyChar.startNotifications();
  notifyChar.addEventListener('characteristicvaluechanged', ev => {
    try { onNotify(ev.target.value); } catch (e) {}
  });
  notifyReady = true; connected = true; linkConfirmed = false;
  reconnectDelay = RECONNECT_BASE_MS;
  // The GATT link is up, but iOS reports success even for a bonded device that is far out of range
  // (a phantom link). Do NOT show "connected" yet - wait for REAL telemetry (see dispatch). The
  // keep-alive below asks the scooter to stream; if nothing arrives in time it was a phantom.
  setStatus('linking');
  refreshFinField();
  renderLive();                  // show the FIN + tiles from the BLE name
  try { if (device && device.id) localStorage.setItem(LS_DEVICE, device.id); } catch (e) {}
  log('link up, waiting for data. notify=' + notifyChar.uuid.slice(0, 8) + ' write=' + writeChar.uuid.slice(0, 8));
  startKeepAlive();
  if (linkTimer) clearTimeout(linkTimer);
  linkTimer = setTimeout(() => {
    if (!linkConfirmed && connected) {
      log('no data - device not responding (out of range?), disconnecting');
      userDisconnect = true;
      try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch (e) {}
      connected = false; notifyReady = false;
      setStatus('no-data');
      resetTiles(); refreshFinField(); refreshSettingsInputs();
    }
  }, 6000);
}

// The common ISSC/FF services to fetch directly when enumeration is unavailable (Bluefy).
const COMMON_SERVICES = [ISSC_SERVICE, NORDIC_SERVICE,
  '0000ffe0-0000-1000-8000-00805f9b34fb', '0000ffe1-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe5-0000-1000-8000-00805f9b34fb', '0000fff6-0000-1000-8000-00805f9b34fb',
  '0000ffb0-0000-1000-8000-00805f9b34fb', '0000fee0-0000-1000-8000-00805f9b34fb'];

async function pickService(srv) {
  const isMatch = u => u.startsWith('495353') || u.startsWith('6e400001') || /^0000f[c-f]/.test(u) || /^f[c-f][0-9a-f]{2}$/.test(u);
  async function direct(list) {
    const BATCH = 16;   // fetch in parallel batches so scanning the whole range stays fast
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      const rs = await Promise.allSettled(batch.map(u => srv.getPrimaryService(u)));
      for (let j = 0; j < rs.length; j++) {
        if (rs[j].status === 'fulfilled' && rs[j].value) { log('service (direct): ' + batch[j].slice(0, 8)); return rs[j].value; }
      }
    }
    return null;
  }
  // The native app waits ~1500 ms after connect before discovering services. In Web Bluetooth the
  // service list can likewise be empty right after connect (Bluefy), so try twice with a wait.
  for (let attempt = 0; attempt < 2; attempt++) {
    let services = [];
    try { services = await srv.getPrimaryServices(); } catch (e) { log('service enumerate failed: ' + e); }
    if (services.length) {
      log('services: ' + services.map(s => s.uuid.slice(0, 8)).join(', '));
      let chosen = null;
      for (const s of services) if (isMatch(s.uuid.toLowerCase())) chosen = s;   // last match wins (as native)
      if (chosen) return chosen;
    }
    // Direct fetch of the same ISSC/FF set the native app matches - works even when enumeration is empty.
    const d = await direct(COMMON_SERVICES);
    if (d) return d;
    if (attempt === 0) { log('no service yet - waiting for GATT discovery, retrying'); await sleep(1500); }
  }
  return await direct(VENDOR_16BIT);   // last resort: batched direct-fetch over the whole declared 0xFCxx-0xFFxx range
}

async function pickCharacteristics(svc) {
  notifyChar = null; writeChar = null;
  const u = svc.uuid.toLowerCase();
  if (u.startsWith('495353')) {
    try { notifyChar = await svc.getCharacteristic(ISSC_NOTIFY); } catch (e) {}
    try { writeChar  = await svc.getCharacteristic(ISSC_WRITE); } catch (e) {}
    if (notifyChar && writeChar) return;
  }
  let chars = [];
  try { chars = await svc.getCharacteristics(); } catch (e) { log('char enumerate failed: ' + e); }
  log('chars on ' + svc.uuid.slice(0, 8) + ': ' + chars.map(c => c.uuid.slice(0, 8)).join(', '));
  let anyWritable = null;
  for (const c of chars) {                       // last notify / last write-only wins (as native)
    const p = c.properties;
    if (p.notify) notifyChar = c;
    else if (p.write) writeChar = c;
    if (p.write || p.writeWithoutResponse) anyWritable = c;
  }
  if (!writeChar) writeChar = anyWritable;
}

function onDisconnected() {
  connected = false; notifyReady = false; linkConfirmed = false;
  if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
  stopKeepAlive();
  setStatus('disconnected');
  resetTiles();
  refreshFinField();
  refreshSettingsInputs();
  log('link dropped' + (userDisconnect ? ' (by user)' : ''));
  if (!userDisconnect && device) {
    if (pendingRestore) restoreArmed = true;     // a rename-triggered drop: arm the settings restore
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    log('reconnecting in ' + delay + ' ms');
    setTimeout(() => { if (!userDisconnect) reconnect(); }, delay);
  }
}

async function reconnect() {
  try { await connectGatt(); }
  catch (e) { log('reconnect failed: ' + e); if (!userDisconnect) setTimeout(reconnect, reconnectDelay); }
}

function disconnectBle() {
  userDisconnect = true;
  linkConfirmed = false;
  if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
  stopKeepAlive();
  try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch (e) {}
  connected = false; notifyReady = false;
  setStatus('disconnected');
  resetTiles();
  refreshFinField();
  refreshSettingsInputs();
}

// ─────────────────────────── keep-alive + write queue ───────────────────────────

function startKeepAlive() {
  stopKeepAlive();
  const tick = () => {
    if (!notifyReady) return;
    enqueue(sendConnectCode(0));
    keepAliveTimer = setTimeout(tick, CONNECT_CODE_INTERVAL_MS);
  };
  tick();
}
function stopKeepAlive() { if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; } }

const writeQueue = [];
let writing = false;
function enqueue(frame) { writeQueue.push(frame); drain(); }
async function drain() {
  if (writing || !notifyReady) return;
  writing = true;
  while (writeQueue.length) {
    const f = writeQueue.shift();
    try { await doWrite(f); } catch (e) { log('write error: ' + e); }
    await sleep(WRITE_GAP_MS);
  }
  writing = false;
}
async function doWrite(frame) {
  const wc = writeChar;
  if (!wc) throw 'no write characteristic';
  const buf = frame.buffer ? frame : Uint8Array.from(frame);
  if (wc.properties.write && wc.writeValueWithResponse) return wc.writeValueWithResponse(buf);
  if (wc.properties.writeWithoutResponse && wc.writeValueWithoutResponse) return wc.writeValueWithoutResponse(buf);
  return wc.writeValue(buf);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────── lock / unlock + wheel / cruise ───────────────────────────
//
// Wheel diameter + cruise are the ONLY user prefs we persist (localStorage). The scooter keeps
// neither: on lock the wheel is forced to 10 (eKFV), so the app is the sole place the real value
// survives. On unlock, after the rename-reconnect brings a fresh 55 71, we re-apply both.

const LS_WHEEL = 'tru_wheel', LS_CRUISE = 'tru_cruise', LS_DEVICE = 'tru_device';
let pendingRestore = false;     // set on unlock; consumed by the first 55 71 after the reconnect
let restoreArmed = false;       // set once the rename-drop actually happened

function savedWheel() { const v = parseFloat(localStorage.getItem(LS_WHEEL)); return isNaN(v) ? null : v; }
function savedCruise() { const v = parseInt(localStorage.getItem(LS_CRUISE), 10); return isNaN(v) ? null : v; }

function persistWheel(v) { localStorage.setItem(LS_WHEEL, String(v)); }
function persistCruise(v) { localStorage.setItem(LS_CRUISE, String(v)); }

// User sets the wheel diameter (open mode). Save it, then write the full 0x18 with the new wheel.
function setWheel(v) {
  if (!requireReady()) return;
  S.wheel = v;
  persistWheel(v);
  enqueueAllGears();
  log('wheel set to ' + v + ' (saved, all gears)');
}

// User sets cruise: 0 off, 1 auto, 2 manual. Save it, then write the full 0x18.
function setCruise(v) {
  if (!requireReady()) return;
  S.cruise = v;
  persistCruise(v);
  enqueue(sendSettingCode());
  log('cruise set to ' + v + ' (saved)');
}

function unlock() {
  if (!connected) { log('connect first'); return; }
  const fin = (finField.value || deviceName || '').trim();
  if (!fin.startsWith('TDE')) { log('already unlocked (FIN not TDE...)'); }
  const open = fin.startsWith('TDE') ? ('T' + fin.slice(3)) : fin;   // drop "DE"
  log('unlock -> FIN ' + open);
  enqueue(setDeviceName(open));
  // Arm the wheel + cruise restore for the fresh 55 71 after the rename-reconnect.
  pendingRestore = true; restoreArmed = false;
  deviceName = open; finField.value = open; updateFin();
  refreshToggle();
}

function lock() {
  if (!requireReady()) return;
  const fin = (finField.value || deviceName || '').trim();
  const locked = fin.startsWith('TDE') ? fin : ('TDE' + fin.slice(1));   // add "DE"
  // Remember the current wheel + cruise so a later unlock restores exactly them.
  persistWheel(S.wheel);
  persistCruise(S.cruise);
  // eKFV: force wheel to 10 and turn cruise off. Written while still open (before the rename), so
  // the controller accepts it, then lock via the FIN.
  S.wheel = 10;
  S.cruise = 0;
  enqueueAllGears();
  log('lock: wheel 10, cruise off, FIN -> ' + locked);
  enqueue(setDeviceName(locked));
  pendingRestore = false; restoreArmed = false;
  deviceName = locked; finField.value = locked; updateFin();
  refreshToggle();
}

// Called on every 55 71. When a restore is armed (unlock happened, link dropped and came back),
// re-apply the saved wheel + cruise once, exactly like the native maybeRestoreFinSettings.
function onSettingsFrame() {
  if (pendingRestore && restoreArmed && S.received71) {
    const w = savedWheel(), c = savedCruise();
    if (w != null) S.wheel = w;
    if (c != null) S.cruise = c;
    enqueueAllGears();
    log('restored after unlock: wheel=' + (w != null ? w : '-') + ' cruise=' + (c != null ? c : '-') + ' (all gears)');
    pendingRestore = false; restoreArmed = false;
  }
}

function requireReady() {
  if (!connected) { log('connect first'); return false; }
  if (!S.received71) { log('waiting for telemetry (55 71) before writing settings'); return false; }
  return true;
}

// ─────────────────────────── shortcut deep-link + auto-reconnect ───────────────────────────
//
// A home-screen shortcut (iOS Shortcuts / Android home-screen icon) opens the page with ?do=lock or
// ?do=unlock. On load we reconnect to the last granted scooter via getDevices() - no chooser, works
// in Bluefy (iOS) and Chrome - then run the action once connected. getDevices()/auto-connect need no
// fresh picker, but the scooter must be on and in range; otherwise the user just taps Connect.

let pendingDeepAction = null;     // 'lock' | 'unlock' parsed from the URL, run once after connect

function parseDeepLink() {
  try {
    let a = (new URLSearchParams(location.search).get('do') || '').toLowerCase();
    if (!a && location.hash) a = (new URLSearchParams(location.hash.replace(/^#/, '')).get('do') || '').toLowerCase();
    if (a === 'lock' || a === 'unlock') { pendingDeepAction = a; log('shortcut: ' + a + ' requested'); }
  } catch (e) {}
}

function maybeRunDeepAction() {
  if (!pendingDeepAction || !connected) return;
  if (pendingDeepAction === 'unlock') {
    if (!deviceName) return;                 // need the FIN / BLE name first
    pendingDeepAction = null;
    log('shortcut: auto-unlock');
    unlock();
  } else if (pendingDeepAction === 'lock') {
    if (!S.received71) return;               // lock needs a 55 71 first
    pendingDeepAction = null;
    log('shortcut: auto-lock');
    lock();
  }
}

// Reconnect to a previously paired scooter without showing the chooser (Web Bluetooth getDevices()).
// A first-time visitor has nothing granted yet, so nothing happens and the user taps Connect.
async function tryAutoReconnect() {
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return;
  try {
    const devs = await navigator.bluetooth.getDevices();
    if (!devs || !devs.length) return;
    const savedId = localStorage.getItem(LS_DEVICE);
    const dev = (savedId && devs.find(d => d.id === savedId))
             || devs.find(d => (d.name || '') && NAME_PREFIXES.some(p => d.name.startsWith(p)))
             || null;
    if (!dev) return;
    device = dev;
    deviceName = device.name || '';
    updateFin();
    device.addEventListener('gattserverdisconnected', onDisconnected);
    if (finField) finField.value = deviceName;
    userDisconnect = false;
    log('auto-reconnect: ' + (deviceName || device.id));
    await connectGatt();
  } catch (e) {
    setStatus('disconnected');
    log('auto-reconnect skipped: ' + e);
  }
}

// ─────────────────────────── UI ───────────────────────────

let finField;
function $(id) { return document.getElementById(id); }
function setStatus(s) { const el = $('status'); if (el) { el.textContent = s; el.dataset.state = s; } }
function log(m) {
  const el = $('log'); if (!el) return;
  el.textContent = ('[' + new Date().toLocaleTimeString() + '] ' + m + '\n') + el.textContent;
}
// The single lock/unlock control reflects the current state: "Unlock" when the scooter is locked
// (FIN starts with TDE), "Lock" when it is open. Driven by the live FIN, refreshed on every frame.
function refreshToggle() {
  const btn = $('btn-toggle');
  if (!btn) return;
  const fin = ((finField && finField.value) || deviceName || '').trim();
  const locked = fin.startsWith('TDE');
  btn.textContent = locked ? 'Unlock' : 'Lock';
  btn.dataset.action = locked ? 'unlock' : 'lock';
  btn.disabled = !linkConfirmed;   // only actionable once a real telemetry frame confirmed the link
}
function renderLive() {
  $('t-wheel').textContent = S.received71 ? S.wheel.toFixed(1) : '-';
  $('t-cruise').textContent = S.received71 ? ['Off', 'Auto', 'Manual'][S.cruise] || S.cruise : '-';
  $('t-fin').textContent = T.fin || deviceName || '-';
  refreshSettingsInputs();
  refreshToggle();
}
function resetTiles() {                                 // no telemetry -> show "-"
  $('t-wheel').textContent = '-';
  $('t-cruise').textContent = '-';
  $('t-fin').textContent = deviceName || '-';
  refreshToggle();
}
// The FIN field is editable only once a FIN was actually read from the scooter.
function refreshFinField() {
  if (finField) finField.disabled = !(connected && deviceName);
}
// Wheel + cruise: editable only once the scooter reported its config (55 71). Prefilled ONCE with
// the value the scooter delivers; after that the user edits freely (no per-frame overwrite).
let settingsPrefilled = false;
function refreshSettingsInputs() {
  const ready = connected && S.received71;
  const win = $('wheel-in'), cin = $('cruise-in'), bw = $('btn-set-wheel'), bc = $('btn-set-cruise');
  [win, cin, bw, bc].forEach(el => { if (el) el.disabled = !ready; });
  if (ready && !settingsPrefilled) {
    if (win) win.value = S.wheel.toFixed(1);
    if (cin) cin.value = String(S.cruise);
    settingsPrefilled = true;
  } else if (!ready) {
    settingsPrefilled = false;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  finField = $('fin');
  log('tr-unlock build ' + BUILD);   // so a tester's log shows which deployed version they run
  $('btn-connect').addEventListener('click', pickAndConnect);
  $('btn-disconnect').addEventListener('click', disconnectBle);
  $('btn-toggle').addEventListener('click', () => {
    if ($('btn-toggle').dataset.action === 'unlock') unlock(); else lock();
  });
  $('btn-set-wheel').addEventListener('click', () => {
    const v = parseFloat($('wheel-in').value);
    if (!isNaN(v) && v > 0) setWheel(v);
  });
  $('btn-set-cruise').addEventListener('click', () => setCruise(parseInt($('cruise-in').value, 10)));
  refreshSettingsInputs();   // start disabled; enabled + prefilled once a scooter reports its config
  if (!navigator.bluetooth) log('Web Bluetooth not available. On iOS use the Bluefy browser.');
  parseDeepLink();                              // read ?do=lock|unlock from a home-screen shortcut
  if (pendingDeepAction) tryAutoReconnect();    // only a shortcut auto-reconnects; a normal open uses the chooser
});
