'use strict';
/*
 * Self-updater using GitHub Releases (works for unsigned apps, unlike Squirrel).
 *
 * check()    -> newest release newer than the running version
 * download() -> DMG into a temp folder, with progress, size-verified
 * install()  -> mount DMG, verify bundle id + version, stage a copy,
 *               ad-hoc sign it, then a helper script swaps it in after
 *               the app quits and relaunches. Falls back to opening the
 *               DMG in Finder whenever an automatic install isn't safe.
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { execFile, spawn } = require('child_process');

const OWNER = 'PetrBytes';
const REPO = 'axon-servo-programmer-mac';
const BUNDLE_ID = 'nz.peter.axonprogrammer';
const APP_NAME = 'Axon Servo Programmer.app';

/* --------------------------------------------------------- pure helpers */

function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver comparison including pre-release tags. Returns -1, 0 or 1. */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1; // 1.0.0 > 1.0.0-beta
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

function pickAsset(assets, arch) {
  const dmgs = (assets || []).filter((a) => /\.dmg$/i.test(a.name));
  const other = arch === 'arm64' ? /x64|intel/i : /arm64|apple/i;
  return dmgs.find((a) => a.name.toLowerCase().includes(arch)) || dmgs.find((a) => !other.test(a.name)) || null;
}

/** From a GitHub releases list, pick the newest usable release newer than `current`. */
function pickRelease(releases, current, { includePrerelease = true, arch = 'arm64' } = {}) {
  let best = null;
  for (const r of releases || []) {
    if (r.draft) continue;
    if (r.prerelease && !includePrerelease) continue;
    if (!parseVersion(r.tag_name)) continue;
    const asset = pickAsset(r.assets, arch);
    if (!asset) continue;
    if (compareVersions(r.tag_name, current) <= 0) continue;
    if (!best || compareVersions(r.tag_name, best.tag_name) > 0) best = { ...r, asset };
  }
  if (!best) return null;
  return {
    version: best.tag_name.replace(/^v/i, ''),
    tag: best.tag_name,
    name: best.name || best.tag_name,
    notes: best.body || '',
    prerelease: !!best.prerelease,
    publishedAt: best.published_at,
    htmlUrl: best.html_url,
    asset: { name: best.asset.name, size: best.asset.size, url: best.asset.browser_download_url },
  };
}

/* ------------------------------------------------------------ main side */

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 120000, ...opts }, (err, stdout, stderr) => {
    if (err) { err.stderr = String(stderr || ''); reject(err); } else resolve(String(stdout || ''));
  });
});

function workDir() { return path.join(os.tmpdir(), 'axon-programmer-update'); }

/*
 * Each download gets its own fresh folder inside workDir(), so a new download
 * never has to delete anything first. Old folders are removed by clean(),
 * which never throws and never touches the folder currently in use.
 * (1.4.0 deleted workDir() before downloading; if the launch tidy-up was still
 * deleting the same folder, the two clashed with ENOTEMPTY.)
 */
let activeDir = null;
const RM_OPTS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

async function clean() {
  const root = workDir();
  let entries = [];
  try { entries = await fsp.readdir(root); } catch { return; }
  await Promise.all(entries.map(async (name) => {
    const full = path.join(root, name);
    if (activeDir && full === activeDir) return;
    try { await fsp.rm(full, RM_OPTS); } catch { /* best effort; retried next launch */ }
  }));
}

async function freshDir() {
  const dir = path.join(workDir(), `dl-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  await fsp.mkdir(dir, { recursive: true });
  activeDir = dir;
  return dir;
}

async function check(fetchImpl, current, opts) {
  const res = await fetchImpl(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=30`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AxonServoProgrammer' },
  });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub is rate-limiting update checks. Try again later.');
  if (!res.ok) throw new Error(`Couldn’t reach GitHub (HTTP ${res.status}).`);
  return pickRelease(await res.json(), current, opts);
}

async function download(fetchImpl, update, onProgress) {
  const dir = await freshDir();
  clean().catch(() => {}); // remove older downloads in the background
  const file = path.join(dir, path.basename(update.asset.name).replace(/[^A-Za-z0-9._-]/g, '_'));
  const res = await fetchImpl(update.asset.url, { headers: { 'User-Agent': 'AxonServoProgrammer' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || update.asset.size || 0;
  const out = fs.createWriteStream(file);
  let got = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      onProgress && onProgress(got, total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (update.asset.size && got !== update.asset.size) throw new Error('Download was incomplete. Please try again.');
  return file;
}

/** Where the running .app lives, or null if it can't be replaced in place. */
async function currentBundle(execPath) {
  const bundle = path.resolve(execPath, '..', '..', '..');
  if (!bundle.endsWith('.app')) return null;
  if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return null;
  try { await fsp.access(path.dirname(bundle), fs.constants.W_OK); } catch { return null; }
  return bundle;
}

async function plistValue(plist, key) {
  return (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).trim();
}

/**
 * Verify and stage the update. Returns { staged } or throws.
 * Nothing in the installed app is touched here.
 */
async function stage(dmgFile, expectedVersion) {
  const dir = path.dirname(dmgFile); // the download's own folder
  activeDir = dir;
  const mnt = path.join(dir, 'mnt');
  const stagedDir = path.join(dir, 'staged');
  await fsp.mkdir(mnt, { recursive: true });
  await fsp.rm(stagedDir, RM_OPTS);
  await fsp.mkdir(stagedDir, { recursive: true });
  await run('/usr/bin/hdiutil', ['attach', dmgFile, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt]);
  try {
    const src = path.join(mnt, APP_NAME);
    const plist = path.join(src, 'Contents', 'Info.plist');
    const id = await plistValue(plist, 'CFBundleIdentifier');
    if (id !== BUNDLE_ID) throw new Error('The downloaded app isn’t Axon Servo Programmer. Update cancelled.');
    const ver = await plistValue(plist, 'CFBundleShortVersionString');
    if (compareVersions(ver, expectedVersion.split('-')[0]) !== 0 && compareVersions(ver, expectedVersion) !== 0) {
      throw new Error(`The downloaded app is version ${ver}, expected ${expectedVersion}. Update cancelled.`);
    }
    await run('/usr/bin/ditto', [src, path.join(stagedDir, APP_NAME)]);
  } finally {
    await run('/usr/bin/hdiutil', ['detach', mnt, '-force']).catch(() => {});
  }
  const staged = path.join(stagedDir, APP_NAME);
  await run('/usr/bin/xattr', ['-cr', staged]).catch(() => {});
  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', staged]).catch(() => {});
  return staged;
}

const SWAP_SCRIPT = `#!/bin/bash
# Waits for the old app to quit, swaps in the new one, restores the old one on failure.
PID="$1"; TARGET="$2"; NEW="$3"
for i in $(seq 1 600); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
BACKUP="$(dirname "$TARGET")/.axon-old-$$.app"
if ! mv "$TARGET" "$BACKUP"; then open "$TARGET"; exit 1; fi
if /usr/bin/ditto "$NEW" "$TARGET"; then
  /usr/bin/xattr -cr "$TARGET" 2>/dev/null
  /usr/bin/codesign --force --deep --sign - "$TARGET" >/dev/null 2>&1
  rm -rf "$BACKUP"
else
  rm -rf "$TARGET"; mv "$BACKUP" "$TARGET"
fi
open "$TARGET"
`;

/** Launch the swap helper. Caller must quit the app right after. */
async function scheduleSwap(staged, target, pid) {
  const script = path.join(path.dirname(path.dirname(staged)), 'swap.sh');
  await fsp.writeFile(script, SWAP_SCRIPT, { mode: 0o755 });
  const child = spawn('/bin/bash', [script, String(pid), target, staged], { detached: true, stdio: 'ignore' });
  child.unref();
}

/** Fallback: put the DMG in Downloads and open it so the user can drag it in. */
async function openManually(dmgFile, downloadsDir, openPath) {
  const dest = path.join(downloadsDir, path.basename(dmgFile));
  await fsp.copyFile(dmgFile, dest);
  await openPath(dest);
  return dest;
}

module.exports = {
  OWNER, REPO, parseVersion, compareVersions, pickAsset, pickRelease,
  check, download, currentBundle, stage, scheduleSwap, openManually, workDir, clean, SWAP_SCRIPT,
};
