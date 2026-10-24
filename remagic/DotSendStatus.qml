import QtQuick
import common
import "../../remarkable-dot-selection/integration" as DotSelection

Item {
    id: root
    readonly property bool notifying: toast.active
    visible: notifying
    property bool reading: false
    function consume(value) {
        if (!Values.smartDotSendBusy || !value || !Number.isFinite(value.epoch_ms) || value.epoch_ms < Values.smartDotSendEpoch) return
        if (value.state === "sent" || value.state === "failed") {
            Values.smartDotSendBusy = false
            toast.duration = value.state === "sent" ? 2200 : 6500
            toast.show(value.state === "sent" ? qsTr("Sent to Dot") : qsTr("Send not confirmed. Check Dot before sending again."))
        }
    }
    DotSelection.StatusToast { id: toast }
    Timer {
        interval: 500; repeat: true; running: Values.smartDotSendBusy
        onTriggered: {
            if (Date.now() - Values.smartDotSendEpoch > 120000) {
                root.consume({state:"failed", epoch_ms:Date.now()}); return
            }
            if (root.reading) return
            root.reading = true
            const request = new XMLHttpRequest()
            request.onreadystatechange = function() {
                if (request.readyState !== XMLHttpRequest.DONE) return
                root.reading = false
                try { root.consume(JSON.parse(request.responseText)) } catch (e) {}
            }
            request.open("GET", "file:///run/smart-remarkable/send-status.json")
            request.send()
        }
    }
}
