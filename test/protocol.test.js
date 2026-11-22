const assert = require('node:assert/strict');
const test = require('node:test');
const A = require('../src/protocol.js');

const mk = (opts) => { const m = new A.MockServo(opts); return [m, new A.Programmer(m, { delay: 0 })]; };

test('chunking matches original (59 + 36 bytes, report id 4)', async () => {
  const [m, p] = mk();
  await p.readServo();
  const reads = m.packets.filter((x) => x[1] === A.CMD.READ_PARAMS);
  assert.deepEqual(reads.map((x) => [x[0], (x[2] << 8) | x[3], x[4]]), [[4, 0, 59], [4, 59, 36]]);
});

test('decode mock servo', async () => {
  const [, p] = mk();
  const s = await p.readServo();
  assert.equal(s.family, 'AAS');
  assert.equal(s.version, 'V020105');
  assert.equal(s.name, 'AXON MAX');
  assert.equal(s.manufactured, '2023/6/12');
  assert.equal(s.settings.range, 255);
  assert.equal(s.settings.neutral, 0);
  assert.equal(s.settings.ppmRange, 0);
  assert.equal(s.settings.deadband, 0);
  assert.equal(s.settings.maxPower, 255);
  assert.equal(s.settings.damping, 200);
  assert.equal(s.settings.softStart, true);
  assert.equal(s.settings.overload, true);
  assert.equal(s.settings.olLevels[0].power, 80);
});

test('write with no changes leaves every byte identical', async () => {
  const [m, p] = mk();
  const before = Uint8Array.from(m.P);
  const s = await p.readServo();
  const r = await p.writeServo(JSON.parse(JSON.stringify(s.settings)));
  assert.deepEqual(Array.from(m.P), Array.from(before));
  assert.deepEqual(r.mismatch, []);
});

test('write changes the right bytes only', async () => {
  const [m, p] = mk();
  const before = Uint8Array.from(m.P);
  const s = (await p.readServo()).settings;
  Object.assign(s, { range: 180, neutral: -10, deadband: 2, maxPower: 200, damping: 450, ppmRange: 1, lostPPM: 2, softStart: false });
  await p.writeServo(s);
  const P = m.P;
  assert.equal(P[4], 180); assert.equal(P[5], 180);
  assert.equal(P[6], 118);
  assert.equal(P[0x0c], 0x30);
  assert.deepEqual([P[0x0f], P[0x11], P[0x12], P[0x13]], [180, 200, 200, 200]);
  for (const o of [0x0a, 0x27, 0x29, 0x2b]) assert.equal((P[o] << 8) | P[o + 1], 450);
  assert.deepEqual([P[0], P[1], P[2], P[3]], [0x32, 0x3e, 0x15, 0x88]);
  assert.equal(P[0x25] & 0x60, 0x60);
  assert.equal(P[0x25] & 0x10, 0);
  assert.equal(P[0x50], before[0x50], 'opaque bytes preserved');
  for (const i of [0x30,0x31,0x32,0x40,0x41,0x42,0x43,0x44,0x45,0x46,0x47]) assert.equal(P[i], before[i], "identity untouched");
  const again = await p.readServo();
  assert.equal(again.settings.range, 180);
  assert.equal(again.settings.neutral, -10);
  assert.equal(again.settings.deadband, 2);
  assert.equal(again.settings.ppmRange, 1);
  assert.equal(again.settings.lostPPM, 2);
});

test('inversion toggles bit 1 and flips bit 0, like the original', async () => {
  const [m, p] = mk();
  const f0 = m.P[0x25];
  const s = (await p.readServo()).settings;
  s.inversion = true; await p.writeServo(s);
  assert.equal(m.P[0x25], (f0 | 2) ^ 1);
  s.inversion = false; await p.writeServo(s);
  assert.equal(m.P[0x25], f0);
});

test('narrow band / SSR use fixed PPM windows', async () => {
  const [m, p] = mk();
  const s = (await p.readServo()).settings;
  s.narrowBand = true; await p.writeServo(s);
  assert.deepEqual(Array.from(m.P.subarray(0, 4)), [0x19, 0x1f, 0x0a, 0xc4]);
  assert.equal((await p.readServo()).settings.narrowBand, true);
  s.narrowBand = false; s.sanwaSSR = true; await p.writeServo(s);
  assert.deepEqual(Array.from(m.P.subarray(0, 4)), [0x0b, 0x3e, 0x03, 0x1c]);
});

test('overload levels round-trip and edits encode correctly', async () => {
  const [m, p] = mk();
  const s = (await p.readServo()).settings;
  s.olLevels[1].power = 50; s.olLevels[2].time = 4.08;
  await p.writeServo(s);
  assert.equal(m.P[0x37], 128);
  assert.equal(m.P[0x3a], 40);
  assert.equal(m.P[0x35], 204, 'untouched level kept');
  s.overload = false; await p.writeServo(s);
  assert.equal(m.P[0x25] & 0x80, 0);
});

test('UPL family', async () => {
  const [m, p] = mk({ family: 'UPL' });
  const s = await p.readServo();
  assert.equal(s.family, 'UPL');
  s.settings.maxPower = 150; s.settings.proPTL = 77;
  await p.writeServo(s.settings);
  assert.equal(m.P[0x12], 150); assert.equal(m.P[0x36], 77);
});

test('ANS family is read-only', async () => {
  const [, p] = mk({ family: 'ANS' });
  assert.equal((await p.readServo()).family, 'ANS');
  await assert.rejects(p.writeServo({}), /no writable/);
});

test('module init handshake', async () => {
  const [m, p] = mk({ moduleState: 0 });
  assert.equal(await p.initModule(), true);
  assert.ok(m.packets.some((x) => x[1] === 0x90 && ((x[2] << 8) | x[3]) === 0x100));
});

test('factory default', async () => {
  const [m, p] = mk();
  const s = (await p.readServo()).settings; s.range = 10; await p.writeServo(s);
  await p.factoryDefault();
  assert.equal((await p.readServo()).settings.range, 255);
});

test('rejected reads raise errors', async () => {
  const p = new A.Programmer({ exchange: async () => { const r = new Uint8Array(64); r[1] = 0; return r; } }, { delay: 0 });
  await assert.rejects(p.readServo(), /rejected/);
});

test('concurrent calls are serialised', async () => {
  const [m, p] = mk();
  await Promise.all([p.readServo(), p.readServo(), p.readServo()]);
  const seq = m.packets.map((x) => x[1]);
  assert.deepEqual(seq, Array(3).fill([0x8a, 0xcd, 0xcd]).flat());
});

test('restore raw backup', async () => {
  const [m, p] = mk();
  const backup = Uint8Array.from(m.P);
  const s = (await p.readServo()).settings; s.range = 5; s.damping = 600; await p.writeServo(s);
  await p.writeServo(null, { rawBlock: backup });
  assert.deepEqual(Array.from(m.P), Array.from(backup));
});

test('probe follows the Windows timer rules', async () => {
  const [m, p] = mk();
  assert.equal(await p.probe(), 'AAS');
  m.present = false;
  assert.equal(await p.probe(), null);
  m.present = true;
  const [, pu] = mk({ family: 'UPL' });
  assert.equal(await pu.probe(), 'UPL');
  const [, pa] = mk({ family: 'ANS' });
  assert.equal(await pa.probe(), null);
});
