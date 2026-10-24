// After app publication and base recovery, capture fresh state and generate
// the native owner with the existing PDF/Restyle/WebPDF overlay unchanged.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync as run} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const repo=path.resolve(import.meta.dirname,'..'), stage=process.argv[2], out=process.argv[3];
assert(stage?.startsWith(repo+'/.cache/') && out?.startsWith(repo+'/.cache/') && !fs.existsSync(out));
fs.mkdirSync(out,{recursive:true,mode:0o700});
const hash=b=>createHash('sha256').update(b).digest('hex');
const app='/home/root/xovi/exthome/appload/smart-remarkable/';
const pins={files:[],settings:[]};
for(const line of fs.readFileSync(stage+'/app/DOT-SEND-FILES.sha256','utf8').trim().split('\n')){
 const [,sha256,name]=line.match(/^([a-f0-9]{64})  ([\w./-]+)$/)||[];assert(name && !name.includes('..'));
 assert.equal(hash(fs.readFileSync(stage+'/app/'+name)),sha256);pins.files.push({path:app+name,sha256});
}
pins.files.push({path:app+'DOT-SEND-FILES.sha256',sha256:hash(fs.readFileSync(stage+'/app/DOT-SEND-FILES.sha256'))});
const privateHash=run('ssh',['-i','/Users/mdf/.ssh/id_ed25519_remarkable_new','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','root@10.100.102.101','sha256sum '+app+'.dot.env'],{encoding:'utf8'}).split(' ')[0];
assert(/^[a-f0-9]{64}$/.test(privateHash));pins.settings.push({path:app+'.dot.env',sha256:privateHash});
fs.writeFileSync(out+'/smart-pins.json',JSON.stringify(pins,null,2)+'\n',{mode:0o600});
run('node',['/Users/mdf/code/.worktrees/remarkable-beta-os-pro-3290153/scripts/capture-pro153-controller.mjs',out+'/base.json'],{stdio:'inherit'});
run('node',['/Users/mdf/code/personal/remarkable-dispatch-app/selection/integration/prepare-pro153.mjs',out+'/base.json',hash(fs.readFileSync(out+'/base.json'))],{stdio:'inherit',env:{...process.env,
 DOT_NOTEBOOK_QMD:stage+'/smart-remarkable-llm.qmd',DOT_NOTEBOOK_QMD_SHA256:hash(fs.readFileSync(stage+'/smart-remarkable-llm.qmd')),
 DOT_NOTEBOOK_PINS:out+'/smart-pins.json',DOT_SELECTION_NATIVE_DIR:out,
 DOT_SELECTION_BUILD_DIR:'/Users/mdf/code/personal/remarkable-dispatch-app/.cache/dot-selection-toast-app',
}});
