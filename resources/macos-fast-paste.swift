import Cocoa

if !AXIsProcessTrusted() {
    exit(2)
}

guard let source = CGEventSource(stateID: .hidSystemState) else { exit(1) }

// Command (0x37) and V (0x09)
guard let cmdDown = CGEvent(keyboardEventSource: source, virtualKey: 0x37, keyDown: true),
      let vDown = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: true),
      let vUp = CGEvent(keyboardEventSource: source, virtualKey: 0x09, keyDown: false),
      let cmdUp = CGEvent(keyboardEventSource: source, virtualKey: 0x37, keyDown: false) else {
    exit(1)
}

cmdDown.flags = .maskCommand
vDown.flags = .maskCommand
vUp.flags = .maskCommand
// cmdUp doesn't strictly need maskCommand, but we can set it
cmdUp.flags = CGEventFlags(rawValue: 0)

cmdDown.post(tap: .cgSessionEventTap)
usleep(2000)
vDown.post(tap: .cgSessionEventTap)
usleep(15000) // Slightly longer hold for Electron
vUp.post(tap: .cgSessionEventTap)
usleep(2000)
cmdUp.post(tap: .cgSessionEventTap)
usleep(20000)
exit(0)
