import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
  allowedDestination, validateManifest, PROTECTED_FILES, BRIDGE_ROOT, PLUGIN_ROOT,
  waitForGatewayReady, restartServicesInOrder, probeGatewayStartup,
  gatewayCommandTimeout,
} from '../ops/deploy-dispatch-parity-server.mjs';

const sha256 = 'a'.repeat(64);
test('Gateway stop and restart waits exceed its live 60-second graceful-stop budget', () => {
  for (const action of ['stop', 'restart']) assert.equal(gatewayCommandTimeout(action), 90_000);
  for (const action of ['is-active', 'show', 'start']) assert.equal(gatewayCommandTimeout(action), 45_000);
});
function fixture() {
  return {
    transactionId: '20260919T170000Z-parity',
    files: ['main-http.js', 'openclaw-handwriting-support.js', 'remarkable-agent-policy.js'].map((name) => ({
      source: `artifacts/${name}`, destination: `/opt/anki-server/dist/${name}`,
      sha256, beforeSha256: name === 'remarkable-agent-policy.js' ? null : 'b'.repeat(64),
    })),
  };
}
test('accepts exactly scoped runtime artifacts and duplicate plugin trees', () => {
  assert.equal(validateManifest(fixture()).files.length, 3);
  for (const pathname of [`${BRIDGE_ROOT}/src/main.mjs`, `${BRIDGE_ROOT}/metadata.json`,
    `${BRIDGE_ROOT}/openclaw-plugin/index.mjs`, `${PLUGIN_ROOT}/openclaw.plugin.json`,
    `${PLUGIN_ROOT}/response-pdf-renderer.py`]) assert.equal(allowedDestination(pathname), true);
});
for (const pathname of [
  '/etc/systemd/system/anki-http.service', '/home/mdf/.openclaw/openclaw.json',
  `${BRIDGE_ROOT}/node_modules/openclaw/index.mjs`, `${BRIDGE_ROOT}/src/../../secrets.mjs`,
  `${BRIDGE_ROOT}/request-journal/state.json`, `${PLUGIN_ROOT}/nested/unsafe.mjs`,
  '/opt/anki-server/dist/dispatch-user-experience.js',
]) test(`rejects out-of-scope destination ${pathname}`, () => assert.equal(allowedDestination(pathname), false));
test('requires each preimage and refuses duplicate destinations or missing core artifacts', () => {
  let value = fixture(); delete value.files[0].beforeSha256; assert.throws(() => validateManifest(value));
  value = fixture(); value.files.push(value.files[0]); assert.throws(() => validateManifest(value));
  value = fixture(); value.files.pop(); assert.throws(() => validateManifest(value));
});
test('rejects stage escape and unsafe IDs', () => {
  for (const source of ['../elsewhere.js', '/tmp/elsewhere.js', 'a/../b.js']) {
    const value = fixture(); value.files[0].source = source; assert.throws(() => validateManifest(value));
  }
  const value = fixture(); value.transactionId = 'x;systemctl'; assert.throws(() => validateManifest(value));
});
test('protected hashes cannot be overridden by the manifest', () => {
  const value = fixture();
  value.protected = [{ path: '/opt/anki-server/dist/dispatch-user-experience.js', sha256 }];
  assert.throws(() => validateManifest(value));
  value.protected[0].sha256 = PROTECTED_FILES['dispatch-user-experience.js'];
  assert.doesNotThrow(() => validateManifest(value));
});
test('controller retains independent rollback and scoped restoration constraints', () => {
  const source = fs.readFileSync(new URL('../ops/deploy-dispatch-parity-server.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("'--on-active=900s'"));
  assert.ok(source.includes("'--property=Restart=on-failure'"));
  assert.ok(source.includes("run('/usr/bin/flock', ['--exclusive', '--nonblock', '3']"));
  assert.ok(source.includes('fs.closeSync(lock)'));
  assert.ok(source.includes("sys('stop', WATCHDOG_SERVICE)"));
  assert.ok(source.includes("userSys('stop', GATEWAY_UNIT)"));
  assert.ok(source.includes('Rollback conflict:'));
  assert.ok(source.includes('Provide the verified off-host backup SHA-256'));
  assert.ok(source.includes("state.phase === 'committed'"));
  assert.ok(!source.includes('daemon-reload'));
  assert.ok(!source.includes('rmSync'));
});

test('allows slow cold Gateway startup without starting bridge probes early', async () => {
  let clock = 0;
  let attempts = 0;
  const result = await waitForGatewayReady({
    probe: async () => { attempts++; return clock >= 120_000; },
    serviceActive: () => true,
    now: () => clock,
    sleep: async (duration) => { clock += duration; },
  });
  assert.equal(result.elapsedMs, 120_000);
  assert.ok(attempts > 35);
});

test('startup readiness also requires the existing Gateway service to be active', async () => {
  let clock = 0;
  let serviceChecks = 0;
  await waitForGatewayReady({
    probe: async () => true,
    serviceActive: () => ++serviceChecks >= 3,
    now: () => clock,
    sleep: async (duration) => { clock += duration; },
  });
  assert.equal(serviceChecks, 3);
  assert.equal(clock, 3000);
});

test('Gateway startup wait remains bounded and never runs capability or CLI work', async () => {
  let clock = 0;
  let serviceChecks = 0;
  await assert.rejects(waitForGatewayReady({
    probe: async () => false,
    serviceActive: () => { serviceChecks++; return true; },
    now: () => clock,
    sleep: async (duration) => { clock += duration; },
  }), /180 seconds/);
  assert.equal(clock, 180_000);
  assert.equal(serviceChecks, 0);
});

test('apply and rollback share ordered Gateway-then-bridge startup', async () => {
  const events = [];
  await restartServicesInOrder({
    system: (...args) => events.push(['system', ...args]),
    gateway: (...args) => events.push(['gateway', ...args]),
    waitGateway: async () => events.push(['gateway-startup-ready']),
    waitBridge: async () => events.push(['bridge-capability-ready']),
  });
  assert.deepEqual(events, [
    ['system', 'restart', 'anki-http.service'],
    ['gateway', 'restart', 'openclaw-gateway.service'],
    ['gateway-startup-ready'],
    ['system', 'start', 'smart-remarkable-openclaw-bridge.service'],
    ['bridge-capability-ready'],
  ]);
  const source = fs.readFileSync(new URL('../ops/deploy-dispatch-parity-server.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/await restartServicesInOrder\(\);/g)?.length, 2);
});

test('never starts bridge when Gateway startup readiness fails', async () => {
  const actions = [];
  await assert.rejects(restartServicesInOrder({
    system: (...args) => actions.push(args),
    gateway: () => {},
    waitGateway: async () => { throw new Error('upstream unavailable'); },
    waitBridge: async () => assert.fail('bridge readiness must not run'),
  }), /upstream unavailable/);
  assert.deepEqual(actions, [['restart', 'anki-http.service']]);
});

test('startup probe uses the exact unauthenticated loopback endpoint and refuses redirects', async () => {
  let captured;
  const ready = await probeGatewayStartup(async (url, options) => {
    captured = { url, options };
    return { status: 200, json: async () => ({ ok: true, status: 'started', version: '2026.9.5' }) };
  });
  assert.equal(ready, true);
  assert.equal(captured.url, 'http://127.0.0.1:18789/startupz');
  assert.equal(captured.options.method, 'GET');
  assert.equal(captured.options.redirect, 'error');
  assert.ok(captured.options.signal instanceof AbortSignal);
  assert.equal(captured.options.headers, undefined);
});

for (const [status, body] of [
  [503, { ok: false, status: 'starting' }],
  [200, { ok: false, status: 'starting' }],
  [200, { ok: true, status: 'draining' }],
  [200, { ok: 'true', status: 'started' }],
  [200, { ok: true, status: 'live' }],
  [200, { ready: true }],
  [200, null],
  [201, { ok: true, status: 'started' }],
  [302, { ok: true, status: 'started' }],
]) test(`startup probe rejects ${status} ${JSON.stringify(body)}`, async () => {
  assert.equal(await probeGatewayStartup(async () => ({ status, json: async () => body })), false);
});

test('startup probe fails closed on timeout, refused connections, or non-JSON responses', async () => {
  for (const name of ['TimeoutError', 'TypeError', 'ECONNREFUSED']) {
    assert.equal(await probeGatewayStartup(async () => { throw new Error(name); }), false);
  }
  assert.equal(await probeGatewayStartup(async () => ({
    status: 200, json: async () => { throw new Error('not JSON'); },
  })), false);
});

test('rollback confirmation closes only an already-restored interrupted transaction', () => {
  const source = fs.readFileSync(new URL('../ops/deploy-dispatch-parity-server.mjs', import.meta.url), 'utf8');
  const confirmation = source.split('async function confirmRollback(backup) {')[1].split('\nasync function apply(')[0];
  assert.ok(confirmation.includes("state.phase === 'applying'"));
  assert.equal(confirmation.match(/verifyCurrent\(state, false\)/g)?.length, 2);
  assert.ok(confirmation.indexOf('verifyCurrent(state, false)') < confirmation.indexOf('await health()'));
  assert.ok(confirmation.includes("state.phase = 'rolled_back'"));
  assert.ok(confirmation.includes("sys('stop', `${timerName(state)}.timer`)"));
  assert.ok(!confirmation.includes('restartServicesInOrder'));
  assert.ok(!confirmation.includes('restoreFiles'));
  assert.ok(!confirmation.includes('atomicWrite('));
  assert.ok(!confirmation.includes("'restart'"));
});
