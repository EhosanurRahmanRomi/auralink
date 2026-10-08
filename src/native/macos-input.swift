import Foundation
import ApplicationServices
import AppKit

// Compile on the Mac: swiftc macos-input.swift -framework ApplicationServices -framework AppKit -o macos-input
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

// Click counts are determined on the host, not accepted from a remote packet.
// Keep only three mouse buttons and a bounded 1...3 click sequence. A drag,
// different button, timeout or release/revoke breaks the previous sequence.
struct ClickTracker {
    private struct Press {
        let point: CGPoint
        let downAt: TimeInterval
        let count: Int
        var dragged = false
    }
    private let interval: TimeInterval
    private let distanceSquared: CGFloat = 16
    private var previous = [Int: Press]()
    private var active = [Int: Press]()
    private var lastButton: Int?

    init(interval: TimeInterval) {
        self.interval = interval.isFinite ? min(2, max(0.1, interval)) : 0.5
    }

    private func nearby(_ a: CGPoint, _ b: CGPoint) -> Bool {
        let x = a.x - b.x, y = a.y - b.y
        return x * x + y * y <= distanceSquared
    }

    mutating func move(to point: CGPoint) {
        for button in Array(active.keys) {
            if let press = active[button], !nearby(press.point, point) { active[button]?.dragged = true }
        }
        for button in Array(previous.keys) {
            if let press = previous[button], !nearby(press.point, point) { previous.removeValue(forKey: button) }
        }
    }

    mutating func down(_ button: Int, at point: CGPoint, time: TimeInterval) -> Int {
        guard (0...2).contains(button), validPoint(point), time.isFinite else { reset(); return 1 }
        if let press = active[button] { return press.count }
        if lastButton != button { previous.removeAll() }
        lastButton = button
        var count = 1
        if let press = previous[button] {
            let elapsed = time - press.downAt
            if elapsed >= 0 && elapsed <= interval && nearby(press.point, point) && press.count < 3 {
                count = press.count + 1
            }
        }
        active[button] = Press(point: point, downAt: time, count: count)
        return count
    }

    mutating func up(_ button: Int, at point: CGPoint) -> Int {
        guard let press = active.removeValue(forKey: button) else { return 1 }
        if !press.dragged && nearby(press.point, point) && lastButton == button { previous[button] = press }
        else { previous.removeValue(forKey: button) }
        return press.count
    }

    func activeCount(_ button: Int) -> Int { active[button]?.count ?? 1 }

    mutating func reset() { previous.removeAll(); active.removeAll(); lastButton = nil }
}

func buttonEvent(source: CGEventSource?, button: Int, down: Bool, point: CGPoint,
                 flags: CGEventFlags, clickCount: Int) -> CGEvent? {
    guard (0...2).contains(button), (1...3).contains(clickCount), validPoint(point) else { return nil }
    let nativeButton: CGMouseButton = button == 0 ? .left : button == 2 ? .right : .center
    let type: CGEventType = button == 0 ? (down ? .leftMouseDown : .leftMouseUp) :
        button == 2 ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
    guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: nativeButton) else { return nil }
    event.flags = flags
    event.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
    return event
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
    private var clicks = ClickTracker(interval: NSEvent.doubleClickInterval)
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
        clicks.move(to: point)
        let type: CGEventType = pressedButtons.contains(0) ? .leftMouseDragged :
            pressedButtons.contains(2) ? .rightMouseDragged : pressedButtons.contains(1) ? .otherMouseDragged : .mouseMoved
        let activeButton = pressedButtons.contains(0) ? 0 : pressedButtons.contains(2) ? 2 : pressedButtons.contains(1) ? 1 : 0
        let button: CGMouseButton = activeButton == 0 ? .left : activeButton == 2 ? .right : .center
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw InputFailure() }
        position = point
        event.flags = flags
        if !pressedButtons.isEmpty { event.setIntegerValueField(.mouseEventClickState, value: Int64(clicks.activeCount(activeButton))) }
        event.post(tap: .cghidEventTap)
    }

    func button(_ button: Int, down: Bool) throws {
        guard (0...2).contains(button) else { throw InputFailure() }
        let count = down ? clicks.down(button, at: position, time: ProcessInfo.processInfo.systemUptime) : clicks.up(button, at: position)
        guard let event = buttonEvent(source: source, button: button, down: down, point: position, flags: flags, clickCount: count) else { throw InputFailure() }
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
        clicks.reset()
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
    // These checks create in-memory events, never post them or ask for TCC access.
    var checks = [
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
    let point = CGPoint(x: 100, y: 200)
    var clicks = ClickTracker(interval: 0.5)
    var clickChecks = [Bool]()
    // Down/up fields must agree. Single, double and triple clicks are distinct;
    // sustained rapid clicking remains bounded rather than increasing forever.
    for (index, count) in [1, 2, 3, 1].enumerated() {
        clickChecks.append(clicks.down(0, at: point, time: 10 + Double(index) * 0.15) == count)
        clickChecks.append(clicks.up(0, at: point) == count)
    }
    clickChecks.append(clicks.down(0, at: point, time: 11.1) == 1)
    clickChecks.append(clicks.up(0, at: point) == 1)
    clickChecks.append(clicks.down(0, at: point, time: 11) == 1) // Clock reversal cannot extend a sequence.
    _ = clicks.up(0, at: point)
    clicks.reset()
    _ = clicks.down(0, at: point, time: 20); _ = clicks.up(0, at: point)
    clickChecks.append(clicks.down(2, at: point, time: 20.1) == 1)
    _ = clicks.up(2, at: point)
    clickChecks.append(clicks.down(0, at: point, time: 20.2) == 1) // Another button interrupts it.
    _ = clicks.up(0, at: point)
    clicks.reset()
    _ = clicks.down(0, at: point, time: 30)
    clicks.move(to: CGPoint(x: 105, y: 200))
    clicks.move(to: point)
    clickChecks.append(clicks.activeCount(0) == 1)
    clickChecks.append(clicks.up(0, at: point) == 1)
    clickChecks.append(clicks.down(0, at: point, time: 30.2) == 1) // A drag-and-return is not a double click.
    _ = clicks.up(0, at: point)
    clicks.move(to: CGPoint(x: 100, y: 205)); clicks.move(to: point)
    clickChecks.append(clicks.down(0, at: point, time: 30.3) == 1) // Large hover movement breaks it too.
    _ = clicks.up(0, at: point)
    clicks.reset()
    _ = clicks.down(1, at: point, time: 40); _ = clicks.up(1, at: point)
    let nearby = CGPoint(x: 102, y: 202)
    clicks.move(to: nearby)
    clickChecks.append(clicks.down(1, at: nearby, time: 40.2) == 2)
    clickChecks.append(clicks.activeCount(1) == 2)
    clickChecks.append(clicks.up(1, at: nearby) == 2)
    clicks.reset()
    clickChecks.append(clicks.down(1, at: nearby, time: 40.3) == 1) // Fresh consent starts at one.
    clickChecks.append(clicks.down(1, at: nearby, time: 40.31) == 1) // Repeated down does not increase it.
    _ = clicks.up(1, at: nearby)
    var invalidInterval = ClickTracker(interval: .infinity)
    _ = invalidInterval.down(0, at: point, time: 50); _ = invalidInterval.up(0, at: point)
    clickChecks.append(invalidInterval.down(0, at: point, time: 50.2) == 2)
    _ = invalidInterval.up(0, at: point)
    var longInterval = ClickTracker(interval: 100)
    _ = longInterval.down(0, at: point, time: 60); _ = longInterval.up(0, at: point)
    clickChecks.append(longInterval.down(0, at: point, time: 62.1) == 1)
    var shortInterval = ClickTracker(interval: -1)
    _ = shortInterval.down(0, at: point, time: 70); _ = shortInterval.up(0, at: point)
    clickChecks.append(shortInterval.down(0, at: point, time: 70.2) == 1)
    checks.append(contentsOf: clickChecks)

    var fieldChecks = [Bool]()
    for button in 0...2 {
        for count in 1...3 {
            for down in [true, false] {
                let event = buttonEvent(source: nil, button: button, down: down, point: point, flags: .maskShift, clickCount: count)
                let nativeButton: CGMouseButton = button == 0 ? .left : button == 2 ? .right : .center
                fieldChecks.append(event?.getIntegerValueField(.mouseEventClickState) == Int64(count) &&
                    event?.getIntegerValueField(.mouseEventButtonNumber) == Int64(nativeButton.rawValue) &&
                    event?.flags.contains(.maskShift) == true && event?.location == point)
            }
        }
    }
    fieldChecks.append(buttonEvent(source: nil, button: 3, down: true, point: point, flags: [], clickCount: 1) == nil)
    fieldChecks.append(buttonEvent(source: nil, button: 0, down: true, point: point, flags: [], clickCount: 0) == nil)
    fieldChecks.append(buttonEvent(source: nil, button: 0, down: true, point: point, flags: [], clickCount: 4) == nil)
    fieldChecks.append(buttonEvent(source: nil, button: 0, down: true, point: CGPoint(x: .infinity, y: 0), flags: [], clickCount: 1) == nil)
    checks.append(contentsOf: fieldChecks)
    output(["type": "self-test", "passed": checks.allSatisfy { $0 }, "checks": checks.count,
            "clickTrackingChecks": clickChecks.count, "quartzClickFieldChecks": fieldChecks.count, "inputPosted": false])
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
