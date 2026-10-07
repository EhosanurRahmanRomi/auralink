import Foundation
import ApplicationServices

// Compile on the Mac: swiftc macos-input.swift -framework ApplicationServices -o macos-input
// macOS Accessibility permission is required. Screen capture permission belongs
// to the application and is handled separately; this helper captures nothing.
struct InputFailure: Error {}

func modifierFlags(_ keys: Set<String>) -> CGEventFlags {
    var result: CGEventFlags = []
    if keys.contains("ShiftLeft") || keys.contains("ShiftRight") { result.insert(.maskShift) }
    if keys.contains("ControlLeft") || keys.contains("ControlRight") { result.insert(.maskControl) }
    if keys.contains("AltLeft") || keys.contains("AltRight") { result.insert(.maskAlternate) }
    if keys.contains("MetaLeft") || keys.contains("MetaRight") { result.insert(.maskCommand) }
    return result
}

func validPoint(_ point: CGPoint) -> Bool {
    return point.x.isFinite && point.y.isFinite && abs(point.x) <= 262144 && abs(point.y) <= 262144
}

func output(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value),
       let text = String(data: data, encoding: .utf8) {
        print(text)
        fflush(stdout)
    }
}

final class NativeInput {
    private let source = CGEventSource(stateID: .privateState)
    private var pressedKeys = Set<String>()
    private var pressedButtons = Set<Int>()
    private var position = CGEvent(source: nil)?.location ?? CGPoint.zero
    private var flags: CGEventFlags = []
    private let keyCodes: [String: CGKeyCode] = [
        "KeyA":0, "KeyS":1, "KeyD":2, "KeyF":3, "KeyH":4, "KeyG":5,
        "KeyZ":6, "KeyX":7, "KeyC":8, "KeyV":9, "KeyB":11, "KeyQ":12,
        "KeyW":13, "KeyE":14, "KeyR":15, "KeyY":16, "KeyT":17,
        "Digit1":18, "Digit2":19, "Digit3":20, "Digit4":21, "Digit6":22,
        "Digit5":23, "Equal":24, "Digit9":25, "Digit7":26, "Minus":27,
        "Digit8":28, "Digit0":29, "BracketRight":30, "KeyO":31, "KeyU":32,
        "BracketLeft":33, "KeyI":34, "KeyP":35, "Enter":36, "KeyL":37,
        "KeyJ":38, "Quote":39, "KeyK":40, "Semicolon":41, "Backslash":42,
        "Comma":43, "Slash":44, "KeyN":45, "KeyM":46, "Period":47,
        "Tab":48, "Space":49, "Backquote":50, "Backspace":51, "Escape":53,
        "MetaLeft":55, "MetaRight":54, "ShiftLeft":56, "CapsLock":57, "AltLeft":58, "ControlLeft":59,
        "ShiftRight":60, "AltRight":61, "ControlRight":62,
        "Insert":114, "Home":115, "PageUp":116, "Delete":117,
        "End":119, "PageDown":121, "ArrowLeft":123, "ArrowRight":124,
        "ArrowDown":125, "ArrowUp":126,
    ]

    private func currentFlags() -> CGEventFlags {
        return modifierFlags(pressedKeys)
    }

    func key(_ code: String, down: Bool) throws {
        guard let keyCode = keyCodes[code], let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down) else { throw InputFailure() }
        if down { pressedKeys.insert(code) } else { pressedKeys.remove(code) }
        flags = currentFlags()
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }

    func move(_ point: CGPoint) throws {
        guard validPoint(point) else { throw InputFailure() }
        let type: CGEventType = pressedButtons.contains(0) ? .leftMouseDragged :
            pressedButtons.contains(2) ? .rightMouseDragged : pressedButtons.contains(1) ? .otherMouseDragged : .mouseMoved
        let button: CGMouseButton = pressedButtons.contains(2) ? .right : pressedButtons.contains(1) ? .center : .left
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw InputFailure() }
        position = point
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }

    func button(_ button: Int, down: Bool) throws {
        guard (0...2).contains(button) else { throw InputFailure() }
        let nativeButton: CGMouseButton = button == 0 ? .left : button == 2 ? .right : .center
        let type: CGEventType = button == 0 ? (down ? .leftMouseDown : .leftMouseUp) :
            button == 2 ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: position, mouseButton: nativeButton) else { throw InputFailure() }
        event.flags = flags
        event.post(tap: .cghidEventTap)
        if down { pressedButtons.insert(button) } else { pressedButtons.remove(button) }
    }

    func wheel(_ x: Int32, _ y: Int32) throws {
        guard abs(Int64(x)) <= 1200, abs(Int64(y)) <= 1200,
              let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -y, wheel2: -x, wheel3: 0) else { throw InputFailure() }
        event.location = position
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }

    func releaseAll() {
        for code in Array(pressedKeys) { try? key(code, down: false) }
        for button in Array(pressedButtons) { try? self.button(button, down: false) }
        pressedKeys.removeAll()
        pressedButtons.removeAll()
        flags = []
    }

    func execute(_ packet: [String: Any]) throws {
        guard let type = packet["type"] as? String else { throw InputFailure() }
        // TCC can be revoked while a helper is running. Never continue a grant
        // after the Mac owner removes Accessibility permission.
        guard type == "release" || AXIsProcessTrusted() else { throw InputFailure() }
        switch type {
        case "move", "down", "up":
            guard let x = packet["x"] as? Double, let y = packet["y"] as? Double else { throw InputFailure() }
            try move(CGPoint(x: x, y: y))
            if type != "move" {
                guard let b = packet["button"] as? Int else { throw InputFailure() }
                try button(b, down: type == "down")
            }
        case "keydown", "keyup":
            guard let code = packet["code"] as? String else { throw InputFailure() }
            try key(code, down: type == "keydown")
        case "wheel":
            guard let x = packet["deltaX"] as? Int, let y = packet["deltaY"] as? Int,
                  let safeX = Int32(exactly: x), let safeY = Int32(exactly: y) else { throw InputFailure() }
            try wheel(safeX, safeY)
        case "release":
            releaseAll()
            output(["type": "ack", "id": packet["id"] ?? 0, "ok": true])
        default: throw InputFailure()
        }
    }
}

if CommandLine.arguments.contains("--self-test") {
    // Pure checks deliberately avoid posting an event or asking for TCC access.
    let checks = [
        validPoint(CGPoint(x: -1920, y: 0)),
        validPoint(CGPoint(x: 262144, y: -262144)),
        !validPoint(CGPoint(x: CGFloat.infinity, y: 0)),
        !validPoint(CGPoint(x: 262145, y: 0)),
        modifierFlags([]).isEmpty,
        modifierFlags(["MetaLeft"]).contains(.maskCommand),
        modifierFlags(["MetaRight", "ShiftLeft"]).contains([.maskCommand, .maskShift]),
        modifierFlags(["AltRight", "ControlLeft"]).contains([.maskAlternate, .maskControl]),
        !modifierFlags(["KeyA"]).contains(.maskCommand),
    ]
    output(["type": "self-test", "passed": checks.allSatisfy { $0 }, "checks": checks.count, "inputPosted": false])
    exit(checks.allSatisfy { $0 } ? 0 : 1)
}

if CommandLine.arguments.contains("--check-permissions") {
    output(["type": "permissions", "accessibility": AXIsProcessTrusted(), "inputPosted": false])
    exit(0)
}

guard AXIsProcessTrusted() else {
    output(["type": "ready", "available": false, "reason": "Grant Accessibility access to Auralink in macOS System Settings, then approve the request again"])
    exit(1)
}

let input = NativeInput()
output(["type": "ready", "available": true])
while let line = readLine() {
    do {
        guard line.utf8.count <= 2048, let data = line.data(using: .utf8),
              let packet = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw InputFailure() }
        try input.execute(packet)
    } catch {
        input.releaseAll()
        output(["type": "error", "reason": "Native input failed; all pressed input was released"])
        exit(1)
    }
}
input.releaseAll()
