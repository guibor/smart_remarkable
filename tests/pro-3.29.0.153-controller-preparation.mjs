// Local draft checks. This is not activation/runtime qualification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
const file='ops/activate-pro-3.29.0.153-fullstack.sh';
const source=fs.readFileSync(file,'utf8');
const old=fs.readFileSync('ops/activate-pro-3.29.0.152-fullstack.sh','utf8');
const extract=(s,name)=>{
  const start=s.indexOf('\n'+name+'() {'); assert(start>=0,name);
  const firstEnd=s.indexOf('\n',start+1);
  return s.slice(start+1,s.slice(start+1,firstEnd).endsWith('}')?firstEnd:s.indexOf('\n}',start)+2);
};
for(const name of ['rollback','owner_alive','decision_committed','mark','stock_process','candidate_process',
  'verify_log','no_other_owner','baseline_policy','render_mode','make_policy_sources','verify_policy_sources',
  'owned_or_absent','publish_owned','verify_runtime_policy','write_policy','remove_owned_policy',
  'verify_environment','verify_process_environment']){
  assert.equal(extract(source,name),extract(old,name),`Reaudit safety-logic change: ${name}`);
}
assert.match(source,/IMG_VERSION="3\.29\.0\.153"/);
assert.match(source,/9d6d844d793b6242345c7c25667451620c48b2cc28986a21049fa8d534042dd4/);
assert.doesNotMatch(source,/7aa5d67da6850d7021ade5a2232edeb5f34550236eca6f7a102f37f962dd4bd2/);
assert.match(source,/927a5cac7fbb4031a0f78c2ec59bc795c499e330d5029aaa993e99e7dd917417/);
assert.match(source,/PENDING_EXACT_153_ELEVEN_QMD_MANIFEST/);
assert(source.indexOf('exit 78')<source.indexOf('ACTION='));
assert.match(extract(source,'settings_snapshot'),/profiles\/mdf-dot.json/);
execFileSync('bash',['-n',file]);
for(const action of ['prepare','activate','commit','watchdog']){
  const result=spawnSync('bash',[file,action],{encoding:'utf8'});
  assert.equal(result.status,78);
  assert.match(result.stderr,/Unsealed .153 controller/);
}
console.log('PASS: .153 draft rejects every entry action; safety functions identical to policy-tested .152; exact target and profile-preservation checks present. NOT SEALED.');
