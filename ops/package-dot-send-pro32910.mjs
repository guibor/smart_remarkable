// Deterministic app delta; existing credentials and settings are not packaged.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const repo=path.resolve(import.meta.dirname,'..'), out=process.argv[2];
assert(out && out.includes('/.cache/') && !fs.existsSync(out));
fs.mkdirSync(out+'/app',{recursive:true,mode:0o700});
const hash=b=>createHash('sha256').update(b).digest('hex');
const inputs={
 'smart_remarkable':'/Users/mdf/code/.cache/smart-dot-arm64/aarch64-unknown-linux-gnu/release/smart_remarkable',
 'appload-launch.sh':repo+'/remagic/appload-launch.sh',
 'external.manifest.json':repo+'/remagic/external.manifest.json',
 'integration/DotSendStatus.qml':repo+'/remagic/DotSendStatus.qml',
};
for(const name of ['run-armed-once.sh','run-dot-once.sh','dot-runtime-env.sh','mode-settings.sh','selection-protocol.sh'])inputs['scripts/'+name]=repo+'/scripts/'+name;
const pins=[];
for(const [name,source] of Object.entries(inputs)){
 const data=fs.readFileSync(source);fs.mkdirSync(path.dirname(out+'/app/'+name),{recursive:true});
 fs.writeFileSync(out+'/app/'+name,data,{mode:name.endsWith('.sh')||name==='smart_remarkable'?0o755:0o644});
 pins.push(hash(data)+'  '+name+'\n');
}
fs.writeFileSync(out+'/app/DOT-SEND-FILES.sha256',pins.sort().join(''),{mode:0o644});
for(const [source,name] of [[repo+'/build/pro-3.29.1.0/qmd/smart-remarkable-llm.qmd','smart-remarkable-llm.qmd'],[repo+'/ops/dot-send-pro32910-device.sh','device.sh']])fs.copyFileSync(source,out+'/'+name);
function files(p){return fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(p+'/'+e.name):[p+'/'+e.name]);}
fs.writeFileSync(out+'/SHA256SUMS',files(out).sort().map(p=>hash(fs.readFileSync(p))+'  '+path.relative(out,p)+'\n').join(''),{mode:0o600});
console.log(JSON.stringify({out,manifest:hash(fs.readFileSync(out+'/SHA256SUMS')),binary:hash(fs.readFileSync(out+'/app/smart_remarkable'))}));
