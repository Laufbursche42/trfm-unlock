// TR Unlock: a Web Bluetooth port of the Laufbursche Edition BLE core.
// Copyright (c) 2026 Laufbursche (https://github.com/Laufbursche42)
// Scope: scan, reconnect, lock/unlock, wheel diameter + cruise (persisted, restored on unlock) and
// the transport for the firmware flasher in ota.js.
// The protocol (CRC-8, 0x18 settings frame, 55 71 parse) is ported 1:1 from the native lb-edition
// (CommandBuilder.java / SettingsState.java / FrameParser.java).
//
// Runs in a Web Bluetooth browser: Bluefy on iOS, Chrome on Android/desktop. Safari has no BLE.

'use strict';

const BUILD = 'v46';   // logged on load so a tester's log reveals which deployed build is running

// --------------------------- BLE transport constants ---------------------------

// Only real scooters: the BLE name is the FIN, "TDE..." when locked, "T1..." when unlocked. The old
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
// Nordic). That covers almost every module WITHOUT knowing its exact UUID. It also makes the real service
// appear in getPrimaryServices() and the log, so a new module is identified from a log line, not by hand.
const VENDOR_16BIT = [];
for (const base of ['fc', 'fd', 'fe', 'ff'])
  for (let i = 0; i < 256; i++)
    VENDOR_16BIT.push('0000' + base + i.toString(16).padStart(2, '0') + '-0000-1000-8000-00805f9b34fb');
const NORDIC_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';   // Nordic UART: a common non-ISSC/FF BLE-UART module
const OPTIONAL_SERVICES = [ISSC_SERVICE, NORDIC_SERVICE, ...VENDOR_16BIT];

const CONNECT_CODE_INTERVAL_MS = 6500;
const WRITE_GAP_MS = 200;         // match the native app's ~200 ms spacing (gentler on the BLE module)
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 20000;
const LINK_TIMEOUT_MS = 6000;     // how long a fresh link may stay silent before it is reported

// --------------------------- CRC-8 (poly 0x07), exact port ---------------------------

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

// --------------------------- bit helpers ---------------------------

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

// --------------------------- frame assembly ---------------------------

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
function connectCode(e) {          // handshake / keep-alive: AA 01 10 <e> FF..FF CRC
  const a = base(1);
  a[2] = 0x10;
  a[3] = e & 0xFF;
  return finalizeFrame(a);
}
// cmd 0x1B: BLE speed lock/unlock (TESTLOCK firmware). AA 1B <val> 00*16 CRC. val 1 = UNLOCK, 0 = LOCK.
// Zero-padded (NOT 0xFF): the firmware handler reads only the value byte, rest must be 0.
function setLockState(unlocked) {
  const a = new Array(19).fill(0);
  a[0] = 170;               // 0xAA
  a[1] = 0x1B;
  a[2] = unlocked ? 1 : 0;
  return finalizeFrame(a);
}

// --------------------------- settings state (mirrors SettingsState.java) ---------------------------

const S = {
  gear: 1, wheel: 8.5, sysProTemp: 80, motorPolePairs: 15,
  assistSpeedLimit: 25, speedLimit: 25, fCurrent: 0, rCurrent: 0, packVolt: 60,
  enfEcon: false, isUnitMile: false, atMode: false, isSmart: false,
  cruise: 0, abs: false, startMode: false,
  fStartLevel: 0, rStartLevel: 0, eabsLevel: 0, sleepTime: 0, prTime: 0,
  rmStatus: 1, doubleMotor: 1,
  received71: false,
};

// Per-gear cache: each gear's OWN speed/current/assist, filled from 55 71 telemetry, so we can write
// wheel + cruise into every gear WITHOUT disturbing that gear's other per-gear settings.
const gearCache = {};

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
  gearCache[S.gear] = { assistSpeedLimit: S.assistSpeedLimit, fCurrent: S.fCurrent, rCurrent: S.rCurrent,
                        eabsLevel: S.eabsLevel, fStartLevel: S.fStartLevel, rStartLevel: S.rStartLevel };
}

// Full 0x18 settings frame. All shared config comes from S; per-gear bytes from the args. Mirrors
// CommandBuilder.buildSettingFrame: the whole state is serialised, so only call after received71.
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

// Wheel + cruise are GLOBAL in the firmware (a single 0x2000029D wheel byte / 0x200002D1 cruise byte),
// so ONE 0x18 write for the active gear sets them for every gear. Writing all gears was legacy (built
// when we assumed per-gear wheel); its multi-frame burst could starve the display 0x4c link long enough
// that the VCU flags the display as gone (0x20000306) and the next display frame trips the power-on
// boot-lock: a false LOCK on a settings write. One write also never touches another gear's values.
function writeWheelCruiseAllGears() {
  const cur = S.gear & 0xFF;
  enqueue(buildSettingFrame(2, cur, S.eabsLevel, S.fStartLevel, S.rStartLevel,
                            S.assistSpeedLimit, S.fCurrent, S.rCurrent));
}

// --------------------------- telemetry parse (subset of FrameParser.java) ---------------------------

const T = { speed: 0, soc: 0, gear: 0, speedRaw: 0, volt: 0, frameNum: '', fin: '', lock: null };

function u16(t, i) { return ((t[i] & 0xFF) << 8) | (t[i + 1] & 0xFF); }

// Frame reassembly: a BLE notification is not guaranteed to carry exactly one 20-byte frame (it can
// be fragmented or batched), so we buffer the bytes and pull out every 20-byte frame that starts
// with 0x55 and has a valid CRC. The old code assumed 20-byte-aligned notifications and, on a unit
// that fragments, parsed nothing at all: no telemetry, so the FIN only appeared on disconnect.
let rxBuf = new Uint8Array(0);
let diagNotify = 0;
let diagParsed = false;

// One OTA answer per notification, checked exactly the way ota.js checks it: header 0xCC plus the
// CRC-8 over the ten bytes behind it. Sharing that test means this can never accept a frame the
// engine rejects or reject one it would have accepted.
function isOtaResponse(u) {
  return u.length >= 12 && u[0] === 0xCC && crc8(u.subarray(1, 11), 10) === (u[11] & 0xFF);
}

function onNotify(value) {                       // value: DataView
  const len = value.byteLength;
  const u = new Uint8Array(len);
  for (let i = 0; i < len; i++) u[i] = value.getUint8(i);
  const otaResp = isOtaResponse(u);
  if (otaResp) confirmLink();                    // an answer from the controller proves the link
  // A running flash owns the link: the engine gets the raw notification, exactly as the native app
  // and lbtool.py hand it over. A garbled answer has to reach it too, its 100 ms nudge is the
  // recovery path for one.
  if (otaEngine) { otaEngine.onNotify(u); return; }
  // A scooter waiting in update mode streams no telemetry, it only answers on the OTA path, so an
  // OTA answer is the only link proof it can give (see the phantom-link timer in connectGatt).
  if (otaResp) return;
  if (diagNotify < 3) {                          // log the first raw notifications for diagnosis
    diagNotify++;
    let h = '';
    for (let i = 0; i < Math.min(len, 12); i++) h += u[i].toString(16).padStart(2, '0') + ' ';
    log('rx ' + len + 'B: ' + h.trim());
  }
  const merged = new Uint8Array(rxBuf.length + len);
  merged.set(rxBuf, 0);
  merged.set(u, rxBuf.length);
  let pos = 0;
  while (pos + 20 <= merged.length) {
    if (merged[pos] !== 0x55) { pos++; continue; }            // resync to the 0x55 frame marker
    const t = new Array(20);
    for (let i = 0; i < 20; i++) t[i] = merged[pos + i];
    if (crc8(t, 19) !== (t[19] & 0xFF)) { pos++; continue; }  // not a valid frame, skip one byte
    dispatch(t);
    pos += 20;
  }
  rxBuf = merged.slice(pos);                     // keep the unconsumed tail for the next notification
  if (rxBuf.length > 200) rxBuf = rxBuf.slice(rxBuf.length - 40);
}

// A frame from the scooter is the only proof the link is real: iOS reports a connected GATT even for a
// bonded device far out of range. Telemetry and OTA answers both count.
function confirmLink() {
  if (linkConfirmed) return;
  linkConfirmed = true;
  if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
  setStatus('connected');
  maybeRunDeepAction();
}

function dispatch(t) {
  if (!diagParsed) { diagParsed = true; log('telemetry ok, first frame 0x' + (t[1] & 0xFF).toString(16)); }
  confirmLink();                 // first real frame proves the device is truly here -> now "connected"
  switch (t[1]) {
    case 0x71:
      updateFrom71(t);
      // TESTLOCK firmware streams the lock flag in on-wire t[2]: 0 = LOCKED, 1 = UNLOCKED.
      T.lock = (t[2] & 1) === 0 ? 'locked' : 'unlocked';
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
    case 0x43:
      // 55 43 version frame: t[2..4] = base VCU sw version (5.4.19); t[6] = our internal build number
      // stamped into the hwVer major byte by the patcher (FirmwarePatcher FW_BUILD), so the app can
      // read which TESTLOCK build is on the controller.
      if ((t[2] & 0xFF) > 0) T.swVer = (t[2] & 0xFF) + '.' + (t[3] & 0xFF) + '.' + (t[4] & 0xFF);
      T.fwBuild = t[6] & 0xFF;
      break;
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
function updateFin() { T.fin = (deviceName || T.frameNum || '').trim(); }   // FIN only (BLE name; telemetry as fallback)

// --------------------------- BLE connection ---------------------------

let device = null, server = null, notifyChar = null, writeChar = null;
let notifyReady = false, connected = false, userDisconnect = false;
let deviceName = '';
let reconnectDelay = RECONNECT_BASE_MS;
let keepAliveTimer = null;
let linkConfirmed = false, linkTimer = null;   // "connected" is shown only once real telemetry arrives
let connecting = false;                        // connectGatt is not re-entrant, see the guard there

async function pickAndConnect() {
  if (!navigator.bluetooth) { log('Web Bluetooth not available. Use Bluefy (iOS) or Chrome.'); return; }
  try {
    userDisconnect = false;
    log('scanning...');
    const dev = await navigator.bluetooth.requestDevice({
      filters: NAME_PREFIXES.map(p => ({ namePrefix: p })),
      optionalServices: OPTIONAL_SERVICES,
    });
    log('selected: ' + (dev.name || '') + ' [' + dev.id + ']');
    await connectGatt(dev);                      // adopts the device, see adoptDevice
  } catch (e) {
    log('scan/connect cancelled: ' + e);
  }
}

// Named handler: an anonymous one leaves a second listener behind on a re-entered connect. Two
// listeners deliver every response twice, which makes the engine count one ack as two.
function onCharacteristicValue(ev) {
  try { onNotify(ev.target.value); } catch (e) {}
}

// The listener lives on the characteristic, so it has to be released BEFORE the reference to that
// characteristic is dropped: otherwise the old one keeps delivering into this page for as long as its
// GATT link lasts. Every response would then arrive twice.
function detachNotify() {
  const nc = notifyChar;
  notifyChar = null;
  if (!nc) return;
  try { nc.removeEventListener('characteristicvaluechanged', onCharacteristicValue); } catch (e) {}
  // Not awaited: with the listener gone nothing can arrive either way. Waiting for a CCCD write on a
  // device that may already be gone would only hold up the connect.
  try { const p = nc.stopNotifications(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}

// The one place where a device becomes THE device: the old notify listener goes first, then the
// reference, so a replaced device cannot leave a live listener behind.
function adoptDevice(dev) {
  if (!dev || dev === device) return;
  detachNotify();
  // The replaced device's disconnect handler goes with it: a drop on a scooter this page no longer
  // talks to would otherwise reset the page state and end a running flash on the new one.
  try { if (device) device.removeEventListener('gattserverdisconnected', onDisconnected); } catch (e) {}
  device = dev;
  deviceName = device.name || '';
  updateFin();
  device.addEventListener('gattserverdisconnected', onDisconnected);
}

async function connectGatt(next) {
  const target = next || device;
  // Several paths can arrive here at once: a drop during an in-flight reconnect, reconnect()'s own
  // retry on top of the one onDisconnected scheduled, auto-reconnect racing a tap on Connect.
  if (connecting) { log('connect already in progress'); return; }
  // The guard has to test the device this call is about to connect to, not the one already held.
  if (connected && target && target.gatt && target.gatt.connected) { log('already connected'); return; }
  connecting = true;
  try {
    adoptDevice(target);
    setStatus('connecting');
    notifyReady = false; connected = false;
    rxBuf = new Uint8Array(0);
    diagNotify = 0; diagParsed = false;                            // fresh frame buffer + diagnostics
    server = await device.gatt.connect();
    const svc = await pickService(server);
    if (!svc) { setStatus('no-service'); log('no matching GATT service'); return; }
    await pickCharacteristics(svc);
    if (!notifyChar || !writeChar) { setStatus('no-char'); log('notify/write characteristic missing'); return; }
    await notifyChar.startNotifications();
    notifyChar.removeEventListener('characteristicvaluechanged', onCharacteristicValue);
    notifyChar.addEventListener('characteristicvaluechanged', onCharacteristicValue);
    notifyReady = true; connected = true; linkConfirmed = false;
    reconnectDelay = RECONNECT_BASE_MS;
    // The GATT link is up, but iOS reports success even for a bonded device that is far out of range
    // (a phantom link). Do NOT show "connected" yet: wait for a REAL frame (see confirmLink). The
    // keep-alive below asks the scooter to stream; if nothing arrives in time it was a phantom.
    setStatus('linking');
    renderLive();                  // show the tiles we already know from the BLE name
    try { if (device && device.id) localStorage.setItem(LS_DEVICE, device.id); } catch (e) {}
    log('link up, waiting for data. notify=' + notifyChar.uuid.slice(0, 8) + ' write=' + writeChar.uuid.slice(0, 8));
    startKeepAlive();
    if (linkTimer) clearTimeout(linkTimer);
    linkTimer = setTimeout(onLinkTimeout, LINK_TIMEOUT_MS);
  } finally {
    connecting = false;
  }
}

// Silence is not proof of a dead link: a scooter left in update mode by a half-finished flash answers
// on the OTA path only. That is the state a re-flash has to recover, so this reports the silence and
// keeps the link plus auto-reconnect intact. It never tears a usable link down.
function onLinkTimeout() {
  linkTimer = null;
  if (flashOwnsLink()) return;             // a flash owns the link and answers on its own path
  if (linkConfirmed || !connected) return;
  log('no data yet: out of range or sitting in update mode. Link kept, flashing still possible.');
  setStatus('no-data');
  resetTiles(); refreshSettingsInputs();
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
    // Direct fetch of the same ISSC/FF set the native app matches. Works even when enumeration is empty.
    const d = await direct(COMMON_SERVICES);
    if (d) return d;
    if (attempt === 0) { log('no service yet, waiting for GATT discovery, retrying'); await sleep(1500); }
  }
  return await direct(VENDOR_16BIT);   // last resort: batched direct-fetch over the whole declared 0xFCxx-0xFFxx range
}

async function pickCharacteristics(svc) {
  detachNotify();                                // release the old characteristic before losing it
  writeChar = null;
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
  if (otaEngine) otaEngine.onDisconnect();   // ends the flash and restores the UI through finished()
  setStatus('disconnected');
  resetTiles();
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
  refreshSettingsInputs();
}

// --------------------------- keep-alive + write queue ---------------------------

function startKeepAlive() {
  stopKeepAlive();
  const tick = () => {
    if (!notifyReady) return;
    enqueue(connectCode(0));
    keepAliveTimer = setTimeout(tick, CONNECT_CODE_INTERVAL_MS);
  };
  tick();
}
function stopKeepAlive() { if (keepAliveTimer) { clearTimeout(keepAliveTimer); keepAliveTimer = null; } }

const writeQueue = [];
let writing = false;
function clearWriteQueue() { writeQueue.length = 0; }

// The flasher writes on its own chain, so the normal queue has to stay off the characteristic for the
// whole flash: two GATT writes in flight on one characteristic and the browser rejects the loser.
function enqueue(frame) {
  if (flashOwnsLink()) return;
  writeQueue.push(frame);
  drain();
}
async function drain() {
  if (writing || !notifyReady || flashOwnsLink()) return;
  writing = true;
  while (writeQueue.length) {
    if (flashOwnsLink()) { clearWriteQueue(); break; }   // a flash took over between two writes
    const f = writeQueue.shift();
    try { await doWrite(f); } catch (e) { log('write error: ' + e); }
    await sleep(WRITE_GAP_MS);
  }
  writing = false;
}
// A write that is already in flight cannot be recalled, so the flash waits for it to land. Bounded:
// on a dead link the write never settles and the flash still has to be able to start. Returns false
// when the cap expired with a write still out, which the caller has to report.
async function waitWriteIdle() {
  for (let i = 0; i < 40 && writing; i++) await sleep(25);
  return !writing;
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

// --------------------------- OTA transport ---------------------------
//
// The flasher does its own timing (30 ms between packet-data frames), so its writes must NOT go
// through the 200 ms telemetry queue. They still have to be strictly serialised: two GATT writes in
// flight give "operation already in progress" and the packet is lost. One promise chain does both.

const OTA_RETRY_MS = 25;
const OTA_SETTLE_MS = 500;            // how long a frame may stay in flight before the wait is logged
const OTA_FIRST_TRIES = 40;           // 40 x 25 ms, inside the 1500 ms ota.js waits before START

let otaEngine = null;                 // non-null while a flash runs: notifications route to it
let otaChain = Promise.resolve();     // serialises OTA writes without adding a gap
let otaEpoch = 0;                     // bumped on start, cancel and finish, see otaWrite
let flashPending = false;             // set while a flash is being armed, before the engine exists
let otaFirstFrame = false;            // armed at flash start for the prepare frame, see otaWrite

// True from the moment a flash is armed until its write chain is idle again. The normal write path and
// the deep-link actions are fenced off for exactly that window.
function flashOwnsLink() { return !!otaEngine || flashPending; }

// A frame already handed to the characteristic cannot be recalled, so both the start and the end of a
// run wait here until the chain is genuinely idle: a normal write on top of an in-flight OTA frame is
// the one the browser rejects. OTA_SETTLE_MS only decides when the wait is worth a log line.
function otaChainIdle(chain) {
  const done = chain ? chain.catch(() => {}) : Promise.resolve();
  let idle = false;
  done.then(() => { idle = true; });
  sleep(OTA_SETTLE_MS).then(() => { if (!idle) log('an OTA frame is still in flight, waiting for it'); });
  return done;
}

// Reassigning otaChain does not unqueue the writes already chained onto the old one: they still reach
// the characteristic. Each write carries the epoch it was queued in then drops out once that run is
// over, so no frame from a cancelled run can enter the next one.
function otaWrite(frame) {
  const epoch = otaEpoch;
  // The prepare/erase frame goes out ONCE and no retry path re-sends it, so the first frame of a run
  // retries until the characteristic takes it: a browser rejection would otherwise cost the whole run.
  // Every later frame has the engine's own resend behind it, so one quick retry is enough there.
  const tries = otaFirstFrame ? OTA_FIRST_TRIES : 2;
  otaFirstFrame = false;
  otaChain = otaChain.then(async () => {
    for (let i = 0; i < tries; i++) {
      if (epoch !== otaEpoch) return;
      try { await otaWriteOnce(frame); return; } catch (e) { if (i + 1 >= tries) throw e; }
      await sleep(OTA_RETRY_MS);
    }
  }).catch(e => { log('ota write dropped: ' + e); });   // keep the chain alive for the next frame
}

// Opposite preference to doWrite: without-response has no per-frame acknowledgement round trip, which
// is what keeps the packet stream inside the controller's receive window.
async function otaWriteOnce(frame) {
  const wc = writeChar;
  if (!wc) throw new Error('no write characteristic');
  if (wc.properties.writeWithoutResponse && wc.writeValueWithoutResponse) return wc.writeValueWithoutResponse(frame);
  if (wc.writeValueWithResponse) return wc.writeValueWithResponse(frame);
  return wc.writeValue(frame);
}

// --------------------------- lock / unlock + wheel / cruise ---------------------------
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
  if (!requireReady() || !requireUnlocked('wheel size')) return;
  S.wheel = v;
  persistWheel(v);
  writeWheelCruiseAllGears();
  log('wheel set to ' + v + ' (saved)');
}

// User sets cruise: 0 off, 1 auto, 2 manual. Save it, then write the full 0x18.
function setCruise(v) {
  if (!requireReady() || !requireUnlocked('cruise control')) return;
  S.cruise = v;
  persistCruise(v);
  writeWheelCruiseAllGears();
  log('cruise set to ' + v + ' (saved)');
}

// Lock/unlock go over the TESTLOCK firmware's cmd 0x1B (unlockFlag), NOT a FIN rename.
// The FIN never changes, so there is no rename-reconnect and no wheel/cruise restore dance; the real
// lock state comes back streamed in 55 71 t[2] and drives refreshToggle on the next frame.
function unlock() {
  if (!connected) { log('connect first'); return; }
  log('unlock -> cmd 0x1B');
  enqueue(setLockState(true));
  T.lock = 'unlocked';     // optimistic; the streamed t[2] confirms/corrects it
  refreshToggle();
}

function lock() {
  if (!connected) { log('connect first'); return; }
  log('lock -> cmd 0x1B');
  enqueue(setLockState(false));
  T.lock = 'locked';
  refreshToggle();
}

// Called on every 55 71. When a restore is armed (unlock happened, link dropped and came back),
// re-apply the saved wheel + cruise once, exactly like the native maybeRestoreFinSettings.
function onSettingsFrame() {
  if (pendingRestore && restoreArmed && S.received71) {
    const w = savedWheel(), c = savedCruise();
    if (w != null) S.wheel = w;
    if (c != null) S.cruise = c;
    writeWheelCruiseAllGears();
    log('restored after unlock: wheel=' + (w != null ? w : '-') + ' cruise=' + (c != null ? c : '-'));
    pendingRestore = false; restoreArmed = false;
  }
}

function requireReady() {
  if (!connected) { log('connect first'); return false; }
  if (!S.received71) { log('waiting for telemetry (55 71) before writing settings'); return false; }
  return true;
}

// Wheel size and cruise are only settable on an UNLOCKED scooter: the firmware discards the write
// otherwise. The inputs are already disabled while locked; this is the second guard so a deep-link,
// a stale page or a console call cannot push a write the controller would silently drop.
function requireUnlocked(what) {
  if (T.lock === 'locked') { log('unlock the scooter first to change the ' + what); return false; }
  return true;
}

// --------------------------- firmware flasher (ota.js) ---------------------------
//
// This page ships no firmware: the user supplies the file, ota.js checks it and runs the flash.

let fwText = null;      // the text of the accepted file, kept until the flash starts
let fwCheck = null;     // the window.OTA.checkImage result for it
// The file the open dialog describes and the flash then runs, captured when the dialog opens. The
// picker stays disabled from that moment, so what the user confirms is what goes on the wire.
let flashChk = null;
let flashArmed = false; // the confirmation dialog is open and waiting for an answer

// Controls that must not fire while a flash runs: an extra frame or a disconnect breaks the stream.
const FLASH_LOCK_IDS = ['btn-conn', 'btn-toggle', 'wheel-in', 'btn-set-wheel', 'cruise-in', 'btn-set-cruise'];

// Blob.text() is missing on older WebKit, where Bluefy still has to work.
function readFileText(file) {
  if (file.text) return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsText(file);
  });
}

// The verdict is kept, not just drawn: a language switch has to redraw the same result.
let fwVerdict = null;   // { key, ok, chk } for an accepted file, { key, ok, name, err } for a refused one

function showFwVerdict(v) { fwVerdict = v; renderFwVerdict(); }

// Built as DOM nodes, not markup: the headline and the detail carry a user-supplied file name.
function renderFwVerdict() {
  const host = $('fw-check');
  if (!host || !fwVerdict) return;
  const v = fwVerdict;
  const detail = v.chk
    ? (v.chk.name + '  ' + t('fwVersion') + ' ' + (v.chk.version || '?') + '  '
       + v.chk.bytes + ' ' + t('fwBytes') + '  ' + v.chk.packets + ' ' + t('fwPackets')
       + '  CRC ' + v.chk.calcCrc)
    : (v.name + ': ' + v.err);
  host.textContent = '';
  const box = document.createElement('div');
  box.className = v.ok ? 'verdict' : 'verdict bad';
  const b = document.createElement('b');
  b.textContent = t(v.key);
  const d = document.createElement('span');
  d.className = 'detail';
  d.textContent = detail;
  box.appendChild(b);
  box.appendChild(d);
  host.appendChild(box);
}

async function onFwFile(file) {
  if (!file) return;
  fwText = null; fwCheck = null;
  refreshFlashButtons();
  let text;
  try {
    text = await readFileText(file);
  } catch (e) {
    showFwVerdict({ ok: false, key: 'fwReadFail', name: file.name, err: String(e) });
    return;
  }
  try {
    const chk = window.OTA.checkImage(text, file.name);
    fwText = text; fwCheck = chk;
    showFwVerdict({ ok: true, key: chk.isVcu ? 'fwOkVcu' : 'fwOkBms', chk: chk });
    log('firmware file ready: ' + chk.name + ' v' + chk.version + ' ' + chk.bytes + ' bytes CRC ' + chk.calcCrc);
  } catch (e) {
    const why = (e && e.message) ? e.message : String(e);
    showFwVerdict({ ok: false, key: 'fwBad', name: file.name, err: why });
    log('firmware file rejected: ' + why);
  }
  refreshFlashButtons();
}

// Choose file needs a link, Flash needs a checked file as well. While a flash runs the Flash button
// is the only way out, so it turns into Cancel.
function refreshFlashButtons() {
  const pick = $('btn-pick'), flash = $('btn-flash'), file = $('fw-file');
  // The open confirmation counts as busy: picking a second file must not change what is flashed.
  const busy = flashOwnsLink() || flashArmed;
  if (pick) pick.disabled = !connected || busy;
  if (file) file.disabled = busy;
  if (!flash) return;
  if (otaEngine) {
    flash.textContent = t('btnCancel');
    flash.dataset.act = 'cancel';
    flash.disabled = false;
    return;
  }
  flash.textContent = t('btnFlash');
  flash.dataset.act = 'flash';
  flash.disabled = !connected || !fwText;
}

function setControlsForFlash(flashing) {
  FLASH_LOCK_IDS.forEach(id => { const el = $(id); if (el) el.disabled = flashing; });
  if (!flashing) { refreshToggle(); refreshSettingsInputs(); }
}

// Both the progress line and the result line are kept as values, so a language switch
// mid-flash redraws them instead of leaving the old language on screen.
let fwProgress = null;   // { percent, packet, count, phase }
let fwResult = null;     // { success, message, phase }

function setFwProgress(percent, packet, count, phase) {
  fwProgress = { percent: percent, packet: packet, count: count, phase: phase };
  fwResult = null;
  renderFwProgress();
}

function renderFwProgress() {
  if (!fwProgress) return;
  const p = fwProgress;
  const prog = $('fw-progress');
  if (prog) prog.hidden = false;
  const bar = $('fw-bar');
  if (bar) bar.style.width = Math.max(0, Math.min(100, p.percent)) + '%';
  const ph = $('fw-phase');
  if (ph) {
    ph.textContent = p.count
      ? fmt(t('progPacket'), { n: p.packet, m: p.count, phase: tPhase(p.phase) })
      : tPhase(p.phase);
  }
}

function renderFwResult() {
  const ph = $('fw-phase');
  if (!ph || !fwResult) return;
  ph.textContent = fwResult.success
    ? t('fwDone')
    : fmt(t('fwStopped'), { phase: tPhase(fwResult.phase), msg: tMessage(fwResult.message) });
}

// The dialog names the file it is about to flash. Text, not markup: the name comes from the user.
function renderDlgFile() {
  const el = $('dlg-file');
  if (!el) return;
  el.textContent = flashChk
    ? fmt(t('dlgFile'), { name: flashChk.name, version: flashChk.version || '?',
                          bytes: flashChk.bytes, packets: flashChk.packets })
    : '';
}

// The confirm button stays dead until the rider says they read the disclaimer.
function syncFlashConsent() {
  const consent = $('dlg-consent'), ok = $('btn-warn-ok');
  if (ok) ok.disabled = !(consent && consent.checked);
}

function askFlash() {
  if (!connected || !fwCheck || flashOwnsLink() || flashArmed) return;
  const dlg = $('flash-warn');
  if (!dlg || !dlg.showModal) { log('this browser cannot show the confirmation, flashing not started'); return; }
  // The file is captured HERE and the picker is disabled until the dialog is answered, so the file the
  // dialog describes is the one startFlash hands to the engine.
  flashChk = fwCheck;
  flashArmed = true;
  renderDlgFile();
  // Asked fresh every time: the tick from the previous dialog never carries over.
  const consent = $('dlg-consent');
  if (consent) consent.checked = false;
  syncFlashConsent();
  refreshFlashButtons();
  // Stopped here, not at flash start: a connect-code frame enqueued while the dialog is open could
  // still be in flight when the first OTA frame goes out. Restarted from the dialog's close event.
  stopKeepAlive();
  dlg.showModal();
}

async function startFlash() {
  if (!connected || !flashChk || flashOwnsLink()) return;
  flashPending = true;                                 // fence the normal write path before anything else
  try {
    stopKeepAlive();
    clearWriteQueue();      // a connect-code frame inside the packet stream breaks the flash
    if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }   // no telemetry comes during a flash
    otaEpoch++;             // nothing queued before this moment may reach the characteristic
    const settling = otaChain;
    otaChain = Promise.resolve();
    const idle = await waitWriteIdle();
    await otaChainIdle(settling);     // a frame of the previous run may still be in flight
    // As the native app: the flag is dropped so a write whose promise never settles cannot keep the
    // normal queue blocked for the rest of the session.
    writing = false;
    if (!idle) log('a normal write is still in flight, the update request goes out with retries');
    if (!connected) { log('link lost before the flash started'); flashPending = false; refreshFlashButtons(); return; }
    setControlsForFlash(true);
    setFwProgress(0, 0, 0, 'preparing');
    const engine = new window.OTA.OtaEngine(flashChk, {
      write: otaWrite,
      log: log,
      progress: p => setFwProgress(p.percent, p.packet, p.count, p.phase),
      finished: onFlashFinished,
    });
    otaEngine = engine;     // set before start(): the first response must already route to the engine
    refreshFlashButtons();
    log('flashing ' + flashChk.name + ', keep the scooter on and stay in range');
    otaFirstFrame = true;   // the engine's first write is the prepare frame, which may not be lost
    engine.start();
  } catch (e) {
    flashPending = false;
    log('flash could not start: ' + e);
    setControlsForFlash(false);
    refreshFlashButtons();
  }
}

function onFlashFinished(success, message, phase) {
  otaEngine = null;                   // the engine is done; the fence stays up until its chain is idle
  otaEpoch++;                         // frames still queued from this run must not reach the next one
  const settling = otaChain;
  otaChain = Promise.resolve();
  rxBuf = new Uint8Array(0);          // drop OTA bytes so telemetry parsing resyncs cleanly
  if (success) {
    setFwProgress(100, flashChk ? flashChk.packets : 0, flashChk ? flashChk.packets : 0, 'done');
    log('flash finished: ' + message + '. Switch the scooter off and on again to run the new firmware.');
  } else {
    log('flash stopped in ' + phase + ': ' + message
      + '. The scooter stays in update mode until a flash completes, so flash again before riding.');
  }
  // The log keeps the wording ota.js produced (English, the way the guide quotes it);
  // the line under the bar is the translated one.
  fwResult = { success: success, message: message, phase: phase };
  renderFwResult();
  // The controls and the keep-alive come back only once the chain is idle: a tap or a settings restore
  // would otherwise put a normal frame on the wire while the last OTA frame is still in flight.
  otaChainIdle(settling).then(() => {
    flashPending = false;
    setControlsForFlash(false);
    refreshFlashButtons();
    if (connected && notifyReady && !flashOwnsLink()) startKeepAlive();
  });
}

// --------------------------- shortcut deep-link + auto-reconnect ---------------------------
//
// A home-screen shortcut (iOS Shortcuts / Android home-screen icon) opens the page with ?do=lock or
// ?do=unlock. On load we reconnect to the last granted scooter via getDevices(): no chooser, works
// in Bluefy (iOS) and Chrome. Then the action runs once connected. getDevices()/auto-connect need no
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
  // A flash owns the link, so the shortcut waits: it runs on the first telemetry frame afterwards.
  if (!pendingDeepAction || !connected || flashOwnsLink()) return;
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
    userDisconnect = false;
    log('auto-reconnect: ' + (dev.name || dev.id));
    await connectGatt(dev);                      // adopts the device, see adoptDevice
  } catch (e) {
    setStatus('disconnected');
    log('auto-reconnect skipped: ' + e);
  }
}

// --------------------------- UI ---------------------------

function $(id) { return document.getElementById(id); }
function setStatus(s) {
  const el = $('status'); if (el) { el.textContent = s; el.dataset.state = s; }
  // Single Connect/Disconnect control: reads "Disconnect" while connected or connecting, "Connect" otherwise.
  const cb = $('btn-conn');
  if (cb) {
    // "no-data" keeps the GATT link, so the control has to offer Disconnect there as well.
    const on = (s === 'connecting' || s === 'linking' || s === 'connected' || s === 'no-data');
    cb.textContent = on ? t('btnDisconnect') : t('btnConnect');
    cb.dataset.act = on ? 'disconnect' : 'connect';
  }
  refreshFlashButtons();   // both flasher buttons need a link and every state change decides that
}
function log(m) {
  const el = $('log'); if (!el) return;
  el.textContent = ('[' + new Date().toLocaleTimeString() + '] ' + m + '\n') + el.textContent;
}
// The single lock/unlock control reflects the current state: "Unlock" when the scooter is locked,
// "Lock" when it is open. The state is driven ONLY by the real IVCU value streamed in 55 71 t[2]
// (T.lock). It is NEVER inferred from the FIN / BLE name: the FIN does not reflect the real lock and
// lying about it is worse than admitting we do not know yet. Until a real 55 71 sets T.lock the state
// is shown as unknown ("reading...") and the button is disabled.
function refreshToggle() {
  const btn = $('btn-toggle');
  if (!btn) return;
  if (otaEngine) { btn.disabled = true; return; }   // a flash owns the link, no lock frames meanwhile
  const known = (T.lock === 'locked' || T.lock === 'unlocked');
  const locked = (T.lock === 'locked');
  // Without a link there is nothing being read, so the idle label stands in for the unknown state.
  btn.textContent = known ? (locked ? t('btnUnlock') : t('btnLock'))
                          : (connected ? t('btnReading') : t('btnUnlock'));
  btn.dataset.action = locked ? 'unlock' : 'lock';
  btn.disabled = !linkConfirmed || !known;   // actionable only once a real 55 71 gave the state
}
function renderLive() {
  $('t-wheel').textContent = S.received71 ? S.wheel.toFixed(1) : '-';
  $('t-cruise').textContent = S.received71 ? (cruiseName(S.cruise) || S.cruise) : '-';
  $('t-swver').textContent = T.swVer ? ('R' + T.swVer) : '-';
  $('t-fwver').textContent = (T.fwBuild != null && T.fwBuild > 0) ? ('V' + T.fwBuild) : '-';
  refreshSettingsInputs();
  refreshToggle();
}
function resetTiles() {                                 // no telemetry -> show "-"
  // Drop cached telemetry so a reconnect can NEVER show a pre-reboot lock state. Without this, T.lock
  // keeps its last value and refreshToggle shows it until a fresh 55 71 arrives. Cleared to null,
  // refreshToggle shows "reading..." (unknown) until the next real 55 71 gives the true state.
  T.lock = null;
  S.received71 = false;
  $('t-wheel').textContent = '-';
  $('t-cruise').textContent = '-';
  refreshToggle();
}
// Wheel + cruise: editable only once the scooter reported its config (55 71). Prefilled ONCE with
// the value the scooter delivers; after that the user edits freely (no per-frame overwrite).
let settingsPrefilled = false;
function refreshSettingsInputs() {
  if (otaEngine) return;     // a running flash keeps these disabled until it reports finished
  const ready = connected && S.received71;
  const win = $('wheel-in'), cin = $('cruise-in'), bw = $('btn-set-wheel'), bc = $('btn-set-cruise');
  // Wheel size and cruise may only be changed while UNLOCKED: a locked (roadside-legal) scooter keeps
  // an honest speedometer and no cruise. The firmware enforces both on its own, so this only keeps the
  // UI honest instead of accepting a write the controller discards. Lock state comes from the streamed
  // 55 71 t[2]; if it is not known yet (T.lock == null) the controls stay editable.
  const locked = ready && T.lock === 'locked';
  [win, bw].forEach(el => { if (el) { el.disabled = !ready || locked; el.title = locked ? t('tipWheelLocked') : ''; } });
  [cin, bc].forEach(el => { if (el) { el.disabled = !ready || locked; el.title = locked ? t('tipCruiseLocked') : ''; } });
  if (ready && !settingsPrefilled) {
    if (win) win.value = S.wheel.toFixed(1);
    if (cin) cin.value = String(S.cruise);
    settingsPrefilled = true;
  } else if (!ready) {
    settingsPrefilled = false;
  }
}

// --------------------------- language ---------------------------
//
// Every visible string comes from i18n.js: elements carry data-t="key", the run-time
// strings are looked up with t(). German is the default, never browser-detected, so the
// page reads the same on every device until the reader picks EN.

let lang = 'de';

function table() { return (window.I18N && window.I18N[lang]) || {}; }
function t(key) { const v = table()[key]; return (typeof v === 'string') ? v : ''; }
function tList(key) { const v = table()[key]; return Array.isArray(v) ? v : []; }
function fmt(s, vars) { return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)); }
function cruiseName(v) { return [t('cruiseOff'), t('cruiseAuto'), t('cruiseManual')][v]; }

// Flasher phase names come from ota.js, so an unknown one falls back to its raw name.
function tPhase(p) { return (table().phase || {})[p] || String(p); }

// Result messages come from ota.js too. The two carrying packet numbers are matched by
// pattern; anything unmapped is shown as the engine worded it.
function tMessage(m) {
  const msg = table().msg || {};
  if (msg[m]) return msg[m];
  let hit = /^packet (\d+)\/(\d+) failed repeatedly$/.exec(m);
  if (hit && msg.packetFailed) return fmt(msg.packetFailed, { n: hit[1], m: hit[2] });
  hit = /^packet (\d+)\/(\d+) got no response\./.exec(m);
  if (hit && msg.packetNoAnswer) return fmt(msg.packetNoAnswer, { n: hit[1], m: hit[2] });
  return String(m);
}

function renderList(hostId, key) {
  const host = $(hostId);
  if (!host) return;
  host.textContent = '';
  tList(key).forEach(item => {
    const li = document.createElement('li');
    li.innerHTML = item;   // scan-ok: our own translation table, the only markup is <b>
    host.appendChild(li);
  });
}

function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach(n => {
    const v = t(n.getAttribute('data-t'));
    // Only strings with emphasis, a link or an escaped character go in as markup.
    if (/[<&]/.test(v)) n.innerHTML = v; else n.textContent = v;   // scan-ok: our own translation table
  });
  renderList('dlg-list', 'dlgPoints');
  { const el = $('wheel-in'); if (el) el.placeholder = t('phWheel'); }
  // href is only the fallback for opening in a new tab; the click opens the viewer.
  { const el = $('link-guide'); if (el) el.href = docFile('GUIDE'); }
  { const el = $('link-readme'); if (el) el.href = docFile('README'); }
  { const el = $('link-privacy'); if (el) el.href = docFile('PRIVACY'); }
  { const el = $('link-license'); if (el) el.href = docFile('LICENSE'); }
  { const el = $('link-trademarks'); if (el) el.href = docFile('TRADEMARKS'); }

  { const el = $('langs'); if (el) el.setAttribute('aria-label', t('langGroup')); }
  { const el = $('build-ver'); if (el) el.textContent = t('buildLabel') + ' ' + BUILD; }
  document.querySelectorAll('#langs button').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  });
  // Everything drawn from state has to be redrawn in the new language.
  renderFwVerdict();
  renderDlgFile();
  if (fwResult) renderFwResult(); else renderFwProgress();
  { const el = $('status'); setStatus(el ? el.dataset.state : 'disconnected'); }
  renderLive();
}

function initLangSwitch() {
  document.querySelectorAll('#langs button').forEach(b => {
    b.addEventListener('click', () => { lang = b.dataset.lang; applyLang(); });
  });
}

// --------------------------- document viewer ---------------------------
// The guide, the disclaimer, the licence, the privacy notice and the trademarks
// are files of this site. They open here, so a reader is never handed a raw
// markdown file or sent off to a code host.

const DOC_TITLES = {
  'GUIDE.de.md': 'footGuide', 'GUIDE.en.md': 'footGuide',
  'PRIVACY.de.md': 'footPrivacy', 'PRIVACY.md': 'footPrivacy',
  'LICENSE.de.md': 'footLicense', 'LICENSE.md': 'footLicense',
  'TRADEMARKS.de.md': 'footTrademarks', 'TRADEMARKS.md': 'footTrademarks',
  'README.md': 'footReadme',
};

const DISCLAIMER_HREF = 'README.md#disclaimer';

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// GitHub's heading slugs, so an anchor written inside a document keeps working here.
// One space becomes one dash, runs are NOT collapsed: a code host drops the punctuation
// first, so "Disclaimer & Trademarks" ends up with two dashes and an anchor written for
// that host has to find the same id here.
const slug = s => s.toLowerCase().trim()
  .replace(/[^\w\sÀ-ɏ-]/g, '')
  .replace(/ /g, '-');

// Only the markdown these documents use: headings, lists with one level of
// nesting, tables, fenced code, quotes, rules, bold, inline code and links.
// Indented content stays inside its list item, so the numbering of the steps
// after it keeps counting.
function mdToHtml(src) {
  const inline = s => escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, text, href) => {
      // The disclaimer link reads well on a code host and opens our own terms here.
      if (href === DISCLAIMER_HREF) return `<a href="${href}" data-disclaimer>${text}</a>`;
      if (DOC_TITLES[href]) return `<a href="${href}" data-docfile="${href}">${text}</a>`;
      // An anchor belongs to the document being read, so it scrolls instead of opening a
      // tab on an address that answers to nothing.
      if (href.startsWith('#')) return `<a href="${href}" data-anchor="${href.slice(1)}">${text}</a>`;
      return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
    });

  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let listKind = null;   // the open top-level list, 'ul' or 'ol'
  let li = null;         // { parts: [], nested: bool } of the open list item
  let para = [];
  let inFence = false;

  const sink = () => (li ? li.parts : out);
  const flushPara = () => { if (para.length) { sink().push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const closeNested = () => { if (li && li.nested) { li.parts.push('</ul>'); li.nested = false; } };
  const closeLi = () => {
    if (!li) return;
    flushPara(); closeNested();
    out.push('<li>' + li.parts.join('\n') + '</li>');
    li = null;
  };
  const closeList = () => { closeLi(); if (listKind) { out.push('</' + listKind + '>'); listKind = null; } };
  const block = () => { flushPara(); closeList(); };
  const openList = kind => {
    flushPara();
    if (listKind !== kind) { closeList(); out.push('<' + kind + '>'); listKind = kind; } else closeLi();
  };
  const cells = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const body = l.trim();
    const indented = /^ {2,}\S/.test(l);

    if (inFence) {
      if (body.startsWith('```')) { sink().push('</code></pre>'); inFence = false; } else sink().push(escHtml(l));
      continue;
    }
    if (body.startsWith('```')) {
      if (li) { flushPara(); closeNested(); } else block();
      sink().push('<pre><code>');
      inFence = true;
      continue;
    }
    // A blank line inside a list item only ends its paragraph: the item goes on
    // as long as the next line is indented.
    if (body === '') {
      if (li && /^ {2,}\S/.test(lines[i + 1] || '')) flushPara(); else block();
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(body)) { block(); out.push('<hr>'); continue; }

    // A header row followed by a divider row starts a table.
    if (body.startsWith('|') && /^\|[\s:|-]+\|?\s*$/.test((lines[i + 1] || '').trim())) {
      if (li) { flushPara(); closeNested(); } else block();
      sink().push('<div class="doc-table"><table><thead><tr>'
        + cells(body).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>');
      i++;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
        sink().push('<tr>' + cells(lines[++i].trim()).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>');
      }
      sink().push('</tbody></table></div>');
      continue;
    }

    let m;
    if ((m = body.match(/^(#{1,4})\s+(.*)$/))) {
      block();
      const n = m[1].length;
      out.push(`<h${n} id="${slug(m[2])}">${inline(m[2])}</h${n}>`);
      continue;
    }
    if ((m = body.match(/^>\s?(.*)$/))) {
      if (li) { flushPara(); closeNested(); } else block();
      sink().push('<blockquote>' + inline(m[1]) + '</blockquote>');
      continue;
    }
    // An indented bullet is a sub-list of the open item.
    if (indented && li && (m = body.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      if (!li.nested) { li.parts.push('<ul class="nested">'); li.nested = true; }
      li.parts.push('<li>' + inline(m[1]) + '</li>');
      continue;
    }
    if ((m = body.match(/^[-*]\s+(.*)$/)) && !indented) {
      openList('ul'); li = { parts: [inline(m[1])], nested: false };
      continue;
    }
    if ((m = body.match(/^\d+\.\s+(.*)$/)) && !indented) {
      openList('ol'); li = { parts: [inline(m[1])], nested: false };
      continue;
    }
    // Indented prose belongs to the open item; anything else is a new paragraph.
    if (li && !indented) closeList();
    if (li) closeNested();
    para.push(body);
  }
  if (inFence) sink().push('</code></pre>');
  block();
  return out.join('\n');
}

const docCache = {};

// Every document exists in German as well. English keeps the plain name, because
// LICENSE.md is the file GitHub reads and the binding wording of the licence.
const docFile = name => {
  if (name === 'GUIDE') return `GUIDE.${lang}.md`;
  if (name === 'README') return 'README.md';   // only exists in English
  return lang === 'de' ? `${name}.de.md` : `${name}.md`;
};

function openDoc(name, anchor, titleKey) { openDocFile(docFile(name), anchor, titleKey); }

function openDocFile(file, anchor, titleKey) {
  const dlg = $('doc'), body = $('doc-body');
  if (!dlg || !body) return;
  // A document in the other language is labelled as such, so nobody wonders why
  // the licence suddenly reads English.
  const mark = (lang === 'de' && !file.includes('.de.')) ? ' ' + t('docEnglish') : '';
  // The link label carries the loading state; the document's own heading takes over
  // as soon as it is rendered.
  $('doc-title').textContent = (t(titleKey || DOC_TITLES[file] || '') || file) + mark;
  if (typeof dlg.showModal === 'function') dlg.showModal();

  const show = html => {
    body.innerHTML = html;   // scan-ok: markdown of our own documents, rendered by mdToHtml which escapes first
    // The heading becomes the window title instead of standing twice on screen.
    const h1 = body.querySelector('h1');
    if (h1) { $('doc-title').textContent = h1.textContent.trim() + mark; h1.remove(); }
    body.scrollTop = 0;
    if (!anchor) return;
    const target = body.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(anchor) : anchor));
    if (target) body.scrollTop = target.offsetTop - body.offsetTop;
  };

  if (docCache[file]) { show(docCache[file]); return; }
  body.innerHTML = '<p>' + escHtml(t('docLoading')) + '</p>';   // scan-ok: escaped
  // Same marker the script tags carry: without it a document stays in the browser cache
  // across builds and a reader keeps seeing the text from the first time they opened it.
  fetch(file + '?v=' + BUILD)
    .then(r => { if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return r.text(); })
    .then(txt => { docCache[file] = mdToHtml(txt); show(docCache[file]); })
    .catch(e => {
      body.innerHTML = '<p>' + escHtml(t('docFail')) + '</p><pre class="err">'   // scan-ok: escaped
                     + escHtml(file + ': ' + (e && e.message ? e.message : e)) + '</pre>';
    });
}

// The footer disclaimer shows the same points as the warning before a flash, but
// without a confirm button: reading the terms must never start a flash.
function openDisclaimer() {
  const dlg = $('doc'), body = $('doc-body');
  if (!dlg || !body) return;
  $('doc-title').textContent = t('footDisclaimer');
  body.innerHTML = '<p>' + escHtml(t('discLede')) + '</p><ul>'   // scan-ok: escaped lede, list items from our own table
                 + tList('discPoints').map(p => '<li>' + p + '</li>').join('') + '</ul>';
  body.scrollTop = 0;
  if (typeof dlg.showModal === 'function') dlg.showModal();
}

function wireDocViewer() {
  // Delegated: the guide link inside a translated hint is rebuilt on every switch.
  document.addEventListener('click', e => {
    if (!e.target.closest) return;
    const jump = e.target.closest('[data-anchor]');
    if (jump) {
      e.preventDefault();
      const body = $('doc-body');
      const target = body && body.querySelector('#' + CSS.escape(jump.getAttribute('data-anchor')));
      if (target) body.scrollTop = target.offsetTop - body.offsetTop;
      return;
    }
    const a = e.target.closest('[data-doc], [data-docfile], [data-disclaimer]');
    if (!a) return;
    e.preventDefault();
    if (a.hasAttribute('data-disclaimer')) { openDisclaimer(); return; }
    const anchor = a.getAttribute('data-doc-anchor') || '';
    const file = a.getAttribute('data-docfile');
    const titleKey = a.getAttribute('data-t') || '';
    if (file) openDocFile(file, anchor, titleKey); else openDoc(a.getAttribute('data-doc'), anchor, titleKey);
  });
  { const el = $('link-disclaimer');
    if (el) el.addEventListener('click', e => { e.preventDefault(); openDisclaimer(); }); }
  ['doc-x', 'doc-close'].forEach(id => {
    const b = $(id);
    if (b) b.addEventListener('click', () => { const d = $('doc'); if (d) d.close(); });
  });
}

window.addEventListener('DOMContentLoaded', () => {
  log('tr-unlock build ' + BUILD);   // so a tester's log shows which deployed version they run
  initLangSwitch();
  wireDocViewer();
  applyLang();                       // fills every data-t element, German first
  $('btn-conn').addEventListener('click', () => {
    if ($('btn-conn').dataset.act === 'disconnect') disconnectBle(); else pickAndConnect();
  });
  $('btn-toggle').addEventListener('click', () => {
    if ($('btn-toggle').dataset.action === 'unlock') unlock(); else lock();
  });
  $('btn-set-wheel').addEventListener('click', () => {
    const v = parseFloat($('wheel-in').value);
    if (!isNaN(v) && v > 0) setWheel(v);
  });
  $('btn-set-cruise').addEventListener('click', () => setCruise(parseInt($('cruise-in').value, 10)));

  // Firmware flasher. Clearing the input first makes re-picking the same file fire "change" again.
  $('btn-pick').addEventListener('click', () => {
    const f = $('fw-file');
    if (f) { f.value = ''; f.click(); }
  });
  $('fw-file').addEventListener('change', ev => {
    const fs = ev.target.files;
    onFwFile(fs && fs.length ? fs[0] : null);
  });
  $('btn-flash').addEventListener('click', () => {
    if (otaEngine) {
      otaEpoch++;              // drop the frames still queued for this run before the engine unwinds
      otaEngine.cancel();
      return;
    }
    askFlash();
  });
  $('btn-warn-cancel').addEventListener('click', () => { const d = $('flash-warn'); if (d) d.close(); });
  // Esc closes the dialog as well, so the keep-alive comes back from the close event, not the button.
  $('flash-warn').addEventListener('close', () => {
    flashArmed = false;              // the confirmation window is over, whichever way it ended
    refreshFlashButtons();
    if (!flashOwnsLink() && connected && notifyReady) startKeepAlive();
  });
  $('dlg-consent').addEventListener('change', syncFlashConsent);
  // Opens on top of the confirmation, which stays open behind it: reading the terms is not an answer.
  $('dlg-disclaimer').addEventListener('click', e => { e.preventDefault(); openDisclaimer(); });
  $('btn-warn-ok').addEventListener('click', () => {
    const consent = $('dlg-consent');
    if (!consent || !consent.checked) return;
    startFlash();                    // fences the link before the close event can restart the keep-alive
    const d = $('flash-warn'); if (d) d.close();
  });

  refreshSettingsInputs();   // start disabled; enabled + prefilled once a scooter reports its config
  refreshFlashButtons();     // start disabled; both need a link and Flash needs a checked file
  if (!navigator.bluetooth) log('Web Bluetooth not available. On iOS use the Bluefy browser.');
  // Someone arriving at .../#disclaimer meant the terms, an address written in the documents.
  if (location.hash.replace('#', '').toLowerCase().startsWith('disclaimer')) openDisclaimer();
  parseDeepLink();                              // read ?do=lock|unlock from a home-screen shortcut
  if (pendingDeepAction) tryAutoReconnect();    // only a shortcut auto-reconnects; a normal open uses the chooser
});
