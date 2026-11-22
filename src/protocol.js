/*
 * Axon servo programmer protocol (reverse engineered from
 * Axon_Servo_Programming_Software_v1.0.5.exe).
 *
 * USB HID, VID 0x0471 PID 0x13AA. Every exchange is one 64-byte output
 * report followed by one 64-byte input report:
 *   out: [0x04, cmd, addrHi, addrLo, len (<=59), data...]
 *   in : [id, status(!=0 ok), err(0 ok for reads), ?, ?, data...]
 *
 * Works in Node (tests) and in the browser/Electron renderer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Axon = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VENDOR_ID = 0x0471;
  const PRODUCT_ID = 0x13aa;
  const REPORT_ID = 0x04;
  const CHUNK = 59;
  const PARAM_LEN = 0x5f;
  const PACKET_DELAY_MS = 25;

  const CMD = {
    MODULE_STATUS: 0x91,
    MODULE_INIT: 0x90,
    IDENTIFY: 0x8a,
    READ_PARAMS: 0xcd,
    WRITE_PARAMS: 0xcb,
    FACTORY_DEFAULT: 0x5a,
  };

  // Servo families, as the original tool tells them apart.
  const FAMILY = {
    AAS: 'AAS', // standard Axon servos: full parameter page
    UPL: 'UPL', // reduced page: inversion, max power, ProPTL
    ANS: 'ANS', // recognised but the original software exposes no parameters
  };

  const PPM_RANGES = [
    { label: '500 – 2500 µs', hi: 0x3bd0, lo: 0x0bf6 },
    { label: '900 – 2100 µs', hi: 0x323e, lo: 0x1588 },
    { label: '1100 – 1900 µs', hi: 0x2d75, lo: 0x1a51 },
  ];
  const NB_RANGE = { label: '450 – 1050 µs (Narrow Band)', hi: 0x191f, lo: 0x0ac4 };
  const SSR_RANGE = { label: '130 – 470 µs (Sanwa SSR)', hi: 0x0b3e, lo: 0x031c };

  const LOST_PPM = ['Release', 'Keep Position', 'Go to Neutral'];

  const LIMITS = {
    range: [1, 255],
    neutral: [-127, 127],
    deadband: [0, 3],
    maxPower: [100, 255],
    damping: [50, 600],
    ppmRange: [0, 2],
    olPower: [0, 100], // percent
    olTime: [0, 26], // seconds (byte * 0.102)
    uplMaxPower: [100, 255],
    uplProPTL: [0, 255],
  };

  /*
   * SAFETY. Only these commands can ever be sent. Firmware commands used by the
   * Windows "UPF" tab (0x80-0x83) are deliberately absent, so this app cannot
   * erase or flash a servo even if there were a bug elsewhere.
   */
  const ALLOWED_CMDS = new Set([0x91, 0x90, 0x8a, 0xcd, 0xcb, 0x5a]);

  /*
   * SAFETY. The only parameter-block bytes a write may change, per family.
   * These are exactly the bytes the Windows software's encoders touch.
   * Everything else (calibration, identity, unknown bytes) is always copied
   * back unchanged from what the servo currently holds.
   */
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const WRITABLE = {
    AAS: new Set([...range(0x00, 0x06), 0x0a, 0x0b, 0x0c, 0x0f, 0x11, 0x12, 0x13, 0x25, ...range(0x27, 0x2c), ...range(0x35, 0x3a)]),
    UPL: new Set([0x12, 0x25, 0x36]),
  };

  // Manufacture date (0x30-0x32) and model name (0x40-0x47).
  const IDENTITY_BYTES = [0x30, 0x31, 0x32, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, [a, b]) => Math.min(b, Math.max(a, v));
  const u16 = (p, i) => (p[i] << 8) | p[i + 1];
  const put16 = (p, i, v) => { p[i] = (v >> 8) & 0xff; p[i + 1] = v & 0xff; };

  const olPowerOf = (b) => Math.round(((b * 100) / 255) * 10) / 10; // %
  const olTimeOf = (b) => Math.round(b * 0.102 * 1000) / 1000; // seconds

  class ProtocolError extends Error {}

  /* ---------------------------------------------------------------- codec */

  function decodeInfo(P) {
    let name = '';
    for (let i = 0; i < 8; i++) {
      const c = P[0x40 + i];
      name += c === 0x2a || c === 0 ? ' ' : String.fromCharCode(c);
    }
    return {
      name: name.trim(),
      manufactured: `${2000 + P[0x32]}/${P[0x31]}/${P[0x30]}`,
    };
  }

  function decodeAAS(P) {
    const f = P[0x25];
    const s = {
      softStart: !!(f & 0x10),
      narrowBand: !!(f & 0x08),
      sanwaSSR: !!(f & 0x04),
      inversion: !!(f & 0x02),
      overload: !!(f & 0x80),
      lostPPM: f & 0x40 ? (f & 0x20 ? 2 : 1) : 0,
      range: P[0x04],
      neutral: P[0x06] - 128,
      deadband: 0,
      ppmRange: 2,
      maxPower: 0,
      damping: 0,
      olLevels: [],
    };
    const n = P[0x0c] >> 4;
    s.deadband = n > 1 ? n - 1 : 0;
    if (s.deadband > 3) s.deadband = 3;

    const us = u16(P, 0) * 0.16326530612244897;
    s.ppmRange = us > 2450 ? 0 : us > 2005 ? 1 : 2;

    if (P[0x26] & 0x40) { s.maxPower = P[0x13]; s.damping = u16(P, 0x27); }
    else { s.maxPower = P[0x12]; s.damping = u16(P, 0x0a); }

    for (let i = 0; i < 3; i++) {
      s.olLevels.push({
        power: olPowerOf(P[0x35 + 2 * i]),
        time: olTimeOf(P[0x36 + 2 * i]),
        rawPower: P[0x35 + 2 * i],
        rawTime: P[0x36 + 2 * i],
      });
    }
    return s;
  }

  function setInversion(P, on) {
    // The original toggles bit 0 whenever bit 1 (inversion) changes.
    const was = !!(P[0x25] & 0x02);
    if (on === was) return;
    if (on) P[0x25] |= 0x02; else P[0x25] &= ~0x02 & 0xff;
    P[0x25] ^= 0x01;
  }

  function encodeAAS(src, s) {
    const P = Uint8Array.from(src);
    const range = clamp(s.range | 0, LIMITS.range);

    if (s.softStart) P[0x25] |= 0x10; else P[0x25] &= 0xef;

    let ppm;
    if (s.narrowBand) { P[0x25] |= 0x08; ppm = NB_RANGE; }
    else if (s.sanwaSSR) { P[0x25] |= 0x04; ppm = SSR_RANGE; }
    else { P[0x25] &= 0xf3; ppm = PPM_RANGES[clamp(s.ppmRange | 0, LIMITS.ppmRange)]; }
    put16(P, 0, ppm.hi);
    put16(P, 2, ppm.lo);
    P[0x04] = range;
    P[0x05] = range;

    setInversion(P, !!s.inversion);

    if (s.overload) {
      P[0x25] |= 0x80;
      s.olLevels.forEach((lv, i) => {
        // Keep the original byte if the user didn't touch it (avoids rounding drift).
        P[0x35 + 2 * i] = lv.rawPower !== undefined && lv.power === olPowerOf(lv.rawPower)
          ? lv.rawPower
          : clamp(Math.round((lv.power * 255) / 100), [0, 255]);
        P[0x36 + 2 * i] = lv.rawTime !== undefined && lv.time === olTimeOf(lv.rawTime)
          ? lv.rawTime
          : clamp(Math.round(lv.time / 0.102), [0, 255]);
      });
    } else {
      P[0x25] &= 0x7f;
    }

    const lost = clamp(s.lostPPM | 0, [0, 2]);
    if (lost === 0) P[0x25] &= 0x9f;
    else if (lost === 1) { P[0x25] &= 0xdf; P[0x25] |= 0x40; }
    else P[0x25] |= 0x60;

    P[0x06] = (clamp(s.neutral | 0, LIMITS.neutral) + 0x80) & 0xff;
    P[0x0c] = ((clamp(s.deadband | 0, LIMITS.deadband) + 1) << 4) & 0xff;

    const pwr = clamp(s.maxPower | 0, LIMITS.maxPower);
    P[0x12] = pwr; P[0x13] = pwr; P[0x11] = pwr;
    P[0x0f] = (pwr - 20) & 0xff;

    const damp = clamp(s.damping | 0, LIMITS.damping);
    put16(P, 0x0a, damp); put16(P, 0x27, damp);
    put16(P, 0x29, damp); put16(P, 0x2b, damp);
    return P;
  }

  function decodeUPL(P) {
    return { inversion: !!(P[0x25] & 0x02), maxPower: P[0x12], proPTL: P[0x36] };
  }

  function encodeUPL(src, s) {
    const P = Uint8Array.from(src);
    setInversion(P, !!s.inversion);
    P[0x12] = clamp(s.maxPower | 0, [0, 255]);
    P[0x36] = clamp(s.proPTL | 0, LIMITS.uplProPTL);
    return P;
  }

  function decode(family, P) {
    if (family === FAMILY.AAS) return decodeAAS(P);
    if (family === FAMILY.UPL) return decodeUPL(P);
    return {};
  }
  function encode(family, P, s) {
    if (family === FAMILY.AAS) return encodeAAS(P, s);
    if (family === FAMILY.UPL) return encodeUPL(P, s);
    throw new ProtocolError('This servo type has no writable parameters.');
  }

  /* -------------------------------------------------------------- checks */

  /** Returns a reason string if a block is clearly not a valid parameter block. */
  function hardCheck(P) {
    if (!P || P.length !== PARAM_LEN) return 'the servo returned the wrong amount of data.';
    const first = P[0];
    if (P.every((b) => b === first)) return 'the servo returned blank data (every byte the same).';
    for (let i = 0x40; i < 0x48; i++) {
      const c = P[i];
      if (c !== 0 && (c < 0x20 || c > 0x7e)) return 'the servo name area contains unexpected data.';
    }
    return null;
  }

  /**
   * Non-fatal: things the Windows software always leaves consistent. If any
   * are off, the servo may use a layout this app doesn't know, so the UI asks
   * for extra confirmation before writing.
   */
  function softCheck(family, P) {
    const w = [];
    if (family !== FAMILY.AAS) return w;
    const hi = u16(P, 0);
    const known = [...PPM_RANGES, NB_RANGE, SSR_RANGE].map((r) => r.hi);
    if (!known.includes(hi)) w.push('PPM range value is not one the Windows software uses');
    if (P[4] === 0) w.push('Range is 0');
    if (P[4] !== P[5]) w.push('the two Range bytes differ');
    const sens = P[0x0c] >> 4;
    if ((P[0x0c] & 0x0f) !== 0 || sens < 1 || sens > 4) w.push('Sensitivity byte is out of the usual range');
    const damp = u16(P, P[0x26] & 0x40 ? 0x27 : 0x0a);
    if (damp < 50 || damp > 600) w.push('Damping is outside 50–600');
    const pwr = P[P[0x26] & 0x40 ? 0x13 : 0x12];
    if (pwr < 100) w.push('Max Power is below 100');
    return w;
  }

  /* ----------------------------------------------------------- transport */

  /**
   * transport.exchange(Uint8Array(64)) -> Promise<Uint8Array(64)>
   * byte 0 of both is the report id.
   */
  class Programmer {
    constructor(transport, { delay = PACKET_DELAY_MS, log = () => {} } = {}) {
      this.t = transport;
      this.delay = delay;
      this.log = log;
      this.busy = Promise.resolve();
    }

    // Serialise all USB traffic so overlapping clicks can't interleave packets.
    _lock(fn) {
      const run = this.busy.then(fn, fn);
      this.busy = run.catch(() => {});
      return run;
    }

    async _packet(cmd, addr, len, data) {
      if (!ALLOWED_CMDS.has(cmd)) throw new ProtocolError(`Blocked command 0x${cmd.toString(16)}.`);
      if (len > CHUNK) throw new ProtocolError('Packet too long.');
      const out = new Uint8Array(64);
      out[0] = REPORT_ID; out[1] = cmd;
      out[2] = (addr >> 8) & 0xff; out[3] = addr & 0xff; out[4] = len;
      if (data) out.set(data.subarray(0, len), 5);
      if (this.delay) await sleep(this.delay);
      const r = await this.t.exchange(out);
      if (!r || r.length < 5) throw new ProtocolError('No reply from programmer.');
      return r;
    }

    async _read(cmd, addr, length) {
      const buf = new Uint8Array(length);
      let off = 0;
      while (off < length) {
        const n = Math.min(CHUNK, length - off);
        const r = await this._packet(cmd, addr + off, n);
        if (r[1] === 0 || r[2] !== 0) {
          throw new ProtocolError(`Read 0x${cmd.toString(16)} rejected (status ${r[1]}, ${r[2]}).`);
        }
        buf.set(r.subarray(5, 5 + n), off);
        off += n;
      }
      return buf;
    }

    async _write(cmd, addr, data) {
      let off = 0;
      while (off < data.length) {
        const n = Math.min(CHUNK, data.length - off);
        const r = await this._packet(cmd, addr + off, n, data.subarray(off, off + n));
        if (r[1] === 0) throw new ProtocolError(`Write 0x${cmd.toString(16)} rejected.`);
        off += n;
      }
    }

    /** Adapter handshake done by the original when the USB stick is plugged in. */
    initModule() {
      return this._lock(async () => {
        let st = await this._read(CMD.MODULE_STATUS, 0, 0x20);
        if (st[0] === 1) return true;
        if (st[0] === 0) {
          await this._write(CMD.MODULE_INIT, 0x100, st);
          st = await this._read(CMD.MODULE_STATUS, 0, 0x20);
          return st[0] === 1;
        }
        return false;
      });
    }

    _identify() {
      return this._read(CMD.IDENTIFY, 0, 4).then((d) => {
        const version = 'V' + [d[1], d[2], d[3]].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
        let family = null;
        if (d[0] === 3 && d[2] === 1) family = FAMILY.AAS;
        else if (d[0] === 2 && d[2] === 1) family = FAMILY.ANS;
        else if (d[0] === 4) family = FAMILY.UPL;
        return { family, version, raw: Array.from(d) };
      });
    }

    /**
     * Presence check, exactly like the Windows tool's 300 ms timer:
     * one identify packet; a servo is present only if the reply is
     * status 1 / error 0 and the type is AAS (3) or UPL (4) with byte 2 == 1.
     * Never throws for a missing servo; resolves null instead.
     */
    probe() {
      return this._lock(async () => {
        const r = await this._packet(CMD.IDENTIFY, 0, 4);
        if (r[1] !== 1 || r[2] !== 0) return null;
        const d = r.subarray(5, 9);
        if (d[2] !== 1) return null;
        if (d[0] === 3) return FAMILY.AAS;
        if (d[0] === 4) return FAMILY.UPL;
        return null;
      });
    }

    /** Identify the servo and read its parameter block. */
    readServo() {
      return this._lock(async () => {
        const id = await this._identify();
        if (!id.family) throw new ProtocolError('No servo detected. Check the servo is plugged into the programmer.');
        const block = await this._read(CMD.READ_PARAMS, 0, PARAM_LEN);
        return {
          ...id,
          ...(id.family === FAMILY.ANS ? { name: '', manufactured: '' } : decodeInfo(block)),
          block,
          settings: decode(id.family, block),
        };
      });
    }

    /**
     * Read-modify-write exactly like the original, with extra safety checks,
     * then read back and verify. Returns the freshly read servo state.
     *
     * expect: { family, version, block } from the read the user edited. The
     * write is refused if a different servo (or a changed one) is now plugged in.
     * rawBlock: restore a backup; only WRITABLE bytes are taken from it.
     */
    writeServo(settings, { rawBlock, expect } = {}) {
      return this._lock(async () => {
        const id = await this._identify();
        if (!id.family) throw new ProtocolError('No servo detected.');
        if (!WRITABLE[id.family]) throw new ProtocolError('This servo type has no writable parameters.');
        if (expect && (expect.family !== id.family || expect.version !== id.version)) {
          throw new ProtocolError('A different servo is plugged in now. Nothing was written. Read it first.');
        }
        const current = await this._read(CMD.READ_PARAMS, 0, PARAM_LEN);
        const sanity = hardCheck(current);
        if (sanity) throw new ProtocolError(`Refusing to write: ${sanity} Nothing was written.`);
        if (expect && expect.block) {
          for (const i of IDENTITY_BYTES) {
            if (current[i] !== expect.block[i]) throw new ProtocolError('A different servo is plugged in now. Nothing was written. Read it first.');
          }
        }

        let next;
        if (rawBlock) {
          if (rawBlock.length !== PARAM_LEN) throw new ProtocolError('Backup has the wrong size. Nothing was written.');
          next = Uint8Array.from(current);
          for (const i of WRITABLE[id.family]) next[i] = rawBlock[i];
        } else {
          next = encode(id.family, current, settings);
        }
        if (next.length !== PARAM_LEN) throw new ProtocolError('Bad parameter block length.');
        // Belt and braces: anything outside the writable set must be untouched.
        for (let i = 0; i < PARAM_LEN; i++) {
          if (!WRITABLE[id.family].has(i) && next[i] !== current[i]) {
            throw new ProtocolError(`Internal safety check failed (byte 0x${i.toString(16)}). Nothing was written.`);
          }
        }
        let changed = 0;
        for (let i = 0; i < PARAM_LEN; i++) if (next[i] !== current[i]) changed++;
        if (changed) await this._write(CMD.WRITE_PARAMS, 0, next);

        const back = await this._read(CMD.READ_PARAMS, 0, PARAM_LEN);
        const mismatch = [];
        for (let i = 0; i < PARAM_LEN; i++) if (back[i] !== next[i]) mismatch.push(i);
        return {
          ...id, ...decodeInfo(back), block: back,
          settings: decode(id.family, back), previous: current, mismatch, changedBytes: changed,
        };
      });
    }

    factoryDefault() {
      return this._lock(async () => {
        const id = await this._identify().catch(() => ({}));
        if (!id.family || !WRITABLE[id.family]) throw new ProtocolError('No supported servo detected. Nothing was reset.');
        const r = await this._read(CMD.FACTORY_DEFAULT, 0, 1);
        if (r[0] !== 0xaa) throw new ProtocolError("Servo refused factory reset.");
        return true;
      });
    }
  }

  /* ------------------------------------------------------- mock (tests/demo) */

  class MockServo {
    constructor({ family = FAMILY.AAS, moduleState = 1 } = {}) {
      this.module = moduleState;
      this.type = family === FAMILY.UPL ? [4, 0x01, 0x01, 0x03] : family === FAMILY.ANS ? [2, 0x01, 0x01, 0x00] : [3, 0x02, 0x01, 0x05];
      const P = new Uint8Array(PARAM_LEN);
      put16(P, 0, 0x3bd0); put16(P, 2, 0x0bf6);
      P[4] = P[5] = 255; P[6] = 128; P[0x0c] = 0x10;
      P[0x0f] = 235; P[0x11] = P[0x12] = P[0x13] = 255;
      put16(P, 0x0a, 200); put16(P, 0x27, 200); put16(P, 0x29, 200); put16(P, 0x2b, 200);
      P[0x25] = 0x10 | 0x80; P[0x26] = 0x00;
      P[0x35] = 204; P[0x36] = 20; P[0x37] = 153; P[0x38] = 40; P[0x39] = 102; P[0x3a] = 80;
      P[0x30] = 12; P[0x31] = 6; P[0x32] = 23;
      'AXON MAX'.split('').forEach((c, i) => (P[0x40 + i] = c === ' ' ? 0x2a : c.charCodeAt(0)));
      P[0x50] = 0x5a; // some opaque calibration byte we must never lose
      this.P = P;
      this.factory = Uint8Array.from(P);
      this.status = new Uint8Array(0x20);
      this.present = true;
      this.packets = [];
    }
    async exchange(out) {
      this.packets.push(Array.from(out.subarray(0, 5)));
      const r = new Uint8Array(64);
      r[0] = REPORT_ID; r[1] = 1; r[2] = 0;
      const cmd = out[1], addr = (out[2] << 8) | out[3], n = out[4];
      if (out[0] !== REPORT_ID || n > CHUNK) { r[1] = 0; return r; }
      if (!this.present && cmd !== CMD.MODULE_STATUS && cmd !== CMD.MODULE_INIT) { r[1] = 0; return r; }
      const src = {
        [CMD.MODULE_STATUS]: () => { const s = new Uint8Array(0x20); s[0] = this.module; return s; },
        [CMD.IDENTIFY]: () => Uint8Array.from(this.type),
        [CMD.READ_PARAMS]: () => this.P,
        [CMD.FACTORY_DEFAULT]: () => { this.P = Uint8Array.from(this.factory); return Uint8Array.of(0xaa); },
      }[cmd];
      if (cmd === CMD.WRITE_PARAMS) { this.P.set(out.subarray(5, 5 + n), addr); return r; }
      if (cmd === CMD.MODULE_INIT) { this.module = 1; return r; }
      if (!src) { r[1] = 0; return r; }
      const d = src();
      const a = cmd === CMD.FACTORY_DEFAULT ? 0 : addr;
      r.set(d.subarray(a, a + n), 5);
      return r;
    }
  }

  return {
    VENDOR_ID, PRODUCT_ID, REPORT_ID, PARAM_LEN, CMD, FAMILY, LIMITS,
    PPM_RANGES, NB_RANGE, SSR_RANGE, LOST_PPM,
    Programmer, MockServo, ProtocolError,
    decode, encode, decodeInfo, hardCheck, softCheck, WRITABLE, ALLOWED_CMDS, IDENTITY_BYTES,
  };
});
