import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const qml=fs.readFileSync(new URL('../remagic/DotSendStatus.qml',import.meta.url),'utf8');
const fn=qml.slice(qml.indexOf('function consume('),qml.indexOf('\n    DotSelection.StatusToast'));
const messages=[],Values={smartDotSendBusy:true,smartDotSendEpoch:100};
const ctx={Values,toast:{show:v=>messages.push(v)},qsTr:v=>v};
vm.createContext(ctx);vm.runInContext(fn,ctx);
for(const value of [null,{state:'sent'},{state:'sent',epoch_ms:99},{state:'capturing',epoch_ms:101}])ctx.consume(value);
assert.equal(messages.length,0);assert.equal(Values.smartDotSendBusy,true);
ctx.consume({state:'sent',epoch_ms:101});assert.deepEqual(messages,['Sent to Dot']);
assert.equal(Values.smartDotSendBusy,false);assert.equal(ctx.toast.duration,2200);
ctx.consume({state:'sent',epoch_ms:101});assert.equal(messages.length,1);
Values.smartDotSendBusy=true;ctx.consume({state:'failed',epoch_ms:102});
assert.equal(messages.length,2);assert.match(messages[1],/not confirmed/);
assert.equal(ctx.toast.duration,6500);
assert.doesNotMatch(qml,/MouseArea|TapHandler|focus:\s*true/);
const source=fs.readFileSync(new URL('../xovi-qmd/llm-button-dot-3.29.1.0.source.qmd',import.meta.url),'utf8');
assert.match(source,/id: smartRemarkableLlmButton\s+visible: false/);
assert.match(source,/mode !== "whatsapp_only" \|\| Values.smartDotSendBusy/);
const button=source.slice(source.indexOf('id: smartRemarkableSendButton'),source.indexOf('END AFFECT',source.indexOf('id: smartRemarkableSendButton')));
assert.match(button,/iconSource: "qrc:\/ark\/icons\/notebook_sparkles"/);
assert.doesNotMatch(button,/text: qsTr\("Send to Dot"\)/);
const capture=source.slice(source.indexOf('function captureSnapshot()'),source.indexOf('function ensureAppLoadHelper()')).trim();
const root={smartRemarkableContextAllowed:true,width:1620,height:2160,
 mapToGlobal:(x,y)=>({x,y}),smartRemarkableDocumentId:'11111111-1111-4111-8111-111111111111',
 smartRemarkablePageId:'page-one',smartRemarkablePageIndex:0,pageBounds:{x:0,y:0,width:1620,height:2160}};
const geometry={selectionRoot:root,controller:{selectionContainsStroke:true},
 selection:{width:400,height:200,mapToItem:(_,x,y)=>({x:200+x,y:300+y})}};
vm.createContext(geometry);vm.runInContext(capture,geometry);
assert.match(geometry.captureSnapshot(),/^v3,ink,normal,/);
root.mapToGlobal=(x,y)=>({x:1620-x,y:2160-y});
assert.match(geometry.captureSnapshot(),/^v3,ink,rot180,/);
root.mapToGlobal=(x,y)=>({x:x+10,y});assert.equal(geometry.captureSnapshot(),'');
root.mapToGlobal=(x,y)=>({x:x/2,y:y/2});assert.equal(geometry.captureSnapshot(),'');
const main=fs.readFileSync(new URL('../src/main.rs',import.meta.url),'utf8');
assert.match(main,/if config.engine.as_deref\(\) == Some\("dot"\) \{\s+return Ok\(\(\)\);/);
console.log('Send-only menu, no writer registration, stale/duplicate receipts and passive toast tests passed');
