// Local controller provenance/argument checks. Not activation/runtime qualification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
const file='ops/activate-pro-3.29.1.0-fullstack.sh';
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
assert.match(source,/IMG_VERSION="3\.29\.1\.0"/);
assert.match(source,/35e940d8acb3de0dfaf61f1a421d450e61dbaa915f885c818a2a3cc5c94c8ecd/);
assert.doesNotMatch(source,/7aa5d67da6850d7021ade5a2232edeb5f34550236eca6f7a102f37f962dd4bd2/);
assert.match(source,/2d83991be3a49c56b2871c334b0b18902791d84406e6a688099a08df5ed8de20/);
assert.doesNotMatch(source,/PENDING_EXACT|exit 78/);
assert.match(source,/4094f63f6e0740e30ac9d1fd0bb1207b23d527b303d47052a989d058391fd258/);
assert.match(extract(source,'settings_snapshot'),/profiles\/mdf-dot.json/);
execFileSync('bash',['-n',file]);
for(const action of ['prepare','activate','commit','watchdog']){
  const result=spawnSync('bash',[file,action],{encoding:'utf8'});
  // No ID/stage/reviewed hash: reject before invoking any device-dependent helper.
  assert.equal(result.status,2);
}
console.log('PASS: 3.29.1.0 sealed controller rejects incomplete arguments; safety functions identical to policy-tested .152; exact target, table, inventory and profile-preservation checks present. Not device qualification.');
