// Offline full composition. Never overwrite the installed/base sealed outputs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const repo=path.resolve(import.meta.dirname,'..');
const wt=path.dirname(repo);
const tool='/Users/mdf/code/remarkable-beta-os/.cache/tools/qmldiff-25681c3-bin';
const fw=path.join(wt,'remarkable-beta-os-pro-32910/.cache/firmware/3.29.1.0');
const companion=path.join(wt,'companion-pro-32910/build/pro-3.29.1.0');
const native=path.join(companion,'payload-537979b5dd2b');
const out=path.join(repo,'build/pro-3.29.1.0-dot');
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
assert.equal(sha(path.join(fw,'hashtab')),'2d83991be3a49c56b2871c334b0b18902791d84406e6a688099a08df5ed8de20');
fs.mkdirSync(out,{recursive:true});
const source=path.join(repo,'xovi-qmd/llm-button-dot-3.29.1.0.source.qmd');
const candidate=path.join(out,'smart-remarkable-llm.qmd');
fs.copyFileSync(source,candidate);
execFileSync(tool,['hash-diffs',path.join(fw,'hashtab'),candidate]);
assert.equal(execFileSync(tool,['check-compatibility',path.join(fw,'hashtab'),candidate],{encoding:'utf8'}).trim(),'No compatibility errors found.');
const spec=JSON.parse(fs.readFileSync(path.join(native,'controller-inputs.json')));
const peers=spec.peers.map(p=>{
    assert.equal(sha(p.path),p.sha256,'Old sealed peer changed');
    return path.basename(p.path)==='smart-remarkable-llm.qmd'?candidate:p.path;
});
const nativeQmd=path.join(native,'companion-notebook.qmd');
const files=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(d,e.name)):[path.join(d,e.name)]);
const toc=peers.find(p=>path.basename(p).startsWith('betterToc-'));
for(const [name,qmds] of [['native-last',[...peers,nativeQmd]],['native-after-toc',[toc,nativeQmd,...peers.filter(p=>p!==toc)]]]) {
    const dest=path.join(out,name);
    execFileSync(tool,['apply-diffs','--clean','--hashtab',path.join(fw,'hashtab'),'--version','3.29.1.0',path.join(companion,'composition-input'),dest,...qmds],{stdio:'pipe'});
    for(const f of files(dest).filter(f=>f.endsWith('.qml'))) execFileSync('qmlformat',['--ignore-settings',f],{stdio:['ignore','ignore','pipe']});
    const handler=fs.readFileSync(path.join(dest,'qml/common/SceneSelectionHandler.qml'),'utf8');
    assert.equal((handler.match(/id: smartRemarkableLlmButton/g)||[]).length,1);
    assert.equal((handler.match(/id: smartRemarkableSendButton/g)||[]).length,1);
    assert.equal((handler.match(/enabled: selectionRoot.smartRemarkableContextAllowed/g)||[]).length,2);
    const scene=fs.readFileSync(path.join(dest,'qml/device/view/documentview/DeviceSceneView.qml'),'utf8');
    assert.match(scene,/selection-write-ack/);
    assert.match(scene,/id: smartDotOwner/);
    assert.doesNotMatch(handler,/sequence: "Ctrl\+Alt\+Shift\+6"/);
}
const text=fs.readFileSync(source,'utf8');
const start=text.indexOf('function smartRemarkableSingleViewAllowed()');
const stop=text.indexOf('function invalidateWrite()',start);
const fn=text.slice(start,stop).trim();
const allowed=root=>vm.runInNewContext(fn+'; smartRemarkableSingleViewAllowed()',{root});
assert.equal(allowed({visible:true}),true);
assert.equal(allowed({visible:false}),false);
assert.equal(allowed({visible:true,cnDocumentViewOwner:null}),false);
const stable=()=>({visible:true,cnDocumentViewOwner:{visible:true,cnSecondary:false,cnHost:{}}});
assert.equal(allowed(stable()),true);
for(const flag of ['paired','quickPadActive','cornerPaneActive','transitionBusy','restoring','modalOpen','closing']) {
    const root=stable(); root.cnDocumentViewOwner.cnHost[flag]=true; assert.equal(allowed(root),false,flag);
}
for(const flag of ['cnPaired','cnQuickPad','cnLayoutBusy','cnAdmissionLocked']) {
    const root=stable();root[flag]=true;assert.equal(allowed(root),false,flag);
}
const secondary=stable(); secondary.cnDocumentViewOwner.cnSecondary=true;assert.equal(allowed(secondary),false);
// Exercise the persistent owner's actual JS, not a second implementation.
// The selection child may be destroyed synchronously by its close signal.
function ownerFunction(name, next) {
    const begin=text.indexOf(`function ${name}(`);
    const end=text.indexOf(next,begin);
    assert.ok(begin>=0 && end>begin);
    return text.slice(begin,end).trim();
}
function leaseOwner() {
    const calls=[],later=[];
    const state={generation:0,leaseSnapshot:'',leaseIdentity:'',leaseStarted:0,
        writeChecks:0,contextAllowed:true,currentIdentity:'notebook/page/0',
        root:{selectionHandler:null},Date:{now:()=>1000},
        leaseExpiry:{stop(){},restart(){}},Qt:{callLater:f=>later.push(f)},
        launch:arg=>{calls.push(arg);return true;},
        XMLHttpRequest:function(){this.open=()=>{};this.send=()=>{};this.responseText='a'.repeat(64)+'\n';}};
    vm.createContext(state);
    vm.runInContext([
        ownerFunction('invalidateWrite','function launch('),
        ownerFunction('closeAndAcknowledge','function authorizeWrite('),
        ownerFunction('authorizeWrite','Timer {'),
    ].join('\n'),state);
    return {state,calls,later};
}
{
    const {state,calls,later}=leaseOwner();
    let destroyed=false;
    state.closeAndAcknowledge({close(){destroyed=true;}},'snapshot','write_back');
    assert.equal(destroyed,true);
    assert.equal(calls.length,0);
    later.shift()();
    assert.deepEqual(calls,['--selection-close-ack=snapshot']);
    state.authorizeWrite(false);
    state.authorizeWrite(true);
    assert.deepEqual(calls,['--selection-close-ack=snapshot','--selection-write-ack=snapshot',
        '--selection-write-final-ack='+ 'a'.repeat(64)+',snapshot']);
    assert.equal(state.leaseSnapshot,'');
    state.authorizeWrite(true);
    assert.equal(calls.length,3,'Consumed lease cannot authorize twice');
}
for(const failure of ['identity','context','new-selection','expiry','phase-replay','missing-challenge']) {
    const {state,calls,later}=leaseOwner();
    state.closeAndAcknowledge({close(){}},'snapshot','write_back');later.shift()();
    state.authorizeWrite(false);
    if(failure==='identity') {state.currentIdentity='other';state.invalidateWrite();state.currentIdentity='notebook/page/0';}
    if(failure==='context') state.contextAllowed=false;
    if(failure==='new-selection') state.root.selectionHandler={visible:true};
    if(failure==='expiry') state.Date.now=()=>212000;
    if(failure==='phase-replay') state.authorizeWrite(false);
    if(failure==='missing-challenge') state.XMLHttpRequest=function(){this.open=()=>{};this.send=()=>{};this.responseText='';};
    state.authorizeWrite(true);
    assert.equal(calls.length,2,failure+' must not publish final authorization');
    assert.equal(state.leaseSnapshot,'',failure+' consumes invalid lease');
}
{
    const {state,calls,later}=leaseOwner();
    state.closeAndAcknowledge({close(){}},'snapshot','whatsapp_only');later.shift()();
    state.authorizeWrite(false);
    assert.deepEqual(calls,['--selection-close-ack=snapshot'],'Send-only never authorizes a write');
}
console.log('Dot QMD: exact-table compatibility, both 13-QMD composition orders, parsing, single-view guards and persistent lease/challenge tests pass; not installed.');
