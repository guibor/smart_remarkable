import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const work = process.argv[2];
assert(work, "usage: node dispatch-document-menu-harness.mjs WORKDIR");

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const mocks = path.join(work, "mocks", "net", "asivery", "AppLoad");
fs.mkdirSync(mocks, { recursive: true });

fs.writeFileSync(path.join(mocks, "qmldir"), [
  "module net.asivery.AppLoad",
  "AppLoadLibrary 1.0 AppLoadLibrary.qml",
  "",
].join("\n"));

fs.writeFileSync(path.join(mocks, "AppLoadLibrary.qml"), `import QtQuick 2.5
QtObject {
    property var applications: []
    property int launches: 0
    property int reloads: 0
    property int nextPid: 4242
    property bool throwLaunch: false
    property string lastId: ""
    property int lastKey: -1
    property var lastArgs: null
    property var lastEnv: null
    function reloadList() { reloads++; }
    function launchExternal(id, key, args, env) {
        launches++;
        lastId = id;
        lastKey = key;
        lastArgs = args;
        lastEnv = env;
        if (throwLaunch) throw Error("mock launch failure");
        return nextPid;
    }
}
`);

fs.copyFileSync(path.join(repo, "qml", "DispatchLauncher.qml"), path.join(work, "DispatchLauncher.qml"));

fs.writeFileSync(path.join(work, "MockWindow.qml"), `import QtQuick 2.5
FocusScope {
    id: root
    property int globalWidth: 0
    property int globalHeight: 0
    property int minWidth: 0
    property int minHeight: 0
    property int scaledContentWidth: 0
    property int scaledContentHeight: 0
    property bool disablesWindowedMode: false
    property string appName: ""
    property bool supportsScaling: false
    property var qtfbKey: -1
    property int appPid: -1
    property bool minimized: false
    property bool fullscreen: false
    property var virtualKeyboardLayout: null
    property var virtualKeyboardRef: null
    property int maximizeCalls: 0
    signal closed
    function maximize() { maximizeCalls++; fullscreen = !fullscreen; }
    function simulateCoordinatorUnload() {
        virtualKeyboardRef.active = false;
        closed();
    }
}
`);

fs.writeFileSync(path.join(work, "BrokenWindow.qml"), `import QtQuick 2.5
Item { required property string propertyThatIsNeverProvided }
`);

fs.writeFileSync(path.join(work, "dispatch-harness.qml"), `import QtQuick 2.5

Rectangle {
    id: root
    width: 1620
    height: 2160
    property var passcodeHandler: ({userLocked: false})
    property var primaryWindow: null

    QtObject {
        id: keyboard
        property bool active: false
        property var config: null
        property var layout: null
    }

    Item {
        id: navigator
        property var apploadVKB: keyboard
    }

    DispatchLauncher {
        id: panel
        anchors.fill: parent
        appRoot: root
        appWindowsRoot: navigator
        windowSource: Qt.resolvedUrl("MockWindow.qml")
    }

    function check(ok, reason) {
        if (!ok) {
            console.error(reason);
            Qt.exit(1);
            throw Error(reason);
        }
    }

    function exactApp() {
        return {
            id: "external::remarkable-dispatch",
            name: "Dispatch",
            externalType: 2,
            aspectRatio: "original",
            disablesWindowedMode: true,
            supportsScaling: false,
            virtualKeyboardLayout: null
        };
    }

    function findWindows() {
        const matches = [];
        for (let index = 0; index < root.children.length; ++index) {
            const child = root.children[index];
            if (child.appName === "Dispatch" && child.qtfbKey !== undefined)
                matches.push(child);
        }
        return matches;
    }

    function makeExtraWindow(pid) {
        const component = Qt.createComponent(panel.windowSource);
        check(component.status === Component.Ready, "mock window component ready");
        const window = component.createObject(root, {
            appName: "Dispatch",
            supportsScaling: false,
            disablesWindowedMode: true,
            virtualKeyboardRef: keyboard,
            globalWidth: root.width,
            globalHeight: root.height,
            minWidth: 400,
            minHeight: 533,
            implicitWidth: 400,
            implicitHeight: 533,
            scaledContentWidth: 1620,
            scaledContentHeight: 2160,
            qtfbKey: 987654,
            appPid: pid,
            fullscreen: true
        });
        check(window !== null, "extra mock window created");
        return window;
    }

    function afterClose() {
        check(findWindows().length === 0, "closed Dispatch window destroyed");
        check(!keyboard.active, "close path disables shared AppLoad keyboard");

        panel.appLibrary.nextPid = 0;
        panel.openDispatch();
        check(panel.appLibrary.launches === 2, "non-positive launch called once");
        check(panel.errorText.indexOf("did not start") !== -1, "non-positive PID is user-visible");

        Qt.callLater(afterFailedPidCleanup);
    }

    function afterExtraDestroyed() {
        check(findWindows().length === 1, "extra Dispatch window destroyed");
        primaryWindow.appPid = -1;
        panel.openDispatch();
        check(panel.appLibrary.launches === 1, "stale window fails closed");
        check(panel.errorText.indexOf("stale") !== -1, "stale-window failure is user-visible");
        primaryWindow.appPid = 4242;

        keyboard.active = true;
        primaryWindow.simulateCoordinatorUnload();
        Qt.callLater(afterClose);
    }

    function afterFailedPidCleanup() {
        check(findWindows().length === 0, "non-positive PID leaves no window");

        panel.appLibrary.nextPid = 5151;
        panel.appLibrary.throwLaunch = true;
        panel.openDispatch();
        check(panel.appLibrary.launches === 3, "launch exception called once");
        check(panel.errorText.indexOf("did not start") !== -1, "launch exception is user-visible");
        panel.appLibrary.throwLaunch = false;

        Qt.callLater(afterExceptionCleanup);
    }

    function afterExceptionCleanup() {
        check(findWindows().length === 0, "launch exception leaves no window");

        navigator.apploadVKB = null;
        panel.openDispatch();
        check(panel.appLibrary.launches === 3, "missing keyboard host cannot launch");
        check(panel.errorText.indexOf("keyboard host") !== -1, "missing keyboard host is user-visible");
        navigator.apploadVKB = keyboard;

        panel.windowSource = Qt.resolvedUrl("does-not-exist.qml");
        panel.openDispatch();
        check(panel.appLibrary.launches === 3, "component error cannot launch");
        check(panel.errorText.indexOf("could not be loaded") !== -1, "component error is user-visible");

        panel.windowSource = Qt.resolvedUrl("BrokenWindow.qml");
        panel.openDispatch();
        check(panel.appLibrary.launches === 3, "createObject failure cannot launch");
        check(panel.errorText.indexOf("could not be created") !== -1, "createObject failure is user-visible");

        check(panel.appLibrary.reloads === 0, "shortcut never performs synchronous global AppLoad rescan");
        console.log("Dispatch document-menu runtime PASSED");
        Qt.quit();
    }

    Timer {
        interval: 100
        running: true
        repeat: false
        onTriggered: {
            check(panel.appLibrary.launches === 0 && findWindows().length === 0, "no launch on controller load");

            panel.appLibrary.applications = [];
            panel.openDispatch();
            check(panel.appLibrary.launches === 0 && findWindows().length === 0, "missing app fails without launch");

            const wrong = exactApp();
            wrong.aspectRatio = "move";
            panel.appLibrary.applications = [wrong];
            panel.openDispatch();
            check(panel.appLibrary.launches === 0, "wrong app contract fails without launch");

            panel.appLibrary.applications = [exactApp(), exactApp()];
            panel.openDispatch();
            check(panel.appLibrary.launches === 0, "ambiguous app contract fails without launch");

            panel.appLibrary.applications = [exactApp()];
            panel.openDispatch();
            check(panel.appLibrary.launches === 1, "exact app launches once");
            check(panel.appLibrary.lastId === "external::remarkable-dispatch", "exact external id");
            check(panel.appLibrary.lastKey >= 0, "QTFB key supplied");
            check(panel.appLibrary.lastArgs.length === 0, "empty extra argument list");
            check(Object.keys(panel.appLibrary.lastEnv).length === 0, "empty extra environment map");

            let windows = findWindows();
            check(windows.length === 1, "one Dispatch window created");
            const primary = windows[0];
            root.primaryWindow = primary;
            check(primary.appPid === 4242 && primary.qtfbKey === panel.appLibrary.lastKey, "PID and QTFB key assigned");
            check(primary.fullscreen && primary.maximizeCalls === 1, "new window maximized exactly once");
            check(primary.globalWidth === 1620 && primary.globalHeight === 2160, "global native dimensions");
            check(primary.scaledContentWidth === 1620 && primary.scaledContentHeight === 2160, "source native dimensions");
            check(primary.minWidth === 400 && primary.minHeight === 533, "minimum original-device dimensions");
            check(primary.implicitWidth === 400 && primary.implicitHeight === 533, "implicit original-device dimensions");
            check(primary.virtualKeyboardRef === keyboard, "shared AppLoad keyboard wired");

            panel.openDispatch();
            check(panel.appLibrary.launches === 1, "second tap reuses existing window");
            check(primary.maximizeCalls === 1 && primary.fullscreen, "fullscreen reuse never toggles windowed");

            const extra = makeExtraWindow(4343);
            panel.openDispatch();
            check(panel.appLibrary.launches === 1, "multiple windows fail closed");
            check(panel.errorText.indexOf("More than one") !== -1, "multiple-window failure is user-visible");
            extra.destroy();
            Qt.callLater(afterExtraDestroyed);
        }
    }
}
`);
