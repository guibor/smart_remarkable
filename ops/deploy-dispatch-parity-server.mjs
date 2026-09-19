#!/usr/bin/env node
// Root-side, file-scoped server transaction. No transport, config, or credential writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BACKUP_ROOT = '/var/backups/smart-dispatch-parity';
export const BRIDGE_ROOT = '/home/mdf/.local/share/smart-remarkable-openclaw-bridge';
export const PLUGIN_ROOT = '/home/mdf/.openclaw/extensions/smart-remarkable-delivery';
const ANKI_ROOT = '/opt/anki-server/dist';
const ANKI_FILES = ['main-http.js', 'openclaw-handwriting-support.js', 'remarkable-agent-policy.js'];
export const PROTECTED_FILES = Object.freeze({
  'dispatch-filename-title.js': '439b8d16ae98018be45341effd525fc623d05d00d2b68320bef50db9b320c9ba',
  'dispatch-user-experience.js': 'ab0001ec375d5eb54da6e7820b5817f3cb29903ed4623ea88e2c825d67af1dca',
  'remarkable-research-handwriting.js': '67bd80a7ce65beb1a5d88c43fc42b911530d5be1dafefefacc81b355cfb0f012',
  'openclaw-dispatch-support.js': '451cfed7617e65db8ab992b5768d0418c308a22f0912b176613c012f0fc6088a',
  'multilingual-pdf.js': '64d5831e713c710e96b6dc0e67ae87dc7f1a25ab4e4af0e958d8375fac981d34',
});
const BRIDGE_UNIT = 'smart-remarkable-openclaw-bridge.service';
const GATEWAY_UNIT = 'openclaw-gateway.service';
const WATCHDOG_UNIT = 'openclaw-gateway-watchdog.timer';
const WATCHDOG_SERVICE = 'openclaw-gateway-watchdog.service';
const LOCK = '/run/smart-dispatch-parity.lock';
const SHA = /^[a-f0-9]{64}$/;
const TRANSACTION = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/;
const MAX_FILE = 8 * 1024 * 1024;
const self = fileURLToPath(import.meta.url);
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
function requireValue(ok, message) { if (!ok) throw new Error(message); }

export function allowedDestination(destination) {
  if (typeof destination !== 'string' || path.normalize(destination) !== destination) return false;
  if (destination === `${BRIDGE_ROOT}/metadata.json`) return true;
  if (ANKI_FILES.some((name) => destination === `${ANKI_ROOT}/${name}`)) return true;
  const roots = [`${BRIDGE_ROOT}/src`, `${BRIDGE_ROOT}/openclaw-plugin`, PLUGIN_ROOT];
  return roots.some((root) => {
    if (!destination.startsWith(`${root}/`)) return false;
    const name = destination.slice(root.length + 1);
    return /^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:mjs|py)$/.test(name) ||
      ['package.json', 'openclaw.plugin.json', 'metadata.json'].includes(name);
  });
}

export function validateManifest(manifest) {
  requireValue(manifest && TRANSACTION.test(manifest.transactionId), 'Invalid transaction ID');
  requireValue(Array.isArray(manifest.files) && manifest.files.length >= 3 && manifest.files.length <= 80,
    'Manifest must contain 3 to 80 exact files');
  const seen = new Set();
  for (const entry of manifest.files) {
    requireValue(allowedDestination(entry.destination), 'Destination outside the scoped source allowlist');
    requireValue(!seen.has(entry.destination), 'Duplicate destination'); seen.add(entry.destination);
    requireValue(typeof entry.source === 'string' && !path.isAbsolute(entry.source) &&
      path.normalize(entry.source) === entry.source && !entry.source.startsWith('../') &&
      !entry.source.includes('\0'), 'Unsafe stage source');
    requireValue(SHA.test(entry.sha256) && (entry.beforeSha256 === null || SHA.test(entry.beforeSha256)),
      'Each file needs exact candidate and preimage hashes (null means absent)');
  }
  for (const name of ANKI_FILES) requireValue(seen.has(`${ANKI_ROOT}/${name}`), `Missing required artifact: ${name}`);
  // No externally supplied path can weaken this fixed protected set.
  if (manifest.protected !== undefined) {
    requireValue(Array.isArray(manifest.protected), 'Invalid protected manifest');
    for (const item of manifest.protected) requireValue(
      PROTECTED_FILES[path.basename(item.path)] === item.sha256 &&
      item.path === `${ANKI_ROOT}/${path.basename(item.path)}`, 'Unknown protected artifact');
  }
  return manifest;
}

function noLinks(filename, missingLeaf = false) {
  const components = path.resolve(filename).split(path.sep).filter(Boolean);
  let current = '/';
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i]);
    try { requireValue(!fs.lstatSync(current).isSymbolicLink(), 'Symlink in transaction path'); }
    catch (error) {
      if (error.code === 'ENOENT' && missingLeaf && i === components.length - 1) return;
      throw error;
    }
  }
}
function readRegular(filename) {
  noLinks(filename);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    requireValue(stat.isFile() && stat.nlink === 1 && stat.size <= MAX_FILE, 'Unsafe or oversized transaction file');
    const data = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    requireValue(after.size === stat.size && after.mtimeMs === stat.mtimeMs && data.length === stat.size,
      'Transaction file changed during read');
    return { data, stat, sha256: hash(data) };
  } finally { fs.closeSync(fd); }
}
function present(filename) { try { fs.lstatSync(filename); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function currentHash(filename) { return present(filename) ? readRegular(filename).sha256 : null; }
function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45_000, ...options }).trim();
}
function sys(...args) { return run('/usr/bin/systemctl', args); }
export function gatewayCommandTimeout(action) {
  // The installed unit permits 60 seconds for graceful shutdown. Do not kill
  // our waiting systemctl client before that normal stop budget has elapsed.
  return ['stop', 'restart'].includes(action) ? 90_000 : 45_000;
}
function userSys(...args) {
  const uid = run('/usr/bin/id', ['-u', 'mdf']);
  return run('/usr/sbin/runuser', ['-u', 'mdf', '--', '/usr/bin/env', `XDG_RUNTIME_DIR=/run/user/${uid}`,
    '/usr/bin/systemctl', '--user', ...args], { timeout: gatewayCommandTimeout(args[0]) });
}
function active(fn, unit) { try { return fn('is-active', unit) === 'active'; } catch { return false; } }
function protectedCheck() {
  for (const [name, sha256] of Object.entries(PROTECTED_FILES))
    requireValue(currentHash(`${ANKI_ROOT}/${name}`) === sha256, `Protected artifact changed: ${name}`);
}
function acquireLock() {
  noLinks(LOCK, true);
  const fd = fs.openSync(LOCK, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    requireValue(stat.isFile() && stat.nlink === 1 && stat.uid === 0 && (stat.mode & 0o077) === 0,
      'Unsafe controller lock');
    // fd3 inherits the same open-file description. The kernel lock outlives
    // the short flock child and is released when this controller closes or
    // crashes. Never unlink the lock inode, which could permit two owners.
    run('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}
function pauseWatchdog() {
  sys('stop', WATCHDOG_UNIT);
  // Stopping a timer alone does not stop an already-running watchdog turn.
  sys('stop', WATCHDOG_SERVICE);
  requireValue(!active(sys, WATCHDOG_UNIT) && !active(sys, WATCHDOG_SERVICE), 'Gateway watchdog did not quiesce');
}
function atomicWrite(destination, data, { uid = 0, gid = 0, mode = 0o600 } = {}) {
  noLinks(path.dirname(destination)); noLinks(destination, true);
  const temporary = `${destination}.parity-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, data); fs.fchownSync(fd, uid, gid); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, destination); }
  catch (error) { fs.unlinkSync(temporary); throw error; }
  const directory = fs.openSync(path.dirname(destination), fs.constants.O_RDONLY); fs.fsyncSync(directory); fs.closeSync(directory);
}
function storeState(backup, state) { atomicWrite(`${backup}/transaction.json`, Buffer.from(JSON.stringify(state, null, 2))); }
function loadState(backup) {
  requireValue(path.dirname(backup) === BACKUP_ROOT && TRANSACTION.test(path.basename(backup)), 'Invalid backup path');
  noLinks(backup);
  const directory = fs.statSync(backup);
  requireValue(directory.uid === 0 && (directory.mode & 0o077) === 0, 'Backup is not root-private');
  const stateFile = readRegular(`${backup}/transaction.json`);
  requireValue(stateFile.stat.uid === 0 && (stateFile.stat.mode & 0o077) === 0, 'Unsealed transaction state');
  const state = JSON.parse(stateFile.data.toString('utf8'));
  validateManifest(state.manifest);
  requireValue(state.manifest.transactionId === path.basename(backup), 'Backup identity mismatch');
  return state;
}
function timerName(state) { return `smart-dispatch-parity-rollback-${state.manifest.transactionId}`; }
function verifyCurrent(state, candidate) {
  protectedCheck();
  for (const entry of state.files) requireValue(currentHash(entry.destination) ===
    (candidate ? entry.sha256 : entry.beforeSha256), `Runtime preimage mismatch: ${entry.destination}`);
}

function prepare(stage) {
  requireValue(path.isAbsolute(stage) && stage.startsWith('/home/mdf/') && path.normalize(stage) === stage,
    'Stage must be an absolute directory below /home/mdf');
  noLinks(stage);
  const manifest = validateManifest(JSON.parse(readRegular(`${stage}/manifest.json`).data.toString('utf8')));
  protectedCheck();
  requireValue(active(sys, 'anki-http.service') && active(sys, BRIDGE_UNIT) && active(userSys, GATEWAY_UNIT),
    'All three existing services must be active before preparation');
  if (!present(BACKUP_ROOT)) fs.mkdirSync(BACKUP_ROOT, { mode: 0o700 });
  noLinks(BACKUP_ROOT);
  const backup = `${BACKUP_ROOT}/${manifest.transactionId}`;
  fs.mkdirSync(backup, { mode: 0o700 });
  fs.mkdirSync(`${backup}/preimage`, { mode: 0o700 });
  fs.mkdirSync(`${backup}/candidate`, { mode: 0o700 });
  const files = manifest.files.map((entry, index) => {
    const source = path.join(stage, entry.source);
    requireValue(source.startsWith(`${stage}/`), 'Source escaped stage');
    const candidate = readRegular(source);
    requireValue(candidate.sha256 === entry.sha256, 'Candidate hash mismatch');
    const prior = present(entry.destination) ? readRegular(entry.destination) : null;
    requireValue((prior?.sha256 ?? null) === entry.beforeSha256, `Unexpected preimage: ${entry.destination}`);
    const record = `${index}`;
    atomicWrite(`${backup}/candidate/${record}`, candidate.data);
    if (prior) atomicWrite(`${backup}/preimage/${record}`, prior.data);
    const owner = prior?.stat ?? fs.statSync(path.dirname(entry.destination));
    return { ...entry, record, uid: owner.uid, gid: owner.gid, mode: prior ? prior.stat.mode & 0o777 : 0o644 };
  });
  const state = { manifest, files, phase: 'prepared', watchdogWasActive: active(sys, WATCHDOG_UNIT) };
  storeState(backup, state);
  atomicWrite(`${backup}/controller.mjs`, readRegular(self).data, { mode: 0o700 });
  run('/usr/bin/tar', ['-czf', `${backup}/preimage.tar.gz`, '-C', backup, 'preimage', 'transaction.json', 'controller.mjs']);
  fs.chmodSync(`${backup}/preimage.tar.gz`, 0o600);
  const archiveHash = readRegular(`${backup}/preimage.tar.gz`).sha256;
  console.log(JSON.stringify({ backup, archive: `${backup}/preimage.tar.gz`, sha256: archiveHash }));
}

export async function probeGatewayStartup(fetchFn = fetch) {
  try {
    // OpenClaw 2026.9.5's unauthenticated startup probe reflects completed
    // sidecar startup, unlike a bound TCP port or the basic liveness endpoint.
    const response = await fetchFn('http://127.0.0.1:18789/startupz', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2000),
    });
    if (response.status !== 200) return false;
    const body = await response.json();
    return body?.ok === true && body?.status === 'started';
  } catch { return false; }
}

export async function waitForGatewayReady({
  probe = probeGatewayStartup,
  serviceActive = () => active(userSys, GATEWAY_UNIT),
  timeoutMs = 180_000,
  intervalMs = 1500,
  now = () => performance.now(),
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
} = {}) {
  const started = now();
  const deadline = started + timeoutMs;
  while (now() < deadline) {
    // This is only the fixed loopback HTTP startup probe plus unit inspection:
    // no token, CLI, WebSocket authentication, model call, or registry probe.
    if (await probe() && serviceActive()) return { elapsedMs: Math.round(now() - started) };
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  throw new Error('Gateway startup readiness did not become ready within 180 seconds');
}

async function health() {
  const deadline = performance.now() + 90_000;
  while (performance.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:18792/health', { signal: AbortSignal.timeout(1500) });
      const body = await response.json();
      if (response.ok && body.status === 'ok' && active(sys, 'anki-http.service') &&
          active(sys, BRIDGE_UNIT) && active(userSys, GATEWAY_UNIT)) return;
    } catch {}
    const remaining = deadline - performance.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(1500, remaining)));
  }
  throw new Error('Current bridge capability health did not become ready');
}

export async function restartServicesInOrder({
  system = sys,
  gateway = userSys,
  waitGateway = waitForGatewayReady,
  waitBridge = health,
} = {}) {
  system('restart', 'anki-http.service');
  gateway('restart', GATEWAY_UNIT);
  // A cold Gateway can take longer than the old combined 52-second budget.
  // Keep the bridge stopped until its upstream has completed startup, avoiding repeated
  // client startup/ECONNREFUSED loops on the shared two-vCPU host.
  await waitGateway();
  system('start', BRIDGE_UNIT);
  await waitBridge();
}
function restoreFiles(backup, state) {
  // Refuse to overwrite another deployment that happened after this one.
  for (const entry of state.files) requireValue([entry.sha256, entry.beforeSha256].includes(currentHash(entry.destination)),
    `Rollback conflict: ${entry.destination}`);
  for (const entry of state.files) {
    if (entry.beforeSha256 === null) {
      if (present(entry.destination)) {
        fs.unlinkSync(entry.destination);
        const directory = fs.openSync(path.dirname(entry.destination), fs.constants.O_RDONLY);
        fs.fsyncSync(directory); fs.closeSync(directory);
      }
    }
    else {
      const prior = readRegular(`${backup}/preimage/${entry.record}`);
      requireValue(prior.sha256 === entry.beforeSha256, 'Rollback preimage corrupt');
      atomicWrite(entry.destination, prior.data, entry);
    }
  }
}
async function rollback(backup, state = loadState(backup)) {
  if (state.phase === 'committed' || state.phase === 'rolled_back') return;
  pauseWatchdog(); sys('stop', BRIDGE_UNIT); userSys('stop', GATEWAY_UNIT);
  restoreFiles(backup, state);
  verifyCurrent(state, false);
  await restartServicesInOrder();
  if (state.watchdogWasActive) sys('start', WATCHDOG_UNIT);
  state.phase = 'rolled_back'; storeState(backup, state);
  try { sys('stop', `${timerName(state)}.timer`); } catch {}
  console.log(JSON.stringify({ status: 'rolled_back', backup }));
}

async function confirmRollback(backup) {
  const state = loadState(backup);
  requireValue(state.phase === 'applying', 'Only an interrupted applying transaction can confirm rollback');
  // A previous controller may have restored every file but timed out during
  // cold startup. Confirm only that exact recovered state; never promote,
  // restore, or restart anything while closing this interrupted transaction.
  verifyCurrent(state, false);
  await health();
  verifyCurrent(state, false);
  if (state.watchdogWasActive) sys('start', WATCHDOG_UNIT);
  state.phase = 'rolled_back'; storeState(backup, state);
  sys('stop', `${timerName(state)}.timer`);
  console.log(JSON.stringify({ status: 'rolled_back', method: 'confirmed-existing-recovery', backup }));
}
async function apply(backup, receipt) {
  const state = loadState(backup);
  requireValue(state.phase === 'prepared', 'Transaction is not prepared');
  requireValue(SHA.test(receipt) && readRegular(`${backup}/preimage.tar.gz`).sha256 === receipt,
    'Provide the verified off-host backup SHA-256');
  verifyCurrent(state, false);
  for (const entry of state.files) requireValue(readRegular(`${backup}/candidate/${entry.record}`).sha256 === entry.sha256,
    'Sealed candidate changed');
  // The independent root timer survives this process and SSH disconnection.
  run('/usr/bin/systemd-run', ['--unit', timerName(state), '--on-active=900s', '--timer-property=AccuracySec=1s',
    '--property=Type=oneshot', '--property=Restart=on-failure', '--property=RestartSec=5s',
    '/usr/bin/node', `${backup}/controller.mjs`, 'rollback', backup]);
  state.phase = 'applying'; storeState(backup, state);
  try {
    // Quiesce both producers before replacing plugin modules so an unrelated
    // Gateway turn cannot observe a mixed-generation module tree.
    pauseWatchdog(); sys('stop', BRIDGE_UNIT); userSys('stop', GATEWAY_UNIT);
    for (const entry of state.files) atomicWrite(entry.destination, readRegular(`${backup}/candidate/${entry.record}`).data, entry);
    verifyCurrent(state, true);
    for (const entry of state.files) {
      if (/\.(?:js|mjs)$/.test(entry.destination)) run('/usr/bin/node', ['--check', entry.destination]);
      if (entry.destination.endsWith('.json')) JSON.parse(readRegular(entry.destination).data.toString('utf8'));
    }
    // Evaluate imports as the bridge identity, never as root. No model call.
    run('/usr/sbin/runuser', ['-u', 'mdf', '--', '/usr/bin/node', '--input-type=module', '-e',
      `const p=await import('${ANKI_ROOT}/remarkable-agent-policy.js'); if(p.REMARKABLE_AGENT_POLICY_VERSION!=='remarkable-agent-policy-v1'||p.REMARKABLE_AGENT_DEFAULT_MODEL!=='openai/gpt-6-astra'||p.REMARKABLE_AGENT_DEFAULT_THINKING!=='low')process.exit(1);`]);
    await restartServicesInOrder();
    state.phase = 'applied'; storeState(backup, state);
    console.log(JSON.stringify({ status: 'applied', backup, rollbackAfterSeconds: 900, commitRequired: true }));
  } catch (error) { await rollback(backup, state); throw error; }
}
async function commit(backup) {
  const state = loadState(backup);
  requireValue(state.phase === 'applied', 'Only a verified applied transaction can be committed');
  verifyCurrent(state, true); await health();
  if (state.watchdogWasActive) sys('start', WATCHDOG_UNIT);
  // A late queued rollback reads this marker and cannot undo a commit.
  state.phase = 'committed'; storeState(backup, state);
  sys('stop', `${timerName(state)}.timer`);
  console.log(JSON.stringify({ status: 'committed', backup }));
}

export async function main(argv = process.argv.slice(2)) {
  const [mode, location, receipt] = argv;
  requireValue(['prepare', 'apply', 'commit', 'rollback', 'confirm-rollback'].includes(mode) && location &&
    argv.length === (mode === 'apply' ? 3 : 2),
    'usage: controller prepare STAGE | apply BACKUP OFFHOST_SHA256 | commit BACKUP | rollback BACKUP | confirm-rollback BACKUP');
  requireValue(process.getuid?.() === 0, 'Run the sealed server controller as root');
  // Controllers are short; a busy lock prevents races with another promotion.
  const lock = acquireLock();
  try {
    if (mode === 'prepare') prepare(location);
    if (mode === 'apply') await apply(location, receipt);
    if (mode === 'commit') await commit(location);
    if (mode === 'rollback') await rollback(location);
    if (mode === 'confirm-rollback') await confirmRollback(location);
  } finally { fs.closeSync(lock); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().catch((error) => { console.error(`Dispatch parity transaction failed: ${error.message}`); process.exitCode = 1; });
}
