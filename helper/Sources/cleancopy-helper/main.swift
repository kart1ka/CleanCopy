import AppKit
import Foundation

// cleancopy-helper — the tiny native side of CleanCopy.
//
// It does only what must be done natively: watch a pasteboard for changes,
// report which app is frontmost, and read/write plain text. All judgement
// (is this a terminal? is this prose? what should the cleaned text be?)
// lives in the Node process that spawns this binary.
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
//   helper -> node  {"type":"wrote"}            ack of a write
//   helper -> node  {"type":"stale"}            write skipped: pasteboard moved on
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
    default:
        FileHandle.standardError.write(Data("cleancopy-helper: unknown argument \(arguments[argIndex])\n".utf8))
        exit(2)
    }
    argIndex += 1
}

let pasteboard = pasteboardName.map { NSPasteboard(name: $0) } ?? NSPasteboard.general

// Copies larger than this are never prose worth reflowing; drop them here so
// the text never even crosses the pipe to Node.
let maxTextBytes = 2 * 1024 * 1024

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
    guard text.utf8.count <= maxTextBytes else { return }

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
        send(["type": "wrote"])
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

send(["type": "ready"])
RunLoop.main.run()
