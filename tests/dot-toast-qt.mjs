import fs from 'node:fs';
import path from 'node:path';
import {execFileSync as run} from 'node:child_process';
const repo=path.resolve(import.meta.dirname,'..'), out=repo+'/.cache/dot-toast-qt';
for(const dir of ['smart-remarkable/integration','remarkable-dot-selection/integration','imports/common'])fs.mkdirSync(out+'/'+dir,{recursive:true});
fs.copyFileSync(repo+'/remagic/DotSendStatus.qml',out+'/smart-remarkable/integration/DotSendStatus.qml');
fs.copyFileSync('/Users/mdf/code/personal/remarkable-dispatch-app/selection/qml/StatusToast.qml',out+'/remarkable-dot-selection/integration/StatusToast.qml');
fs.writeFileSync(out+'/imports/common/qmldir','module common\nsingleton Values 1.0 Values.qml\n');
fs.writeFileSync(out+'/imports/common/Values.qml','pragma Singleton\nimport QtQuick\nQtObject { property bool smartDotSendBusy: false; property double smartDotSendEpoch: 0 }\n');
fs.writeFileSync(out+'/tst_receipt.qml',`import QtQuick
import QtTest
import common
import "smart-remarkable/integration" as App
TestCase {
 name:"NotebookDotReceipt"; when:windowShown; visible:true; width:1620; height:2160
 property int clicks:0
 MouseArea {id:document;anchors.fill:parent;onClicked:clicks++}
 Loader {id:host; anchors.fill:parent; z:10; sourceComponent:App.DotSendStatus {} visible:item && item.notifying}
 function test_receipt_visibility_and_passive_size() {
  verify(!host.visible)
  Values.smartDotSendEpoch=Date.now(); Values.smartDotSendBusy=true
  host.item.consume({state:"sent",epoch_ms:Date.now()})
  verify(host.visible); verify(!Values.smartDotSendBusy)
  const toast=host.item.children[0]
  verify(toast.width<600);verify(toast.height<150);verify(toast.y>1800)
  clicks=0;mouseClick(document,800,2080);compare(clicks,1)
  toast.duration=20;toast.show("Sent to Dot");tryCompare(host,"visible",false,1000)
 }
}
`);
run('qmltestrunner',['-input',out,'-import',out+'/imports'],{stdio:'inherit',env:{...process.env,QT_QPA_PLATFORM:'offscreen',QML_XHR_ALLOW_FILE_READ:'1'}});
