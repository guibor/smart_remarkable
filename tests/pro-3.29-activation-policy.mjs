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
assert.doesNotMatch(source,/printf[^\n]*OnFailure=\\n/,'Empty dependency resets do not work in systemd');
assert.match(source,/FragmentPath --value xochitl.service\)" = "\$UNIT"/);
assert.match(source,/DropInPaths --value xochitl.service\)" = "\$VENDOR \$DROP"/);
assert.match(source,/UnsetEnvironment=LD_PRELOAD XOVI_ROOT QMLDIFF_HASHTAB_CREATE/);
assert.match(source,/Environment="QML_XHR_ALLOW_FILE_WRITE=1" "QML_XHR_ALLOW_FILE_READ=1"/);
assert.match(source,/Unable to assign/);
assert.match(source,/XMLHttpRequest: Using/);
assert(source.indexOf('systemd-run --unit="${WATCH')<source.indexOf('write_policy candidate\n'));
assert(source.indexOf('write_policy candidate\n')<source.indexOf('systemctl restart xochitl.service'));
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
write_policy() { printf 'policy:%s\\n' "$1" >>"$STATE/calls"; }
remove_owned_policy() { printf 'remove-owned-policy\\n' >>"$STATE/calls"; systemctl daemon-reload; }
stock_process() { printf 'stock-proof\\n' >>"$STATE/calls"; if [ ! -e "$STATE/first-stock-check" ]; then touch "$STATE/first-stock-check"; return 1; fi; }
root_ro() { printf 'root-ro\\n' >>"$STATE/calls"; }
${body}`],{env:{...process.env,...vars},encoding:'utf8'});
  return {dir,result};
}
const rollbackCase=shell('mark dates-started owned\nrollback timeout');
const calls=fs.readFileSync(path.join(rollbackCase.dir,'calls'),'utf8');
assert(calls.indexOf('systemctl:kill')<calls.indexOf('policy:stock'));
assert(calls.indexOf('systemctl:stop mock-owner')<calls.indexOf('policy:stock'));
assert(calls.includes('systemctl:stop notebook-date-index.service'));
assert(calls.indexOf('stock-proof')<calls.indexOf('systemctl:daemon-reload'));
assert.equal(fs.readFileSync(path.join(rollbackCase.dir,'decision'),'utf8'),'rollback:20260921T000000Z-1\n');
assert(fs.existsSync(path.join(rollbackCase.dir,'rolled-back')));
const unowned=shell('rollback owner-died');
assert(!fs.readFileSync(path.join(unowned.dir,'calls'),'utf8').includes('stop notebook-date-index.service'));
const retried=shell('mark rollback-ready "rollback:$ID"\nln "$STATE/rollback-ready" "$STATE/decision"\nrollback watchdog-retry\nrollback late-retry');
assert.equal((fs.readFileSync(path.join(retried.dir,'calls'),'utf8').match(/policy:stock/g)||[]).length,1,'An interrupted claim resumes; completed rollback is idempotent');
const alreadyStock=shell('touch "$STATE/first-stock-check"\nrollback policy-gate-failed');
const alreadyStockCalls=fs.readFileSync(path.join(alreadyStock.dir,'calls'),'utf8');
assert(!alreadyStockCalls.includes('policy:stock'));
assert(!alreadyStockCalls.includes('systemctl:stop xochitl.service'));
assert(!alreadyStockCalls.includes('systemctl:start xochitl.service'));
assert(alreadyStockCalls.includes('remove-owned-policy'),'A pre-restart failure recovers without restarting a healthy stock process');
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
const acceptedEnvironment='LD_PRELOAD=/home/root/xovi/xovi.so\nXOVI_ROOT=/home/root/xovi/services/xochitl.service/\nQML_DISABLE_DISK_CACHE=1\nQML_XHR_ALLOW_FILE_WRITE=1\nQML_XHR_ALLOW_FILE_READ=1\nMALLOC_ARENA_MAX=8';
const environmentCases=[
  ['candidate',acceptedEnvironment,true],
  ['candidate',acceptedEnvironment.replace('QML_XHR_ALLOW_FILE_READ=1\n',''),false],
  ['candidate',acceptedEnvironment.replace('QML_XHR_ALLOW_FILE_WRITE=1','QML_XHR_ALLOW_FILE_WRITE=0'),false],
  ['candidate',acceptedEnvironment+'\nQMLDIFF_HASHTAB_CREATE=1',false],
  ['candidate',acceptedEnvironment+'\nQML_XHR_ALLOW_FILE_READ=1',false],
  ['stock','MALLOC_ARENA_MAX=8\nPATH=/usr/bin:/bin',true],
  ['stock','MALLOC_ARENA_MAX=8\nQML_XHR_ALLOW_FILE_READ=1',false],
  ['stock','LD_PRELOAD=',false],
];
for(const [mode,environment,valid] of environmentCases){
  shell(`${fn('verify_environment')}\nX=/home/root/xovi\nif verify_environment '${mode}' ${JSON.stringify(environment).replace(/\\n/g,'\n')}; then ${valid?'true':'exit 9'}; else ${valid?'exit 9':'true'}; fi`);
}
for(const error of [null,'TypeError: Cannot read property size of undefined','Unable to assign [undefined] to QColor','XMLHttpRequest: Using GET on a local file is disabled by default.']){
  const qmdLines=manifest.trim().split('\n').map(line=>'[qmldiff]: Loading file '+line.trim().split(/\s+/)[1]).join('\n')+'\n';
  shell(`${fn('verify_log')}
STAGE=$STATE
printf '%s' '${manifest}' >"$STAGE/qmd.sha256"
printf '%s' '${qmdLines+(error||'')}' >"$STATE/xochitl.log"
if verify_log; then ${error?'exit 9':'true'}; else ${error?'true':'exit 9'}; fi`);
}

// The exact pinned vendor fixtures must differ from their shadows ONLY in the
// two OnFailure lines. This tests generation, not systemd manager semantics.
const firmware='/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.29.0.148';
const acceptedQrr=fs.readFileSync(path.join(firmware,'qt-resource-rebuilder.conf'),'utf8');
assert.equal(createHash('sha256').update(acceptedQrr).digest('hex'),'6036f7776f8775529f94056fafe066ff373f5aa6bca39633bfd4dabfc1552ffd');
const rendered=shell(`${fn('render_mode')}\nX=/home/root/xovi\nrender_mode candidate`).result;
for(const [,entry] of acceptedQrr.matchAll(/^Environment="([^"]+)"$/gm)) assert(rendered.includes('"'+entry+'"'),entry);
for(const [file,pinned,shadow] of [
  ['xochitl.service','23f537cf59d527bfbf4823f372385d613e1ade0961c98831c935a372018f9566','0cbc768bc2b28a15992e11185538c9ae7ce496fb354a75ab112ddd7f646ca863'],
  ['xochitl-service-override.conf','a9432caffacb29d6fcb35136dcc3cb43d8737eb6c2efcb35ea335725f42082d1','9b9b319cc0c9173bcfee48ed9210937d292f4a8cea5e26011e5d23ee624af83c'],
]){
  const original=fs.readFileSync(path.join(firmware,file));
  assert.equal(createHash('sha256').update(original).digest('hex'),pinned);
  const transformed=execFileSync('sed',['/^[[:space:]]*OnFailure[[:space:]]*=/d'],{input:original});
  assert.equal(createHash('sha256').update(transformed).digest('hex'),shadow);
  assert.equal((original.toString().match(/^OnFailure=.+$/gm)||[]).length,1);
  assert.equal(transformed.toString(),original.toString().replace(/^OnFailure=.+\n/gm,''));
  assert(source.includes(shadow));
}
// Run the real ownership/cleanup functions against an isolated filesystem.
// Mock only external manager and device checks; never invoke the entry point.
const policyDefs=['absent','exact','hash','render_mode','owned_or_absent','remove_owned_policy','verify_runtime_policy'].map(fn).join('\n');
const partial=shell(`${policyDefs}
UNIT=$STATE/xochitl.service; VENDOR=$STATE/vendor.conf; DROP=$STATE/drop.conf; X=/home/root/xovi
hash() { shasum -a 256 "$1" | cut -d' ' -f1; }
readlink() { if [ "$1" = -f ]; then printf '%s\\n' "$2"; else command readlink "$@"; fi; }
verify_policy_sources() { :; }
baseline_policy() { absent "$UNIT" && absent "$VENDOR" && absent "$DROP"; }
render_mode candidate >"$STATE/policy-candidate.conf"; render_mode stock >"$STATE/policy-stock.conf"
sed '/^[[:space:]]*OnFailure[[:space:]]*=/d' '${firmware}/xochitl.service' >"$UNIT"
cp "$STATE/policy-candidate.conf" "$DROP"
remove_owned_policy
baseline_policy`);
assert(!fs.existsSync(path.join(partial.dir,'xochitl.service')));
for(const foreign of ['content','symlink']){
  assert.throws(()=>shell(`${policyDefs}
UNIT=$STATE/xochitl.service; VENDOR=$STATE/vendor.conf; DROP=$STATE/drop.conf; X=/home/root/xovi
hash() { shasum -a 256 "$1" | cut -d' ' -f1; }
readlink() { if [ "$1" = -f ]; then printf '%s\\n' "$2"; else command readlink "$@"; fi; }
verify_policy_sources() { :; }
${foreign==='content'?'printf foreign >"$UNIT"':'ln -s foreign "$UNIT"'}
remove_owned_policy`));
}
assert(source.indexOf('stock_process\n    # Remove only our three')<source.indexOf('remove_owned_policy\n    stock_process'));

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
console.log('Pro 3.29 activation policy passed: syntax, pins, exact shadow generation, accepted environment parity, strict error logs, partial-publication cleanup, foreign-file refusal, stock-no-restart recovery, rollback ordering, late commit and 32 atomic races. Not device qualification.');
