// Local-only source/composition gate; never connects to a device or service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const firmware = process.env.RM_PRO_FIRMWARE_DIR || '/Users/mdf/code/.worktrees/remarkable-beta-os-pro-3290153/.cache/firmware/3.29.0.153';
const previous = '/Users/mdf/code/remarkable-beta-os/.cache/firmware/3.29.0.152';
const tool = '/Users/mdf/code/remarkable-beta-os/.cache/tools/qmldiff-25681c3-bin';
const structuralOnly = process.argv.includes('--structural-only');
const table = process.env.RM_PRO_HASHTAB || path.join(firmware,'hashtab');
const out = path.join(repo, 'build/pro-3.29.0.153-dispatch-smart');
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const exact = (p,h) => assert.equal(hash(p),h,p);
const run = (cmd,args,options={}) => execFileSync(cmd,args,{cwd:repo,stdio:'pipe',...options});
const walk = p => fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]);

exact(path.join(firmware,'xochitl'),'9d6d844d793b6242345c7c25667451620c48b2cc28986a21049fa8d534042dd4');
exact(tool,'5d48704b2b55702bf553f65e0fac46bc2eacd72d3d995ac52b379df7e0ce973d');
exact(path.join(previous,'appload-0.6.so'),'5b2dd6c066da6932d88a1d62be1068ca5ba751f481636dd51f727221db62e3ad');
exact(path.join(previous,'appload-0.6-embedded.qmd'),'69147587485e8f90336f8e504f48ffebb39212b47572d9cd990b7cfd12ec692a');
// A prior table is usable ONLY as an explicitly labelled source diagnostic.
// Two independent .153 captures are canonically equal; pin the selected raw file.
const runtimeTableHash = '927a5cac7fbb4031a0f78c2ec59bc795c499e330d5029aaa993e99e7dd917417';
if (!structuralOnly) exact(table,runtimeTableHash);
else exact(table,'5d5e9e6fe21a9dfbed27306aa57b137e3efdf59f5ba904df4440e222cdd2fe86');

const affected = ['qml/common/Values.qml','qml/device/view/main/MainView.qml',
  'qt/qml/xofm/libs/toolbar/qml/SettingsMenu.qml','qml/common/SceneSelectionHandler.qml',
  'qml/device/view/documentview/DeviceSceneView.qml'];
const sourceProof = affected.map(p=>{
  const current=hash(path.join(firmware,'resources',p));
  assert.equal(current,hash(path.join(previous,'resources',p)),`Reaudit changed resource: ${p}`);
  return {path:p,sha256:current};
});
fs.mkdirSync(out,{recursive:true});
const inputs=path.join(out,'inputs');
fs.rmSync(inputs,{recursive:true,force:true});
fs.cpSync(path.join(firmware,'resources'),inputs,{recursive:true});
fs.cpSync(path.join(previous,'appload-0.6-resources'),inputs,{recursive:true});
const artifacts={};
for(const stem of ['llm-button-inert','dispatch-document-menu','dispatch-document-menu-inert']){
  const source=path.join(repo,'xovi-qmd',stem+'-3.29.0.153.source.qmd');
  const old=path.join(repo,'xovi-qmd',stem+'-3.29.0.152.source.qmd');
  assert.equal(fs.readFileSync(source,'utf8'),fs.readFileSync(old,'utf8').replaceAll('3.29.0.152','3.29.0.153'));
  const target=path.join(out,stem+'-3.29.0.153.qmd');
  fs.copyFileSync(source,target);
  run(tool,['hash-diffs',table,target]);
  assert.equal(run(tool,['check-compatibility',table,target],{encoding:'utf8'}).trim(),'No compatibility errors found.');
  artifacts[stem]={path:target,sha256:hash(target)};
}
const inert=fs.readFileSync(path.join(repo,'xovi-qmd/llm-button-inert-3.29.0.153.source.qmd'),'utf8');
assert.equal((inert.match(/enabled: false/g)||[]).length,2);
assert.doesNotMatch(inert,/onClicked|onPressed|launchExternal|SR_WAND|https?:/);
const embedded=path.join(previous,'appload-0.6-embedded.qmd');
for(const [name,menu] of [['functional','dispatch-document-menu'],['inert','dispatch-document-menu-inert']]){
  const patches=[embedded,artifacts['llm-button-inert'].path,artifacts[menu].path];
  for(const [order,qmds] of [['first',patches],['last',[...patches.slice(1),embedded]]]){
    const dest=path.join(out,name+'-'+order);
    run(tool,['apply-diffs','--clean','--hashtab',table,'--version','3.29.0.153',inputs,dest,...qmds]);
    for(const f of walk(dest).filter(f=>f.endsWith('.qml'))) run('qmlformat',['--ignore-settings',f]);
    const settings=fs.readFileSync(path.join(dest,'qt/qml/xofm/libs/toolbar/qml/SettingsMenu.qml'),'utf8');
    assert.match(settings,/label: "Dispatch"/);
    assert.match(settings,/root\.documentType\s*===\s*"note"\s*\|\|\s*root\.documentType\s*===\s*"pdf"/);
    if(name==='functional') assert.match(settings,/Values.dispatchOpenRequested\(\)/);
    else assert.doesNotMatch(settings,/Values.dispatchOpenRequested\(\)/);
    const selection=fs.readFileSync(path.join(dest,'qml/common/SceneSelectionHandler.qml'),'utf8');
    assert.doesNotMatch(selection,/--selection-button|SR_WAND|launchExternal/);
    const window=fs.readFileSync(path.join(dest,'appload/qml/window.qml'),'utf8');
    assert.match(window,/allowScaling: true/);
    assert.doesNotMatch(window,/root.appName === "Dispatch"/);
  }
}
for(const version of ['3.29.0.152','3.28.0.169']){
  const dest=path.join(out,'rejected-'+version);
  run(tool,['apply-diffs','--clean','--hashtab',table,'--version',version,inputs,dest,...Object.values(artifacts).map(a=>a.path)]);
  assert.equal(walk(dest).length,0,'Wrong firmware must receive no patch');
}
const harness=path.join(out,'harness'); fs.mkdirSync(harness,{recursive:true});
run('node',['tests/dispatch-document-menu-harness.mjs',harness]);
const check=spawnSync('qml',['--disable-context-sharing',path.join(harness,'dispatch-harness.qml')],{
  env:{...process.env,QML_IMPORT_PATH:path.join(harness,'mocks'),QT_QUICK_CONTROLS_STYLE:'Basic',QT_QPA_PLATFORM:'offscreen',QT_QUICK_BACKEND:'software'},encoding:'utf8',timeout:30000});
const log=(check.stdout||'')+(check.stderr||'');
fs.writeFileSync(path.join(out,'dispatch-harness.log'),log);
assert.equal(check.status,0,log); assert.match(log,/Dispatch document-menu runtime PASSED/);
const report={status:'offline-app-hooks-passed-not-deployed',structuralOnly,fullElevenQmdComposition:false,
  firmware:'3.29.0.153',tableSha256:hash(table),sourceProof,artifacts};
fs.writeFileSync(path.join(out,'qualification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
