// Offline-only policy/race checks. Never executes the controller entry point.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const source=fs.readFileSync('ops/activate-pro-3.29-fullstack.sh','utf8');
const manifest=fs.readFileSync('ops/pro-3.29-qmd.sha256','utf8');
const digest=createHash('sha256').update(manifest).digest('hex');
assert(source.includes(digest));
assert.equal(manifest.trim().split('\n').length,11);
assert(!manifest.includes('partial-repaint'));
assert.doesNotMatch(source.replace(/^\s*#.*$/gm,''),/\binstall -|find[^\n]*-printf|mount -o|remount|systemctl enable|\/bin\/bash "\$.*REMAGIC/);
assert.match(source,/OnFailure=\\nOnFailureJobMode=replace\\nStartLimitAction=none/);
assert.match(source,/UnsetEnvironment=LD_PRELOAD XOVI_ROOT QMLDIFF_HASHTAB_CREATE/);
assert(source.indexOf('systemd-run --unit="${WATCH')<source.indexOf('write_dropin candidate\n'));
assert.match(source,/cat "\$STATE\/mac-backup-verified"/);
assert.match(source,/verify_files; verify_device; verify_log; no_app_running/);
assert.match(source,/RuntimeMaxSec=360/);
assert.match(source,/Restart=on-failure --property=RestartSec=1/);
assert.match(source,/attempts.*-ge 3/);
assert.match(source,/deadline=\$\(cat "\$STATE\/deadline"\)/);
assert.match(source,/systemctl kill --kill-whom=all --signal=KILL "\$OWNER"/);
execFileSync('bash',['-n','ops/activate-pro-3.29-fullstack.sh']);
const fn=name=>{
  const start=source.indexOf('\n'+name+'() {');
  assert(start>=0,name);
  const firstEnd=source.indexOf('\n',start+1);
  if(source.slice(start+1,firstEnd).endsWith('}')) return source.slice(start+1,firstEnd);
  const end=source.indexOf('\n}',start)+2;
  return source.slice(start+1,end);
};
const base=path.resolve('build/pro-3.29-activation-policy');
fs.mkdirSync(base,{recursive:true});
const defs=['mark','names','qmd_names','decision_committed','rollback'].map(fn).join('\n');
function shell(body,vars={}){
  const dir=fs.mkdtempSync(path.join(base,'case-'));
  const result=execFileSync('bash',['-c',`set -Eeuo pipefail
STATE=${JSON.stringify(dir)}; ID=20260921T000000Z-1; OWNER=mock-owner; Q=$STATE; DROP=$STATE/drop.conf; LOCK=$STATE/lock
mkdir "$LOCK"
${defs}
systemctl() { printf 'systemctl:%s\\n' "$*" >>"$STATE/calls"; }
read_pid() { printf '%s\\n' "\${MOCK_OWNER_PID:-0}"; }
verify_device() { printf 'verify-device\\n' >>"$STATE/calls"; }
write_dropin() { printf 'dropin:%s\\n' "$1" >>"$STATE/calls"; }
stock_process() { printf 'stock-proof\\n' >>"$STATE/calls"; }
root_ro() { printf 'root-ro\\n' >>"$STATE/calls"; }
${body}`],{env:{...process.env,...vars},encoding:'utf8'});
  return {dir,result};
}
const rollbackCase=shell('mark dates-started owned\nrollback timeout');
const calls=fs.readFileSync(path.join(rollbackCase.dir,'calls'),'utf8');
assert(calls.indexOf('systemctl:kill')<calls.indexOf('dropin:stock'));
assert(calls.indexOf('systemctl:stop mock-owner')<calls.indexOf('dropin:stock'));
assert(calls.includes('systemctl:stop notebook-date-index.service'));
assert(calls.indexOf('stock-proof')<calls.indexOf('systemctl:daemon-reload'));
assert.equal(fs.readFileSync(path.join(rollbackCase.dir,'decision'),'utf8'),'rollback:20260921T000000Z-1\n');
assert(fs.existsSync(path.join(rollbackCase.dir,'rolled-back')));
const unowned=shell('rollback owner-died');
assert(!fs.readFileSync(path.join(unowned.dir,'calls'),'utf8').includes('stop notebook-date-index.service'));
const retried=shell('mark rollback-ready "rollback:$ID"\nln "$STATE/rollback-ready" "$STATE/decision"\nrollback watchdog-retry\nrollback late-retry');
assert.equal((fs.readFileSync(path.join(retried.dir,'calls'),'utf8').match(/dropin:stock/g)||[]).length,1,'An interrupted claim resumes; completed rollback is idempotent');
// Check the actual stock predicate in a conditional (errexit is disabled there).
const failedService=shell(`${fn('stock_process')}\nsystemctl() { return 1; }\nif stock_process; then exit 8; fi`);
assert(!fs.existsSync(path.join(failedService.dir,'calls')));
const absentPid=shell(`${fn('stock_process')}\nsystemctl() { return 0; }\nread_pid() { echo 0; }\nif stock_process; then exit 8; fi`);
assert(!fs.existsSync(path.join(absentPid.dir,'calls')));
const late=shell('mark ready 55\nmark commit-ready "commit:$ID:55"\nln "$STATE/commit-ready" "$STATE/decision"\nrollback timeout\ndecision_committed');
assert(!fs.existsSync(path.join(late.dir,'calls')),'Late watchdog must not touch committed runtime');
const claim=shell('mark rollback-ready "rollback:$ID"\nln "$STATE/rollback-ready" "$STATE/decision"\nmark commit-ready "commit:$ID:55"\nif ln "$STATE/commit-ready" "$STATE/decision" 2>/dev/null; then exit 9; fi\n! decision_committed');
assert(fs.readFileSync(path.join(claim.dir,'decision'),'utf8').startsWith('rollback:'));
const listing=shell('touch "$Q/a.qmd" "$Q/.hidden.qrr" "$Q/old.rcc" "$Q/hashtab"\nqmd_names');
assert.equal(listing.result,'.hidden.qrr\na.qmd\nold.rcc\n');

// Real filesystem hard-link races: exactly one complete decision wins, never
// an empty marker or a directory claimed before contents exist.
for(let n=0;n<32;n++){
  const dir=fs.mkdtempSync(path.join(base,'race-'));
  fs.writeFileSync(path.join(dir,'commit'),'commit:complete\n');
  fs.writeFileSync(path.join(dir,'rollback'),'rollback:complete\n');
  const child=name=>new Promise(resolve=>{
    const p=spawn('ln',[path.join(dir,name),path.join(dir,'decision')],{stdio:'ignore'});
    p.on('exit',code=>resolve(code));
  });
  const results=await Promise.all([child('commit'),child('rollback')]);
  assert.equal(results.filter(code=>code===0).length,1);
  assert(['commit:complete\n','rollback:complete\n'].includes(fs.readFileSync(path.join(dir,'decision'),'utf8')));
}
console.log('Pro 3.29 activation policy passed: syntax, pins, portability constraints, rollback ordering, ownership, late commit and 32 atomic races. Not device qualification.');
