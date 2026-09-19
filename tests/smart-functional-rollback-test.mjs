// Execute the actual rollback gate against mocked unit/cgroup state. No device,
// systemd, real process signaling, sleeps, or file restoration is performed.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const cases = [
  ['stopped', true, true],
  ['empty-cgroup', true, true],
  ['not-found', true, true],
  ['commit-won', true, false],
  ['active-kill-failed', false, false],
  ['control-pid', false, false],
  ['populated-cgroup', false, false],
  ['collected-with-descendant', false, false],
  ['wrong-cgroup', false, false],
  ['unreadable-events', false, false],
  ['systemd-error', false, false],
  ['unknown-load', false, false],
  ['missing-cgroup-v2', false, false],
];
const repo = new URL('../', import.meta.url).pathname;
for (const file of [repo + 'ops/rollback-smart-functional.sh']) {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('# BEGIN installer-quiescence gate');
  const finish = source.indexOf('# END installer-quiescence gate');
  assert.ok(start >= 0 && finish > start);
  const gate = source.slice(start, finish);
  const unit = 'smart-functional-install-20260919T170000Z-1.service';
  assert.match(gate, /for attempt in \$\(seq 1 20\)/);
  assert.ok(gate.indexOf('test "$quiescent" = 1') < gate.lastIndexOf('test ! -e "$rec/committed"'));
  assert.ok(finish < source.indexOf('exact_owned_file "$RECOVERY/prior-target.qmd"'));
  for (const [scenario, success, restores] of cases) {
    const mocks = String.raw`
set -eu
scenario=$1
expected=$2
rec=/mock-recovery
RECOVERY=$rec
TRANSACTION_UNIT=$expected
committed=0
systemctl() {
  if [[ "$1" == kill ]]; then
    [[ "$2" == --kill-whom=all && "$3" == --signal=KILL && "$4" == "$expected" && "$#" == 4 ]] || exit 91
    if [[ "$scenario" == commit-won ]]; then committed=1; fi
    if [[ "$scenario" == active-kill-failed ]]; then return 1; fi
    return 0
  fi
  [[ "$1" == show && "$2" == "$expected" && "$3" == -p && "$5" == --value && "$#" == 5 ]] || exit 92
  [[ "$scenario" != systemd-error ]] || return 1
  case "$4" in
    LoadState)
      case "$scenario" in not-found|collected-with-descendant) echo not-found ;; unknown-load) echo masked ;; *) echo loaded ;; esac ;;
    ActiveState)
      case "$scenario" in active-kill-failed) echo active ;; not-found|collected-with-descendant) echo ;; *) echo failed ;; esac ;;
    MainPID)
      case "$scenario" in active-kill-failed) echo 42 ;; not-found|collected-with-descendant) echo ;; *) echo 0 ;; esac ;;
    ControlPID)
      case "$scenario" in control-pid) echo 43 ;; not-found|collected-with-descendant) echo ;; *) echo 0 ;; esac ;;
    ControlGroup)
      case "$scenario" in not-found|collected-with-descendant) echo ;; wrong-cgroup) echo /system.slice/other.service ;; *) echo "/system.slice/$expected" ;; esac ;;
    *) exit 93 ;;
  esac
}
test() {
  case "$*" in
    '-r /sys/fs/cgroup/unified/cgroup.controllers') [[ "$scenario" != missing-cgroup-v2 ]] ;;
    "! -e /sys/fs/cgroup/unified/system.slice/$expected")
      case "$scenario" in empty-cgroup|populated-cgroup|collected-with-descendant|unreadable-events) return 1 ;; *) return 0 ;; esac ;;
    "! -L /sys/fs/cgroup/unified/system.slice/$expected") return 0 ;;
    '! -e /mock-recovery/committed') [[ "$committed" == 0 ]] ;;
    '! -e /mock-recovery/rolled-back') return 0 ;;
    *) builtin test "$@" ;;
  esac
}
awk() {
  [[ "$2" == "/sys/fs/cgroup/unified/system.slice/$expected/cgroup.events" ]] || exit 94
  case "$scenario" in
    populated-cgroup|collected-with-descendant) echo 1 ;;
    unreadable-events) return 1 ;;
    *) echo 0 ;;
  esac
}
findmnt() {
  [[ "$*" == '-n -o FSTYPE /sys/fs/cgroup/unified' ]] || exit 96
  if [[ "$scenario" == missing-cgroup-v2 ]]; then echo cgroup; else echo cgroup2; fi
}
sleep() { [[ "$1" == 1 ]] || exit 95; }
`;
    const run = spawnSync('/bin/bash', ['-s', '--', scenario, unit], {
      input: mocks + '\n' + gate + '\nprintf "RESTORE_ALLOWED\\n"\n',
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(run.error, undefined, file + ': ' + scenario);
    assert.equal(run.status === 0, success, file + ': ' + scenario + '\n' + run.stderr);
    assert.equal(run.stdout.includes('RESTORE_ALLOWED'), restores, file + ': ' + scenario);
  }
}
const rollback = fs.readFileSync(repo + 'ops/rollback-smart-functional.sh', 'utf8');
const stockStart = rollback.indexOf('# BEGIN stock-stability gate');
const stockEnd = rollback.indexOf('# END stock-stability gate');
assert.ok(stockStart > 0 && stockEnd > stockStart);
assert.ok(stockEnd < rollback.indexOf('write_marker "$RECOVERY/rolled-back"'));
const stockGate = rollback.slice(stockStart, stockEnd).replaceAll('/proc/', '$PROC_FIXTURE/');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-stock-gate-'));
const statLine = start => '4242 (xochitl) ' + ['S', ...Array(18).fill('0'), String(start)].join(' ') + '\n';
const stockCases = [
  ['healthy', true], ['inactive', false], ['preloaded', false],
  ['xovi-mapped', false], ['empty-maps', false], ['missing-maps', false],
  ['restarts', false], ['pid-change', false], ['pid-reused', false],
  ['maps-change', false], ['restart-change', false], ['root-change', false],
  ['bad-start', false], ['wrong-executable', false],
];
try {
  for (const [scenario, success] of stockCases) {
    const fixture = path.join(work, scenario);
    const proc = path.join(fixture, '4242');
    fs.mkdirSync(proc, {recursive: true});
    fs.writeFileSync(path.join(proc, 'stat'), scenario === 'bad-start' ? 'malformed\n' : statLine(100));
    fs.writeFileSync(path.join(proc, 'environ'), scenario === 'preloaded' ? 'LD_PRELOAD=/home/root/xovi/xovi.so\0' : 'HOME=/home/root\0');
    fs.writeFileSync(path.join(proc, 'maps'), scenario === 'empty-maps' ? '' : scenario === 'xovi-mapped' ? '0000-ffff r-xp /home/root/xovi/xovi.so\n' : '0000-ffff r-xp /usr/bin/xochitl\n');
    if (scenario === 'missing-maps') fs.unlinkSync(path.join(proc, 'maps'));
    fs.writeFileSync(path.join(fixture, 'replacement-stat'), statLine(101));
    const mocks = String.raw`set -eu
scenario=$1
PROC_FIXTURE=$2
XOCHITL=/usr/bin/xochitl
fake_pid=4242
fake_restarts=0
fake_root=ro
[ "$scenario" != restarts ] || fake_restarts=1
systemctl() {
  if [ "$1" = is-active ]; then [ "$scenario" != inactive ]; return; fi
  [ "$1" = show ] && [ "$2" = -p ] && [ "$4" = --value ] && [ "$5" = xochitl.service ] || exit 90
  case "$3" in MainPID) echo "$fake_pid" ;; NRestarts) echo "$fake_restarts" ;; *) exit 91 ;; esac
}
readlink() {
  if [ "$scenario" = wrong-executable ]; then echo /usr/bin/other; else echo /usr/bin/xochitl; fi
}
findmnt() { echo "$fake_root,relatime"; }
sleep() {
  [ "$1" = 1 ] || exit 92
  case "$scenario" in
    pid-change) fake_pid=4243 ;;
    pid-reused) cp "$PROC_FIXTURE/replacement-stat" "$PROC_FIXTURE/4242/stat" ;;
    maps-change) printf '0000-ffff r-xp /home/root/xovi/xovi.so\n' >"$PROC_FIXTURE/4242/maps" ;;
    restart-change) fake_restarts=1 ;;
    root-change) fake_root=rw ;;
  esac
}
`;
    const run = spawnSync('/bin/bash', ['-s', '--', scenario, fixture], {input: mocks + '\n' + stockGate + '\nprintf "STOCK_PROVEN:%s\\n" "$pid"\n', encoding: 'utf8', timeout: 10000});
    assert.equal(run.error, undefined, scenario);
    assert.equal(run.status === 0, success, scenario + '\n' + run.stderr);
    assert.equal(run.stdout.includes('STOCK_PROVEN:4242'), success, scenario);
  }
} finally { fs.rmSync(work, {recursive: true, force: true}); }
console.log('Smart functional rollback gates PASSED (13 quiescence and 14 stock-health cases)');
