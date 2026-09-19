import QtQuick 2.5
import net.asivery.AppLoad 1.0

// Lazily loaded by the exact-firmware document-menu QMD. Loading this
// controller has no side effect; openDispatch() is called only after a user
// presses the Dispatch row in a notebook or PDF.
Item {
    id: host

    required property var appRoot
    required property var appWindowsRoot

    readonly property string applicationId: "external::remarkable-dispatch"
    readonly property string applicationName: "Dispatch"
    property url windowSource: "qrc:/appload/qml/window.qml"
    property string errorText: ""

    property alias appLibrary: library

    AppLoadLibrary {
        id: library
    }

    function fail(message) {
        errorText = message;
        errorTimer.restart();
        console.warn("Dispatch shortcut:", message);
    }

    function isExactApplication(application) {
        return application
            && application.id === applicationId
            && application.name === applicationName
            && application.externalType === 2
            && application.aspectRatio === "original"
            && application.disablesWindowedMode === true
            && application.supportsScaling === false;
    }

    function exactApplication() {
        let match = null;
        let matches = 0;
        const applications = library.applications;
        for (let index = 0; index < applications.length; ++index) {
            if (isExactApplication(applications[index])) {
                match = applications[index];
                matches++;
            }
        }
        return matches === 1 ? match : null;
    }

    function isDispatchShapedWindow(window) {
        return window
            && window.appName === applicationName
            && window.disablesWindowedMode === true
            && window.supportsScaling === false
            && window.qtfbKey !== undefined
            && window.appPid !== undefined
            && window.scaledContentWidth === 1620
            && window.scaledContentHeight === 2160
            && typeof window.maximize === "function"
            && typeof window.forceActiveFocus === "function";
    }

    function collectDispatchWindows(node, depth, seen, matches) {
        if (!node || depth > 12 || seen.indexOf(node) !== -1)
            return;
        seen.push(node);
        if (isDispatchShapedWindow(node))
            matches.push(node);
        const children = node.children || [];
        for (let index = 0; index < children.length; ++index)
            collectDispatchWindows(children[index], depth + 1, seen, matches);
    }

    function existingWindows() {
        const matches = [];
        const seen = [];
        collectDispatchWindows(appRoot, 0, seen, matches);
        collectDispatchWindows(appWindowsRoot, 0, seen, matches);
        return matches;
    }

    function virtualKeyboardReference() {
        if (!appWindowsRoot || !appWindowsRoot.apploadVKB)
            return null;
        const keyboard = appWindowsRoot.apploadVKB;
        if (keyboard.active === undefined || keyboard.config === undefined || keyboard.layout === undefined)
            return null;
        return keyboard;
    }

    function bringForward(window) {
        window.parent = appRoot;
        window.globalWidth = Qt.binding(function() { return appRoot.width; });
        window.globalHeight = Qt.binding(function() { return appRoot.height; });
        window.z = 20000;
        window.visible = true;
        window.minimized = false;
        if (!window.fullscreen)
            window.maximize();
        window.forceActiveFocus();
    }

    function openDispatch() {
        errorText = "";
        errorTimer.stop();

        const windows = existingWindows();
        if (windows.length > 1) {
            fail("More than one Dispatch window is open. Close them in AppLoad and try again.");
            return;
        }
        if (windows.length === 1) {
            if (Number(windows[0].qtfbKey) >= 0 && Number(windows[0].appPid) > 0)
                bringForward(windows[0]);
            else
                fail("A stale Dispatch window is open. Close it in AppLoad and try again.");
            return;
        }

        const application = exactApplication();
        if (!application) {
            fail("The exact Dispatch AppLoad application is not available. Nothing was started.");
            return;
        }

        const virtualKeyboard = virtualKeyboardReference();
        if (!virtualKeyboard) {
            fail("The AppLoad keyboard host is unavailable. Nothing was started.");
            return;
        }

        const component = Qt.createComponent(windowSource);
        if (component.status !== Component.Ready) {
            fail("Dispatch controls could not be loaded. Nothing was started.");
            console.warn("Dispatch shortcut:", component.errorString());
            return;
        }

        const qtfbKey = Math.floor(Math.random() * 10000000);
        const window = component.createObject(appRoot, {
            objectName: "remarkableDispatchWindow",
            x: 0,
            y: 0,
            appName: application.name,
            supportsScaling: application.supportsScaling,
            disablesWindowedMode: application.disablesWindowedMode,
            virtualKeyboardLayout: application.virtualKeyboardLayout,
            virtualKeyboardRef: virtualKeyboard,
            globalWidth: Qt.binding(function() { return appRoot.width; }),
            globalHeight: Qt.binding(function() { return appRoot.height; }),
            minWidth: 400,
            minHeight: 533,
            implicitWidth: 400,
            implicitHeight: 533,
            scaledContentWidth: 1620,
            scaledContentHeight: 2160,
            qtfbKey: qtfbKey
        });
        if (!window) {
            fail("Dispatch controls could not be created. Nothing was started.");
            return;
        }

        window.closed.connect(function() { window.destroy(); });
        let pid = -1;
        try {
            // AppLoad 0.5.0 exposes this exact four-argument Q_INVOKABLE.
            pid = library.launchExternal(application.id, qtfbKey, [], ({}));
        } catch (error) {
            console.warn("Dispatch shortcut launch exception:", String(error));
        }
        if (!(pid > 0)) {
            window.destroy();
            fail("Dispatch did not start. Nothing was left open.");
            return;
        }

        window.appPid = pid;
        bringForward(window);
    }

    Timer {
        id: errorTimer
        interval: 8000
        repeat: false
        onTriggered: host.errorText = ""
    }

    Rectangle {
        id: errorStrip
        objectName: "dispatchShortcutErrorStrip"
        visible: host.errorText !== "" && appRoot.visible && !appRoot.passcodeHandler.userLocked
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 18
        width: Math.min(parent.width - 48, 1000)
        height: 96
        color: "white"
        border.color: "black"
        border.width: 2
        radius: 6
        z: 25000

        MouseArea {
            anchors.fill: parent
            onClicked: host.errorText = ""
        }

        Text {
            anchors.fill: parent
            anchors.margins: 16
            text: host.errorText
            color: "black"
            font.pixelSize: 22
            wrapMode: Text.WordWrap
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
        }
    }
}
