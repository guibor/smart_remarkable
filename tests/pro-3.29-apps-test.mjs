// Offline-only cross-repository candidate gate. No SSH, deployment or server calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worktrees = path.dirname(repo);
const dates = path.join(worktrees, 'notebook-date-index-pro-3290148');
const stream = path.join(worktrees, 'appload-rmstream-beta-pro-3290148');
const fw = '3.29.0.148';
const firmware = process.env.RM_PRO_FIRMWARE_DIR || '/Users/mdf/code/remarkable-beta-os/.cache/firmware/'+fw;
const table = process.env.RM_PRO_HASHTAB || path.join(firmware, 'hashtab');
const tool = process.env.QMLDIFF_BIN || '/Users/mdf/code/remarkable-beta-os/.cache/tools/qmldiff-25681c3-bin';
const out = path.join(repo, 'build', 'pro-'+fw);
const runtime = path.join(out, 'qmd');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exact = (file, hash) => assert.equal(sha(file), hash, file);
const run = (cmd, args, cwd=repo) => execFileSync(cmd, args, {cwd, stdio:'inherit', env:process.env});
const files = dir => fs.readdirSync(dir, {withFileTypes:true}).flatMap(e =>
  e.isDirectory() ? files(path.join(dir,e.name)) : [path.join(dir,e.name)]);

exact(path.join(firmware, 'xochitl'), '4f433281c71a29d07921665b4724420735f3c88aceb431067f3a432b3f89f6a4');
exact(path.join(firmware, 'appload-0.6.so'), '5b2dd6c066da6932d88a1d62be1068ca5ba751f481636dd51f727221db62e3ad');
exact(path.join(firmware, 'appload-0.6-embedded.qmd'), '69147587485e8f90336f8e504f48ffebb39212b47572d9cd990b7cfd12ec692a');
exact(tool, '5d48704b2b55702bf553f65e0fac46bc2eacd72d3d995ac52b379df7e0ce973d');
assert(fs.statSync(table).isFile(), 'A separately derived exact-target hashtable is required');
// Until a runtime-derived table is sealed by the maintenance owner, this gate
// establishes structural/source compatibility only, never deployment approval.
const runtimeTableSha256 = '1f2a0f7177dac3cdfc030ff32b4643170dd2ef6e2f6c6369b4c4168513ce01f0';
const structuralOnly = sha(table) !== runtimeTableSha256;
if(table === path.join(firmware,'hashtab')) exact(table,runtimeTableSha256);
fs.mkdirSync(out, {recursive:true});
fs.rmSync(runtime, {recursive:true, force:true});
fs.mkdirSync(runtime);
run('node', ['build-qmd.mjs'], dates);
exact(path.join(dates,'build/DatesPanel.qml'), '5280822baf8891bfb3f091d4c598f03413cc78373b76761eebe2fc133517b23a');
exact(path.join(dates,'build/DateTree.js'), '336c47e7f619734214467b9f30e5324b82deeccae4977106bf8c64310f1e87dd');
exact(path.join(stream,'qml/ScreenSharing.qml'), 'bc453c77f41e04778642bdaa15db590f5a43021cd17a99486be1fd2b422ea149');
const compile = (source, destination) => {
  fs.copyFileSync(source,destination);
  run(tool, ['hash-diffs', table, destination]);
  run(tool, ['check-compatibility', table, destination]);
};
compile(path.join(dates,'build/notebook-date-index.source.qmd'), path.join(runtime,'notebook-date-index.qmd'));
compile(path.join(stream,'shortcut.source.qmd'), path.join(runtime,'rmstream-shortcut.qmd'));
compile(path.join(repo,'xovi-qmd/llm-button-inert-'+fw+'.source.qmd'), path.join(runtime,'smart-remarkable-llm.qmd'));
compile(path.join(repo,'xovi-qmd/dispatch-document-menu-'+fw+'.source.qmd'), path.join(runtime,'dispatch-document-menu-'+fw+'.qmd'));
compile(path.join(dates,'build/notebook-date-index-preview.source.qmd'), path.join(out,'dates-preview.qmd'));
compile(path.join(repo,'xovi-qmd/dispatch-document-menu-inert-'+fw+'.source.qmd'), path.join(out,'dispatch-menu-inert.qmd'));

const inert = fs.readFileSync(path.join(repo,'xovi-qmd/llm-button-inert-'+fw+'.source.qmd'),'utf8');
assert.equal((inert.match(/enabled: false/g)||[]).length,2);
assert.doesNotMatch(inert,/onClicked|onPressed|launchExternal|ndiRequest|https?:/);
const peerDir = process.env.RM_PRO_PEERS;
if (process.argv.includes('--build-only')) {
  console.log(JSON.stringify({status:'candidates-built-not-deployed',structuralOnly,tableSha256:sha(table),runtime},null,2));
  process.exit(0);
}
assert(peerDir, 'RM_PRO_PEERS must name the explicit seven-package QMD directory');
const peers = fs.readdirSync(peerDir).filter(n=>n.endsWith('.qmd')).sort();
assert.equal(peers.length,7,'Exactly seven package peers required');
for (const name of peers) {
  assert(!/dispatch|smart-remarkable|notebook-date-index|rmstream/i.test(name), 'Peer directory contains an app-owned patch');
  fs.copyFileSync(path.join(peerDir,name),path.join(runtime,name));
}
assert.equal(fs.readdirSync(runtime).length,11);
assert(!fs.readdirSync(runtime).some(n=>n.includes('partial-repaint')));
const inputs = path.join(out,'inputs');
fs.rmSync(inputs,{recursive:true,force:true});
fs.cpSync(path.join(firmware,'resources'),inputs,{recursive:true});
fs.cpSync(path.join(firmware,'appload-0.6-resources'),inputs,{recursive:true});
const ordered = fs.readdirSync(runtime).sort().map(n=>path.join(runtime,n));
const appQmd=path.join(firmware,'appload-0.6-embedded.qmd');
const variants = [
  ['appload-first', [appQmd,...ordered]],
  ['appload-last', [...ordered,appQmd]],
  ['apps-last', [appQmd,...ordered.filter(p=>peers.includes(path.basename(p))),...ordered.filter(p=>!peers.includes(path.basename(p)))]],
  ['dates-preview', [appQmd,...ordered.map(p=>path.basename(p)==='notebook-date-index.qmd'?path.join(out,'dates-preview.qmd'):p)]],
];
const counts = {};
for(const [name,qmds] of variants) {
  const dest=path.join(out,name);
  const applied=spawnSync(tool,['apply-diffs','--clean','--hashtab',table,'--version',fw,inputs,dest,...qmds],{encoding:'utf8'});
  fs.writeFileSync(path.join(out,name+'.log'),(applied.stdout||'')+(applied.stderr||''));
  assert.equal(applied.status,0,applied.error?.message||(applied.stdout||'')+(applied.stderr||''));
  counts[name]=files(dest).length;
  assert.equal(counts[name],29,'Exact composed resource count changed');
  for(const f of files(dest).filter(f=>f.endsWith('.qml'))) execFileSync('qmlformat',['--ignore-settings',f],{stdio:['ignore','ignore','pipe']});
  const read=p=>fs.readFileSync(path.join(dest,p),'utf8');
  const toolbar=read('qt/qml/xofm/libs/toolbar/qml/Toolbar.qml');
  assert(toolbar.indexOf('id: ndiDatesButton')<toolbar.indexOf('id: tocButton'),'Dates precedes BetterTOC');
  assert.match(toolbar,/stockShowableToolsCount/);
  assert.doesNotMatch(toolbar,/Values\.colorMidGray/,'Removed 3.29 color token must not survive composition');
  assert.match(toolbar,/ArkTokens\.Toolbar\.primary\.foldout\.divider\.fill/);
  const toc=read('qml/device/view/documentview/TableOfContent.qml');
  assert.doesNotMatch(toc,/Values\.colorMidGray/);
  assert.match(toc,/ArkTokens\.Style\.interaction\.icon\.disabled/);
  const notification=read('qt/qml/xofm/libs/system/qml/StatusIndicatorNotification.qml');
  assert.doesNotMatch(notification,/Style\.variable\.icon/,'Removed 3.29 icon-size token must not survive composition');
  assert.match(notification,/root\.type\.message\.icon\.sizing/);
  const menu=read('qt/qml/xofm/libs/toolbar/qml/SettingsMenu.qml');
  assert.match(menu,/label: "Dispatch"/); assert.match(menu,/Start screen sharing/); assert.match(menu,/label: "Dates"/);
  for(const p of ['qml/device/view/documentview/DocumentView.qml','qml/device/view/documentview/PagesActions.qml','qml/device/view/documentview/HwcDialog.qml','qt/qml/xofm/modules/library/ui/qml/LibraryActions.qml']) {
    if(name==='dates-preview') assert.doesNotMatch(read(p),/Values\.ndiAddPage\(/);
    else assert.match(read(p),/Values\.ndiAddPage\(DocumentController,\s*document,/);
    assert.doesNotMatch(read(p),/Values\.ndiAddPage\(document,/);
  }
  assert.match(read('qml/device/view/documentview/DocumentView.qml'),/requestTableOfContents\(true\)/);
  const window=read('appload/qml/window.qml');
  assert.match(window,/allowScaling: true/); assert.match(window,/fillMode: FBController.PreserveAspectFit/);
  assert.doesNotMatch(window,/root\.appName === "Dispatch"/);
  const selection=read('qml/common/SceneSelectionHandler.qml');
  assert.match(selection,/id: smartRemarkableLlmButton/); assert.match(selection,/id: smartRemarkableSendButton/);
  assert.doesNotMatch(selection,/--selection-button|SR_WAND|launchExternal/);
}
const wrong=path.join(out,'wrong-version');
const rejected=spawnSync(tool,['apply-diffs','--clean','--hashtab',table,'--version','3.28.0.169',inputs,wrong,...ordered],{encoding:'utf8'});
fs.writeFileSync(path.join(out,'wrong-version.log'),(rejected.stdout||'')+(rejected.stderr||''));
assert.equal(rejected.status,0,rejected.error?.message||rejected.stderr);
assert.equal(files(wrong).length,0,'Every standalone QMD refuses the old firmware');
const harness=path.join(out,'dispatch-harness'); fs.mkdirSync(harness,{recursive:true});
run('node',['tests/dispatch-document-menu-harness.mjs',harness]);
const env={...process.env,QML_IMPORT_PATH:path.join(harness,'mocks'),QT_QUICK_CONTROLS_STYLE:'Basic',QT_QPA_PLATFORM:'offscreen',QT_QUICK_BACKEND:'software'};
const checked=spawnSync('qml',['--disable-context-sharing',path.join(harness,'dispatch-harness.qml')],{env,encoding:'utf8',timeout:30000});
const log=(checked.stdout||'')+(checked.stderr||'');
process.stdout.write(log);
fs.writeFileSync(path.join(out,'dispatch-harness.log'),log);
assert.equal(checked.status,0,checked.error?.message||log);
assert.match(log,/Dispatch document-menu runtime PASSED/);
fs.writeFileSync(path.join(out,'qmd-sha256.txt'),fs.readdirSync(runtime).sort().map(n=>sha(path.join(runtime,n))+'  '+n+'\n').join(''));
if(!structuralOnly) assert.equal(fs.readFileSync(path.join(out,'qmd-sha256.txt'),'utf8'),fs.readFileSync(path.join(repo,'ops/pro-3.29-qmd.sha256'),'utf8'),'Composed runtime must match the controller inventory exactly');
fs.writeFileSync(path.join(out,'ordered-full-stack.sha256'),[appQmd,...ordered].map(p=>sha(p)+'  '+p+'\n').join(''));
const report={status:'offline-composition-passed-not-deployed',structuralOnly,tableSha256:sha(table),qmdCount:11,embeddedQmdCount:1,counts,runtime,inputs};
fs.writeFileSync(path.join(out,'qualification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
