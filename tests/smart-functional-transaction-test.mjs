// Exercise the actual stage verifier, not a second implementation. No network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const repo = new URL('../', import.meta.url).pathname;
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
const installer = read('ops/device-install-smart-functional.sh');
const rollback = read('ops/rollback-smart-functional.sh');
const deploy = read('ops/deploy-smart-functional.sh');
const fn = name => {
  const start = installer.indexOf(name + '() {');
  const end = installer.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, name);
  return installer.slice(start, end + 3);
};
const constants = installer.slice(installer.indexOf('EXPECTED_MODEL='), installer.indexOf('hash_file() {'));
const functions = ['hash_file', 'exact_root_file', 'exact_owned_file', 'verify_stage'].map(fn).join('\n');
const files = {
  'artifact-compatibility-contract.sh': 'ops/artifact-compatibility-contract.sh',
  'compatibility.env': 'xovi-qmd/compatibility-3.28.0.169.env',
  'baseline.sha256': 'ops/smart-functional-peers.sha256',
  'device-install.sh': 'ops/device-install-smart-functional.sh',
  'functional.qmd': 'xovi-qmd/llm-button-3.28.0.169.qmd',
  'inert.qmd': 'xovi-qmd/llm-button-inert-3.28.0.169.qmd',
  'panel.qml': 'qml/DispatchLauncher.qml',
  'rollback.sh': 'ops/rollback-smart-functional.sh',
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-functional-transaction-'));
try {
  for (const [scenario, success] of [['valid', true], ['changed-candidate', false], ['hidden-extra', false], ['symlink-contract', false], ['wrong-receipt', false]]) {
    const stage = path.join(work, scenario);
    fs.mkdirSync(stage);
    for (const [name, source] of Object.entries(files)) fs.copyFileSync(path.join(repo, source), path.join(stage, name));
    const manifest = Object.keys(files).map(name => sha(fs.readFileSync(path.join(stage, name))) + '  ' + name).join('\n') + '\n';
    fs.writeFileSync(path.join(stage, 'SHA256SUMS'), manifest);
    if (scenario === 'changed-candidate') fs.appendFileSync(path.join(stage, 'functional.qmd'), '\0');
    if (scenario === 'hidden-extra') fs.writeFileSync(path.join(stage, '.extra'), 'unreviewed');
    if (scenario === 'symlink-contract') {
      fs.unlinkSync(path.join(stage, 'compatibility.env'));
      fs.symlinkSync(path.join(repo, files['compatibility.env']), path.join(stage, 'compatibility.env'));
    }
    const input = String.raw`set -eu
STAGE=$1
REVIEWED_MANIFEST_SHA256=$2
sha256sum() { shasum -a 256 "$@"; }
stat() {
  if [ "$2" = %u:%g ]; then printf '0:0\n'; return; fi
  case "$3" in */device-install.sh|*/rollback.sh) printf '0:0:700\n' ;; *) printf '0:0:600\n' ;; esac
}
` + constants + '\n' + functions + '\nverify_stage\n';
    const run = spawnSync('/bin/bash', ['-s', '--', stage, scenario === 'wrong-receipt' ? '0'.repeat(64) : sha(manifest)], {input, encoding: 'utf8', timeout: 10000});
    assert.equal(run.error, undefined);
    assert.equal(run.status === 0, success, scenario + '\n' + run.stderr);
  }
  // Execute the production metadata/hash checker using each call site's exact
  // mode, including a same-hash mode drift. Never execute a tablet helper.
  for (const [helper, expectedMode] of [['REMAGIC', '700'], ['START', '755'], ['STOCK', '755']]) {
    assert.ok(installer.includes('exact_owned_file "$' + helper + '" "$EXPECTED_' + helper + '_SHA256" 0:0:' + expectedMode));
    const fixture = path.join(work, helper);
    fs.writeFileSync(fixture, 'helper-mode-test');
    const digest = sha(fs.readFileSync(fixture));
    for (const [mode, success] of [[expectedMode, true], [expectedMode === '700' ? '755' : '644', false]]) {
      const input = String.raw`set -eu
fixture=$1
expected_sha=$2
expected_mode=$3
actual_mode=$4
sha256sum() { shasum -a 256 "$@"; }
stat() { printf '0:0:%s\n' "$actual_mode"; }
` + fn('hash_file') + '\n' + fn('exact_owned_file') + '\nexact_owned_file "$fixture" "$expected_sha" "0:0:$expected_mode"\n';
      const run = spawnSync('/bin/bash', ['-s', '--', fixture, digest, expectedMode, mode], {input, encoding: 'utf8', timeout: 10000});
      assert.equal(run.error, undefined);
      assert.equal(run.status === 0, success, helper + ' mode ' + mode + '\n' + run.stderr);
    }
  }
  if (process.argv[2]) {
    const peers = path.join(repo, 'ops/smart-functional-peers.sha256');
    const peerName = fs.readFileSync(peers, 'utf8').trim().split('\n')[0].split(/\s+/)[1];
    for (const [scenario, state, success] of [
      ['inert', 'inert', true], ['functional', 'functional', true],
      ['wrong-state', 'functional', false], ['changed-peer', 'inert', false],
      ['missing-peer', 'inert', false], ['extra-qmd', 'inert', false],
      ['symlink-peer', 'inert', false], ['wrong-mode', 'inert', false],
    ]) {
      const qdir = path.join(work, 'qmd-' + scenario);
      fs.cpSync(process.argv[2], qdir, {recursive: true});
      const stage = path.join(work, 'qmd-stage-' + scenario);
      fs.mkdirSync(stage);
      fs.copyFileSync(peers, path.join(stage, 'baseline.sha256'));
      if (scenario === 'functional') fs.copyFileSync(path.join(repo, files['functional.qmd']), path.join(qdir, 'smart-remarkable-llm.qmd'));
      if (scenario === 'changed-peer') fs.appendFileSync(path.join(qdir, peerName), '\0');
      if (scenario === 'missing-peer') fs.unlinkSync(path.join(qdir, peerName));
      if (scenario === 'extra-qmd') fs.writeFileSync(path.join(qdir, '.extra.qmd'), 'unexpected');
      if (scenario === 'symlink-peer') {
        const target = path.join(work, 'linked-peer');
        fs.copyFileSync(path.join(qdir, peerName), target);
        fs.unlinkSync(path.join(qdir, peerName));
        fs.symlinkSync(target, path.join(qdir, peerName));
      }
      const input = String.raw`set -eu
QDIR=$1
STAGE=$2
TARGET=$QDIR/smart-remarkable-llm.qmd
state=$3
scenario=$4
sha256sum() { shasum -a 256 "$@"; }
stat() {
  if [ "$2" = %u:%g ]; then printf '0:0\n'; return; fi
  if [ "$scenario" = wrong-mode ]; then printf '0:0:777\n'; return; fi
  case "$3" in */notebook-date-index.qmd) printf '0:0:600\n' ;; *) printf '0:0:644\n' ;; esac
}
` + constants + '\n' + functions + '\n' + fn('qmd_names') + '\n' + fn('verify_qmd_set') + '\nverify_qmd_set "$state"\n';
      const run = spawnSync('/bin/bash', ['-s', '--', qdir, stage, state, scenario], {input, encoding: 'utf8', timeout: 10000});
      assert.equal(run.error, undefined);
      assert.equal(run.status === 0, success, 'QMD ' + scenario + '\n' + run.stderr);
    }
  }
} finally { fs.rmSync(work, {recursive: true, force: true}); }

assert.match(installer, /smart_contract_installed_client_is_exact \/home\/root\/xovi\/exthome\/appload\/smart-remarkable/);
assert.match(installer, /--on-active=180/);
assert.match(installer, /\/sys\/fs\/cgroup\/unified\/cgroup.controllers/);
assert.match(installer, /TRANSACTION_ID=20260814T232837Z-37203/);
assert.match(installer, /LOCK=\/run\/smart-remarkable-llm-button\/deployment.lock/);
assert.match(installer, /cmp "\$RECOVERY\/preserved.snapshot" "\$RECOVERY\/preserved.after.snapshot"/);
assert.match(installer, /Loading file smart-remarkable-llm.qmd/);
assert.match(installer, /-eq 12/);
assert.doesNotMatch(installer, /mv .*"\$PANEL"/);
assert.doesNotMatch(rollback, /cp .*gestik|tar -x|cp .*"\$PANEL"/);
assert.ok(deploy.indexOf('tests/smart-functional-test.sh') < deploy.indexOf('ssh-keyscan'));
assert.ok(deploy.includes('--server-verified') && deploy.includes('--confirm-inert-visible='));
assert.ok(installer.indexOf('mac-backup-verified') < installer.indexOf('--on-active=180'));
assert.ok(installer.indexOf('--on-active=180') < installer.indexOf('mv -f "$RECOVERY/candidate.ready" "$TARGET"'));
for (const source of [installer, rollback]) {
  assert.doesNotMatch(source, /mount .*remount|\bmodprobe\b|\/usr\/bin\/screenshot/);
  assert.doesNotMatch(source, /^systemctl is-active --quiet \S+ \S+/m);
}
console.log('Smart functional stage verifier and transaction policy PASSED');
