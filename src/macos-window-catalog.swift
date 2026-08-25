import AppKit
import CoreGraphics
import Foundation

private func terminate(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    Foundation.exit(2)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 2, arguments[0] == "--bundle-id" else {
    terminate("usage: macos-window-catalog.swift --bundle-id reverse.dns.identifier")
}

let bundleIdentifier = arguments[1]
guard bundleIdentifier.count <= 255,
      bundleIdentifier.range(
        of: #"^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$"#,
        options: .regularExpression
      ) != nil else {
    terminate("bundle identifier is invalid")
}

let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
guard let rawWindows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    terminate("CoreGraphics did not return a window catalog")
}

var windows: [[String: Any]] = []
var seenWindowIdentifiers = Set<UInt32>()

for rawWindow in rawWindows {
    guard let number = rawWindow[kCGWindowNumber as String] as? NSNumber,
          let pidNumber = rawWindow[kCGWindowOwnerPID as String] as? NSNumber,
          let layerNumber = rawWindow[kCGWindowLayer as String] as? NSNumber,
          let boundsDictionary = rawWindow[kCGWindowBounds as String] as? NSDictionary else {
        continue
    }

    let windowIdentifier = number.uint32Value
    let ownerPid = pid_t(pidNumber.int32Value)
    guard windowIdentifier > 0,
          ownerPid > 0,
          !seenWindowIdentifiers.contains(windowIdentifier),
          NSRunningApplication(processIdentifier: ownerPid)?.bundleIdentifier == bundleIdentifier else {
        continue
    }

    var bounds = CGRect.zero
    guard CGRectMakeWithDictionaryRepresentation(boundsDictionary as CFDictionary, &bounds),
          bounds.width > 0,
          bounds.height > 0 else {
        continue
    }

    guard let ownerName = rawWindow[kCGWindowOwnerName as String] as? String,
          !ownerName.isEmpty else {
        continue
    }
    seenWindowIdentifiers.insert(windowIdentifier)
    let titleValue = rawWindow[kCGWindowName as String] as? String
    let title = titleValue ?? ""
    let onScreen = (rawWindow[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
    let sharingState = (rawWindow[kCGWindowSharingState as String] as? NSNumber)?.intValue ?? 0

    windows.append([
        "bounds": [
            "height": bounds.height,
            "width": bounds.width,
            "x": bounds.origin.x,
            "y": bounds.origin.y,
        ],
        "bundleId": bundleIdentifier,
        "isOnScreen": onScreen,
        "layer": layerNumber.intValue,
        "ownerName": ownerName,
        "ownerPid": Int(ownerPid),
        "sharingState": sharingState,
        "title": title,
        "titleAvailable": titleValue != nil,
        "windowId": Int(windowIdentifier),
    ])
}

windows.sort {
    guard let left = $0["windowId"] as? Int,
          let right = $1["windowId"] as? Int else {
        return false
    }
    return left < right
}

let document: [String: Any] = [
    "kind": "nelos-macos-window-catalog",
    "schemaVersion": 1,
    "windows": windows,
]

do {
    let output = try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys])
    FileHandle.standardOutput.write(output)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    terminate("could not serialize the window catalog")
}
