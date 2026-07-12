import AppKit
import Carbon.HIToolbox
import Foundation

// cleancopy-helper — the tiny native side of CleanCopy.
//
// It does only what must be done natively: watch a pasteboard for changes,
// report which app is frontmost, read/write plain text, and register global
// hotkeys. All judgement (is this a terminal? is this prose? what should the
// cleaned text be? what does a hotkey press mean right now?) lives in the
// Node process that spawns this binary.
//
// macOS has no clipboard-change notification, so the helper polls
// NSPasteboard.changeCount — an integer compare every `pollInterval`,
// the standard cheap approach.
//
// Protocol: one JSON object per line, both directions.
//
//   helper -> node  {"type":"ready"}
//   helper -> node  {"type":"clipboard","bundleId":"com.googlecode.iterm2",
//                    "appName":"iTerm2","text":"...","changeCount":42}
//   helper -> node  {"type":"wrote","changeCount":43}  ack of a write
//   helper -> node  {"type":"stale"}            write skipped: pasteboard moved on
//   helper -> node  {"type":"dropped","reason":"too-large"}  copy withheld (content-free)
//   helper -> node  {"type":"hotkey","id":"revert"}     a --hotkey combo was pressed
//   helper -> node  {"type":"hotkey-failed","id":"revert"}  combo taken by another app
//   helper -> node  {"type":"pong"}             reply to ping
//   node -> helper  {"type":"write","text":"...","expectedChangeCount":42}
//   node -> helper  {"type":"ping"}
//
// Privacy: anything that is not plain text is discarded right here and never
// leaves this process; nothing is ever written to disk or the network. The
// helper remembers the changeCount of its own writes so it never reports its
// own output back (no clean-own-output loops).

// --- arguments -------------------------------------------------------------

var pasteboardName: NSPasteboard.Name? = nil
var pollInterval: TimeInterval = 0.2
var failNextWrite = false // deterministic integration-test hook
var hotkeySpecs: [(id: String, spec: String)] = []

// Transport guard only — the user-visible size policy (and its "too-large"
// log line) lives in decide.ts. Measured in UTF-16 code units, the same
// unit as a JS string's length, so the two limits nest by construction:
// this cap sits well above MAX_TEXT_LENGTH, and anything it withholds is
// announced with a content-free "dropped" message instead of vanishing.
var maxTextUTF16 = 2 * 1024 * 1024

var argIndex = 1
let arguments = CommandLine.arguments
while argIndex < arguments.count {
    switch arguments[argIndex] {
    case "--pasteboard": // a private named pasteboard; used by tests so they never touch the real clipboard
        argIndex += 1
        if argIndex < arguments.count { pasteboardName = NSPasteboard.Name(arguments[argIndex]) }
    case "--interval": // seconds between changeCount polls
        argIndex += 1
        if argIndex < arguments.count { pollInterval = max(0.05, Double(arguments[argIndex]) ?? pollInterval) }
    case "--fail-next-write":
        failNextWrite = true
    case "--max-text": // lower the transport cap; used by the integration tests
        argIndex += 1
        if argIndex < arguments.count { maxTextUTF16 = Int(arguments[argIndex]) ?? maxTextUTF16 }
    case "--hotkey": // "<id>:<combo>", e.g. "clean:cmd+ctrl+c" — repeatable
        argIndex += 1
        if argIndex < arguments.count {
            let value = arguments[argIndex]
            guard let colon = value.firstIndex(of: ":"), colon != value.startIndex else {
                FileHandle.standardError.write(Data("cleancopy-helper: --hotkey expects <id>:<combo>, got \(value)\n".utf8))
                exit(2)
            }
            hotkeySpecs.append((
                id: String(value[..<colon]),
                spec: String(value[value.index(after: colon)...])
            ))
        }
    default:
        FileHandle.standardError.write(Data("cleancopy-helper: unknown argument \(arguments[argIndex])\n".utf8))
        exit(2)
    }
    argIndex += 1
}

let pasteboard = pasteboardName.map { NSPasteboard(name: $0) } ?? NSPasteboard.general

// Items marked by password managers and clipboard tools as secret or
// ephemeral (http://nspasteboard.org) must never be read or rewritten.
let concealedType = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

// --- outgoing messages -----------------------------------------------------

let stdout = FileHandle.standardOutput
let newlineData = Data([0x0A])

func send(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    stdout.write(data)
    stdout.write(newlineData)
}

// --- global hotkeys ----------------------------------------------------------
//
// Carbon's RegisterEventHotKey is the one API that grabs a global hotkey
// without Accessibility permission or an event tap. The combo grammar here
// must accept everything normalizeHotkey() in src/watcher/config.ts emits;
// keep the two tables in sync.

let hotkeyKeyCodes: [String: UInt32] = [
    "a": UInt32(kVK_ANSI_A), "b": UInt32(kVK_ANSI_B), "c": UInt32(kVK_ANSI_C),
    "d": UInt32(kVK_ANSI_D), "e": UInt32(kVK_ANSI_E), "f": UInt32(kVK_ANSI_F),
    "g": UInt32(kVK_ANSI_G), "h": UInt32(kVK_ANSI_H), "i": UInt32(kVK_ANSI_I),
    "j": UInt32(kVK_ANSI_J), "k": UInt32(kVK_ANSI_K), "l": UInt32(kVK_ANSI_L),
    "m": UInt32(kVK_ANSI_M), "n": UInt32(kVK_ANSI_N), "o": UInt32(kVK_ANSI_O),
    "p": UInt32(kVK_ANSI_P), "q": UInt32(kVK_ANSI_Q), "r": UInt32(kVK_ANSI_R),
    "s": UInt32(kVK_ANSI_S), "t": UInt32(kVK_ANSI_T), "u": UInt32(kVK_ANSI_U),
    "v": UInt32(kVK_ANSI_V), "w": UInt32(kVK_ANSI_W), "x": UInt32(kVK_ANSI_X),
    "y": UInt32(kVK_ANSI_Y), "z": UInt32(kVK_ANSI_Z),
    "0": UInt32(kVK_ANSI_0), "1": UInt32(kVK_ANSI_1), "2": UInt32(kVK_ANSI_2),
    "3": UInt32(kVK_ANSI_3), "4": UInt32(kVK_ANSI_4), "5": UInt32(kVK_ANSI_5),
    "6": UInt32(kVK_ANSI_6), "7": UInt32(kVK_ANSI_7), "8": UInt32(kVK_ANSI_8),
    "9": UInt32(kVK_ANSI_9),
    "f1": UInt32(kVK_F1), "f2": UInt32(kVK_F2), "f3": UInt32(kVK_F3),
    "f4": UInt32(kVK_F4), "f5": UInt32(kVK_F5), "f6": UInt32(kVK_F6),
    "f7": UInt32(kVK_F7), "f8": UInt32(kVK_F8), "f9": UInt32(kVK_F9),
    "f10": UInt32(kVK_F10), "f11": UInt32(kVK_F11), "f12": UInt32(kVK_F12),
    "space": UInt32(kVK_Space), "tab": UInt32(kVK_Tab),
    "return": UInt32(kVK_Return), "escape": UInt32(kVK_Escape),
    "delete": UInt32(kVK_Delete),
    "left": UInt32(kVK_LeftArrow), "right": UInt32(kVK_RightArrow),
    "up": UInt32(kVK_UpArrow), "down": UInt32(kVK_DownArrow),
]

func parseHotkeyCombo(_ spec: String) -> (keyCode: UInt32, modifiers: UInt32)? {
    var modifiers: UInt32 = 0
    var keyCode: UInt32? = nil
    for part in spec.lowercased().split(separator: "+").map(String.init) {
        switch part {
        case "cmd", "command": modifiers |= UInt32(cmdKey)
        case "ctrl", "control": modifiers |= UInt32(controlKey)
        case "alt", "option", "opt": modifiers |= UInt32(optionKey)
        case "shift": modifiers |= UInt32(shiftKey)
        default:
            guard keyCode == nil, let code = hotkeyKeyCodes[part] else { return nil }
            keyCode = code
        }
    }
    guard modifiers != 0, let code = keyCode else { return nil }
    return (code, modifiers)
}

// Which --hotkey id each registered EventHotKeyID.id number maps back to.
var hotkeyIdsByNumber: [UInt32: String] = [:]
// Kept only so the registrations live as long as the process.
var hotkeyRefs: [EventHotKeyRef] = []

func registerHotkeys() {
    guard !hotkeySpecs.isEmpty else { return }

    var pressed = EventTypeSpec(
        eventClass: OSType(kEventClassKeyboard),
        eventKind: UInt32(kEventHotKeyPressed)
    )
    // The handler is a C function pointer, so no captures — it reaches the
    // id table through the globals above. It runs on the main thread, the
    // same one the pasteboard timer and stdin handling use.
    InstallEventHandler(
        GetEventDispatcherTarget(),
        { _, event, _ -> OSStatus in
            var hotkeyID = EventHotKeyID()
            let status = GetEventParameter(
                event, EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID), nil,
                MemoryLayout<EventHotKeyID>.size, nil, &hotkeyID)
            if status == noErr, let id = hotkeyIdsByNumber[hotkeyID.id] {
                send(["type": "hotkey", "id": id])
            }
            return noErr
        },
        1, &pressed, nil, nil)

    let signature = OSType(0x434C_4350)  // 'CLCP'
    for (index, entry) in hotkeySpecs.enumerated() {
        guard let combo = parseHotkeyCombo(entry.spec) else {
            // Node validates combos before passing them, so this is a bug on
            // the caller's side — fail loudly rather than run half-configured.
            FileHandle.standardError.write(Data("cleancopy-helper: invalid hotkey combo \(entry.spec)\n".utf8))
            exit(2)
        }
        let number = UInt32(index + 1)
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(
            combo.keyCode, combo.modifiers,
            EventHotKeyID(signature: signature, id: number),
            GetEventDispatcherTarget(), 0, &ref)
        guard status == noErr, let registered = ref else {
            // Another app owns this combo. Announce it and carry on: losing
            // one hotkey must not take clipboard watching down with it.
            send(["type": "hotkey-failed", "id": entry.id])
            continue
        }
        hotkeyIdsByNumber[number] = entry.id
        hotkeyRefs.append(registered)
    }
}

// --- pasteboard polling ----------------------------------------------------

var lastSeenChangeCount = pasteboard.changeCount
var ownWriteChangeCount = -1

func pollPasteboard() {
    let count = pasteboard.changeCount
    guard count != lastSeenChangeCount else { return }
    lastSeenChangeCount = count
    guard count != ownWriteChangeCount else { return } // our own write

    if let types = pasteboard.types,
        types.contains(concealedType) || types.contains(transientType)
    {
        return
    }
    guard let text = pasteboard.string(forType: .string) else { return } // not plain text
    guard text.utf16.count <= maxTextUTF16 else {
        // Withheld, not vanished: Node logs the drop so an oversized copy is
        // debuggable from the watcher side. The message carries no content.
        send(["type": "dropped", "reason": "too-large"])
        return
    }

    // The frontmost app right now is the best available proxy for "the app
    // the copy came from": the poll runs within pollInterval of the copy.
    let app = NSWorkspace.shared.frontmostApplication
    send([
        "type": "clipboard",
        "bundleId": app?.bundleIdentifier ?? "",
        "appName": app?.localizedName ?? "",
        "text": text,
        "changeCount": count,
    ])
}

// --- incoming messages -----------------------------------------------------

func handle(line: Data) {
    guard !line.isEmpty,
        let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
        let type = message["type"] as? String
    else { return }
    switch type {
    case "write":
        guard let text = message["text"] as? String else { return }
        // The user may have copied something newer between the poll that
        // reported the event and this reply; overwriting that copy would
        // destroy it. Node echoes back the changeCount of the event it is
        // answering — skip the write when the pasteboard has moved on.
        if let expected = message["expectedChangeCount"] as? Int,
            pasteboard.changeCount != expected
        {
            send(["type": "stale"])
            return
        }
        pasteboard.clearContents()
        let wrote: Bool
        if failNextWrite {
            failNextWrite = false
            wrote = false
        } else {
            wrote = pasteboard.setString(text, forType: .string)
        }
        guard wrote else {
            // Do not claim this changeCount as ours. If another process took
            // ownership during the write, the next poll must still report it.
            send(["type": "write-failed"])
            return
        }
        ownWriteChangeCount = pasteboard.changeCount
        lastSeenChangeCount = pasteboard.changeCount
        // The count this write produced: Node pins any later revert to it so
        // a revert can never overwrite a copy that landed in between.
        send(["type": "wrote", "changeCount": pasteboard.changeCount])
    case "ping":
        send(["type": "pong"])
    default:
        break
    }
}

// stdin is read on a background queue; messages are handled on the main queue
// so all pasteboard access stays on one thread. EOF means the Node side is
// gone — exit rather than linger as an orphan.
let stdinQueue = DispatchQueue(label: "stdin-reader")
stdinQueue.async {
    let stdin = FileHandle.standardInput
    var buffer = Data()
    while true {
        let chunk = stdin.availableData
        if chunk.isEmpty { // EOF
            DispatchQueue.main.async { exit(0) }
            return
        }
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            DispatchQueue.main.async { handle(line: line) }
        }
    }
}

let timer = Timer(timeInterval: pollInterval, repeats: true) { _ in pollPasteboard() }
RunLoop.main.add(timer, forMode: .common)

registerHotkeys()
send(["type": "ready"])
RunLoop.main.run()
