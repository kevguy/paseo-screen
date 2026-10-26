// paseo-screen-helper: captures the screen and injects input for the paseo-screen plugin.
//
// Protocol: one JSON object per line on stdin, one JSON reply per line on stdout.
//   {"id": 1, "cmd": "status"}
//   {"id": 2, "cmd": "frame", "display": 1, "maxWidth": 1600, "quality": 0.6, "since": "abc"}
//   {"id": 3, "cmd": "input", "display": 1, "events": [{"type": "click", "x": 0.5, "y": 0.5}]}
//   {"id": 4, "cmd": "clipboard"}
// Coordinates in input events are normalized to 0...1 within the chosen display.

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import ImageIO
import IOKit.pwr_mgt
import ScreenCaptureKit
import UniformTypeIdentifiers

let outputLock = NSLock()

func reply(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  outputLock.lock()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
  outputLock.unlock()
}

struct HelperError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

// MARK: - Displays

struct DisplayInfo {
  let id: CGDirectDisplayID
  let bounds: CGRect
  let pixelWidth: Int
  let pixelHeight: Int
  let main: Bool
  let builtin: Bool
  let name: String

  var json: [String: Any] {
    [
      "id": Int(id),
      "x": bounds.origin.x, "y": bounds.origin.y,
      "width": bounds.width, "height": bounds.height,
      "pixelWidth": pixelWidth, "pixelHeight": pixelHeight,
      "main": main,
      "builtin": builtin,
      "name": name,
    ]
  }
}

/// Monitor names as shown in System Settings, keyed by display ID.
/// Runs AppKit and Text Input Sources calls on the main thread, where they belong.
/// The main thread runs NSApplication's run loop, which also keeps NSScreen current after hotplug.
func onMain<T>(_ body: () -> T) -> T {
  Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
}

func screenNames() -> [CGDirectDisplayID: String] {
  onMain {
    var names: [CGDirectDisplayID: String] = [:]
    for screen in NSScreen.screens {
      if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
        names[number.uint32Value] = screen.localizedName
      }
    }
    return names
  }
}

func activeDisplays() -> [DisplayInfo] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  let mainID = CGMainDisplayID()
  let names = screenNames()
  // A mirrored display shows the same picture as its source, so only the source is listed.
  return ids.prefix(Int(count)).filter { CGDisplayMirrorsDisplay($0) == kCGNullDirectDisplay }.map { id in
    let mode = CGDisplayCopyDisplayMode(id)
    let builtin = CGDisplayIsBuiltin(id) != 0
    return DisplayInfo(
      id: id,
      bounds: CGDisplayBounds(id),
      pixelWidth: mode?.pixelWidth ?? Int(CGDisplayPixelsWide(id)),
      pixelHeight: mode?.pixelHeight ?? Int(CGDisplayPixelsHigh(id)),
      main: id == mainID,
      builtin: builtin,
      name: names[id] ?? (builtin ? "Built-in Display" : "Display \(id)"))
  }
}

func displayContaining(_ location: CGPoint) -> DisplayInfo? {
  activeDisplays().first { $0.bounds.contains(location) }
}

/// The nearest point that lies on some display, so a drag past the outer edge of the desktop stops at the edge.
func clampToDesktop(_ location: CGPoint) -> CGPoint {
  var best = location
  var bestDistance = CGFloat.infinity
  for display in activeDisplays() {
    let bounds = display.bounds
    let clamped = CGPoint(
      x: min(max(location.x, bounds.minX), bounds.maxX - 1),
      y: min(max(location.y, bounds.minY), bounds.maxY - 1))
    let distance = hypot(clamped.x - location.x, clamped.y - location.y)
    if distance < bestDistance {
      best = clamped
      bestDistance = distance
    }
  }
  return best
}

/// Wakes sleeping displays the way a key press would, and waits briefly for them to come back.
/// Called only for an explicit request (opening the viewer, the Wake button, or input), never from
/// ordinary frame polling, so an open viewer does not keep the host from sleeping or locking.
func wakeDisplays() -> [DisplayInfo] {
  var assertion: IOPMAssertionID = 0
  let declared = IOPMAssertionDeclareUserActivity("Paseo Host screen viewer" as CFString, kIOPMUserActiveLocal, &assertion)
  defer { if declared == kIOReturnSuccess { IOPMAssertionRelease(assertion) } }
  for _ in 0..<30 {
    let displays = activeDisplays()
    if !displays.isEmpty { return displays }
    usleep(100_000)
  }
  return []
}

struct DisplaysAsleep: Error {}

/// True while the login session is locked (the lock screen is showing).
func screenLocked() -> Bool {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any]
  return (session?["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

/// Asleep displays are not "active", so an empty list means the screen is off. With `wake`, the
/// displays are woken; otherwise DisplaysAsleep is thrown.
func resolveDisplay(_ requested: Any?, wake: Bool) throws -> DisplayInfo {
  var displays = activeDisplays()
  if displays.isEmpty {
    guard wake else { throw DisplaysAsleep() }
    displays = wakeDisplays()
  }
  if let number = requested as? NSNumber, number.intValue != 0 {
    if let match = displays.first(where: { Int($0.id) == number.intValue }) { return match }
  }
  if let main = displays.first(where: { $0.main }) ?? displays.first { return main }
  throw HelperError("The host's display is asleep and did not wake up")
}

// MARK: - Capture

var cachedContent: (content: SCShareableContent, at: Date)?
var lastHashByDisplay: [CGDirectDisplayID: String] = [:]

func waitFor<T>(_ body: @escaping (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
  let semaphore = DispatchSemaphore(value: 0)
  var result: Result<T, Error>?
  body { value in
    result = value
    semaphore.signal()
  }
  if semaphore.wait(timeout: .now() + 10) == .timedOut { throw HelperError("timed out") }
  return try result!.get()
}

func shareableContent() throws -> SCShareableContent {
  if let cached = cachedContent, Date().timeIntervalSince(cached.at) < 5 { return cached.content }
  let content: SCShareableContent = try waitFor { done in
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
      if let content { done(.success(content)) } else { done(.failure(error ?? HelperError("no shareable content"))) }
    }
  }
  cachedContent = (content, Date())
  return content
}

func fnv1a(_ data: Data) -> String {
  var hash: UInt64 = 0xcbf2_9ce4_8422_2325
  for byte in data {
    hash ^= UInt64(byte)
    hash = hash &* 0x100_0000_01b3
  }
  return String(hash, radix: 16)
}

func jpeg(_ image: CGImage, quality: Double) throws -> Data {
  let data = NSMutableData()
  guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
    throw HelperError("could not create JPEG encoder")
  }
  CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
  guard CGImageDestinationFinalize(destination) else { throw HelperError("JPEG encoding failed") }
  return data as Data
}

func captureFrame(_ request: [String: Any]) throws -> [String: Any] {
  guard CGPreflightScreenCaptureAccess() else {
    throw HelperError("Screen Recording permission is not granted to Paseo")
  }
  let display: DisplayInfo
  do {
    display = try resolveDisplay(request["display"], wake: (request["wake"] as? Bool) ?? false)
  } catch is DisplaysAsleep {
    // Polling never wakes the host; the viewer shows "asleep" and offers a Wake button.
    return ["asleep": true, "locked": screenLocked()]
  }
  let maxWidth = max(320, (request["maxWidth"] as? NSNumber)?.intValue ?? 1600)
  let quality = min(1, max(0.1, (request["quality"] as? NSNumber)?.doubleValue ?? 0.6))

  var content = try shareableContent()
  if !content.displays.contains(where: { $0.displayID == display.id }) {
    cachedContent = nil
    content = try shareableContent()
  }
  guard let scDisplay = content.displays.first(where: { $0.displayID == display.id }) else {
    throw HelperError("display \(display.id) is not capturable")
  }

  let scale = min(1, Double(maxWidth) / Double(display.pixelWidth))
  let config = SCStreamConfiguration()
  config.width = max(1, Int(Double(display.pixelWidth) * scale))
  config.height = max(1, Int(Double(display.pixelHeight) * scale))
  config.showsCursor = true
  let filter = SCContentFilter(display: scDisplay, excludingWindows: [])

  let image: CGImage = try waitFor { done in
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
      if let image { done(.success(image)) } else { done(.failure(error ?? HelperError("capture failed"))) }
    }
  }
  let data = try jpeg(image, quality: quality)
  let hash = fnv1a(data)
  var result: [String: Any] = [
    "display": display.json,
    "imageWidth": image.width,
    "imageHeight": image.height,
    "hash": hash,
    "bytes": data.count,
    "locked": screenLocked(),
  ]
  if let since = request["since"] as? String, since == hash {
    result["unchanged"] = true
  } else {
    result["jpeg"] = data.base64EncodedString()
  }
  lastHashByDisplay[display.id] = hash
  return result
}

// MARK: - Input

/// By default macOS ignores the physical mouse and keyboard for 0.25 s after each posted event, so a
/// stream of remote moves made the host's own trackpad and keyboard hard to use. Remote and local input
/// now mix freely.
let eventSource: CGEventSource? = {
  let source = CGEventSource(stateID: .hidSystemState)
  source?.localEventsSuppressionInterval = 0
  let permitLocal: CGEventFilterMask = [.permitLocalMouseEvents, .permitLocalKeyboardEvents, .permitSystemDefinedEvents]
  source?.setLocalEventsFilterDuringSuppressionState(permitLocal, state: .eventSuppressionStateSuppressionInterval)
  source?.setLocalEventsFilterDuringSuppressionState(permitLocal, state: .eventSuppressionStateRemoteMouseDrag)
  return source
}()
var pressedButton: CGMouseButton?

func mouseButton(_ name: Any?) -> CGMouseButton {
  switch name as? String {
  case "right": return .right
  case "middle": return .center
  default: return .left
  }
}

func mouseTypes(_ button: CGMouseButton) -> (down: CGEventType, up: CGEventType, drag: CGEventType) {
  switch button {
  case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
  case .center: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
  default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
  }
}

func modifierFlags(_ names: Any?) -> CGEventFlags {
  var flags: CGEventFlags = []
  for name in (names as? [String]) ?? [] {
    switch name {
    case "cmd", "meta": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    case "fn": flags.insert(.maskSecondaryFn)
    default: break
    }
  }
  return flags
}

/// Maps normalized coordinates on `display` to the global desktop. Values outside 0...1 (a drag that
/// left the viewed display) continue onto neighbouring displays and stop at the desktop's outer edge.
func point(_ event: [String: Any], in display: DisplayInfo) -> CGPoint {
  let x = (event["x"] as? NSNumber)?.doubleValue ?? 0.5
  let y = (event["y"] as? NSNumber)?.doubleValue ?? 0.5
  let location = CGPoint(
    x: display.bounds.origin.x + x * (display.bounds.width - 1),
    y: display.bounds.origin.y + y * (display.bounds.height - 1))
  let clamped = clampToDesktop(location)
  lastPointer = clamped
  return clamped
}

var lastPointer: CGPoint?

func postMouse(_ type: CGEventType, at location: CGPoint, button: CGMouseButton, clickCount: Int = 1, flags: CGEventFlags = []) {
  guard let event = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: location, mouseButton: button) else { return }
  event.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
  if !flags.isEmpty { event.flags = flags }
  event.post(tap: .cghidEventTap)
}

func postKey(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags) {
  guard let event = CGEvent(keyboardEventSource: eventSource, virtualKey: keyCode, keyDown: down) else { return }
  // A real keyboard marks arrows as keypad + fn keys and Home/End/Page/Forward Delete as fn keys.
  // System shortcuts such as Ctrl+Left/Right (switch Space) only match with those flags present.
  var flags = flags
  switch keyCode {
  case 123...126: flags.formUnion([.maskNumericPad, .maskSecondaryFn])
  case 114...121: flags.insert(.maskSecondaryFn)
  default: break
  }
  event.flags = flags
  event.post(tap: .cghidEventTap)
}

// Left-side modifier keys in press order. Many apps (menu key equivalents included) only react
// when the modifier key itself was pressed, not just when the flag is set on the key event.
let modifierKeys: [(flag: CGEventFlags, keyCode: CGKeyCode)] = [
  (.maskControl, 59), (.maskAlternate, 58), (.maskShift, 56), (.maskCommand, 55),
]

/// Presses the modifiers in `flags`, runs `body`, then releases them, so no modifier is left held on the host.
func withModifiers(_ flags: CGEventFlags, _ body: () -> Void) {
  let keys = modifierKeys.filter { flags.contains($0.flag) }
  var held: CGEventFlags = []
  for key in keys {
    held.insert(key.flag)
    postKey(key.keyCode, down: true, flags: held)
  }
  body()
  for key in keys.reversed() {
    held.remove(key.flag)
    postKey(key.keyCode, down: false, flags: held)
  }
}

func typeText(_ text: String) {
  // CGEventKeyboardSetUnicodeString accepts up to 20 UTF-16 units per event. Chunks are cut on
  // whole characters so an emoji or other multi-unit character is never split across events.
  // Line breaks and tabs are sent as real Return and Tab presses: inside a unicode string, apps
  // treat a line break as Return and drop the rest of that event's text.
  enum Piece { case text([UniChar]), key(CGKeyCode) }
  var pieces: [Piece] = []
  var current: [UniChar] = []
  func flush() {
    if !current.isEmpty { pieces.append(.text(current)) }
    current = []
  }
  for character in text {
    if character == "\n" || character == "\r" || character == "\r\n" {
      flush()
      pieces.append(.key(36))
      continue
    }
    if character == "\t" {
      flush()
      pieces.append(.key(48))
      continue
    }
    let units = Array(String(character).utf16)
    if current.count + units.count > 20 { flush() }
    current.append(contentsOf: units)
  }
  flush()
  for piece in pieces {
    switch piece {
    case .key(let code):
      postKey(code, down: true, flags: [])
      postKey(code, down: false, flags: [])
    case .text(let chunk):
      for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: down) else { continue }
        event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        event.post(tap: .cghidEventTap)
      }
    }
    usleep(2000)
  }
}

func handleInput(_ request: [String: Any]) throws -> [String: Any] {
  guard AXIsProcessTrusted() else {
    throw HelperError("Accessibility permission is not granted to Paseo")
  }
  // Input is an explicit action, so it wakes a sleeping display before it lands.
  let display = try resolveDisplay(request["display"], wake: true)
  let events = (request["events"] as? [[String: Any]]) ?? []
  for event in events {
    let flags = modifierFlags(event["modifiers"])
    switch event["type"] as? String {
    case "move":
      let location = point(event, in: display)
      if let button = pressedButton {
        postMouse(mouseTypes(button).drag, at: location, button: button, flags: flags)
      } else {
        postMouse(.mouseMoved, at: location, button: .left, flags: flags)
      }
    case "down":
      let button = mouseButton(event["button"])
      pressedButton = button
      postMouse(mouseTypes(button).down, at: point(event, in: display), button: button,
                clickCount: (event["clickCount"] as? NSNumber)?.intValue ?? 1, flags: flags)
    case "up":
      let button = mouseButton(event["button"])
      pressedButton = nil
      postMouse(mouseTypes(button).up, at: point(event, in: display), button: button,
                clickCount: (event["clickCount"] as? NSNumber)?.intValue ?? 1, flags: flags)
    case "click":
      let button = mouseButton(event["button"])
      let location = point(event, in: display)
      let count = max(1, (event["count"] as? NSNumber)?.intValue ?? 1)
      pressedButton = nil
      postMouse(.mouseMoved, at: location, button: button)
      for index in 1...count {
        postMouse(mouseTypes(button).down, at: location, button: button, clickCount: index, flags: flags)
        postMouse(mouseTypes(button).up, at: location, button: button, clickCount: index, flags: flags)
      }
    case "scroll":
      if event["x"] != nil { postMouse(.mouseMoved, at: point(event, in: display), button: .left) }
      // Clamped so an extreme delta can never overflow Int32 and crash the helper.
      let dx = Int32(min(10_000, max(-10_000, (event["dx"] as? NSNumber)?.doubleValue ?? 0)))
      let dy = Int32(min(10_000, max(-10_000, (event["dy"] as? NSNumber)?.doubleValue ?? 0)))
      CGEvent(scrollWheelEvent2Source: eventSource, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0)?
        .post(tap: .cghidEventTap)
    case "key":
      // Either a physical key code, or a character resolved on the host's layout.
      let char = (event["char"] as? String)?.first
      let resolved = char.flatMap { keyCode(for: $0, command: flags.contains(.maskCommand)) ?? ansiLetterKeys[$0.lowercased().first ?? $0] }
      guard let code = resolved ?? (event["keyCode"] as? NSNumber)?.uint16Value else {
        throw HelperError("no key for \(event["char"] ?? event["keyCode"] ?? "nil") on this keyboard layout")
      }
      withModifiers(flags) {
        if let down = event["down"] as? Bool {
          postKey(code, down: down, flags: flags)
        } else {
          postKey(code, down: true, flags: flags)
          postKey(code, down: false, flags: flags)
        }
      }
    case "text":
      typeText((event["text"] as? String) ?? "")
    case "paste":
      // Puts the text on the host clipboard and presses Cmd+V, which is instant and keeps formatting-free line breaks.
      let pasteboard = NSPasteboard.general
      pasteboard.clearContents()
      pasteboard.setString((event["text"] as? String) ?? "", forType: .string)
      usleep(30_000)
      let v = keyCode(for: "v", command: true) ?? 9
      withModifiers(.maskCommand) {
        postKey(v, down: true, flags: .maskCommand)
        postKey(v, down: false, flags: .maskCommand)
      }
    default:
      throw HelperError("unknown input event: \(event["type"] ?? "nil")")
    }
  }
  var result: [String: Any] = ["handled": events.count]
  // Tells the client which display the pointer ended on, so the view can follow a drag to another display.
  if let lastPointer, let landed = displayContaining(lastPointer) { result["pointerDisplay"] = Int(landed.id) }
  return result
}

/// Fallback key codes (US ANSI positions) for letters a layout cannot produce, such as Latin
/// letters on a Cyrillic layout without Command held.
let ansiLetterKeys: [Character: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
  "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
]

/// Virtual key code that types `character` on the host's current keyboard layout, so shortcuts like
/// Cmd+V and Cmd+W work on Dvorak, AZERTY and other layouts. With `command`, the lookup uses the
/// layout's Command-key table, which is what shortcuts actually follow (for example "Dvorak - QWERTY ⌘",
/// or Latin shortcuts on Cyrillic, Greek and Hebrew layouts).
func keyCode(for character: Character, command: Bool = false) -> CGKeyCode? {
  onMain {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
          let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
    let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
    let target = String(character).lowercased()
    return data.withUnsafeBytes { raw -> CGKeyCode? in
      guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
      for code in 0..<128 {
        var deadKeys: UInt32 = 0
        var length = 0
        var chars = [UniChar](repeating: 0, count: 4)
        let modifiers = command ? UInt32((cmdKey >> 8) & 0xFF) : 0
        let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), modifiers, UInt32(LMGetKbdType()),
                                    OptionBits(kUCKeyTranslateNoDeadKeysBit), &deadKeys, chars.count, &length, &chars)
        if status == noErr, length > 0, String(utf16CodeUnits: chars, count: length) == target { return CGKeyCode(code) }
      }
      return nil
    }
  }
}

// MARK: - Clipboard

func clipboard() -> [String: Any] {
  let pasteboard = NSPasteboard.general
  var result: [String: Any] = ["changeCount": pasteboard.changeCount]
  if let text = pasteboard.string(forType: .string) { result["text"] = text }
  return result
}

// MARK: - Status and permissions

func status() -> [String: Any] {
  [
    "screenRecording": CGPreflightScreenCaptureAccess(),
    "accessibility": AXIsProcessTrusted(),
    "locked": screenLocked(),
    "displays": activeDisplays().map(\.json),
  ]
}

func requestPermissions() -> [String: Any] {
  var opened: [String] = []
  if !CGPreflightScreenCaptureAccess() {
    _ = CGRequestScreenCaptureAccess()
    if !CGPreflightScreenCaptureAccess(),
       let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
      NSWorkspace.shared.open(url)
      opened.append("screenRecording")
    }
  }
  if !AXIsProcessTrusted() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    if !AXIsProcessTrustedWithOptions(options),
       let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
      NSWorkspace.shared.open(url)
      opened.append("accessibility")
    }
  }
  var result = status()
  result["openedSettings"] = opened
  return result
}

// MARK: - Main loop

let work = DispatchQueue(label: "paseo-screen-helper")

func handle(_ line: String) {
  guard let data = line.data(using: .utf8),
        let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
    reply(["ok": false, "error": "invalid JSON request"])
    return
  }
  let id = request["id"] ?? NSNull()
  do {
    var result: [String: Any]
    switch request["cmd"] as? String {
    case "status": result = status()
    case "request": result = requestPermissions()
    case "frame": result = try captureFrame(request)
    case "input": result = try handleInput(request)
    case "clipboard": result = clipboard()
    default: throw HelperError("unknown command: \(request["cmd"] ?? "nil")")
    }
    result["id"] = id
    result["ok"] = true
    reply(result)
  } catch {
    reply(["id": id, "ok": false, "error": "\(error)"])
  }
}

Thread.detachNewThread {
  while let line = readLine() {
    if line.isEmpty { continue }
    work.sync { handle(line) }
  }
  exit(0)
}

// An AppKit run loop (with no Dock icon) keeps NSScreen up to date and services main-queue work.
NSApplication.shared.setActivationPolicy(.prohibited)
NSApplication.shared.run()
