import Cocoa
import Foundation

// --- MediaRemote private framework (loaded at runtime) ---

typealias MRMediaRemoteGetNowPlayingInfoFunc = @convention(c) (DispatchQueue, @escaping ([String: Any]) -> Void) -> Void
typealias MRMediaRemoteGetNowPlayingApplicationIsPlayingFunc = @convention(c) (DispatchQueue, @escaping (Bool) -> Void) -> Void

struct MediaRemoteFuncs {
    var isPlaying: MRMediaRemoteGetNowPlayingApplicationIsPlayingFunc?
    var info: MRMediaRemoteGetNowPlayingInfoFunc?
}

func loadMediaRemote() -> MediaRemoteFuncs {
    guard let handle = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_LAZY) else {
        return MediaRemoteFuncs()
    }
    let isPlayingSym = dlsym(handle, "MRMediaRemoteGetNowPlayingApplicationIsPlaying")
    let isPlaying = isPlayingSym.map { unsafeBitCast($0, to: MRMediaRemoteGetNowPlayingApplicationIsPlayingFunc.self) }
    let infoSym = dlsym(handle, "MRMediaRemoteGetNowPlayingInfo")
    let info = infoSym.map { unsafeBitCast($0, to: MRMediaRemoteGetNowPlayingInfoFunc.self) }
    return MediaRemoteFuncs(isPlaying: isPlaying, info: info)
}

// --- Media key event ---

func sendMediaKey() {
    let keyCode: Int = 16  // NX_KEYTYPE_PLAY

    if let downEvent = NSEvent.otherEvent(
        with: .systemDefined,
        location: .zero,
        modifierFlags: NSEvent.ModifierFlags(rawValue: 0xa00),
        timestamp: 0,
        windowNumber: 0,
        context: nil,
        subtype: 8,
        data1: (keyCode << 16) | (0xa << 8),
        data2: -1
    ) {
        downEvent.cgEvent?.post(tap: .cghidEventTap)
    }

    usleep(50_000)

    if let upEvent = NSEvent.otherEvent(
        with: .systemDefined,
        location: .zero,
        modifierFlags: NSEvent.ModifierFlags(rawValue: 0xb00),
        timestamp: 0,
        windowNumber: 0,
        context: nil,
        subtype: 8,
        data1: (keyCode << 16) | (0xb << 8),
        data2: -1
    ) {
        upEvent.cgEvent?.post(tap: .cghidEventTap)
    }
}

// --- Check if media is currently playing ---
// Initialize NSApplication to get a proper app context — MediaRemote callbacks
// require this to work correctly from CLI processes.

func checkIsPlaying() -> Bool {
    // Ensure we have a proper NSApplication context
    let _ = NSApplication.shared

    let mr = loadMediaRemote()
    guard let isPlayingFn = mr.isPlaying else {
        return false
    }

    let semaphore = DispatchSemaphore(value: 0)
    var playing = false

    isPlayingFn(DispatchQueue.main) { result in
        playing = result
        semaphore.signal()
    }

    let deadline = DispatchTime.now() + .milliseconds(500)
    while semaphore.wait(timeout: .now()) != .success {
        CFRunLoopRunInMode(CFRunLoopMode.defaultMode, 0.01, true)
        if DispatchTime.now() > deadline {
            break
        }
    }

    return playing
}

func getNowPlayingInfo() -> [String: Any] {
    let _ = NSApplication.shared

    let mr = loadMediaRemote()
    guard let infoFn = mr.info else {
        return [:]
    }

    let semaphore = DispatchSemaphore(value: 0)
    var nowPlayingInfo: [String: Any] = [:]

    infoFn(DispatchQueue.main) { info in
        nowPlayingInfo = info
        semaphore.signal()
    }

    let deadline = DispatchTime.now() + .milliseconds(500)
    while semaphore.wait(timeout: .now()) != .success {
        CFRunLoopRunInMode(CFRunLoopMode.defaultMode, 0.01, true)
        if DispatchTime.now() > deadline { break }
    }

    return nowPlayingInfo
}

// --- CLI ---

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : ""

switch command {
case "--pause":
    // Check if something is actually playing before toggling
    let isPlaying = checkIsPlaying()
    if !isPlaying {
        // Double-check via playback rate in now-playing info
        let info = getNowPlayingInfo()
        if let rate = info["kMRMediaRemoteNowPlayingInfoPlaybackRate"] as? Double, rate > 0 {
            sendMediaKey()
            print("PAUSED")
        } else {
            print("NOOP")
        }
    } else {
        sendMediaKey()
        print("PAUSED")
    }
    exit(0)

case "--play":
    sendMediaKey()
    print("OK")
    exit(0)

case "--toggle":
    sendMediaKey()
    print("OK")
    exit(0)

case "--is-playing":
    let playing = checkIsPlaying()
    print(playing ? "PLAYING" : "STOPPED")
    exit(0)

case "--debug":
    let playing = checkIsPlaying()
    print("MRIsPlaying: \(playing)")
    let info = getNowPlayingInfo()
    if info.isEmpty {
        print("NowPlayingInfo: (empty)")
    } else {
        for (key, value) in info.sorted(by: { $0.key < $1.key }) {
            print("  \(key): \(value)")
        }
    }
    exit(0)

default:
    print("Usage: macos-media-remote --pause | --play | --toggle | --is-playing | --debug")
    exit(1)
}
