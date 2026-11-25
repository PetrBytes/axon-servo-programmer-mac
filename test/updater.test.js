const assert = require('node:assert/strict');
const test = require('node:test');
const U = require('../updater.js');

test('compareVersions handles semver and pre-releases', () => {
  const c = U.compareVersions;
  assert.equal(c('1.1.0', '1.0.9'), 1);
  assert.equal(c('v1.2.0', '1.2.0'), 0);
  assert.equal(c('1.2.0', '1.10.0'), -1);
  assert.equal(c('1.2.0-beta.1', '1.2.0'), -1);
  assert.equal(c('1.2.0-beta.2', '1.2.0-beta.10'), -1);
  assert.equal(c('1.2.0-rc.1', '1.2.0-beta.9'), 1);
  assert.equal(c('2.0.0', '1.99.99'), 1);
});

const rel = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, body: 'notes', assets: [{ name: `Axon-Servo-Programmer-${tag.slice(1)}-arm64.dmg`, size: 10, browser_download_url: `https://x/${tag}.dmg` }], ...extra });

test('pickRelease picks the newest newer release with a DMG', () => {
  const list = [rel('v1.1.0', { prerelease: true }), rel('v1.3.0', { draft: true }), rel('v1.2.0', { prerelease: true }), rel('v1.0.0')];
  assert.equal(U.pickRelease(list, '1.1.0').version, '1.2.0');
  assert.equal(U.pickRelease(list, '1.1.0', { includePrerelease: false }), null);
  assert.equal(U.pickRelease(list, '1.2.0'), null);
  assert.equal(U.pickRelease([rel('v9.0.0', { assets: [] })], '1.0.0'), null, 'needs a dmg');
});

test('pickAsset prefers matching architecture', () => {
  const assets = [{ name: 'A-1.2.0-x64.dmg' }, { name: 'A-1.2.0-arm64.dmg' }, { name: 'source.zip' }];
  assert.equal(U.pickAsset(assets, 'arm64').name, 'A-1.2.0-arm64.dmg');
  assert.equal(U.pickAsset(assets, 'x64').name, 'A-1.2.0-x64.dmg');
  assert.equal(U.pickAsset([{ name: 'A-1.2.0-x64.dmg' }], 'arm64'), null, 'never offers an Intel build to Apple Silicon');
});

test('currentBundle refuses translocated or read-only locations', async () => {
  assert.equal(await U.currentBundle('/private/var/folders/x/AppTranslocation/y/Axon Servo Programmer.app/Contents/MacOS/Axon Servo Programmer'), null);
  assert.equal(await U.currentBundle('/Volumes/Axon/Axon Servo Programmer.app/Contents/MacOS/Axon Servo Programmer'), null);
  assert.equal(await U.currentBundle('/usr/bin/node'), null);
});

test('check() parses the GitHub API response', async () => {
  const fake = async () => ({ ok: true, status: 200, json: async () => [rel('v1.2.0', { prerelease: true })] });
  const u = await U.check(fake, '1.1.0', { includePrerelease: true, arch: 'arm64' });
  assert.equal(u.version, '1.2.0');
  assert.equal(u.asset.size, 10);
  await assert.rejects(U.check(async () => ({ ok: false, status: 403 }), '1.1.0'), /rate-limiting/);
});

test('swap script is valid bash', () => {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const f = require('path').join(require('os').tmpdir(), 'swaptest.sh');
  fs.writeFileSync(f, U.SWAP_SCRIPT);
  execFileSync('bash', ['-n', f]);
});

test('download works while the launch cleanup is still deleting old update files', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-upd-test-'));
  try {
    // Leftover staged app from a previous update, with plenty of files.
    const res = path.join(U.workDir(), 'staged', 'Axon Servo Programmer.app', 'Contents', 'Resources');
    fs.mkdirSync(res, { recursive: true });
    for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(res, `f${i}`), 'x');
    const body = Buffer.from('dmg-bytes');
    const fakeFetch = async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    const update = { version: '9.9.9', asset: { name: 'Axon-9.9.9.dmg', url: 'x', size: body.length } };
    const [, file] = await Promise.all([U.clean(), U.download(fakeFetch, update)]);
    assert.equal(fs.readFileSync(file, 'utf8'), 'dmg-bytes');
    await U.clean(); // must keep the active download
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(path.join(U.workDir(), 'staged')), 'old leftovers removed');
  } finally {
    process.env.TMPDIR = saved;
  }
});
